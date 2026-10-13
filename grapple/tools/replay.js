#!/usr/bin/env node
/* replay.js — deterministisches Abspielen einer F9-Aufnahme.
   Nutzung:  node tools/replay.js <rec.json> [--runs 2] [--write-fingerprint]
   Jede Ausführung baut eine FRISCHE Headless-Umgebung (eigener DOM/GL-Stub,
   eigenes Bundle), spielt Frame für Frame denselben Input auf demselben
   Frame-dt und misst: NaN, Eindringtiefe der Solver-Polylinie, größter
   Required-Sprung, sowie einen Fingerabdruck der Trajektorie.
   Zweck: eine Bildschirmaufnahme eines Fehlers wird so zum frame-genauen
   Regressionstest — zweimal abgespielt muss derselbe Fingerabdruck heraus-
   kommen, und nach Code-Änderungen derselbe wie der gespeicherte.        */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

function freshEnv() {
  for (const k of Object.keys(require.cache))
    if (k.endsWith('headless_dom.js')) delete require.cache[k];
  const HD = require('./headless_dom.js');
  const FILES = ['00_math.js','01_world.js','02_rope.js','03_player.js','04_render.js','05_fx.js','06_level.js','07_game.js'];
  let code = FILES.map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  code += '\n;this.__GAME = Game;';
  const sandbox = {
    console, Math, Date, JSON, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
    Float32Array, Uint16Array, Float64Array, Array, Object, Number, String, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, Proxy, Reflect,
    window: HD.window, document: HD.document, requestAnimationFrame: HD.window.requestAnimationFrame,
    screen: { width: 1280, height: 720 }, Blob: undefined, URL: undefined,
  };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle.js' });
  const game = new sandbox.__GAME(HD.document.getElementById('gl'));
  return { game, HD };
}

function penetration(game) {
  const W = game.world, pts = game.rope.path.pts;
  let maxPen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    for (let q = 1; q < 10; q++) {
      const u = q / 10;
      const p = [a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u];
      const bx = W.boxContaining(p, true);
      if (!bx) continue;
      const d = Math.min(p[0]-bx.min[0], bx.max[0]-p[0], p[1]-bx.min[1], bx.max[1]-p[1], p[2]-bx.min[2], bx.max[2]-p[2]);
      if (d > maxPen) maxPen = d;
    }
  }
  return maxPen;
}

function replayOnce(rec) {
  const { game } = freshEnv();
  game.applySnapshot(rec.snap);
  const h = crypto.createHash('sha256');
  let maxPen = 0, maxJump = 0, prevReq = null, nan = false;
  for (const fr of rec.frames) {
    game._unpackFrame(fr);
    game.frame(fr.dt);
    const R = game.rope, P = game.player;
    if (!isFinite(P.pos[0]) || !isFinite(P.pos[1]) || !isFinite(P.pos[2]) || !isFinite(R.required)) nan = true;
    maxPen = Math.max(maxPen, penetration(game));
    if (prevReq !== null) maxJump = Math.max(maxJump, Math.abs(R.required - prevReq));
    prevReq = R.required;
    h.update(P.pos.map(v => v.toFixed(4)).join(',') + ';' + R.required.toFixed(4) + ';' + R.path.wraps.length + '\n');
  }
  return { frames: rec.frames.length, maxPen: +maxPen.toFixed(3), maxJump: +maxJump.toFixed(3),
           nan, fingerprint: h.digest('hex').slice(0, 16) };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const runs = parseInt((args.find(a => a.startsWith('--runs=')) || '--runs=2').split('=')[1], 10);
  if (!file) { console.error('Nutzung: node tools/replay.js <rec.json> [--runs=N] [--write-fingerprint]'); process.exit(2); }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const reps = [];
  for (let i = 0; i < runs; i++) reps.push(replayOnce(rec));
  const det = reps.every(r => r.fingerprint === reps[0].fingerprint && !r.nan);
  const storeOk = !rec.fingerprint || rec.fingerprint === reps[0].fingerprint;
  console.log(JSON.stringify({ file: path.basename(file), runs: reps,
    deterministisch: det, gespeicherterFingerprint: rec.fingerprint || null, passt: storeOk,
    harteGrenze: reps.every(r => r.maxPen < 1.0) }, null, 1));
  if (args.includes('--write-fingerprint')) {
    rec.fingerprint = reps[0].fingerprint;
    fs.writeFileSync(file, JSON.stringify(rec));
    console.log('Fingerprint geschrieben:', rec.fingerprint);
  }
  process.exit(det && storeOk && reps.every(r => r.maxPen < 1.0) ? 0 : 1);
}
module.exports = { replayOnce, freshEnv };

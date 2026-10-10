/* probe_feel.js — Messprobe für die gemeldeten Feel-Fehler (headless).
   A) Seil optisch schlaff bei Vollspannung?   B) Knick am Anfang (Ego)?
   C) Nach-hinten-Laufen bei straffem Seil → Schweben?
   D) Bodenreibung / Slide-Dauer               E) Widerstand beim Umkreisen
   Kein Test, nur Messung. physStep() bildet 07_game.js physics() 1:1 ab.     */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'src');
const FILES = ['00_math.js','01_world.js','02_rope.js','03_player.js','05_fx.js','06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.EXP = { World, Rope, Player, Hook, buildLevel, ROPE_PHASE, v3, vdist, vlen, vsubNew, vnorm, vdot, qFromYawPitch, qForward, qUp, qRight };';
const sandbox = { console, Math, Date, performance: { now: () => Number(process.hrtime.bigint())/1e6 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const E = sandbox.EXP;

const world = new E.World(); E.buildLevel(world);
const rope = new E.Rope(world, {}), player = new E.Player(world, {}), hook = new E.Hook(world, {});
const HZ = 120, dt = 1/HZ;
const input = { forward:false, back:false, left:false, right:false, jumpPressed:false,
                slide:false, slideHeld:false, firePressed:false, releasePressed:false, reelDir:0 };

function aimAt(target) {
  const hand = player.handPoint(E.v3(), rope);
  const d = E.vsubNew(target, hand); E.vnorm(d, d);
  player.pitch = Math.asin(Math.max(-1, Math.min(1, d[1])));
  player.yaw = Math.atan2(-d[0], -d[2]);
}
/* 1:1-Nachbau von Game.physics() (Aktionen → Pump → Körper → Haken → Seil → Spieler) */
function physStep() {
  if (input.releasePressed) { rope.detach(); hook.retractNow(rope); }
  if (input.firePressed) {
    if (rope.phase !== 0) { rope.detach(); hook.state = 'idle'; }
    const hand0 = player.handPoint(E.v3(), null);
    E.qFromYawPitch(player.quat, player.yaw, player.pitch);
    const f = E.qForward(E.v3(), player.quat), u = E.qUp(E.v3(), player.quat), rr = E.qRight(E.v3(), player.quat);
    hook.fire(hand0, f, u, rr, player.vel, rope);
  }
  player.pumpInput = (input.forward?1:0) - (input.back?1:0);
  player.reelDir = input.reelDir || 0;
  world.stepBodies(dt);
  const hand = player.handPoint(E.v3(), rope);
  if (hook.state !== 'idle') hook.step(dt, rope, rope.phase === 1 ? player.chestPoint(E.v3()) : hand);
  const chest = player.chestPoint(E.v3());
  rope.visualHand = hand;
  rope.setPlayerCapsule(player.pos, player.p.radius, player.hh);
  rope.step(dt, chest, hook.flying ? hook.pos : null, player.vel);
  player.update(dt, input, rope);
  rope.drainEvents();
  // Edge-Flags NACH der Physik löschen (wie Game.update nach den Substeps)
  input.firePressed = false; input.releasePressed = false; input.jumpPressed = false; input.slide = false;
}
function run(seconds, every, cb) {
  const n = Math.round(seconds*HZ);
  for (let i = 0; i < n; i++) { physStep(); if (cb && i % Math.max(1, Math.round(every*HZ)) === 0) cb(i/HZ); }
}
function chainStats() {
  const C = rope.chain, n = C.n;
  const a = C.pos[0], b = C.pos[n-1];
  const ab = E.vsubNew(b, a); const L2 = ab[0]*ab[0]+ab[1]*ab[1]+ab[2]*ab[2];
  let maxDev = 0, minY = Infinity, arc = 0;
  for (let i = 0; i < n; i++) {
    const p = C.pos[i];
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*ab[0]+(p[1]-a[1])*ab[1]+(p[2]-a[2])*ab[2]) / L2));
    const cx = a[0]+ab[0]*t, cy = a[1]+ab[1]*t, cz = a[2]+ab[2]*t;
    const dev = Math.hypot(p[0]-cx, p[1]-cy, p[2]-cz);
    if (dev > maxDev) maxDev = dev;
    if (p[1] < minY) minY = p[1];
    if (i > 0) arc += E.vdist(p, C.pos[i-1]);
  }
  return { maxDev, minY, arc, chord: Math.sqrt(L2), n };
}
function kinkStats() {
  const C = rope.chain, n = C.n;
  const ang = (i) => {
    const a = E.vsubNew(C.pos[i], C.pos[i-1]), b = E.vsubNew(C.pos[i+1], C.pos[i]);
    const la = E.vlen(a), lb = E.vlen(b);
    if (la < 1e-6 || lb < 1e-6) return 0;
    return Math.acos(Math.max(-1, Math.min(1, E.vdot(a,b)/(la*lb))))*180/Math.PI;
  };
  const chest = player.chestPoint(E.v3());
  return { kink1: ang(1), kink2: ang(2), kink3: ang(3),
           handChest: E.vdist(rope.visualHand || rope.hand, chest),
           seg0: E.vdist(C.pos[0], C.pos[1]) };
}
function fireAt(target) { aimAt(target); input.firePressed = true; physStep(); }
function waitAttached(maxS = 3) {
  let t = 0; while (t < maxS && !rope.attached) { physStep(); t += dt; }
  return t;
}

/* ---------------- A) straffer Schuss, stationär + Zeitverlauf ---------------- */
console.log('=== A) Vollspannung nach Anker: Zeitverlauf budget/required/slack/Kette ===');
player.spawn([10, 1.9, 10], 0); run(0.5);
fireAt([0, 10.05, -25.5]);             // Kante Dach 1, freie Sicht, ~38 m
const tA = waitAttached();
console.log(`verankert nach ${tA.toFixed(2)}s`);
let prevT = 0;
for (const wait of [0.05, 0.1, 0.2, 0.4, 0.7, 1.0, 2.0]) {
  run(wait - prevT); prevT = wait;
  const s = chainStats();
  console.log(`  t+${wait.toFixed(2)}: ph=${rope.phase} budget=${rope.budget.toFixed(2)} req=${rope.required.toFixed(2)} slack=${rope.slack.toFixed(3)} tens=${rope.tensionLevel.toFixed(2)} arc=${s.arc.toFixed(2)} chord=${s.chord.toFixed(2)} Durchhang=${s.maxDev.toFixed(2)} minY=${s.minY.toFixed(1)}`);
}
run(1.0);
let s = chainStats(); let k = kinkStats();
console.log(`stationär: slack=${rope.slack.toFixed(3)} arc-chord=${(s.arc-s.chord).toFixed(2)} Durchhang=${s.maxDev.toFixed(2)} m  (Spannweite ${s.chord.toFixed(1)} m)`);
console.log(`  Knick Ego: Winkel Node1=${k.kink1.toFixed(1)}° Node2=${k.kink2.toFixed(1)}° Node3=${k.kink3.toFixed(1)}°  |Hand-Brust|=${k.handChest.toFixed(2)} m seg0=${k.seg0.toFixed(2)}`);
// Spieler läuft weg bis Anschlag
input.back = true; run(2.5, 0.5, (t) => { const st = chainStats();
  console.log(`  weglaufen t=${t.toFixed(1)} pos=(${player.pos.map(x=>x.toFixed(1)).join(',')}) grounded=${player.grounded} y=${player.pos[1].toFixed(2)} slack=${rope.slack.toFixed(2)} Durchhang=${st.maxDev.toFixed(2)}`); });
input.back = false; run(1.0);
s = chainStats();
console.log(`nach Weglaufen: slack=${rope.slack.toFixed(3)} budget=${rope.budget.toFixed(2)} req=${rope.required.toFixed(2)} arc-chord=${(s.arc-s.chord).toFixed(2)} Durchhang=${s.maxDev.toFixed(2)} minY=${s.minY.toFixed(2)}`);

/* ---------------- C) Schweben beim Rückwärtslaufen (Anker hoch) ---------------- */
console.log('=== C) Rückwärtslaufen bei straffem Seil, Anker hoch ===');
rope.detach(); hook.state = 'idle';
player.spawn([0, 11.0, -24.4], 0); run(0.4);
fireAt([0, 18.4, -35.4]);              // Portal-Riegel über der Schlucht
waitAttached(); run(0.6);
console.log(`verankert: slack=${rope.slack.toFixed(2)} req=${rope.required.toFixed(2)} y=${player.pos[1].toFixed(2)}`);
input.back = true;
run(3.2, 0.4, (t) => console.log(`  t=${t.toFixed(1)} y=${player.pos[1].toFixed(2)} vy=${player.vel[1].toFixed(2)} grounded=${player.grounded} hSpeed=${player.hSpeed.toFixed(1)} slack=${rope.slack.toFixed(2)}`));
input.back = false;

/* ---------------- D) Bodenreibung + Slide ---------------- */
console.log('=== D) Bodenreibung / Slide ===');
rope.detach(); hook.state = 'idle';
player.spawn([0, 1.2, 30], Math.PI); run(0.3);
input.forward = true; run(1.6); input.forward = false;
const p0 = [...player.pos]; const vRelease = player.hSpeed;
let tS = 0; while (player.hSpeed > 0.05 && tS < 5) { physStep(); tS += dt; }
console.log(`  Lauf v=${vRelease.toFixed(1)} m/s → Stillstand nach ${tS.toFixed(2)} s, ${(E.vdist(player.pos, p0)).toFixed(1)} m`);
player.spawn([0, 1.2, 30], Math.PI); run(0.3);
input.forward = true; run(1.6); input.forward = false;
input.slide = true; input.slideHeld = true; physStep();
let tSl = 0; const pSl = [...player.pos]; const vSl = player.hSpeed;
while (tSl < 6 && player.sliding) { physStep(); tSl += dt; }
console.log(`  Slide v0=${vSl.toFixed(1)} → endet nach ${tSl.toFixed(2)} s (sliding=${player.sliding}), Strecke ${(E.vdist(player.pos, pSl)).toFixed(1)} m, hh=${player.hh.toFixed(2)}`);
run(1.0);
console.log(`  nach Slide: sliding=${player.sliding} hh=${player.hh.toFixed(2)} y=${player.pos[1].toFixed(2)}`);

/* ---------------- E) Umkreisen eines Wraps: Widerstand? ---------------- */
console.log('=== E) Umkreisen Wrap-Wand ===');
rope.detach(); hook.state = 'idle';
player.spawn([22, 2.0, -42], Math.PI*0.5); run(0.4);
fireAt([8, 13.0, -42]);                // Ankerblock hinter der Wand (Wrap über Kante y=7)
waitAttached(); run(0.8);
console.log(`verankert: wraps=${rope.path.pts.length-2} wrapAngle=${(rope.totalWrapAngle()*180/Math.PI).toFixed(0)}° slack=${rope.slack.toFixed(2)} tens=${rope.tensionLevel.toFixed(2)}`);
input.left = true;                      // seitlich los → orbit um die Wandkante
run(2.4, 0.4, (t) => console.log(`  orbit t=${t.toFixed(1)} hSpeed=${player.hSpeed.toFixed(1)} pos=(${player.pos.map(x=>x.toFixed(1)).join(',')}) wraps=${rope.path.pts.length-2} ang=${(rope.totalWrapAngle()*180/Math.PI).toFixed(0)}° tens=${rope.tensionLevel.toFixed(2)} slack=${rope.slack.toFixed(2)}`));
input.left = false;
console.log('--- Referenz: gleiche Bewegung OHNE Wrap (freie Sicht) ---');
rope.detach(); hook.state = 'idle';
player.spawn([31, 2.0, -18], -0.207); run(0.4);
fireAt([33, 6.0, -30]);
waitAttached(); run(0.8);
input.left = true;
run(2.4, 0.4, (t) => console.log(`  frei  t=${t.toFixed(1)} hSpeed=${player.hSpeed.toFixed(1)} wraps=${rope.path.pts.length-2} ang=${(rope.totalWrapAngle()*180/Math.PI).toFixed(0)}° tens=${rope.tensionLevel.toFixed(2)}`));
input.left = false;

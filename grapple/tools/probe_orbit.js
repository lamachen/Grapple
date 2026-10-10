/* probe_orbit.js — Messprobe: Säulen-Orbit wie im Nutzervideo (Frame 5s/8s/9s).
   Misst pro Zeitschritt: Live-Topologie vs. frisch konvergierte Referenz,
   Spiel (slack), Pin-Spiel der Kette, Knickwinkel der Kette UND Abstand des
   Knick-Nodes zur nächsten Geometrie (Freiluft-Knick = Solver-Irrtum).
   Kein Test, nur Messung. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = path.join(__dirname, '..', 'src');
const FILES = ['00_math.js','01_world.js','02_rope.js','03_player.js','05_fx.js','06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.EXP = { World, Rope, Player, buildLevel, ROPE_PHASE, v3, vdist, vlen, vsubNew, vnorm, vdot };';
const sandbox = { console, Math, Date, performance: { now: () => Number(process.hrtime.bigint())/1e6 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const E = sandbox.EXP;

const world = new E.World(); const lvl = E.buildLevel(world);
const rope = new E.Rope(world, {});
const ref  = new E.Rope(world, {});          // frische Referenz-Topologie
const HZ = 120, dt = 1/HZ;

/* Anker: Oberkante grüner Block hinter der Säule (wie Spot "Säulen-Wrap") */
let green = null, column = null;
for (const b of world.statics) {
  const c = b.center || [(b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2];
  if (Math.abs(c[0]-33) < 0.1 && Math.abs(c[2]+30) < 0.1 && Math.abs(c[1]-3) < 0.1) green = b;
  if (Math.abs(c[0]-34) < 0.1 && Math.abs(c[2]+24) < 0.1 && Math.abs(c[1]-5) < 0.1) column = b;
}
if (!green || !column) { console.log('Boxen nicht gefunden'); process.exit(1); }
const ANCHOR = [33, 6.0, -30];
const ALLB = world.statics.concat(world.bodies);

function boxName(b) {
  if (b === green) return 'GRUEN';
  if (b === column) return 'SAEULE';
  const c = [(b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2];
  return `box@${c.map(x=>x.toFixed(0)).join(',')}`;
}
function distToBoxes(p) {
  let best = Infinity, bn = '';
  for (const b of world.statics) {
    const dx = Math.max(b.min[0]-p[0], 0, p[0]-b.max[0]);
    const dy = Math.max(b.min[1]-p[1], 0, p[1]-b.max[1]);
    const dz = Math.max(b.min[2]-p[2], 0, p[2]-b.max[2]);
    const d = Math.hypot(dx, dy, dz);
    if (d < best) { best = d; bn = boxName(b); }
  }
  return { d: best, name: bn };
}
function wrapDesc(r) {
  return r.path.wraps.map(w => `${boxName(w.box)}:e${w.edgeIdx}@(${w.p.map(x=>x.toFixed(1)).join(',')})rel${w.release.toFixed(2)}`).join(' | ') || '-';
}
function refLen(chest) {
  ref.path.reset();
  ref.path.solve(chest, ANCHOR, 1/60, null, green);
  return ref.path.converge();
}
function chainKink() {
  const C = rope.chain, n = C.n;
  let best = 0, bp = null;
  for (let i = 1; i < n-1; i++) {
    const a = E.vsubNew(C.pos[i], C.pos[i-1]), b = E.vsubNew(C.pos[i+1], C.pos[i]);
    const la = E.vlen(a), lb = E.vlen(b);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, E.vdot(a,b)/(la*lb))))*180/Math.PI;
    if (ang > best) { best = ang; bp = C.pos[i]; }
  }
  return { ang: best, p: bp };
}
function slackPin(chest, hand) {
  const pts = [hand, ...rope.path.wraps.map(w => w.p), ANCHOR];
  let polyLen = 0;
  for (let i = 1; i < pts.length; i++) polyLen += E.vdist(pts[i-1], pts[i]);
  const pathLen = rope.required;
  const Lraw = Math.max(pathLen, rope.budgetEff > 0 ? rope.budgetEff : rope.budget);
  const pinCorr = Math.max(0, pathLen - polyLen);
  const L = Math.max(polyLen*0.999, Lraw - pinCorr);
  return { slackPin: L - polyLen, polyLen };
}

/* Attach wie nach Haken-Treffer: bezahlte Länge = konvergierter Pfad + Rand */
const chest0 = [31.6, 1.45, -21.0], hand0 = [31.8, 1.9, -20.8];
ref.path.reset(); ref.path.solve(chest0, ANCHOR, 1/60, null, green);
const paid = ref.path.converge() + 0.05;
rope.attachAt(ANCHOR, [0,1,0], green, null, paid);
rope.visualHand = hand0;
console.log(`attach: paid=${paid.toFixed(2)}  Start chest=(${chest0.join(',')})`);

/* Orbit um die Säule: Radius 4.2, Brust y=1.45, eine volle Runde in 12 s */
const CX = 34, CZ = -24, R = 3.2;
let a0 = Math.atan2(chest0[2]-CZ, chest0[0]-CX);   // Startwinkel
const T_ORBIT = 12, STEPS = Math.round(14*HZ);
let prevWraps = -1;
for (let s = 0; s < STEPS; s++) {
  const t = s/HZ;
  const th = a0 + (t/T_ORBIT)*Math.PI*2;
  const cx = CX + Math.cos(th)*R, cz = CZ + Math.sin(th)*R;
  const chest = [cx, 1.45, cz];
  const hand = [cx+0.2, 1.9, cz+0.2];
  const vel = [-Math.sin(th)*R*2*Math.PI/T_ORBIT, 0, Math.cos(th)*R*2*Math.PI/T_ORBIT];
  rope.visualHand = hand;
  rope.step(dt, chest, null, vel);
  rope.drainEvents();
  if (s % Math.round(0.25*HZ) === 0) {
    const rl = refLen(chest);
    const kk = chainKink();
    const kd = kk.p ? distToBoxes(kk.p) : null;
    const sp = slackPin(chest, hand);
    const wc = rope.path.wraps.length;
    const mark = (rope.required - rl > 1.0) ? '  <<< UMWEG' : ((kk.ang > 25 && kd && kd.d > 0.3) ? '  <<< FREILUFT-KNICK' : '');
    console.log(`t=${t.toFixed(2)} th=${(th*180/Math.PI).toFixed(0).padStart(4)}° wr=${wc} req=${rope.required.toFixed(2)} ref=${rl.toFixed(2)} d=${(rope.required-rl).toFixed(2)} slack=${rope.slack.toFixed(2)} slPin=${sp.slackPin.toFixed(2)} kink=${kk.ang.toFixed(0)}°@${kd?kd.d.toFixed(2)+'m/'+kd.name:'-'} ${wrapDesc(rope)}${mark}`);
  }
}
console.log('stats inserts=', rope.path.stats.inserts, 'bogusDropped=', rope.path.stats.bogusDropped || 0);

'use strict';
/* tools/probe_wrapclean.js — Wickel-Messung in einer REINEN Testwelt.

   Warum noch eine Sonde: tools/probe_orbit2.js fährt die Hand um die Säule des
   Levels, und die Handbahn (Radius 4,5 m um die Säulenmitte) läuft dabei durch
   die Levelgeometrie — Box 26 reicht bis 3,54 m, Box 27 bis 3,68 m von der
   Mitte. Die Maske „gültige Hand" sortiert diese Schritte mit 0,4 m Abstand
   aus, aber das lässt genau die Schritte weg, in denen die Sehne die Boxecke
   schneidet — also die interessanten. Gemessen: der „schlimmste blockierte
   Schritt" beider Modi lag bei einer Hand 1,8 mm AUSSEN an der aufgepolsterten
   Boxgrenze (t = 2,68) bzw. 1,7 m INNEN der Box (t = 3,06, von der Maske
   nicht mehr erwischt, weil 37,624 > 35,9). Beide Zahlen sind Testaufbau.

   Diese Sonde baut deshalb eine eigene Welt: Boden + EIN Quader, Hand auf
   einer Kreisbahn mit Radius 4,0 m um eine Säule mit halber Diagonale
   2,75 m — die Hand ist damit immer ≥ 1,25 m ausserhalb, jeder Schritt ist
   gültig, und es gibt ausser der Säule nichts, woran sich ein Kontakt
   festhalten oder womit er kollidieren könnte. Übrig bleibt genau die Frage,
   um die es beim pivot-Solver geht: Hält das Seil die Wicklung um die Säule,
   gleitet der Kontakt stetig, und gibt es weder Blockaden noch Längensprünge?

   Aufruf: MODE=legacy|pivot node tools/probe_wrapclean.js [V] [R] [T]
           SRC=… für eine alternative Quelle
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC : path.join(__dirname, '..', 'src');
const MODE = process.env.MODE || 'pivot';
let code = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.X={World,RopePathSolver,ROPE_DEFAULTS,vdist};';
const sb = {
  console, Math, Date, JSON, performance: { now: () => 0 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN,
  window: {}, document: undefined,
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb);
const X = sb.X;

/* ------------------------------- Testwelt -------------------------------- */
const world = new X.World();
world.gravity = -26;
world.addBox([-40, -2, -40], [40, 0, 40], { color: [1, 1, 1] });          // Boden
const HALB = [1.6, 5, 1.6];                                                // Säule 3,2 × 10 × 3,2
const column = world.addBox([-HALB[0], 0, -HALB[2]], [HALB[0], 2 * HALB[1], HALB[2]], { color: [0.4, 0.8, 0.4] });
const boxes = world.statics.filter(b => b.ropeSolid !== false);
boxes.forEach((b, i) => b.__id = i);

/* Anker: frei stehender Punkt auf gleicher Höhe wie die Handbahn, so weit weg,
   dass die Sehne die Säule für den ganzen Umlauf schneidet. */
const HY = 2.5;
const ANCHOR = [-9, HY, 0];

const V = +(process.argv[2] || 5.0);       // Bahngeschwindigkeit [m/s]
const R = +(process.argv[3] || 4.0);       // Radius [m] — muss > halbe Diagonale + 0,4 sein
const T = +(process.argv[4] || 16);        // Dauer [s]
const halfDiag = Math.hypot(HALB[0], HALB[2]);
if (R < halfDiag + 0.6) {
  console.error(`Radius ${R} m ist zu klein: die Hand läuft in die Säule (halbe Diagonale ${halfDiag.toFixed(2)} m). Abbruch.`);
  process.exit(1);
}

function overlap(a, b, box, sh) {
  const s = sh || 0;
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const mn = box.min[k] + s, mx = box.max[k] - s, d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] <= mn || a[k] >= mx) return null; }
    else {
      let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d;
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 >= t1) return null;
    }
  }
  return [t0, t1];
}
function validHand(A) {
  if (A[1] < 0.2) return false;
  for (const b of boxes)
    if (A[0] > b.min[0] - 0.4 && A[0] < b.max[0] + 0.4
      && A[1] > b.min[1] - 0.4 && A[1] < b.max[1] + 0.4
      && A[2] > b.min[2] - 0.4 && A[2] < b.max[2] + 0.4) return false;
  return true;
}

const hz = 120, dt = 1 / hz;
const P = Object.assign({}, X.ROPE_DEFAULTS, { wrapSolver: MODE });
if (process.env.DEADEND) P.pivotDeadEnd = process.env.DEADEND;
if (process.env.SELFPEN) P.pivotSelfPenRule = process.env.SELFPEN;
if (process.env.DEPTH) P.pivotSelfPenDepth = +process.env.DEPTH;
const S = new X.RopePathSolver(world, P);
S._hostSettled = true;                       // Attached-Betrieb wie im Spiel

const hand = t => { const a = -t * V / R; return [R * Math.sin(a), HY, R * Math.cos(a)]; };
let A = hand(0);
S.solve(A, ANCHOR, dt, null, null);
S.converge();

const N = Math.round(T * hz);
let valid = 0, invalid = 0, blocked = 0, maxDepth = 0, depthAt = -1;
let maxJump = 0, jumpAt = -1, prevLen = S.length;
let maxJumpGeo = 0, jumpGeoAt = -1, prevGeo = S.lengthGeo;
let releases = 0, relWithJump = 0, prevWraps = S.wraps.length;
let maxWraps = 0, contactSteps = 0, noContactBlocked = 0, maxLenOff = 0;
let detourMax = 0, detourAt = -1;
let edgeChanges = 0, prevEdges = S.wraps.map(w => w.box.__id + ':' + w.edgeIdx).join(',');
const worst = [];
const ref = new X.RopePathSolver(world, Object.assign({}, X.ROPE_DEFAULTS));

for (let i = 1; i <= N; i++) {
  const t = i * dt;
  A = hand(t);
  S.solve(A, ANCHOR, dt, null, null);
  maxWraps = Math.max(maxWraps, S.wraps.length);
  if (S.wraps.length < prevWraps) {
    releases += prevWraps - S.wraps.length;
    if (Math.abs(S.length - prevLen) > 0.5) relWithJump++;
  }
  prevWraps = S.wraps.length;
  const edges = S.wraps.map(w => w.box.__id + ':' + w.edgeIdx).join(',');
  if (edges !== prevEdges) edgeChanges++;
  prevEdges = edges;

  if (!validHand(A)) { invalid++; prevLen = S.length; continue; }
  valid++;
  maxLenOff = Math.max(maxLenOff, S._lenOff || 0);
  const jump = Math.abs(S.length - prevLen);
  if (jump > maxJump) { maxJump = jump; jumpAt = t; }
  prevLen = S.length;
  /* ZUSÄTZLICH der ungefilterte Sprung: `S.length` trägt den Offset `_lenOff`,
     der einen Topologiewechsel über `resyncFade` verschmiert. Er ist damit
     KEIN Maß für Stetigkeit — gemessen sprang `length` nur 0,053 m, während
     `lengthGeo` im selben Substep 14,610 m verlor (die Wicklung war weg, der
     Offset hat es verdeckt). Wer Stetigkeit messen will, muss lengthGeo
     messen; beide Werte stehen jetzt in der Ausgabe.                      */
  const jumpGeo = Math.abs(S.lengthGeo - prevGeo);
  if (jumpGeo > maxJumpGeo) { maxJumpGeo = jumpGeo; jumpGeoAt = t; }
  prevGeo = S.lengthGeo;

  ref.wraps.length = 0;
  ref.solve(A, ANCHOR, dt, null, null);
  ref.converge();
  const det = S.length - ref.length;
  if (det > detourMax) { detourMax = det; detourAt = t; }

  let bad = 0, badBox = null, badSeg = -1;
  for (let k = 0; k < S.pts.length - 1; k++)
    for (const b of boxes) {
      const ov = overlap(S.pts[k], S.pts[k + 1], b);
      if (!ov) continue;
      let d2 = 0;
      for (let ax = 0; ax < 3; ax++) { const dd = (S.pts[k + 1][ax] - S.pts[k][ax]) * (ov[1] - ov[0]); d2 += dd * dd; }
      const depth = Math.sqrt(d2);
      if (depth > bad) { bad = depth; badBox = b; badSeg = k; }
    }
  if (bad > 0.06) {
    blocked++;
    if (S.wraps.length === 0) noContactBlocked++;
    if (bad > maxDepth) { maxDepth = bad; depthAt = t; }
    if (worst.length < 6 && (worst.length === 0 || bad > worst[worst.length - 1].depth))
      worst.push({
        t: +t.toFixed(2), depth: +bad.toFixed(2), seg: badSeg, box: badBox.__id,
        hand: A.map(v => +v.toFixed(2)), len: +S.length.toFixed(2), ref: +ref.length.toFixed(2),
        wraps: S.wraps.map(w => ({ id: w.box.__id, e: w.edgeIdx, rel: +w.release.toFixed(2), atEnd: !!w._atEnd, p: w.p.map(v => +v.toFixed(2)) })),
      });
  }
  if (S.wraps.length) contactSteps++;
}

console.log(JSON.stringify({
  mode: MODE, V, R, T, anchor: ANCHOR, halfDiag: +halfDiag.toFixed(2),
  steps: N, valid, invalid,
  blocked, blockedPct: +(blocked / Math.max(1, valid) * 100).toFixed(2),
  maxDepth: +maxDepth.toFixed(2), depthAt: +depthAt.toFixed(2),
  maxJump: +maxJump.toFixed(3), jumpAt: +jumpAt.toFixed(2),
  maxJumpGeo: +maxJumpGeo.toFixed(3), jumpGeoAt: +jumpGeoAt.toFixed(2),
  maxLenOff: +maxLenOff.toFixed(2),
  detourMax: +detourMax.toFixed(2), detourAt: +detourAt.toFixed(2),
  releases, relWithJump, maxWraps, contactSteps, noContactBlocked, edgeChanges,
  pivotInserts: S.stats.pivotInserts || 0,
  legacyInserts: S.stats.inserts || 0,
  selfPen: S.stats.pivotSelfPen || 0,
  pivotSwaps: S.stats.pivotSwaps || 0,
  pivotSwapGain: +(S.stats.pivotSwapGain || 0).toFixed(2),
  pivotWindHeld: S.stats.pivotWindHeld || 0,
  cleanup: { nullRef: S.stats.pcNull || 0, drift: S.stats.pcDrift || 0, gainSeen: +(S.stats.pcGainSeen || 0).toFixed(1) },
  releaseEvents: S.stats.releaseEvents || 0,
  rebuilds: S.stats.rebuilds || 0,
  resyncs: S.stats.resyncs || 0,
  worst,
}, null, 1));

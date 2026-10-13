'use strict';
/* tools/probe_orbit2.js — Orbit-Messung mit echtem Wickel-Zwang.

   Warum eine neue Sonde neben work/probe_pivot.js und tools/test_wrap.js:
   Beide fahren die Hand um die Säule mit dem Anker AUF DER SÜDSEITE derselben
   Säule (Level-Anker [33 | 4,5 | −27,5], Säule z −26,6…−21,4). Damit liegt die
   Säule für JEDE Handposition nördlich der Sehne Hand→Anker — die Sehne kann
   die Säule gar nicht schneiden, es gibt dort nichts zu wickeln. Gemessen:
   22 Kanten-Überstreichungen in 1440 Substeps, und die „Blockaden" stammen aus
   den Schritten, in denen die Hand selbst in der Säule steht (Radius 3,2 m bei
   halber Diagonale 3,68 m) — Testaufbau, nicht Solver.

   Diese Sonde setzt den Anker auf die WESTseite, sodass die Sehne die Säule
   wirklich schneidet und das Seil um die NW- oder SW-Kante laufen MUSS. Dazu
   der Skizzen-Fall: die Hand wechselt die Seite, während das Seil um die Säule
   liegt (genau der gemeldete Defekt: alle Umlenkpunkte lösen sich und das Seil
   nimmt den direkten Weg).

   Aufruf:  MODE=legacy|pivot node tools/probe_orbit2.js
            V/R/T = Bahngeschwindigkeit [m/s], Radius [m], Dauer [s]
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC : path.join(__dirname, '..', 'src');
const MODE = process.env.MODE || 'pivot';
const FILES = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js', '06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.X={World,buildLevel,RopePathSolver,ROPE_DEFAULTS,vdist};';
const sb = {
  console, Math, Date, JSON, performance: { now: () => 0 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN,
  window: {}, document: undefined,
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb);
const X = sb.X;

const world = new X.World();
X.buildLevel(world);
const boxes = world.statics.filter(b => b.ropeSolid !== false);
boxes.forEach((b, i) => b.__id = i);

/* Die Säule am Spot „Säulen-Wrap": B(w, [34, 5.0, −24], [2.6, 10, 2.6]) */
const column = boxes.find(b => Math.abs((b.min[0] + b.max[0]) / 2 - 34) < 0.6
  && Math.abs((b.min[2] + b.max[2]) / 2 + 24) < 0.6 && (b.max[1] - b.min[1]) > 8);
if (!column) { console.error('Säule nicht gefunden'); process.exit(1); }
const CX = (column.min[0] + column.max[0]) / 2;
const CZ = (column.min[2] + column.max[2]) / 2;

/* Anker SÜD-WESTLICH der Säule und deutlich ausserhalb der Handbahn:
   · die Sehne schneidet die Säule für einen großen Teil des Umlaufs, das Seil
     muss also wirklich um eine Kante laufen (Wickel-Zwang),
   · die Hand kommt dem Anker nie näher als ~12 m — der erste Versuch mit dem
     Anker auf der Bahn selbst ([CX−7,5 | 2,5 | CZ]) ließ die Hand fast durch
     den Anker laufen, und daraus kamen Längensprünge von 6,6 m, die reine
     Messgeometrie waren (Seillänge → 0, dann zurück), nicht Solver-Defekte. */
const ANCHOR = [CX - 10, 2.5, CZ - 8];

function segDepth(a, b, box) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const mn = box.min[k], mx = box.max[k], d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] < mn || a[k] > mx) return 0; }
    else {
      let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d;
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 >= t1) return 0;
    }
  }
  const len = t1 - t0;
  let q = 0;
  for (let k = 0; k < 3; k++) { const d = (b[k] - a[k]) * len; q += d * d; }
  return Math.sqrt(q);
}
function validHand(A) {
  if (A[1] < 0.2) return false;
  /* Messhygiene: die Hand muss frei stehen und Abstand zum Anker haben */
  if (Math.hypot(A[0] - ANCHOR[0], A[1] - ANCHOR[1], A[2] - ANCHOR[2]) < 2.0) return false;
  for (const b of boxes)
    if (A[0] > b.min[0] - 0.4 && A[0] < b.max[0] + 0.4
      && A[1] > b.min[1] - 0.4 && A[1] < b.max[1] + 0.4
      && A[2] > b.min[2] - 0.4 && A[2] < b.max[2] + 0.4) return false;
  return true;
}

const V = +(process.env.V || 6.0), R = +(process.env.R || 4.5), T = +(process.env.T || 14);
const hz = 120, dt = 1 / hz;
const P = Object.assign({}, X.ROPE_DEFAULTS, { wrapSolver: MODE });
if (process.env.SELFPEN) P.pivotSelfPenRule = process.env.SELFPEN;
if (process.env.DEPTH) P.pivotSelfPenDepth = +process.env.DEPTH;
if (process.env.CORNER) P.pivotCornerSlide = process.env.CORNER === 'on';
const S = new X.RopePathSolver(world, P);

const hand = t => { const a = -t * V / R; return [CX + R * Math.sin(a), 2.5, CZ + R * Math.cos(a)]; };

let A = hand(0);
S.solve(A, ANCHOR, dt, null, null);
S.converge();

const N = Math.round(T * hz);
let valid = 0, blocked = 0, maxDepth = 0, depthAt = -1;
let maxJump = 0, jumpAt = -1, prevLen = S.length;
let releases = 0, relWithJump = 0, prevWraps = S.wraps.length;
let maxWraps = 0, minWrapsBlocked = 99, wrapLossWhileBlocked = 0;
let columnContactSteps = 0, wrongSideSteps = 0;
let detourMax = 0, jumpInfo = null;
const detourTrace = [];
const ref = new X.RopePathSolver(world, Object.assign({}, X.ROPE_DEFAULTS));
const trace = [];

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

  if (!validHand(A)) { prevLen = S.length; continue; }
  valid++;

  const jump = Math.abs(S.length - prevLen);
  if (jump > maxJump) {
    maxJump = jump; jumpAt = t;
    jumpInfo = {
      t: +t.toFixed(3), from: +prevLen.toFixed(2), to: +S.length.toFixed(2),
      wrapsBefore: prevWraps, wrapsAfter: S.wraps.length,
      hand: A.map(v => +v.toFixed(2)),
      wraps: S.wraps.map(w => ({ id: w.box.__id, e: w.edgeIdx, rel: +w.release.toFixed(2), p: w.p.map(v => +v.toFixed(2)) })),
      pivIns: S.stats.pivotInserts || 0, legIns: S.stats.inserts || 0,
      selfPen: S.stats.pivotSelfPen || 0, relEv: S.stats.releaseEvents || 0,
    };
  }
  prevLen = S.length;

  /* Referenz: gedächtnislos neu gelöst (kürzeste freie Route für diese Hand) */
  ref.wraps.length = 0;
  ref.solve(A, ANCHOR, dt, null, null);
  ref.converge();
  detourMax = Math.max(detourMax, S.length - ref.length);
  if (i % 120 === 0) detourTrace.push({ t: +t.toFixed(1), len: +S.length.toFixed(2), ref: +ref.length.toFixed(2), det: +(S.length - ref.length).toFixed(2), wraps: S.wraps.length });

  /* Blockade + Tiefe */
  let bad = 0;
  for (let k = 0; k < S.pts.length - 1; k++)
    for (const b of boxes) bad = Math.max(bad, segDepth(S.pts[k], S.pts[k + 1], b));
  if (bad > 0.06) {
    blocked++;
    if (bad > maxDepth) { maxDepth = bad; depthAt = t; }
    minWrapsBlocked = Math.min(minWrapsBlocked, S.wraps.length);
    if (!S.wraps.some(w => w.box === column)) wrapLossWhileBlocked++;
  }
  if (S.wraps.some(w => w.box === column)) columnContactSteps++;

  if (process.env.TRACE && (i % 60 === 0)) {
    trace.push({
      t: +t.toFixed(2),
      hand: A.map(v => +v.toFixed(2)),
      len: +S.length.toFixed(2),
      ref: +ref.length.toFixed(2),
      wraps: S.wraps.map(w => ({ id: w.box.__id, e: w.edgeIdx, rel: +w.release.toFixed(2), p: w.p.map(v => +v.toFixed(2)) })),
      blocked: bad > 0.06 ? +bad.toFixed(2) : 0,
    });
  }
}

console.log(JSON.stringify({
  mode: MODE, V, R, T, anchor: ANCHOR, steps: N, valid,
  blocked, blockedPct: +(blocked / Math.max(1, valid) * 100).toFixed(1),
  maxDepth: +maxDepth.toFixed(2), depthAt: +depthAt.toFixed(2),
  maxJump: +maxJump.toFixed(2), jumpAt: +jumpAt.toFixed(2),
  detourMax: +detourMax.toFixed(2),
  releases, relWithJump, maxWraps, minWrapsBlocked, wrapLossWhileBlocked,
  columnContactPct: +(columnContactSteps / Math.max(1, valid) * 100).toFixed(1),
  pivotInserts: S.stats.pivotInserts || 0,
  legacyInserts: S.stats.inserts || 0,
  selfPen: S.stats.pivotSelfPen || 0,
  selfPenShallow: S.stats.pivotSelfPenShallow || 0,
  releaseEvents: S.stats.releaseEvents || 0,
  rebuilds: S.stats.rebuilds || 0,
  resyncs: S.stats.resyncs || 0,
  sweep: {
    calls: S.stats.swCalls || 0, skip: S.stats.swSkip || 0, segs: S.stats.swSegs || 0,
    tests: S.stats.swTests || 0, cross: S.stats.swCross || 0, dup: S.stats.swDup || 0,
    axis: S.stats.swAxis || 0, t: S.stats.swT || 0, free: S.stats.swFree || 0,
    self: S.stats.swSelf || 0, budget: S.stats.swBudget || 0,
  },
  jumpInfo,
  detourTrace,
  trace: process.env.TRACE ? trace : undefined,
}, null, 1));

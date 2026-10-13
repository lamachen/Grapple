'use strict';
/* tools/probe_worst.js — der SCHLIMMSTE blockierte Schritt eines Laufs.
   Zeigt Geometrie, Kontakte und was die drei Reparaturmechanismen sagen. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC : path.join(__dirname, '..', 'src');
const MODE = process.env.MODE || 'pivot';
let code = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js', '06_level.js']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.X={World,buildLevel,RopePathSolver,ROPE_DEFAULTS,vdist};';
const sb = { console, Math, Date, JSON, performance: { now: () => 0 }, Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN, window: {}, document: undefined };
sb.globalThis = sb; vm.createContext(sb); vm.runInContext(code, sb);
const X = sb.X;
const world = new X.World(); X.buildLevel(world);
const boxes = world.statics.filter(b => b.ropeSolid !== false);
boxes.forEach((b, i) => b.__id = i);
const column = boxes.find(b => Math.abs((b.min[0] + b.max[0]) / 2 - 34) < 0.6 && Math.abs((b.min[2] + b.max[2]) / 2 + 24) < 0.6 && (b.max[1] - b.min[1]) > 8);
const CX = (column.min[0] + column.max[0]) / 2, CZ = (column.min[2] + column.max[2]) / 2;
const ANCHOR = [CX - 10, 2.5, CZ - 8];
const P = Object.assign({}, X.ROPE_DEFAULTS, { wrapSolver: MODE });
const S = new X.RopePathSolver(world, P);
S._hostSettled = true;
function overlap(a, b, box) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const mn = box.min[k], mx = box.max[k], d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] < mn || a[k] > mx) return null; }
    else { let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d; if (ta > tb) { const x = ta; ta = tb; tb = x; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 >= t1) return null; }
  }
  return [t0, t1];
}
const hand = t => { const a = -t * 6 / 4.5; return [CX + 4.5 * Math.sin(a), 2.5, CZ + 4.5 * Math.cos(a)]; };
/* Messhygiene wie in tools/test_wrap.js und tools/probe_orbit2.js: Ohne diese
   Maske ist der „schlimmste blockierte Schritt" ein Schritt, in dem die HAND
   selbst in Geometrie steht — gemessen 5,37 m (pivot) und 5,26 m (legacy)
   „Eindringtiefe" bei Hand (37,62 | 2,5 | −26,67) bzw. (35,53 | 2,5 | −28,23),
   also 0,38 m bzw. 0,03 m INNERHALB von Box 26. Das ist Testaufbau, kein
   Solver-Defekt. */
function validHand(A) {
  if (A[1] < 0.2) return false;
  if (Math.hypot(A[0] - ANCHOR[0], A[1] - ANCHOR[1], A[2] - ANCHOR[2]) < 2.0) return false;
  for (const b of boxes)
    if (A[0] > b.min[0] - 0.4 && A[0] < b.max[0] + 0.4
      && A[1] > b.min[1] - 0.4 && A[1] < b.max[1] + 0.4
      && A[2] > b.min[2] - 0.4 && A[2] < b.max[2] + 0.4) return false;
  return true;
}
let A = hand(0); S.solve(A, ANCHOR, 1 / 120, null, null); S.converge();
let best = null;
const N = 14 * 120;
for (let i = 1; i <= N; i++) {
  const t = i / 120; A = hand(t);
  S.solve(A, ANCHOR, 1 / 120, null, null);
  const vh = validHand(A);
  if (process.env.VH && Math.abs(t - 2.683) < 0.001) {
    for (const b of boxes) {
      const c = A[0] > b.min[0] - 0.4 && A[0] < b.max[0] + 0.4
             && A[1] > b.min[1] - 0.4 && A[1] < b.max[1] + 0.4
             && A[2] > b.min[2] - 0.4 && A[2] < b.max[2] + 0.4;
      if (c) console.log('VH trifft Box', b.__id, JSON.stringify(b.min), JSON.stringify(b.max));
    }
    console.log('VH A=', A, 'boxes.length=', boxes.length, 'validHand=', vh);
  }
  if (!vh) continue;
  for (let k = 0; k < S.pts.length - 1; k++) {
    for (const b of boxes) {
      const ov = overlap(S.pts[k], S.pts[k + 1], b);
      if (!ov) continue;
      let d2 = 0;
      for (let ax = 0; ax < 3; ax++) { const dd = (S.pts[k + 1][ax] - S.pts[k][ax]) * (ov[1] - ov[0]); d2 += dd * dd; }
      const depth = Math.sqrt(d2);
      if (depth < 0.06) continue;
      if (process.env.DBG && depth > 1) console.log('DBG t', t.toFixed(3), 'depth', depth.toFixed(2), 'validHand', vh, 'hand', A.map(v=>+v.toFixed(2)));
      if (!best || depth > best.depth) {
        best = {
          depth, t, seg: k, nSeg: S.pts.length - 1, box: { id: b.__id, min: b.min.slice(), max: b.max.slice() },
          a: S.pts[k].slice(), b: S.pts[k + 1].slice(),
          ov: [ov[0], ov[1]],
          hand: A.slice(),
          wraps: S.wraps.map(w => ({ id: w.box.__id, e: w.edgeIdx, rel: +w.release.toFixed(2), atEnd: !!w._atEnd, tRaw: w._tRaw, tLen: w._tLen, p: w.p.map(v => +v.toFixed(2)) })),
          blockedSees: (S._segBlocked(S.pts[k], S.pts[k + 1], S.ptsBox[k], S.ptsBox[k + 1]) || {}).__id ?? null,
        };
      }
    }
  }
}
if (!best) { console.log(JSON.stringify({ mode: MODE, blocked: 0 }, null, 1)); process.exit(0); }
console.log(JSON.stringify({ mode: MODE, worst: best, insertTests: undefined }, null, 1));

'use strict';
/* tools/probe_blocked.js — warum bleibt eine blockierte Route blockiert?
   Faengt den ersten blockierten Schritt ab und fragt den Solver selbst:
   sieht _segBlocked den Blocker, und was sagt _tryInsertWrap? */
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
if (process.env.CORNER) P.pivotCornerSlide = process.env.CORNER === 'on';
const S = new X.RopePathSolver(world, P);
S._hostSettled = true;                      // Attached-Betrieb wie im Spiel
const hand = t => { const a = -t * 6 / 4.5; return [CX + 4.5 * Math.sin(a), 2.5, CZ + 4.5 * Math.cos(a)]; };
function depth(a, b, box) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const mn = box.min[k], mx = box.max[k], d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] < mn || a[k] > mx) return 0; }
    else { let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d; if (ta > tb) { const x = ta; ta = tb; tb = x; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 >= t1) return 0; }
  }
  let q = 0; for (let k = 0; k < 3; k++) { const d = (b[k] - a[k]) * (t1 - t0); q += d * d; }
  return Math.sqrt(q);
}
let A = hand(0); S.solve(A, ANCHOR, 1 / 120, null, null); S.converge();
const N = 14 * 120; let shown = 0;
for (let i = 1; i <= N && shown < 4; i++) {
  const t = i / 120; A = hand(t);
  S.solve(A, ANCHOR, 1 / 120, null, null);
  let worst = 0, wseg = -1, wbox = null;
  for (let k = 0; k < S.pts.length - 1; k++)
    for (const b of boxes) { const d = depth(S.pts[k], S.pts[k + 1], b); if (d > worst) { worst = d; wseg = k; wbox = b; } }
  if (worst <= 0.06) continue;
  shown++;
  const a = S.pts[wseg], b = S.pts[wseg + 1];
  const blocker = S._segBlocked(a, b, S.ptsBox[wseg], S.ptsBox[wseg + 1]);
  const cp = [0, 0, 0];
  let ins = null;
  try {
    const n0 = S.wraps.length;
    const ok = S._tryInsertWrap(true);
    ins = { ok, added: S.wraps.length - n0 };
    if (!ok) { S.wraps.length = n0; }
    else { S.wraps.splice(n0, 1); S._buildPts(S._A, S._B); }   // Zustand zurueck
  } catch (e) { ins = { error: String(e) }; }
  console.log(JSON.stringify({
    t: +t.toFixed(2), depth: +worst.toFixed(2), seg: wseg, nSeg: S.pts.length - 1,
    box: wbox ? { id: wbox.__id, min: wbox.min, max: wbox.max } : null,
    a: a.map(v => +v.toFixed(2)), b: b.map(v => +v.toFixed(2)),
    segBlockedSees: blocker ? (blocker.__id !== undefined ? blocker.__id : 'dyn') : null,
    wraps: S.wraps.map(w => ({ id: w.box.__id, e: w.edgeIdx, rel: +w.release.toFixed(2), atEnd: !!w._atEnd, p: w.p.map(v => +v.toFixed(2)) })),
    insertProbe: ins,
    budget: S.insertBudget, wrapMax: P.wrapMaxCount, sameBoxCount: S.wraps.filter(w => w.box === wbox).length,
  }, null, 1));
}

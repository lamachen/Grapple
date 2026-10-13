'use strict';
/* tools/probe_windoracle.js — Gegenprobe: Umlaufwinkel des Solvers gegen den
   Winkel, den die Handbahn TOPOLOGISCH erzwingt.

   Anlass: ein externes Modell hat dieselbe Messwelt benutzt (Boden + EIN
   Quader, Hand auf Kreisbahn, Anker frei stehend) und dabei einen Befund
   erhoben, der meiner eigenen Deutung widerspricht:

     · Der Umlaufwinkel des Solvers folgt dem erwarteten Winkel EXAKT — bis zu
       einem Punkt, an dem er schlagartig um 2π fällt.
     · Der Fall kommt vom Sackgassen-Neuaufbau (`rebuilds`), nicht von einer
       Freigabe-Regel.
     · Die Route ist an dieser Stelle NICHT zu lang: Sie ist korrekt um die
       Säule gewickelt, weil die Hand eine volle Runde gelaufen ist.
       „maxUmweg 14,4 m" ist damit ein Artefakt der Messgröße — der Umweg wird
       gegen eine gedächtnislose Referenz gemessen, die keine Windung kennt.

   Erwartung für diese Bahn (Handwinkel θ_H(t) = −t·V/R, Anker fest):
       W_erwartet(t) = θ_Anker − θ_H(t)      (mod nichts — Windung zählt echt)
   Solange das Seil nicht durchrutscht, muss der vom Solver gemessene
   Umlaufwinkel (`_pathWindingXZ` um die Säule) dem folgen. Jede Abweichung um
   ein Vielfaches von 2π ist ein verlorener (oder erfundener) Umlauf.

   Aufruf: MODE=legacy|pivot node tools/probe_windoracle.js [V] [R] [T]
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC : path.join(__dirname, '..', 'src');
const MODE = process.env.MODE || 'legacy';
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

/* ------------------------- Welt (wie probe_wrapclean) -------------------- */
const world = new X.World();
world.gravity = -26;
world.addBox([-40, -2, -40], [40, 0, 40], { color: [1, 1, 1] });
const HALB = [1.6, 5, 1.6];
const column = world.addBox([-HALB[0], 0, -HALB[2]], [HALB[0], 2 * HALB[1], HALB[2]], { color: [0.4, 0.8, 0.4] });

const HY = 2.5;
const ANCHOR = [-9, HY, 0];
const V = +(process.argv[2] || 5);
const R = +(process.argv[3] || 4);
const T = +(process.argv[4] || 16);

const P = Object.assign({}, X.ROPE_DEFAULTS, { wrapSolver: MODE });
if (process.env.MAXCOUNT) P.wrapMaxCount = +process.env.MAXCOUNT;
if (process.env.WINDMAX) P.wrapWindMax = +process.env.WINDMAX;
const S = new X.RopePathSolver(world, P);
S._hostSettled = true;

const hz = 120, dt = 1 / hz;
const hand = t => { const a = -t * V / R; return [R * Math.sin(a), HY, R * Math.cos(a)]; };
const thetaH = t => -t * V / R;
const thetaA = Math.atan2(ANCHOR[2] - 0, ANCHOR[0] - 0);   // Ankerwinkel um die Säulenmitte (0,0)

let A = hand(0);
S.solve(A, ANCHOR, dt, null, null);
S.converge();

const rows = [];
const events = [];
let prevW = null, maxDW = 0, maxDWat = 0;
let prevRebuilds = 0, prevResyncs = 0, prevReleases = 0, prevSelfPen = 0;
const N = Math.round(T * hz);

for (let i = 1; i <= N; i++) {
  const t = i * dt;
  A = hand(t);
  const lenBefore = S.length, geoBefore = S.lengthGeo, nBefore = S.wraps.length;
  S.solve(A, ANCHOR, dt, null, null);

  const Wsol = S._pathWindingXZ(S.pts, column);
  const Wexp = thetaA - thetaH(t);
  if (prevW !== null) {
    const dW = Math.abs(Wsol - prevW);
    if (dW > maxDW) { maxDW = dW; maxDWat = t; }
  }
  prevW = Wsol;

  const rb = S.stats.rebuilds || 0, rs = S.stats.resyncs || 0;
  const rel = S.stats.releaseEvents || 0, sp = S.stats.pivotSelfPen || 0;
  if (rb !== prevRebuilds || rs !== prevResyncs || rel !== prevReleases || sp !== prevSelfPen
      || S.wraps.length !== nBefore) {
    events.push({
      t: +t.toFixed(3),
      rebuilds: rb - prevRebuilds ? 'rebuild+' + (rb - prevRebuilds) : undefined,
      resyncs: rs - prevResyncs ? 'resync+' + (rs - prevResyncs) : undefined,
      releases: rel - prevReleases ? 'rel+' + (rel - prevReleases) : undefined,
      selfPen: sp - prevSelfPen ? 'selfPen+' + (sp - prevSelfPen) : undefined,
      wraps: nBefore + '→' + S.wraps.length,
      len: +lenBefore.toFixed(2) + '→' + +S.length.toFixed(2),
      geo: +geoBefore.toFixed(2) + '→' + +S.lengthGeo.toFixed(2),
      lenOff: +(S._lenOff || 0).toFixed(2),
      Wsol: +Wsol.toFixed(2), Wexp: +Wexp.toFixed(2), dW: +(Wsol - Wexp).toFixed(2),
      hand: A.map(v => +v.toFixed(2)),
      edges: S.wraps.map(w => 'e' + w.edgeIdx).join(','),
    });
  }
  prevRebuilds = rb; prevResyncs = rs; prevReleases = rel; prevSelfPen = sp;

  if (i % (hz * 1) === 0) rows.push({
    t: +t.toFixed(1), laps: +(t * V / R / (2 * Math.PI)).toFixed(2),
    Wexp: +Wexp.toFixed(2), Wsol: +Wsol.toFixed(2), diff: +(Wsol - Wexp).toFixed(2),
    len: +S.length.toFixed(2), geo: +S.lengthGeo.toFixed(2), lenOff: +(S._lenOff || 0).toFixed(2),
    n: S.wraps.length,
  });
}

console.log(JSON.stringify({
  mode: MODE, V, R, T, anchor: ANCHOR, thetaA: +thetaA.toFixed(4),
  steps: N,
  maxWindingStep: +maxDW.toFixed(2), maxWindingStepAt: +maxDWat.toFixed(2),
  finalWindingDiff: rows.length ? rows[rows.length - 1].diff : null,
  stats: {
    rebuilds: S.stats.rebuilds || 0, resyncs: S.stats.resyncs || 0,
    releaseEvents: S.stats.releaseEvents || 0, pivotSelfPen: S.stats.pivotSelfPen || 0,
    inserts: S.stats.inserts || 0, pivotInserts: S.stats.pivotInserts || 0,
    windHeld: S.stats.windHeld || 0, bogusWindHeld: S.stats.bogusWindHeld || 0,
    resyncWindHeld: S.stats.resyncWindHeld || 0, pivotWindHeld: S.stats.pivotWindHeld || 0,
    pivotSwaps: S.stats.pivotSwaps || 0,
  },
  caps: { wrapMaxCount: P.wrapMaxCount, wrapWindMax: P.wrapWindMax, wrapWindTol: P.wrapWindTol,
          sameBoxHardcoded: 3 },   // `if (sameBox >= 3) continue;` in _tryInsertWrap, kein Parameter
  rows, events,
}, null, 1));

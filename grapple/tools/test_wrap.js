/* =============================================================================
   tools/test_wrap.js — Regressionstest für das Wickel-/Seitenwechsel-Verhalten

   Warum es diese Datei gibt
   ------------------------
   Gemeldeter Defekt: ein z. B. links um ein Objekt gewickeltes Seil löst sich
   bei seitlicher Bewegung des Spielers von den Kanten, springt auf die andere
   Objektseite („quasi durch das Objekt hindurch") und bildet sich als direkte
   Linie Anker→Spieler neu.

   test_sim.js prüft bereits, dass Kette und Render-Kurve nicht in Geometrie
   stecken. Was dort NICHT vorkommt: der Solver wird nie über längere Zeit um
   ein Objekt HERUMGEFAHREN, und es wird nie gemessen, wie stark die
   Welt-Pfadlänge `required` dabei pro Schritt springt. Genau das ist aber die
   sichtbare Größe — ein Längensprung geht direkt in die Constraint und ist der
   Ruck, den man sieht.

   Dieser Test fährt zwei Orbit-Szenarien an der Säule des Levels (Spot
   „Säulen-Wrap") und misst vier Größen:

     1. Anteil der Schritte, in denen die Solver-Polylinie durch Geometrie läuft
     2. größter Längensprung von `solve()` pro Schritt
     3. Anzahl der Wickel-Freisetzungen mit Längensprung > 0,5 m
     4. ob `_cornerSlide` — der einzige Mechanismus für ein stetiges „um die
        Ecke rutschen" — überhaupt jemals aufgerufen wird

   WICHTIG zur Messhygiene: die Hand-Position muss gültig sein. Ein Orbit mit
   Radius 3,2 m um die Säule (Halbe Diagonale im Grundriss 3,68 m) führt die
   Hand selbst durch die Säulenecken; ohne Maske misst man den Testaufbau und
   nicht den Solver (gemessen: 431 statt 280 auffällige Schritte). Alle Zähler
   hier zählen deshalb nur Schritte mit gültiger Hand-Position.

   Die Schwellen sind bewusst auf den IST-Zustand gelegt und mit `XFAIL`
   markiert: dieser Test dokumentiert und arretiert den Defekt, er ist noch
   kein Abnahmekriterium. Nach einem Fix werden die XFAIL-Zeilen zu echten
   `ok(...)`-Grenzen verschärft — die Zielwerte stehen als Kommentar dabei.
   ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = process.env.SRC || path.join(__dirname, '..', 'src');
const FILES = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js', '06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.EXP = { World, buildLevel, RopePathSolver, ROPE_DEFAULTS, vdist };';
const sandbox = {
  console, Math, Date, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN,
  window: {}, document: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const E = sandbox.EXP;

let passed = 0, failed = 0, xfail = 0;
const results = [];
function ok(cond, name, detail) {
  if (cond) { passed++; results.push(['PASS', name, detail || '']); }
  else { failed++; results.push(['FAIL', name, detail || '']); }
}
function xok(cond, name, detail) {
  if (cond) { passed++; results.push(['PASS', name, detail || '']); }
  else { xfail++; results.push(['XFAIL', name, detail || '']); }
}

/* ------------------------------- Testwelt -------------------------------- */
const world = new E.World();
E.buildLevel(world);
const boxes = world.statics.filter(b => b.ropeSolid !== false);

/* Anker auf dem Ankerblock bei Spot „Säulen-Wrap" (06_level.js:
   B(w, [33, 3.0, -30], [5, 6, 5]) → x 28..38, y -3..9, z -35..-25).
   Der Anker liegt AUF der Blockoberkante, wie es ein echter Treffer erzeugt. */
const ANCHOR = [33, 4.5, -27.5];
const anchorBox = boxes.find(b => ANCHOR.every((v, k) => v >= b.min[k] - 1e-3 && v <= b.max[k] + 1e-3));
if (!anchorBox) { console.error('✘ Ankerbox nicht gefunden — Level geändert?'); process.exit(1); }

/* Die Säule: hoher schmaler Block östlich der direkten Sichtlinie
   (06_level.js: B(w, [34, 5.0, -24], [2.6, 10, 2.6]) → y -5..15). */
const column = boxes.find(b => Math.abs((b.min[0] + b.max[0]) / 2 - 34) < 0.6
                            && Math.abs((b.min[2] + b.max[2]) / 2 + 24) < 0.6
                            && (b.max[1] - b.min[1]) > 8);
if (!column) { console.error('✘ Säule nicht gefunden — Level geändert?'); process.exit(1); }

/* ------------------------------ Prüf-Hilfen ------------------------------ */
function segHitsBox(a, b, box, shrink) {
  const sh = shrink || 0.03;
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const mn = box.min[k] + sh, mx = box.max[k] - sh, d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) { if (a[k] <= mn || a[k] >= mx) return false; }
    else {
      let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d;
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 >= t1) return false;
    }
  }
  return true;
}
function polylineBlocked(pts) {
  for (let s = 0; s < pts.length - 1; s++)
    for (const b of boxes) if (segHitsBox(pts[s], pts[s + 1], b)) return true;
  return false;
}
/** Gültige Hand-Position: nicht in Geometrie, nicht auf dem Anker, über Boden. */
function validHand(A) {
  if (A[1] < 0.2) return false;
  if (Math.hypot(A[0] - ANCHOR[0], A[1] - ANCHOR[1], A[2] - ANCHOR[2]) < 2.0) return false;
  for (const b of boxes)
    if (A[0] > b.min[0] - 0.4 && A[0] < b.max[0] + 0.4
     && A[1] > b.min[1] - 0.4 && A[1] < b.max[1] + 0.4
     && A[2] > b.min[2] - 0.4 && A[2] < b.max[2] + 0.4) return false;
  return true;
}

/* --------------------------- Ein Orbit-Durchlauf -------------------------- */
function orbitRun(name, speed, radius, seconds) {
  const hz = 120, dt = 1 / hz;
  const S = new E.RopePathSolver(world, Object.assign({}, E.ROPE_DEFAULTS));

  /* _cornerSlide-Aufrufe zählen: das ist der Mechanismus, der ein stetiges
     „über die Ecke weiterrutschen" erzeugen soll. */
  let cornerSlideCalls = 0, cornerSlideHits = 0;
  const origCS = S._cornerSlide.bind(S);
  S._cornerSlide = function (i, prev, next, pb, nb, w) {
    cornerSlideCalls++;
    const n0 = this.wraps.length;
    const r = origCS(i, prev, next, pb, nb, w);
    if (this.wraps.length > n0) cornerSlideHits++;
    return r;
  };
  /* _atEnd-Statistik: _cornerSlide ist dahinter verriegelt. */
  let contactSteps = 0, atEndSteps = 0;
  const origUW = S._updateWraps.bind(S);
  S._updateWraps = function (d, rev, full) {
    const r = origUW(d, rev, full);
    if (full) for (const q of this.wraps) { contactSteps++; if (q._atEnd) atEndSteps++; }
    return r;
  };

  const handAt = t => {
    const a = -t * speed / radius;
    return [34 + radius * Math.sin(a), 2.2 + Math.sin(t) * 1.5, -24 + radius * Math.cos(a)];
  };

  let A = handAt(0);
  S.solve(A, ANCHOR, dt, null, anchorBox);
  S.converge();

  const r = { name, speed, radius, valid: 0, blocked: 0, firstBlocked: null,
              maxLenJump: 0, maxLenJumpAt: 0, jumpsOver50cm: 0,
              releases: 0, releasesWithJump: 0, maxWraps: 0,
              cornerSlideCalls, contactSteps: 0, atEndSteps: 0 };
  let prevLen = S.length, prevWraps = S.wraps.length;
  const N = Math.round(seconds * hz);

  for (let i = 1; i <= N; i++) {
    A = handAt(i * dt);
    S.solve(A, ANCHOR, dt, null, anchorBox);
    const t = i * dt;

    r.maxWraps = Math.max(r.maxWraps, S.wraps.length);
    if (S.wraps.length < prevWraps) {
      r.releases += prevWraps - S.wraps.length;
      if (Math.abs(S.length - prevLen) > 0.5) r.releasesWithJump++;
    }
    prevWraps = S.wraps.length;

    if (!validHand(A)) { prevLen = S.length; continue; }   // Messhygiene, s. o.
    r.valid++;

    const dLen = Math.abs(S.length - prevLen);
    if (dLen > r.maxLenJump) { r.maxLenJump = dLen; r.maxLenJumpAt = t; }
    if (dLen > 0.5) r.jumpsOver50cm++;
    prevLen = S.length;

    if (polylineBlocked(S.pts)) {
      r.blocked++;
      if (!r.firstBlocked) r.firstBlocked = { t: +t.toFixed(3), A: A.map(v => +v.toFixed(1)), wraps: S.wraps.length };
    }
  }
  r.cornerSlideCalls = cornerSlideCalls;
  r.cornerSlideHits = cornerSlideHits;
  r.contactSteps = contactSteps;
  r.atEndSteps = atEndSteps;
  r.pctBlocked = r.valid ? +(r.blocked / r.valid * 100).toFixed(2) : 0;
  return r;
}

/* ================================== Läufe ================================== */
/* Szenario 1: enger Orbit (r = 3,2 m) — Hand bleibt außerhalb der Säule, weil
   nur gültige Schritte gezählt werden.                                       */
const a1 = orbitRun('enger Orbit', 9.8, 3.2, 12);
const a2 = orbitRun('enger Orbit schnell', 20, 3.2, 12);
/* Szenario 2: weiterer Orbit (r = 4,5 m) — näher an echtem Spielverhalten. */
const b1 = orbitRun('weiter Orbit', 9.8, 4.5, 12);
const b2 = orbitRun('weiter Orbit schnell', 20, 4.5, 12);
const runs = [a1, a2, b1, b2];

console.log('\n════════════ ORBIT-MESSUNG an der Säule (Spot „Säulen-Wrap") ════════════');
console.log(' Lauf                     gültig  Polyline in Geometrie   max Längensprung   Sprünge>0,5m  Freisetzungen  _cornerSlide');
for (const r of runs) {
  console.log(` ${r.name.padEnd(22)} ${String(r.valid).padStart(6)}  ${String(r.blocked).padStart(6)} (${String(r.pctBlocked).padStart(5)} %)`
    + `   ${r.maxLenJump.toFixed(2).padStart(7)} m @${r.maxLenJumpAt.toFixed(1)}s`
    + `   ${String(r.jumpsOver50cm).padStart(6)}      ${String(r.releases).padStart(5)} (${r.releasesWithJump} m. Sprung)`
    + `   ${String(r.cornerSlideCalls).padStart(5)} Aufrufe`);
}
const totBlocked = runs.reduce((s, r) => s + r.blocked, 0);
const totValid = runs.reduce((s, r) => s + r.valid, 0);
const worstJump = Math.max(...runs.map(r => r.maxLenJump));
const csCalls = runs.reduce((s, r) => s + r.cornerSlideCalls, 0);
const csHits = runs.reduce((s, r) => s + r.cornerSlideHits, 0);
const cSteps = runs.reduce((s, r) => s + r.contactSteps, 0);
const aeSteps = runs.reduce((s, r) => s + r.atEndSteps, 0);

console.log('\n════════════ BEFUND ════════');
console.log(` Polylinie in Geometrie : ${totBlocked} von ${totValid} gültigen Schritten (${(totBlocked / totValid * 100).toFixed(1)} %)`);
console.log(` größter Längensprung   : ${worstJump.toFixed(2)} m pro Schritt (120 Hz)`);
console.log(` _cornerSlide           : ${csCalls} Aufrufe, ${csHits} Erfolge`);
console.log(` _atEnd                 : ${aeSteps} von ${cSteps} Kontakt-Schritten (${(aeSteps / Math.max(1, cSteps) * 100).toFixed(1)} %)`);

/* ============================ assertions ================================= */
/* Diese vier sind ECHTE Invarianten, die heute schon gelten müssen. */
ok(runs.every(r => r.valid > 500), 'W1: jeder Orbit-Lauf hat genug gültige Messschritte',
   runs.map(r => r.valid).join('/'));
ok(runs.every(r => Number.isFinite(r.maxLenJump)), 'W2: keine NaN/Infinity in der Pfadlänge');
ok(csCalls <= aeSteps, 'W3: _cornerSlide wird nur für Kontakte am Kantenende erwogen',
   `${csCalls} Aufrufe bei ${aeSteps} _atEnd-Schritten`);
ok(runs.every(r => r.maxWraps <= E.ROPE_DEFAULTS.wrapMaxCount), 'W4: wrapMaxCount wird nie überschritten',
   `max ${Math.max(...runs.map(r => r.maxWraps))} von ${E.ROPE_DEFAULTS.wrapMaxCount}`);

/* Diese sind der dokumentierte Defekt. XFAIL = bekannt, noch nicht behoben.
   Nach dem Fix als ok(...) mit genau diesen Grenzen übernehmen.              */
xok(totBlocked === 0, 'W5 [XFAIL] Seil läuft nie durch Geometrie',
    `${totBlocked}/${totValid} Schritte — Ziel: 0`);
xok(worstJump < 0.35, 'W6 [XFAIL] kein Längensprung über 0,35 m pro Schritt',
    `${worstJump.toFixed(2)} m — Ziel: < 0,35 m (ein Schritt = 8,3 ms)`);
xok(csHits > 0, 'W7 [XFAIL] _cornerSlide erzeugt beim Umkreisen einen Nachfolgekontakt',
    `${csHits} Erfolge bei ${csCalls} Aufrufen — Ziel: Erfolge > 0. Zwei unabhängige`
    + ` Ursachen: (a) das Gate _atEnd verlangt den Kontaktpunkt innerhalb 5 cm vom`
    + ` KantenENDE; vertikale Kanten im Level sind im Median 5,00 m lang (max 42 m),`
    + ` daher nur ${aeSteps} von ${cSteps} Kontakt-Schritten (${(aeSteps / Math.max(1, cSteps) * 100).toFixed(1)} %).`
    + ` (b) cornerSlideReach = ${E.ROPE_DEFAULTS.cornerSlideReach} m, während die`
    + ` benachbarten vertikalen Kanten der 2,6-m-Säule 5,2 m auseinanderliegen —`
    + ` selbst ein erreichter Aufruf kann die Nachbarkante nicht erreichen.`);
xok(runs.every(r => r.releasesWithJump === 0), 'W8 [XFAIL] Freisetzen einer Wicklung ohne Längensprung',
    `${runs.reduce((s, r) => s + r.releasesWithJump, 0)} von ${runs.reduce((s, r) => s + r.releases, 0)} Freisetzungen springen > 0,5 m`);

/* ============================== Ausgabe ================================== */
console.log('\n══════════════════════ ERGEBNIS ══════════════════════');
for (const [st, name, detail] of results) {
  const z = st === 'PASS' ? '✔' : st === 'XFAIL' ? '⚠' : '✘';
  console.log(` ${z} ${name}${detail ? '   ·  ' + detail : ''}`);
}
console.log(`\n ${passed} bestanden, ${failed} fehlgeschlagen, ${xfail} bekannter Defekt (XFAIL)`);
if (failed) { console.log('\n✘ Echte Invarianten verletzt.'); process.exit(1); }
console.log('\n⚠ XFAIL-Zeilen sind der dokumentierte, noch nicht behobene Defekt.');
process.exit(0);

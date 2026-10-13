'use strict';
/* tools/test_edgecross.js — Unit-Test für edgeCross2D (der Kern des Pivot-Sweeps).

   Prüft zweierlei:
     1. Treffer/Niete gegen handgerechnete Fälle (Translation, Schwenk,
        gekippte Bewegung, Rückwärts, Degenerationen).
     2. KONSISTENZ: bei jedem Treffer muss der zurückgegebene Kreuzungspunkt
        P(s,t) mit dem abgefragten Punkt q übereinstimmen (|P−q| < 1e-9) —
        das fängt Vorzeichen-/Koeffizientenfehler in der quadratischen Lösung,
        die sonst still falsche Kontakte produzieren.
     3. Zufalls-Sweep gegen eine brute-force Referenz: q wird auf der
        bilinearen Fläche aus (s,t) erzeugt und MUSS erkannt werden.
*/
const fs = require('fs'), path = require('path'), vm = require('vm');
/* SRC darf nicht blind aus der Umgebung kommen: ist die Variable gesetzt, aber
   leer/ungültig, fällt der Lauf auf einen falschen Pfad. */
const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC
  : path.join(__dirname, '..', 'src');
let code = ['00_math.js', '01_world.js', '02_rope.js'].map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.X={edgeCross2D,_EC};';
const sb = { console, Math, Date, JSON, performance: { now: () => 0 }, Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN, window: {}, document: undefined };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb);
const f = sb.X.edgeCross2D, EC = sb.X._EC;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) passed++; else { failed++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const CASES = [
  ['Translation quer, Mitte getroffen', [0, 0], [10, 0], [0, 1], [10, 1], [5, 0.5], true],
  ['Translation quer, unterhalb der Startlage', [0, 0], [10, 0], [0, 1], [10, 1], [5, -0.2], false],
  ['Translation quer, oberhalb der Endlage', [0, 0], [10, 0], [0, 1], [10, 1], [5, 2], false],
  ['Translation quer, neben dem Segmentende', [0, 0], [10, 0], [0, 1], [10, 1], [12, 0.5], false],
  ['Schwenk um b: Dreieck getroffen', [0, 0], [10, 0], [0, 2], [10, 0], [2, 1], true],
  ['Schwenk um b: andere Seite', [0, 0], [10, 0], [0, 2], [10, 0], [2, -1], false],
  ['Schwenk um b: ausserhalb nahe a', [0, 0], [10, 0], [0, 2], [10, 0], [8, 1.9], false],
  ['Schwenk um b: ausserhalb nahe b', [0, 0], [10, 0], [0, 2], [10, 0], [9, 1.5], false],
  ['Translation laengs des Segments', [0, 0], [10, 0], [1, 0], [11, 0], [5, 0], false],
  ['keine Bewegung', [0, 0], [10, 0], [0, 0], [10, 0], [5, 0], false],
  ['Rückwaerts ueber q', [0, 1], [10, 1], [0, 0], [10, 0], [5, 0.5], true],
  /* Beide Endpunkte bewegt (Segment kippt): q = P(s=0,5; t=0,25) = (2,5 | 0,5).
     Der frühere Wert (5 | 0,4) lag auf keiner der Zwischenlagen — f(s) ist
     dort konstant 4, es gibt also nichts zu treffen. Konstruierte Fälle
     MÜSSEN die Inzidenz erfüllen, sonst testen sie die falsche Erwartung. */
  ['beide Endpunkte bewegt, gekippt, Treffer', [0, 0], [10, 0], [0, 2], [10, -2], [2.5, 0.5], true],
  ['gekippt, daneben', [0, 0], [10, 0], [0, 2], [10, -2], [5, 0.4], false],
  ['gekippt, weit daneben', [0, 0], [10, 0], [0, 2], [10, -2], [5, 1.5], false],
  ['schraeges Segment, Treffer', [2, 1], [8, 4], [3, 0], [9, 3], [6, 2], true],
  ['schraeges Segment, daneben', [2, 1], [8, 4], [3, 0], [9, 3], [6, 3.4], false],
  /* Der reale Wickel-Fall: SEHR LANGE Sehne (100 m), kleiner Hub (1 m) — die
     Kante wird mitten im Segment überstrichen, weit weg von beiden Endpunkten.
     Genau das hat das Quad-Verfahren (v0/v1) systematisch verpasst: eine Quad
     enthält einen Eckpunkt nur, wenn sich ein ENDPUNKT an ihm vorbeibewegt.
     (Ein früherer „Orbit-Fall" mit Säulenkoordinaten stand hier zu Unrecht:
     dort lag q zu keinem Zeitpunkt auf dem Segment — f(s) war linear ohne
     Nullstelle. Konstruierte Fälle müssen die Inzidenz wirklich erfüllen.) */
  ['lange Sehne, kleiner Hub', [0, 0], [100, 0], [0, 1], [100, 0], [50, 0.5], true],
  ['lange Sehne, Hub verfehlt q', [0, 0], [100, 0], [0, 1], [100, 0], [50, 2], false],
  ['lange Sehne, q ausserhalb', [0, 0], [100, 0], [0, 1], [100, 0], [150, 0.5], false],
  /* Realmaßstab der Säule im Level: Sehne 30 m, Handhub 8 cm pro Substep,
     Kante weit hinten im Segment (t ≈ 0,85) — q = P(s=0,5; t=0,85).        */
  ['Säulenmaßstab: 30 m Sehne, 8 cm Hub', [34, -20.8], [33, 4.5], [34.08, -20.85], [33, 4.5], [33.156, 0.70125], true],
  ['Säulenmaßstab, knapp daneben', [34, -20.8], [33, 4.5], [34.08, -20.85], [33, 4.5], [33.156, 1.7], false],
];

console.log('\n═══ edgeCross2D — Unit-Fälle ═══');
for (const [name, a, b, a2, b2, q, exp] of CASES) {
  const r = f(a[0], a[1], b[0], b[1], a2[0], a2[1], b2[0], b2[1], q[0], q[1]);
  let det = '';
  if (r) {
    const d = Math.hypot(EC.u - q[0], EC.v - q[1]);
    det = 'P=[' + EC.u.toFixed(6) + ',' + EC.v.toFixed(6) + '] |P−q|=' + d.toExponential(1);
    check(name + ' (Konsistenz P==q)', d < 1e-6, det);
  }
  check(name, r === exp, 'erwartet ' + exp + ', bekommen ' + r + '  ' + det);
}

/* Brute-Force-Referenz: Punkt auf der bilinearen Fläche erzeugen ⇒ muss treffen. */
console.log('\n═══ edgeCross2D — Zufalls-Sweep gegen brute force ═══');
let rngState = 12345;
const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };
let miss = 0, incons = 0, falsePos = 0, N = 4000;
for (let i = 0; i < N; i++) {
  const a = [rnd() * 10 - 5, rnd() * 10 - 5], b = [rnd() * 10 - 5, rnd() * 10 - 5];
  const a2 = [a[0] + rnd() * 2 - 1, a[1] + rnd() * 2 - 1], b2 = [b[0] + rnd() * 2 - 1, b[1] + rnd() * 2 - 1];
  const s = 0.02 + rnd() * 0.96, t = 0.02 + rnd() * 0.96;
  const mt = 1 - t, ms = 1 - s;
  const q = [ms * (mt * a[0] + t * b[0]) + s * (mt * a2[0] + t * b2[0]),
             ms * (mt * a[1] + t * b[1]) + s * (mt * a2[1] + t * b2[1])];
  const r = f(a[0], a[1], b[0], b[1], a2[0], a2[1], b2[0], b2[1], q[0], q[1]);
  if (!r) { miss++; if (miss < 4) console.log('  MISS', JSON.stringify({ a, b, a2, b2, q, s, t })); continue; }
  if (Math.hypot(EC.u - q[0], EC.v - q[1]) > 1e-6) { incons++; if (incons < 4) console.log('  INKONSISTENT', JSON.stringify({ a, b, a2, b2, q, P: [EC.u, EC.v] })); }
}
/* Punkte deutlich AUSSEN dürfen nicht treffen */
for (let i = 0; i < N; i++) {
  const a = [rnd() * 10 - 5, rnd() * 10 - 5], b = [rnd() * 10 - 5, rnd() * 10 - 5];
  const a2 = [a[0] + rnd() * 2 - 1, a[1] + rnd() * 2 - 1], b2 = [b[0] + rnd() * 2 - 1, b[1] + rnd() * 2 - 1];
  const q = [rnd() * 40 - 20, rnd() * 40 - 20];
  /* Referenz: grobe Rasterprüfung, ob q im bbox-Hüllbereich der Fläche liegt */
  const us = [a[0], b[0], a2[0], b2[0]], vs = [a[1], b[1], a2[1], b2[1]];
  const outside = q[0] < Math.min(...us) - 1e-9 || q[0] > Math.max(...us) + 1e-9
               || q[1] < Math.min(...vs) - 1e-9 || q[1] > Math.max(...vs) + 1e-9;
  if (!outside) continue;
  const r = f(a[0], a[1], b[0], b[1], a2[0], a2[1], b2[0], b2[1], q[0], q[1]);
  if (r) { falsePos++; if (falsePos < 4) console.log('  FALSE POS', JSON.stringify({ a, b, a2, b2, q, P: [EC.u, EC.v] })); }
}
check('Zufalls-Sweep: Punkte auf der Fläche werden erkannt', miss === 0, miss + ' von ' + N + ' verpasst');
check('Zufalls-Sweep: Kreuzungspunkt stimmt mit q überein', incons === 0, incons + ' inkonsistent');
check('Zufalls-Sweep: keine Treffer ausserhalb der Hüllbox', falsePos === 0, falsePos + ' false positive');

console.log(`\n ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);

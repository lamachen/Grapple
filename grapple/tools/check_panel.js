/* =============================================================================
   tools/check_panel.js — Konsistenzprüfung des Tuning-Panels
   Ein Slider ist genau dann ehrlich, wenn
     1. sein Default im Bereich min..max liegt        (sonst klemmt der Browser),
     2. sein Default auf dem Schritt-Raster liegt      (sonst rundet der Browser),
     3. die Anzeige den echten Wert zeigt              (Einheiten wie ° einbezogen).
   Ist eine der Bedingungen verletzt, steht der Regler woanders als die Physik —
   und der echte Wert ist per Hand nicht mehr erreichbar.
   Außerdem: jeder Schalter muss auf einem echten booleschen Feld sitzen (Defekt #45).
   ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(process.cwd(), 'src');
const FILES = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js', '06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.EXP = { World, Rope, Player, Hook, DEG };';
const sandbox = { console, Math, Date, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN, window: {}, document: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox); vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const E = sandbox.EXP;

const world = new E.World();
const rope = new E.Rope(world, {}), player = new E.Player(world, {}), hook = new E.Hook(world, {});
const gameSrc = fs.readFileSync(path.join(SRC, '07_game.js'), 'utf8');

/* Panel-Spec + Anzeigegenauigkeit aus dem Quelltext lesen (wie der Browser sie sieht) */
const rows = [];
const re = /^\s*\['([^']+)'\s*,\s*'([^']*)'\s*,\s*(-?[\d.eE+]+)\s*,\s*(-?[\d.eE+]+)\s*,\s*([\d.eE+]+)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s*\]/gm;
let m;
while ((m = re.exec(gameSrc)))
  rows.push({ p: m[1], label: m[2], min: +m[3], max: +m[4], step: +m[5],
              unit: m[6] === 'DEG' ? E.DEG : (m[6] ? NaN : 1) });
const digitsSrc = gameSrc.match(/Math\.ceil\(-Math\.log10\(step\)\)/);

function resolve(p) {
  const root = p.startsWith('rope.') ? rope : p.startsWith('player.') ? player
             : p.startsWith('hook.') ? hook : p.startsWith('world.') ? world : null;
  if (!root) { const g = gameSrc.match(new RegExp('this\\.' + p + '\\s*=\\s*(-?[\\d.eE+]+)')); return g ? +g[1] : undefined; }
  return p.split('.').slice(1).reduce((o, k) => (o == null ? o : o[k]), root);
}
/* Verhalten von <input type="range">: auf das Raster runden, dann klemmen */
const knob = (v, min, max, step) =>
  Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));

let bad = 0;
for (const r of rows) {
  const cur = resolve(r.p);
  if (cur === undefined || isNaN(r.unit)) { console.log(`  ? ${r.p} — nicht auflösbar`); bad++; continue; }
  const shown = cur / r.unit;                       // was im Regler stehen soll
  const k = knob(shown, r.min, r.max, r.step);       // was der Browser daraus macht
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(r.step))));
  const label = parseFloat(shown.toFixed(digits));   // was daneben angezeigt wird
  const errs = [];
  if (shown < r.min || shown > r.max) errs.push(`Default ${shown} liegt außerhalb [${r.min}, ${r.max}] → Regler klemmt auf ${k}`);
  else if (Math.abs(k - shown) > 1e-9) errs.push(`Default ${shown} nicht auf dem Raster ${r.step} → Regler springt auf ${k}`);
  if (Math.abs(label - shown) > 1e-9) errs.push(`Anzeige ${label} ≠ Wert ${shown}`);
  if (Math.abs(k * r.unit - cur) > 1e-9) errs.push(`Reglerwert ${k * r.unit} ≠ Physikwert ${cur}`);
  if (errs.length) { bad++; console.log(`  ✘ ${r.p}  (${r.label})`); errs.forEach(e => console.log(`      ${e}`)); }
}
/* Schalter (A/B + Anzeige): jeder muss auf einem echten, booleschen Feld sitzen —
   ein toter Schalter ist genau Defekt #45. */
const swRows = [];
const reSw = /^\s*\['([\w.$]+)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/gm;
while ((m = reSw.exec(gameSrc))) swRows.push({ p: m[1], label: m[2] });

let swBad = 0;
for (const r of swRows) {
  let v;
  if (r.p.includes('.')) v = resolve(r.p);
  else v = new RegExp('this\\.' + r.p + '\\b').test(gameSrc) ? false : undefined;   // Game-Feld
  if (v === undefined || typeof v !== 'boolean') {
    swBad++; console.log(`  ✘ Schalter ${r.p} (${r.label}) — kein boolesches Feld, wäre wirkungslos`);
  }
}
console.log(`${rows.length} Slider + ${swRows.length} Schalter geprüft` +
            (digitsSrc ? '' : ' — WARNUNG: Anzeigegenauigkeit nicht gefunden') + ': ' +
            (bad || swBad ? `${bad + swBad} fehlerhaft` : 'alle zeigen und erreichen ihren echten Wert'));
process.exit(bad || swBad || !digitsSrc ? 1 : 0);

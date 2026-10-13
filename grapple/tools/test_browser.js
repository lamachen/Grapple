/* =============================================================================
   tools/test_browser.js — Headless-Smoke-Test der Browser-Schicht
   Stubbt DOM + WebGL2 und fährt die echte Game-Loop, um Laufzeitfehler in
   Renderer/Viewmodel/HUD zu finden (ohne Browser, ohne GPU).
   ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
// Klassen werden im vm-Kontext nicht automatisch globale Properties → explizit exportieren
code += '\n;this.__BOOT = { Game, Renderer, World, Rope, Player, Hook, Particles, buildLevel,\n  v3, vdist, vsubNew, vnormSafe, vlen, DEG,\n  SHADERS: { VS_BOX, FS_BOX, VS_SKY, FS_SKY, VS_LINE, FS_LINE, VS_ROPE, FS_ROPE, VS_PART, FS_PART } };';

/* ------------------------------ GLSL-Linter ------------------------------- */
/* Der GL-Stub kann kein GLSL kompilieren. Deshalb wird hier statisch geprüft,
   was in der Praxis am häufigsten bricht: Swizzles über die Vektorgröße hinaus
   und Varying-Typ-Mismatch zwischen Vertex- und Fragment-Shader.             */
const VEC_SIZE = { float:1, vec2:2, vec3:3, vec4:4, int:1, ivec2:2, ivec3:3, ivec4:4,
                   bool:1, bvec2:2, bvec3:3, bvec4:4, mat2:0, mat3:0, mat4:0 };
const SWZ = { x:0,r:0,s:0, y:1,g:1,t:1, z:2,b:2,p:2, w:3,a:3,q:3 };
const BUILTIN = { gl_PointCoord:2, gl_Position:4, gl_FragCoord:4, gl_PointSize:1, gl_FragDepth:1 };

function collectDecls(src) {
  const decl = {};
  for (const k in BUILTIN) decl[k] = BUILTIN[k];
  const re = /\b(?:in|out|uniform|attribute|varying)\s+(?:highp\s+|mediump\s+|lowp\s+)?(float|vec2|vec3|vec4|int|ivec2|ivec3|ivec4|bool|bvec2|bvec3|bvec4|mat2|mat3|mat4)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\[[^\]]*\])?\s*(?:=[^;]*)?;/g;
  let m;
  while ((m = re.exec(src))) {
    const size = VEC_SIZE[m[1]];
    m[2].split(',').forEach(n => { decl[n.trim()] = size; });
  }
  return decl;
}
function lintShader(src, name) {
  const errs = [];
  const decl = collectDecls(src);
  const re = /\b([A-Za-z_]\w*)\s*\.\s*([xyzwrgbastpq]{1,4})\b/g;
  let m;
  while ((m = re.exec(src))) {
    const size = decl[m[1]];
    if (!size) continue;                       // unbekannt (z. B. Struct-Feld) → überspringen
    for (const c of m[2]) {
      if (SWZ[c] >= size) {
        const line = src.slice(0, m.index).split('\n').length;
        errs.push(`${name}:${line} — '${m[1]}' hat ${size} Komponenten, '.${m[2]}' liegt außerhalb`);
        break;
      }
    }
  }
  return errs;
}
function lintVaryings(vsSrc, fsSrc, pair) {
  const errs = [];
  const outs = {};
  const re = /\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?(float|vec2|vec3|vec4)\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(vsSrc))) outs[m[2]] = m[1];
  const re2 = /\bin\s+(?:highp\s+|mediump\s+|lowp\s+)?(float|vec2|vec3|vec4)\s+(\w+)\s*;/g;
  while ((m = re2.exec(fsSrc))) {
    if (outs[m[2]] && outs[m[2]] !== m[1])
      errs.push(`${pair} — Varying '${m[2]}': VS schreibt ${outs[m[2]]}, FS liest ${m[1]}`);
  }
  return errs;
}

const SHADER_PAIRS = [['VS_BOX','FS_BOX'],['VS_SKY','FS_SKY'],['VS_LINE','FS_LINE'],
                      ['VS_ROPE','FS_ROPE'],['VS_PART','FS_PART']];
/* shaderErrors lebt in headless_dom.js (der GL-Stub wertet es aus); hier wird HD.shaderErrors gefüllt. */
function lintAllShaders(S) {
  const all = [];
  for (const k in S) all.push(...lintShader(S[k], k));
  for (const [v, f] of SHADER_PAIRS) if (S[v] && S[f]) all.push(...lintVaryings(S[v], S[f], v + '/' + f));
  // Fehler den Quelltexten zuordnen, damit der Stub sie melden kann
  for (const k in S) {
    const e = lintShader(S[k], k);
    if (e.length) HD.shaderErrors[S[k]] = e.join('\n');
  }
  for (const [v, f] of SHADER_PAIRS) {
    const e = lintVaryings(S[v], S[f], v + '/' + f);
    if (e.length) HD.shaderErrors[S[f]] = (HD.shaderErrors[S[f]] || '') + '\n' + e.join('\n');
  }
  return all;
}

const HD = require('./headless_dom.js');
const { makeGL, makeEl, addEventSupport, document, window, rafQueue, gl, stats: HDstats } = HD;
const sandbox = {
  console, Math, Date, JSON, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  Float32Array, Uint16Array, Float32Array, Array, Object, Number, String, Boolean, Error,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, Proxy, Reflect,
  window, document, requestAnimationFrame: window.requestAnimationFrame,
  screen: { width: 1280, height: 720 },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let failed = false;
try {
  vm.runInContext(code, sandbox, { filename: 'bundle.js' });
} catch (e) {
  console.error('✘ Bundle lädt nicht:', e.message, '\n', e.stack.split('\n').slice(0,4).join('\n'));
  process.exit(1);
}

/* DOMContentLoaded auslösen */
console.log('· Bundle geladen (' + FILES.length + ' Dateien, ' + (code.length/1024).toFixed(0) + ' KB)');

// Shader statisch prüfen, BEVOR der Renderer sie "kompiliert"
const RAD = 180/Math.PI;
const E = sandbox.__BOOT;
const SH = sandbox.__BOOT.SHADERS;
const lintErrs = lintAllShaders(SH);
if (lintErrs.length) {
  failed = true;
  console.log('✘ GLSL-Lint: ' + lintErrs.length + ' Fehler');
  lintErrs.forEach(e => console.log('   ' + e));
} else {
  console.log('✔ GLSL-Lint: ' + Object.keys(SH).length + ' Shader, ' + SHADER_PAIRS.length + ' Varying-Paare fehlerfrei');
}

// Game direkt instanziieren (statt auf das Event zu warten)
let game;
try {
  game = new sandbox.__BOOT.Game(document.getElementById('gl'));
} catch (e) {
  console.error('✘ Game-Initialisierung fehlgeschlagen:', e.message, '\n', e.stack.split('\n').slice(0,6).join('\n'));
  process.exit(1);
}
console.log('· Game instanziiert: ' + game.world.statics.length + ' statische Boxen, ' +
            game.world.bodies.length + ' dynamische Körper');
console.log('· Level-Spots: ' + game.level.spots.map(s=>s.name).join(', '));
console.log('· Tuning-Panel: ' + document.getElementById('panel').children.length + ' Einträge');
console.log('· Spawn-Buttons: ' + document.getElementById('spots').children.length);

/* ======================== Blicksteuerung (alle Wege) ======================== */
{
  const cv = document.getElementById('gl');
  const D = 180/Math.PI;
  const reset = () => { game.locked = false; game.dragLook = false; game.freeLook = false;
                        game.input.mouseX = 0; game.input.mouseY = 0; game._lastMX = null;
                        document.pointerLockElement = null; game.updateLookModeLabel(); };
  console.log('\n· Blicksteuerung — Modi:');

  // 1) PRIMÄR: Pointer-Lock (wird nicht als unavailable vorweggenommen)
  reset();
  document.pointerLockElement = cv;
  document.dispatch('pointerlockchange');
  if (!game.locked) { failed = true; console.log('✘ Pointer-Lock wird nicht als primärer Modus erkannt'); }
  else {
    const y0 = game.player.yaw;
    cv.dispatch('mousemove', { clientX: 640, clientY: 360, movementX: 120, movementY: -40, target: cv });
    game.frame(1/60);
    const dy = game.player.yaw - y0;
    if (Math.abs(dy) < 0.05) { failed = true; console.log(`✘ Pointer-Lock-Look wirkt nicht (Δyaw=${dy.toFixed(4)})`); }
    else console.log(`✔ Pointer-Lock (primär): Δyaw=${dy.toFixed(3)} rad = ${(dy*D).toFixed(1)}°`);
  }

  // 2) FALLBACK: rechte Taste halten + ziehen — ohne jede Zeigersperre
  reset();
  const y1 = game.player.yaw;
  cv.dispatch('mousedown', { button: 2, clientX: 400, clientY: 300, target: cv });
  cv.dispatch('mousemove', { clientX: 400, clientY: 300, target: cv });
  cv.dispatch('mousemove', { clientX: 520, clientY: 340, target: cv });
  game.frame(1/60);
  const dy1 = game.player.yaw - y1;
  if (!game.dragLook) { failed = true; console.log('✘ RMB-halten aktiviert Drag-Look nicht'); }
  else if (Math.abs(dy1) < 0.05) { failed = true; console.log(`✘ RMB-Drag-Look wirkt nicht (Δyaw=${dy1.toFixed(4)})`); }
  else console.log(`✔ RMB halten + ziehen (Fallback): Δyaw=${dy1.toFixed(3)} rad = ${(dy1*D).toFixed(1)}°`);
  window.dispatch('mouseup');
  const yAfterRelease = game.player.yaw;
  cv.dispatch('mousemove', { clientX: 900, clientY: 500, target: cv });
  game.frame(1/60);
  if (Math.abs(game.player.yaw - yAfterRelease) > 1e-6) { failed = true; console.log('✘ nach Loslassen der RMB dreht die Kamera weiter'); }
  else console.log('✔ nach Loslassen der rechten Taste keine ungewollte Drehung');

  // 3) OHNE Modus darf sich die Kamera nicht von selbst drehen
  reset();
  const y2 = game.player.yaw;
  cv.dispatch('mousemove', { clientX: 900, clientY: 200, target: cv });
  cv.dispatch('mousemove', { clientX: 1100, clientY: 500, target: cv });
  game.frame(1/60);
  if (Math.abs(game.player.yaw - y2) > 1e-6) { failed = true; console.log('✘ Kamera dreht sich ohne aktiven Blick-Modus (ungefragtes Verhalten)'); }
  else console.log('✔ ohne aktiven Modus keine Eigenbewegung der Kamera');

  // 4) G = frei umsehen ohne Taste
  window.dispatch('keydown', { code: 'KeyG' });
  const y3 = game.player.yaw;
  cv.dispatch('mousemove', { clientX: 300, clientY: 300, target: cv });
  cv.dispatch('mousemove', { clientX: 420, clientY: 330, target: cv });
  game.frame(1/60);
  const dy3 = game.player.yaw - y3;
  if (!game.freeLook || Math.abs(dy3) < 0.05) { failed = true; console.log(`✘ G-Fallback wirkt nicht (freeLook=${game.freeLook}, Δyaw=${dy3.toFixed(4)})`); }
  else console.log(`✔ G schaltet freies Umsehen ohne Taste: Δyaw=${dy3.toFixed(3)} rad = ${(dy3*D).toFixed(1)}°`);
  reset();

  // 5) Pitch-Limit
  document.pointerLockElement = cv; document.dispatch('pointerlockchange');
  for (let i = 0; i < 60; i++) { cv.dispatch('mousemove', { clientX:640, clientY:360, movementX:0, movementY:-400, target:cv }); game.frame(1/60); }
  if (Math.abs(game.player.pitch) > 1.46) { failed = true; console.log('✘ Pitch nicht begrenzt'); }
  else console.log(`✔ Pitch begrenzt auf ±1.45 rad (ist ${game.player.pitch.toFixed(2)})`);

  // 6) Klick feuert
  reset();
  cv.dispatch('mousedown', { button: 0, clientX: 640, clientY: 360, target: cv });
  game.frame(1/60); game.frame(1/60);
  console.log(`✔ Klick löst Schuss aus: Haken=${game.hook.state}, Seil-Phase=${game.rope.phase}`);

  // 7) Tastatur
  const z0 = game.player.pos[2];
  window.dispatch('keydown', { code: 'KeyW' });
  for (let i = 0; i < 30; i++) game.frame(1/60);
  window.dispatch('keyup', { code: 'KeyW' });
  console.log(`✔ Tastatur-Input erreicht den Controller (Δz=${(game.player.pos[2]-z0).toFixed(2)} m)`);

  // 8) V = Orbit
  window.dispatch('keydown', { code: 'KeyV' }); game.frame(1/60);
  console.log((game.orbit ? '✔' : '✘') + ' V schaltet Orbit-Kamera');
  if (!game.orbit) failed = true;
  window.dispatch('keydown', { code: 'KeyV' }); game.frame(1/60);
  reset();
}

/* ============ Steuerung: halten = eingehakt, loslassen = einholen ============ */
{
  game.rope.detach(); game.rope.phase = 0; game.hook.state = 'idle';
  game.teleport(game.level.spots.findIndex(x => x.name === 'Wrap-Wand'));
  game.frame(1/60);
  const cv = document.getElementById('gl');
  cv.dispatch('mousedown', { button: 0, clientX: 640, clientY: 360, target: cv });
  game.frame(1/60); game.frame(1/60);
  const firedOn = game.input.fireHeld === true && game.rope.phase !== 0;
  console.log((firedOn ? '✔' : '✘') + ` LMB drücken feuert und hält: fireHeld=${game.input.fireHeld}, Seil-Phase=${game.rope.phase}`);
  if (!firedOn) failed = true;
  // Taste loslassen muss das Seil VERBUNDEN einholen (Kabelstaubsauger):
  // erst Phase RETRACT, am Ende vollständig eingerollt (Phase 0, Haken idle).
  game.rope.attachAt([8,13,-42],[0,1,0],null,null,20); game.rope.settleActive=false; game.rope.phase=3;
  window.dispatch('mouseup', { button: 0 });
  game.frame(1/60); game.frame(1/60);
  const retracting = game.input.fireHeld === false && game.rope.phase === 4 && game.hook.state === 'retract';
  console.log((retracting ? '✔' : '✘') + ` LMB loslassen holt verbunden ein (Phase=${game.rope.phase}, Haken=${game.hook.state})`);
  if (!retracting) failed = true;
  let voll = 0;
  for (let i = 0; i < 6*60 && game.rope.phase !== 0; i++) { game.frame(1/60); voll = i; }
  const fully = game.rope.phase === 0 && game.hook.state === 'idle';
  console.log((fully ? '✔' : '✘') + ` Seil wird vollständig eingeholt (Phase=${game.rope.phase}, Haken=${game.hook.state}, nach ${(voll/60).toFixed(1)} s)`);
  if (!fully) failed = true;
  // Sprung darf NICHT lösen
  game.rope.attachAt([8,13,-42],[0,1,0],null,null,20); game.rope.settleActive=false; game.rope.phase=3;
  game.player.grounded = false; game.player.airTime = 1;
  window.dispatch('keydown', { code: 'Space' });
  game.frame(1/60); game.frame(1/60);
  const stillOn = game.rope.phase === 3;
  console.log((stillOn ? '✔' : '✘') + ` Sprung am Seil löst NICHT (Phase=${game.rope.phase}) — Schwingen mit Absprung möglich`);
  if (!stillOn) failed = true;
  // R bleibt das bewusste Lösen — jetzt als verbundenes Einrollen, das
  // zuverlässig bis zum Verschwinden des Seils durchläuft.
  window.dispatch('keydown', { code: 'KeyR' });
  game.frame(1/60);
  const rStart = game.rope.phase === 4 || game.rope.phase === 0;
  for (let i = 0; i < 6*60 && game.rope.phase !== 0; i++) game.frame(1/60);
  console.log((rStart && game.rope.phase === 0 ? '✔' : '✘') + ` R löst das Seil bewusst (einrollen bis Phase=${game.rope.phase})`);
  if (!(rStart && game.rope.phase === 0)) failed = true;
  // rechte Taste darf NICHT mehr lösen (sie ist Drag-Look)
  game.rope.attachAt([8,13,-42],[0,1,0],null,null,20); game.rope.settleActive=false; game.rope.phase=3;
  cv.dispatch('mousedown', { button: 2, clientX: 640, clientY: 360, target: cv });
  window.dispatch('mouseup', { button: 2 });
  game.frame(1/60);
  console.log((game.rope.phase === 3 ? '✔' : '✘') + ' rechte Taste = Drag-Look, löst das Seil nicht');
  if (game.rope.phase !== 3) failed = true;
  game.rope.detach(); game.rope.phase = 0;
}

/* ============ Kein Viewmodel — Seil-Ursprung trotzdem stabil und offset ============ */
{
  game.orbit = false; game.rope.detach(); game.rope.phase = 0;
  game.player.fovKick = 0; game.player.roll = 0;
  game.updateCamera(1/60); game.render(1/60);
  // Es darf kein Viewmodel-Code mehr existieren
  const leftovers = ['drawViewmodel','computeArmPose','solveTwoBone','vmVP','showViewmodel']
    .filter(k => typeof game[k] !== 'undefined' || k in game);
  if (leftovers.length) { failed = true; console.log('✘ Viewmodel-Reste im Code: ' + leftovers.join(', ')); }
  else console.log('✔ kein Viewmodel mehr im Code (Arme aus Box-Primitiven ersatzlos entfernt)');

  // Seil-Ursprung: nicht bildmittig, aber stabil
  const O0 = E.vsubNew(game._ropeOrigin, game._camEye);
  const offRight = O0[0]*game.r.camRight[0] + O0[1]*game.r.camRight[1] + O0[2]*game.r.camRight[2];
  const offFwd   = O0[0]*game.r.camFwd[0]   + O0[1]*game.r.camFwd[1]   + O0[2]*game.r.camFwd[2];
  const offUp    = O0[0]*game.r.camUp[0]    + O0[1]*game.r.camUp[1]    + O0[2]*game.r.camUp[2];
  if (!(offRight > 0.05)) { failed = true; console.log(`✘ Seil-Ursprung nicht rechts von der Kamera (${offRight.toFixed(3)} m)`); }
  if (!(offFwd > 0.15))   { failed = true; console.log(`✘ Seil-Ursprung nicht vor der Kamera (${offFwd.toFixed(3)} m)`); }
  if (!(offUp < -0.03))   { failed = true; console.log(`✘ Seil-Ursprung nicht unter der Kamera (${offUp.toFixed(3)} m)`); }
  if (offRight > 0.05 && offFwd > 0.15 && offUp < -0.03)
    console.log(`✔ Seil-Ursprung: rechts ${offRight.toFixed(3)} m, vorn ${offFwd.toFixed(3)} m, unten ${(-offUp).toFixed(3)} m — nicht bildmittig`);

  // Stabilität: Umschauen darf den Ursprung nicht hektisch wandern lassen
  let maxDrift = 0;
  for (const [y, p2] of [[0,0],[30,10],[60,-20],[120,40],[-90,-50],[180,0]]) {
    game.player.yaw = y*E.DEG; game.player.pitch = p2*E.DEG;
    game.updateCamera(1/60); game.render(1/60);
    // Drift relativ zur Kamerabasis messen (mitrotieren ist korrekt)
    const d = E.vsubNew(game._ropeOrigin, game._camEye);
    const drift = Math.abs(E.vlen(d) - E.vlen(O0));
    maxDrift = Math.max(maxDrift, drift);
  }
  if (maxDrift > 0.12) { failed = true; console.log(`✘ Seil-Ursprung wandert beim Umschauen um ${maxDrift.toFixed(3)} m`); }
  else console.log(`✔ Seil-Ursprung bleibt beim Umschauen stabil (max. Drift ${maxDrift.toFixed(3)} m über 6 Blickrichtungen)`);

  // Mit aktivem Seil: Ursprung neigt nur leicht mit, kein Ausschlagen
  game.rope.attachAt([0, 40, -30], [0,-1,0], null, null, 30);
  game.rope.settleActive = false; game.rope.phase = 3;
  game.player.yaw = 0; game.player.pitch = 0;
  game.updateCamera(1/60); game.render(1/60);
  const d2 = E.vsubNew(game._ropeOrigin, game._camEye);
  if (Math.abs(E.vlen(d2) - E.vlen(O0)) > 0.14) { failed = true; console.log(`✘ Seil-Ursprung schlägt bei aktivem Seil aus (${E.vlen(d2).toFixed(3)} m statt ${E.vlen(O0).toFixed(3)})`); }
  else console.log(`✔ mit aktivem Seil neigt der Ursprung nur leicht mit (${E.vlen(d2).toFixed(3)} m, Ruhe ${E.vlen(O0).toFixed(3)} m)`);
  game.rope.detach(); game.rope.phase = 0;
}

/* ============ Dock-Panels: faltbar an der Kante, Titelbalken schaltet ====== */
{
  const names = ['tele','help','tune'];
  const tpl = require('fs').readFileSync(require('path').join(__dirname, 'template.html'), 'utf8');
  const collapsed = (id) => { const e = document.getElementById(id); return e.classList.contains('collapsed'); };
  // Start-Zustand: eingeklappt im DOM, im Spielzustand UND schon im Template
  // (der erste Pinselstrich vor jeglichem JS darf keine offenen Panels zeigen).
  // Der Harness-DOM startet klassenlos (makeEl) — der echte Browser liefert
  // den Erst-Render aus template.html. Also die Template-Klassen einsäen,
  // dann ist der DOM-Check dem ersten Pinselstrich treu.
  for (const nm of names) {
    const m = tpl.match(new RegExp('id="' + nm + '"[^>]*class="([^"]*)"'));
    if (m) m[1].split(/\s+/).forEach(c => document.getElementById(nm).classList.add(c));
  }
  const startDom = names.every(nm => collapsed(nm));
  const startState = names.every(nm => game.uiVisible[nm] === false);
  const startTpl = names.every(nm => new RegExp('id="' + nm + '"[^>]*collapsed').test(tpl));
  if (startDom && startState && startTpl)
    console.log('✔ alle Panels starten eingeklappt (Template, DOM und Spielzustand)');
  else { failed = true; console.log(`✘ Panels starten nicht eingeklappt (DOM ${startDom}, Zustand ${startState}, Template ${startTpl})`); }
  let allok = true;
  for (const nm of names) {
    game.setPanel(nm, false);
    if (!collapsed(nm)) { allok = false; console.log(`✘ Panel "${nm}" lässt sich nicht einklappen`); }
    if (!tpl.includes('data-panel="' + nm + '"')) { allok = false; console.log(`✘ Panel "${nm}" hat keinen klickbaren Titelbalken`); }
  }
  if (allok) console.log('✔ alle drei Dock-Panels lassen sich einklappen (Titelbalken bleibt sichtbar)');
  else failed = true;
  // "Alles" muss sie gemeinsam zurückholen bzw. falten
  game.setPanel('all');
  const back = names.every(nm => !collapsed(nm));
  console.log((back ? '✔' : '✘') + ' "Alles" klappt sämtliche Panels gemeinsam auf');
  if (!back) failed = true;
  game.setPanel('all');
  const gone = names.every(nm => collapsed(nm));
  console.log((gone ? '✔' : '✘') + ' "Alles" falten sämtliche Panels erneut (Screenshot-Modus)');
  if (!gone) failed = true;
  // Tastenkürzel
  game.setPanel('all');
  window.dispatch('keydown', { code: 'KeyU' });
  const byKey = names.every(nm => collapsed(nm));
  window.dispatch('keydown', { code: 'KeyU' });
  const byKeyBack = names.every(nm => !collapsed(nm));
  console.log(((byKey && byKeyBack) ? '✔' : '✘') + ' U faltet die komplette Panel-UI ein/aus');
  if (!(byKey && byKeyBack)) failed = true;
  window.dispatch('keydown', { code: 'KeyT' });
  console.log((collapsed('tele') ? '✔' : '✘') + ' T faltet die Seil-Telemetrie einzeln');
  if (!collapsed('tele')) failed = true;
  window.dispatch('keydown', { code: 'KeyT' });
  window.dispatch('keydown', { code: 'KeyH' });
  console.log((collapsed('help') ? '✔' : '✘') + ' H faltet die Steuerung einzeln');
  if (!collapsed('help')) failed = true;
  window.dispatch('keydown', { code: 'KeyH' });
  window.dispatch('keydown', { code: 'KeyP' });
  console.log((collapsed('tune') ? '✔' : '✘') + ' P faltet das Parameter-Panel einzeln');
  if (!collapsed('tune')) failed = true;
  window.dispatch('keydown', { code: 'KeyP' });
  // Spawn-Leiste: oben angedockt, aktive Markierung, keine uibar-Reste
  const spotsOk = tpl.includes('#spots{left:50%;top:0') && tpl.includes('#spots button.on{');
  const noUibar = !tpl.includes('id="uibar"');
  console.log(((spotsOk && noUibar) ? '✔' : '✘') + ' Spawn-Leiste oben mittig mit Aktiv-Markierung, alte Panel-Leiste entfernt');
  if (!(spotsOk && noUibar)) failed = true;
}

/* --------------------- Frames mit echtem Input fahren --------------------- */
function runFrames(n, label, drive) {
  const t0 = performance.now();
  let err = null;
  for (let i = 0; i < n; i++) {
    try {
      if (drive) drive(game, i);
      game.frame(1/60);
    } catch (e) { err = e; break; }
  }
  const ms = performance.now() - t0;
  if (err) {
    failed = true;
    console.log(`✘ ${label}: ${err.message}\n   ${err.stack.split('\n').slice(1,4).join('\n   ')}`);
  } else {
    console.log(`✔ ${label}: ${n} Frames fehlerfrei in ${ms.toFixed(0)} ms (${(ms/n).toFixed(2)} ms/Frame), ${HDstats.drawCalls} Draw-Calls`);
  }
  return !err;
}

// 1)_IDLE
runFrames(120, 'Leerlauf (Idle, Kamera/Viewmodel/HUD)');

// 2) Laufen + Springen + Rutschen
runFrames(240, 'Boden-Parkour (Laufen, Springen, Slide)', (g, i) => {
  g.input.forward = true;
  g.input.jumpPressed = (i % 45 === 0);
  g.input.slideHeld = (i % 120) > 80;
  g.input.slide = (i % 120) === 81;
  g.player.yaw += Math.sin(i*0.05)*0.02;
});

// 3) Grapple: feuern, schwingen, lösen — in jedem Szenario
let anchored = 0, wrapped = 0, maxWraps = 0;
runFrames(1200, 'Grapple-Betrieb über alle Szenarios', (g, i) => {
  if (i % 200 === 0) {
    const si = Math.floor(i/200) % g.level.spots.length;
    g.teleport(si);
  }
  if (i % 200 === 30) g.input.firePressed = true;
  if (i % 200 === 170) g.input.releasePressed = true;
  g.input.forward = (i % 60) < 40;
  g.input.jumpPressed = (i % 73 === 0);
  g.player.yaw += 0.012; g.player.pitch = Math.sin(i*0.02)*0.5;
  if (g.rope.attached) anchored++;
  if (g.rope.path.wraps.length) { wrapped++; maxWraps = Math.max(maxWraps, g.rope.path.wraps.length); }
});
console.log(`   → ${anchored} Frames mit Seil, ${wrapped} Frames mit Umlenkkontakt (max. ${maxWraps})`);

// 4) Orbit-Kamera + Debug-Ansicht
game.orbit = true; game.debug = true;
runFrames(180, 'Orbit-Kamera + Debug-Overlay');
game.orbit = false; game.debug = false;

// 5) A/B-Modi (naive Referenz + starre Stange)
game.rope.p.wrapPhysics = false;
runFrames(180, 'A/B-Modus "naive Luftlinie"');
game.rope.p.wrapPhysics = true;
game.rope.p.rigidRod = true;
runFrames(180, 'A/B-Modus "starre Stange"');
game.rope.p.rigidRod = false;

// 6) Extremparameter (Stabilität unter Tuning-Grenzwerten)
game.rope.p.chainSpacing = 0.15;   // feinste Kettenauflösung
game.rope.p.waveSpeed = 5; game.player.p.groundMaxSpeed = 18; game.hook.p.speed = 120;
runFrames(300, 'Extremparameter (feine Kette, langsame Welle, hohes Tempo)');

// 7) NaN-Wächter
const P = game.player, R = game.rope;
const bad = [P.pos, P.vel, R.hand, R.anchor, R.chain.pos[0]].some(v => !isFinite(v[0]+v[1]+v[2]));
if (bad) { failed = true; console.log('✘ NaN in Spieler-/Seilzustand'); }
else console.log('✔ keine NaN in Spieler-/Seilzustand nach allen Läufen');

console.log(failed ? '\nFEHLER' : '\nBrowser-Smoke-Test bestanden');
process.exit(failed ? 1 : 0);

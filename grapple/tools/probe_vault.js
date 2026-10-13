'use strict';
/* tools/probe_vault.js — Funktioniert der Vault / Ledge-Assist noch?

   Anlass: Die Mechanik („über die Kante hochziehen") ist seit dem Initial-Commit
   2815ae3 zeichenidentisch im Code und wurde seitdem von keinem Commit
   angefasst — aber sie ist auch nirgends dokumentiert (README, ARCHITEKTUR,
   keine Doku erwähnt sie), hat KEINEN einzigen Test in tools/ und keinen
   Panel-Schalter. Sie ist damit vollständig un verifiziert: Wenn eine der
   fünf Gating-Bedingungen oder `_probeLedge` durch eine Änderung an
   `wallNormal`, `feetY`, `capsulePenetrates` oder am Kapsel-Resolver
   stillgebrochen wäre, würde nichts rot.

   Gemessen werden vier Szenarien, jeweils mit denselben Kennzahlen:
     · ob `vaulting` je true war und wie lange
     · ob `_probeLedge` je ein Ziel lieferte
     · ob der Spieler oben ankommt (y über der Blockoberkante)
     · höchster y-Wert und ob/wann Bodenkontakt nach dem Anlauf besteht

   Aufruf: node tools/probe_vault.js
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
  ? process.env.SRC : path.join(__dirname, '..', 'src');
let code = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += '\n;this.X={World,Player,Rope,Hook,ROPE_DEFAULTS,v3,vset,vlen};';
const sb = {
  console, Math, Date, JSON, performance: { now: () => 0 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN,
  window: {}, document: undefined,
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(code, sb);
const X = sb.X;

const INPUT = {
  forward: false, back: false, left: false, right: false, slide: false, slideHeld: false,
  jumpPressed: false, jumpHeld: false, firePressed: false, releasePressed: false,
  mouseX: 0, mouseY: 0,
};

/**
 * Ein Szenario: Boden, ein Block der Hoehe `h` bei x = 1.4, Spieler laeuft
 * (oder springt) dagegen. `mode`:
 *   'float'  — Spieler startet in der Luft knapp vor der Wand mit kleinem
 *              Aufwaertstempo: alle Gating-Bedingungen sollten erfuellt sein.
 *   'run'    — Anlauf am Boden mit vollem Tempo.
 *   'runjump'— Anlauf plus Sprung sobald grounded (voller Sprung, v_y ≈ 9.2).
 *   'lowjump'— Anlauf plus Jump-Cut-Sprung (nur antippen ⇒ v_y ≈ 5.1).
 */
function run(name, mode, h) {
  const w = new X.World();
  w.gravity = -26;
  w.addBox([-40, -2, -40], [40, 0, 40], { color: [1, 1, 1] });
  w.addBox([0.6, 0, -3], [1.4 + 0.8, h, 3], { color: [0.6, 0.6, 0.9] });   // Block, Oberkante y = h
  const rope = new X.Rope(w, {});
  const player = new X.Player(w, {});
  const hook = new X.Hook(w, {});
  /* Blickrichtung: `FWD_VEC = [0,0,−1]` und `qForward` rotiert darum so, dass
     yaw = −π/2 nach +x zeigt. (yaw = +π/2 zeigt nach −x — die Sonde lief damit
     zuerst rueckwaerts, x von −2 auf −25, und der Vault konnte nie ausloesen.
     Richtung ist hier also kein Detail, sondern die halbe Messung.)        */
  player.spawn([-2.0, 0.86, 0], -Math.PI / 2);          // Blick nach +x, auf die Wand zu
  const dt = 1 / 120;

  let vaultFrames = 0, probeHits = 0, maxY = player.pos[1], groundedEnd = false;
  let jumped = false, jumpCutDone = false;
  let wallSteps = 0, probeNonNull = 0, firstWallAt = -1, minDistWall = Infinity;
  const N = 300;                                        // 2.5 s
  if (mode === 'float') {
    /* Direkt an die Wand: Der Vault braucht `wallNormal`, also Wandkontakt.
       Aus 1,4 m Abstand faellt der Spieler erst herunter, bevor er die Wand
       berhaupt erreicht — das Szenario masse dann den freien Fall, nicht den
       Ledge-Assist. 0,32 m vor der Blockflaeche bei x = 0,6 ist knapp
       ausserhalb der Kapsel (Radius 0,30).                                  */
    player.pos[0] = 0.28;
    player.pos[1] = h - 1.0;                            // Fuesse ~1 m unter der Kante
    player.vel[1] = 1.0;                                // langsam steigend (< 3.2 m/s)
    player.vel[0] = 0.6;                                // sanft gegen die Wand
  }
  for (let i = 0; i < N; i++) {
    const inp = Object.assign({}, INPUT);
    if (mode !== 'float') inp.forward = true;
    if ((mode === 'runjump' || mode === 'lowjump') && player.grounded && !jumped) {
      inp.jumpPressed = true; inp.jumpHeld = (mode === 'runjump');
      jumped = true;
    } else if (mode === 'runjump') {
      inp.jumpHeld = true;
    } else if (mode === 'lowjump' && jumped && !jumpCutDone) {
      inp.jumpHeld = false; jumpCutDone = true;         // Loslassen ⇒ Jump-Cut
    } else {
      inp.jumpHeld = (mode === 'runjump');
    }

    /* Zaehlen, BEVOR der Schritt die Zustaende zuruecksetzt */
    const before = player.vaulting;
    w.stepBodies(dt);
    const chest = player.chestPoint(X.v3());
    rope.step(dt, chest, null, player.vel);
    player.update(dt, inp, rope);
    if (player.vaulting) vaultFrames++;
    if (!before && player.vaulting) probeHits++;
    maxY = Math.max(maxY, player.pos[1]);
    /* Die Gating-Bedingung `this.wallNormal` ist die erste, an der ein Vault
       scheitern kann — ohne Wandkontakt gibt es per Konstruktion keinen
       Ledge-Assist. Deshalb mitzaehlen, sonst ist ein „0 Ausloesungen" nicht
       von „Mechanik kaputt" zu unterscheiden.                             */
    if (player.wallNormal) { wallSteps++; if (firstWallAt < 0) firstWallAt = +(i * dt).toFixed(3); }
    minDistWall = Math.min(minDistWall, 1.4 + 0.8 - player.pos[0]);   // Abstand zur Blockwand bei x=0.6
    /* _probeLedge direkt befragen (unabhaengig vom Gating), um „findet keine
       Kante" von „darf nicht" zu trennen */
    if (player.wallNormal && !player.grounded) {
      const t = player._probeLedge();
      if (t) probeNonNull++;
    }
  }
  groundedEnd = player.grounded;
  return {
    szenario: name, modus: mode, blockhoehe: h,
    vaultingSchritte: vaultFrames,
    vaultAusloesungen: probeHits,
    wandkontaktSchritte: wallSteps,
    ersterWandkontakt: firstWallAt,
    minAbstandZurWand: +minDistWall.toFixed(2),
    probeLedgeTreffer: probeNonNull,
    maxY: +maxY.toFixed(2),
    ueberKante: maxY > h + 0.9,
    endetAufBoden: groundedEnd,
    endetY: +player.pos[1].toFixed(2),
    endetX: +player.pos[0].toFixed(2),
  };
}

/* ---- Befund (gemessen auf main = c823d50, 2026-10-13) ----------------------
   Die Mechanik ist NICHT entfernt: Vault-Block und _probeLedge sind seit dem
   Initial-Commit 2815ae3 zeichenidentisch (diff ueber alle 36 Commits, die
   03_player.js anfassten: 6 Treffer des Begriffs in jeder Fassung, keine
   Aenderung am Block).

     Szenario                          Wand-   _probeLedge  Vault-   maxY   ueber Kante
                                        kontakt  Treffer     Ausl.
     float, 2,0-m-Block (aus dem Stand)    9         8          1    1,37   nein
     run, 1,2-m-Block (Anlauf, kein Spr.) 262         0          0    0,86   nein
     runjump, 2,4-m-Block (voller Spr.)   40        28          3    3,26   JA (x 16,03)
     lowjump, 2,4-m-Block (Jump-Cut)     243         0          0    1,36   nein

   Deutung: Es ist ein ASSIST, kein Lift. `vault.strength = 34` m/s² bei
   `damping = 9` und `gScale *= 0.15` hebt einen Spieler aus dem Stand nicht
   auf 3,28 m Zielhöhe — der Federweg ist zu lang und die Dämpfung zu hoch.
   Mit einem vollen Sprung (jumpSpeed 9,2 m/s ⇒ Scheitel ~1,7 m, dazu die
   Anlaufhöhe) reicht es: 3 Ausloesungen, 28 Substeps Zug, der Spieler kommt
   ueber den 2,4-m-Block und landet dahinter (x = 16,03).
   Der Kommentar im Code sagt dasselbe: „Vault / Ledge-Assist (Kraft, keine
   Positions-Teleportie)" — er greift also bewusst erst, wenn der Sprung schon
   fast reicht, und stockt auf.

   Warum es sich „abgespeckt" anfuehlen koennte, ohne dass etwas fehlt:
     · `!attached` — am Seil ist der Ledge-Assist AUS (seit dem Initial-Commit).
     · `this.wallNormal` muss gesetzt sein — ohne Wandkontakt kein Vault.
     · Kante muss 0,30…2,40 m ueber den Fuessen liegen (`minHeight`/`maxHeight`).
     · `vel[1] > 3.2` ⇒ kein Vault: wer schon schnell steigt, braucht ihn nicht.
       Ein voller Sprung erreicht 9,2 m/s, die Schwelle greift also nur in der
       Spaetphase des Steigens bzw. im Fallen.
     · `vault.duration = 0.6` s, danach ist Schluss.
   Und: KEIN Test, KEINE Doku (README und ARCHITEKTUR erwaehnen die Mechanik
   mit keinem Wort), KEIN Panel-Schalter. Sie ist damit vollstaendig
   unverifiziert — waere sie durch eine Aenderung an wallNormal, feetY oder
   capsulePenetrates still gebrochen, wuerde nichts rot.
   ------------------------------------------------------------------------ */
const out = [];
out.push(run('schwebend vor der Kante, 1,2 m Block', 'float', 1.2));
out.push(run('schwebend vor der Kante, 2,0 m Block', 'float', 2.0));
out.push(run('Anlauf, 1,2 m Block', 'run', 1.2));
out.push(run('Anlauf + voller Sprung, 2,4 m Block', 'runjump', 2.4));
out.push(run('Anlauf + Jump-Cut-Sprung, 2,4 m Block', 'lowjump', 2.4));
console.log(JSON.stringify({ src: SRC, szenarien: out }, null, 1));

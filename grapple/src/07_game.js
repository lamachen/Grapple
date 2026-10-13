/* =============================================================================
   07_game.js — Input, Fixed-Timestep-Loop, Rendering, HUD, Tuning, Boot
   ========================================================================== */
'use strict';

/* --------------------------------- Helfer --------------------------------- */
function m4FromAxes(o, ax, ay, az, p) {
  o[0]=ax[0]; o[1]=ax[1]; o[2]=ax[2]; o[3]=0;
  o[4]=ay[0]; o[5]=ay[1]; o[6]=ay[2]; o[7]=0;
  o[8]=az[0]; o[9]=az[1]; o[10]=az[2]; o[11]=0;
  o[12]=p[0]; o[13]=p[1]; o[14]=p[2]; o[15]=1;
  return o;
}
const _AX = v3(), _AY = v3(), _AZ = v3(), _MM = m4();
/** Orientierte Box entlang `fwd` (lokale X-Achse = fwd). */
function pushOriented(r, from, to, thick, col, spec) {
  vsub(_AX, to, from);
  const len = vnorm(_AX, _AX) || 1e-4;
  let up = Math.abs(_AX[1]) > 0.95 ? [1,0,0] : [0,1,0];
  vcross(_AZ, _AX, up); vnorm(_AZ, _AZ);
  vcross(_AY, _AZ, _AX); vnorm(_AY, _AY);
  vscl(_AX, _AX, len); vscl(_AY, _AY, thick); vscl(_AZ, _AZ, thick);
  const mid = [(from[0]+to[0])*0.5, (from[1]+to[1])*0.5, (from[2]+to[2])*0.5];
  m4FromAxes(_MM, _AX, _AY, _AZ, mid);
  r.pushBox(_MM, col[0], col[1], col[2], spec != null ? spec : 0.5);
}

/* ================================== GAME ================================== */
/* Die drei Dock-Panels (Telemetrie unten links, Steuerung oben links,
   Parameter oben rechts). Spawn-Leiste ist fest, keine Dock-Mechanik. */
const DOCK_PANELS = [
  'tele', 'help', 'tune',
];

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.r = new Renderer(canvas);
    this.world = new World();
    this.world.gravity = -26;
    this.level = buildLevel(this.world);
    this.rope = new Rope(this.world, {});
    this.player = new Player(this.world, {});
    this.hook = new Hook(this.world, {});
    this.particles = new Particles();
    this.audio = new RopeAudio();

    this.input = { forward:false, back:false, left:false, right:false, slide:false, slideHeld:false,
                   jumpPressed:false, jumpHeld:false, firePressed:false, releasePressed:false, fireHeld:false,
                   mouseX:0, mouseY:0, reelDir:0 };
    this.sens = 0.0015;
    this.freeLookSensScale = 1.7;   // Multiplikator, wenn der Zeiger nicht gesperrt ist
    this.locked = false;
    this.freeLook = false;   // Fallback, wenn Pointer-Lock nicht erlaubt ist (z. B. Sandbox-iframe)
    this.dragLook = false;   // Taste gehalten + ziehen (Touchpad-freundlich)
    this._mouseDown = false;
    this._lastMX = null; this._lastMY = null;
    this.lockDenied = false;  // wird nur gesetzt, wenn der Browser wirklich ablehnt
    this.orbit = false; this.orbitYaw = 0.6; this.orbitPitch = 0.32; this.orbitDist = 7.5;
    this.debug = false;
    this.paused = false;
    this.showHelp = true;
    this.fovBase = 82;
    // Kein Viewmodel — siehe Kommentar in render(). Bewusste Entscheidung,
    // kein Platzhalter aus Box-Primitiven.
    this.time = 0;
    this.acc = 0;
    this.PHYS_HZ = 120;
    this.substeps = 0;
    this.perf = { phys: 0, rope: 0, render: 0, fps: 60, raycasts: 0 };
    this._curve = { buf: null, count: 0 };
    this._ropeBuf = new Float32Array(4096*3);
    this._ropeCount = 0;
    this._screen = [0,0];
    this.aimTarget = null;
    this.aimTimer = 0;
    this.flash = 0;
    /* Alle Dock-Panels starten EINGEKLAPPT: freier Blick auf Level und Seil,
       aufklappen per Titelbalken-Klick oder T/H/P (U = alle).              */
    this.uiVisible = { tele: false, help: false, tune: false };
    this.hudTimer = 0;
    this.tensionAudio = 0;
    this.lastTaut = false;

    const s = this.level.spots.find(x => x.name === 'Start');
    this.player.spawn(s.p, s.yaw);
    this.measureCanvas();
    this.bindInput();
    this.buildUI();
    this.bindUI();
  }

  /* -------------------------------- Input -------------------------------- */
  bindInput() {
    const cv = this.canvas;
    const keymap = {
      KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back',
      KeyA:'left', KeyD:'right', ArrowLeft:'left', ArrowRight:'right',
    };
    window.addEventListener('keydown', e => {
      if (keymap[e.code]) { this.input[keymap[e.code]] = true; e.preventDefault(); }
      /* Space: jumpPressed ist eine ECHTE Kante (ohne e.repeat). Sonst liefert
         der Tastatur-Autorepeat bei gehaltener Leertaste jeden Frame einen
         „Sprungimpuls" — am Seil wurde daraus unbegrenztes Fliegen.         */
      if (e.code === 'Space') {
        if (!e.repeat) this.input.jumpPressed = true;
        this.input.jumpHeld = true;
        e.preventDefault();
      }
      if (e.code === 'ShiftLeft' || e.code === 'ControlLeft' || e.code === 'KeyC') {
        this.input.slide = true; this.input.slideHeld = true; e.preventDefault();
      }
      if (e.code === 'KeyR') this.input.releasePressed = true;
      if (e.code === 'KeyF') this.input.firePressed = true;
      if (e.code === 'KeyQ') this.input.reelDir = -1;
      if (e.code === 'KeyE') this.input.reelDir = +1;
      if (e.code === 'KeyV') { this.orbit = !this.orbit; this.updateLookModeLabel(); }
      if (e.code === 'KeyG') { this.setFreeLook(!this.freeLook); }
      if (e.code === 'F1') { this.debug = !this.debug; e.preventDefault(); }
      if (e.code === 'KeyH') this.togglePanel('help');
      if (e.code === 'F9') { this.toggleRecording(); e.preventDefault(); }
      if (e.code === 'KeyU') this.togglePanel('all');
      if (e.code === 'KeyT') this.togglePanel('tele');
      if (e.code === 'KeyP') this.togglePanel('tune');

      if (e.code === 'Escape' && this.freeLook) { this.setFreeLook(false); this.lookActive = false; if (this.dom.lockHint) this.dom.lockHint.style.display = 'flex'; }
      if (e.code === 'KeyM') { this.audio.enabled = !this.audio.enabled; if (!this.audio.enabled && this.audio.ok) { this.audio.master.gain.value = 0; } else if (this.audio.ok) this.audio.master.gain.value = 0.55; }
      if (e.code.startsWith('Digit')) {
        const i = parseInt(e.code.slice(5), 10);
        if (i >= 1 && i <= this.level.spots.length) this.teleport(i-1);
      }
    });
    window.addEventListener('keyup', e => {
      if (keymap[e.code]) { this.input[keymap[e.code]] = false; }
      if (e.code === 'Space') this.input.jumpHeld = false;
      if (e.code === 'ShiftLeft' || e.code === 'ControlLeft' || e.code === 'KeyC') this.input.slideHeld = false;
      if (e.code === 'KeyQ' || e.code === 'KeyE') this.input.reelDir = 0;
    });
    /* ---------------------------- Blicksteuerung ----------------------------
       Primär: Pointer-Lock (wird beim Klick angefordert — es wird NICHT davon
       ausgegangen, dass er unavailable ist; das meldet der Browser selbst über
       pointerlockerror / das ausbleibende pointerlockchange).
       Fallback, immer verfügbar: RECHTE Maustaste halten + ziehen.
       Optional per G: freie Mausbewegung ohne Taste (Delta-Look).
       ------------------------------------------------------------------------ */
    const lookDelta = (e) => {
      let dx, dy, lim;
      if (this.locked && e.movementX != null) { dx = e.movementX; dy = e.movementY; lim = 600; }
      else {
        const lx = this._lastMX, ly = this._lastMY;
        this._lastMX = e.clientX; this._lastMY = e.clientY;
        if (lx == null) return null;             // erster Event: nur Referenz setzen
        dx = e.clientX - lx; dy = e.clientY - ly; lim = 160;
      }
      if (!isFinite(dx) || !isFinite(dy)) return null;
      return [clamp(dx, -lim, lim), clamp(dy, -lim, lim)];
    };
    const applyLook = (dx, dy) => {
      if (this.orbit) { this.orbitYaw -= dx*this.sens; this.orbitPitch = clamp(this.orbitPitch + dy*this.sens, -1.25, 1.4); }
      else { this.input.mouseX += dx; this.input.mouseY += dy; }
    };
    const lookAllowed = () => this.locked || this.dragLook || this.freeLook;

    cv.addEventListener('mousedown', e => {
      e.preventDefault();
      this._mouseDown = true;
      this._lastMX = e.clientX; this._lastMY = e.clientY;
      if (e.button === 2) this.dragLook = true;         // Fallback: RMB halten + ziehen
      if (!this.locked) {
        try {
          const pr = cv.requestPointerLock();
          if (pr && pr.catch) pr.catch(() => this.reportLockUnavailable());
        } catch (err) { this.reportLockUnavailable(); }
      }
      this.audio.init(); this.audio.resume();
      if (this.dom && this.dom.lockHint) this.dom.lockHint.style.display = 'none';
      /* HALTEN = eingehakt, LOSLASSEN = Seil wird eingeholt.
         Die rechte Taste bleibt für Drag-Look frei und löst nichts.          */
      if (e.button === 0) { this.input.fireHeld = true; this.input.firePressed = true; }
      else if (e.button === 1) { this.orbit = !this.orbit; this.updateLookModeLabel(); }
    });
    window.addEventListener('mouseup', e => {
      this._mouseDown = false; this.dragLook = false;
      if (!e || e.button === undefined || e.button === 0) {
        this.input.fireHeld = false;
        this.input.releasePressed = true;
      }
    });
    cv.addEventListener('mousemove', e => {
      if (e.target !== cv && !this.locked) { this._lastMX = null; this._lastMY = null; return; }
      if (!lookAllowed()) return;
      const d = lookDelta(e);
      if (d) applyLook(d[0], d[1]);
    });
    window.addEventListener('mousemove', e => {
      if (this.locked) { const d = lookDelta(e); if (d) applyLook(d[0], d[1]); return; }
      // Drag über Panel-Grenzen hinweg nicht abreißen lassen
      if (this.dragLook && e.target !== cv) { const d = lookDelta(e); if (d) applyLook(d[0], d[1]); }
    });
    cv.addEventListener('mouseleave', () => { this._lastMX = null; this._lastMY = null; });
    window.addEventListener('blur', () => {
      this._lastMX = null; this._lastMY = null; this.dragLook = false; this._mouseDown = false;
      this.input.forward = this.input.back = this.input.left = this.input.right = false;
      this.input.slideHeld = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === cv;
      if (this.locked) { this.lockDenied = false; this.audio.init(); this.audio.resume(); }
      this.updateLookModeLabel();
    });
    document.addEventListener('pointerlockerror', () => this.reportLockUnavailable());
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('wheel', e => {
      if (!this.locked && !this.dragLook && !this.freeLook) return;
      if (this.orbit) { this.orbitDist = clamp(this.orbitDist * (1 + Math.sign(e.deltaY)*0.12), 2.2, 40); return; }
      this.rope.reel(Math.sign(e.deltaY) * 0.9);          // eine Raste ≈ 0.9 m Seil
      e.preventDefault();
    }, { passive:false });
    window.addEventListener('resize', () => { this.r.resize(); this.measureCanvas(); });
  }

  /** Canvas-Abmessungen für das Edge-Steering (ohne Layout-Read pro Event). */
  measureCanvas() {
    let r = null;
    try { if (this.canvas.getBoundingClientRect) r = this.canvas.getBoundingClientRect(); } catch (e) {}
    if (!r || !r.width) {
      const w = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const h = (typeof window !== 'undefined' && window.innerHeight) || 720;
      r = { left: 0, top: 0, width: w, height: h };
    }
    this._rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    return this._rect;
  }

  /* ------------------------- Panel-Sichtbarkeit ------------------------- */
  /**
   * Blendet ein Panel KOMPLETT aus (inklusive Hintergrund und Kopf) — nicht nur
   * den Inhalt. `all` schaltet alles auf einmal, z. B. für Screenshots.
   */
  /* Dock-Panels: ein-/ausklappen. Eingeklappt bleibt der Titelbalken an der
     Bildschirmkante sichtbar und gleitet bei Klick wieder heraus — eine
     separate Leiste zum Zurückholen ausgeblendeter Panels ist damit über-
     flüssig (und entfernt).                                                */
  setPanel(name, visible) {
    if (name === 'all') {
      const anyVisible = DOCK_PANELS.some(n => this.uiVisible[n]);
      DOCK_PANELS.forEach(n => this.setPanel(n, !anyVisible));
      return;
    }
    if (!(name in this.uiVisible)) return;
    this.uiVisible[name] = visible;
    const el = document.getElementById(name);
    if (el) el.classList.toggle('collapsed', !visible);
  }
  /* ------------------------- Deterministisches Replay ---------------------
     Aufzeichnung: ein Snapshot des vollständigen Zustands zu Beginn plus ein
     Input-Record pro Render-Frame (die Physik läuft mit festem 120-Hz-Raster
     und hängt am Frame-dt des Akkumulators — mit denselben Frames und
     demselben Input entsteht dieselbe Substep-Folge). Zweck: jede
     Bildschirmaufnahme eines Seil-Fehls wird zu einem frame-genauen
     Regressionstest (tools/replay.js), statt dass ein Fehler nachgebaut
     werden muss (Prozess-Idee aus der Parallel-Analyse).                  */
  toggleRecording() {
    if (this.rec) { this.lastRec = { v: 1, snap: this.rec.snap, frames: this.rec.frames }; this.rec = null;
      this.consoleInfo('Aufnahme beendet: ' + this.lastRec.frames.length + ' Frames');
      this._downloadRecording();
      return false; }
    this.rec = { snap: this.getSnapshot(), frames: [] };
    this.consoleInfo('Aufnahme läuft (F9 stoppt)');
    return true;
  }
  consoleInfo(m) { if (this.dom && this.dom.hud) {} console.log('[rec] ' + m); }
  _packFrame(dt) {
    const i = this.input;
    return { dt: +dt.toFixed(6), mx: i.mouseX || 0, my: i.mouseY || 0,
             f: i.forward?1:0, b: i.back?1:0, l: i.left?1:0, r: i.right?1:0,
             jp: i.jumpPressed?1:0, jh: i.jumpHeld?1:0, sl: i.slide?1:0, sh: i.slideHeld?1:0,
             fp: i.firePressed?1:0, rp: i.releasePressed?1:0, rd: i.reelDir || 0 };
  }
  _unpackFrame(fr) {
    const i = this.input;
    i.forward = !!fr.f; i.back = !!fr.b; i.left = !!fr.l; i.right = !!fr.r;
    i.jumpPressed = !!fr.jp; i.jumpHeld = !!fr.jh; i.slide = !!fr.sl; i.slideHeld = !!fr.sh;
    i.firePressed = !!fr.fp; i.releasePressed = !!fr.rp; i.reelDir = fr.rd || 0;
    i.mouseX = fr.mx || 0; i.mouseY = fr.my || 0;
  }
  getSnapshot() {
    const P = this.player, R = this.rope, H = this.hook;
    const boxSig = (b) => b ? [b.min.map(v=>+v.toFixed(3)), b.max.map(v=>+v.toFixed(3))] : null;
    return {
      t: +this.time.toFixed(4),
      player: { pos: P.pos.slice(), vel: P.vel.slice(), yaw: P.yaw, pitch: P.pitch },
      rope: { phase: R.phase, budget: R.budget, settleActive: R.settleActive,
              anchor: R.anchor.slice(), anchorBox: boxSig(R.anchorBox), attached: R.attached },
      hook: { state: H.state, pos: H.pos.slice(), vel: H.vel.slice() },
      bodies: this.world.bodies.map(b => ({ sig: boxSig(b), pos: b.pos.slice(), vel: b.vel.slice() })),
    };
  }
  applySnapshot(snap) {
    const P = this.player, R = this.rope, H = this.hook, W = this.world;
    const findBySig = (sig) => {
      if (!sig) return null;
      const all = W.statics.concat(W.bodies);
      for (const b of all) {
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
          if (Math.abs(b.min[k]-sig[0][k]) > 1e-2 || Math.abs(b.max[k]-sig[1][k]) > 1e-2) ok = false;
        }
        if (ok) return b;
      }
      return null;
    };
    P.pos[0]=snap.player.pos[0]; P.pos[1]=snap.player.pos[1]; P.pos[2]=snap.player.pos[2];
    P.vel[0]=snap.player.vel[0]; P.vel[1]=snap.player.vel[1]; P.vel[2]=snap.player.vel[2];
    P.yaw = snap.player.yaw; P.pitch = snap.player.pitch;
    for (const bd of snap.bodies) {
      const b = findBySig(bd.sig);
      if (!b) continue;
      b.pos[0]=bd.pos[0]; b.pos[1]=bd.pos[1]; b.pos[2]=bd.pos[2];
      b.vel[0]=bd.vel[0]; b.vel[1]=bd.vel[1]; b.vel[2]=bd.vel[2];
    }
    R.detach();
    H.state = snap.hook.state; H.pos[0]=snap.hook.pos[0]; H.pos[1]=snap.hook.pos[1]; H.pos[2]=snap.hook.pos[2];
    H.vel[0]=snap.hook.vel[0]; H.vel[1]=snap.hook.vel[1]; H.vel[2]=snap.hook.vel[2];
    if (snap.rope.phase !== 0) {
      const box = findBySig(snap.rope.anchorBox);
      R.attachAt(snap.rope.anchor, [0,1,0], box, (box && box.dynamic) ? box : null, snap.rope.budget);
      R.settleActive = snap.rope.settleActive;
      R.phase = snap.rope.phase;
    }
    this.time = snap.t || 0;
  }
  exportRecording() { return JSON.stringify(this.lastRec || (this.rec ? { v:1, snap:this.rec.snap, frames:this.rec.frames } : null)); }
  _downloadRecording() {
    try {
      const blob = new Blob([this.exportRecording()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'grapple_rec_' + Date.now() + '.json';
      a.click();
    } catch (e) { /* headless: kein DOM-Download, exportRecording() genügt */ }
  }

  togglePanel(name) {
    if (name === 'all') return this.setPanel('all');
    this.setPanel(name, !this.uiVisible[name]);
  }
  bindUI() {
    const self = this;
    const all = document.querySelectorAll ? document.querySelectorAll('[data-panel]') : [];
    for (const b of all) {
      const name = b.dataset.panel;
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); self.togglePanel(name); });
    }
  }

  /**
   * Wird NUR aufgerufen, wenn der Browser die Zeigersperre tatsächlich
   * verweigert (pointerlockerror / abgelehntes Promise). Keine Vorannahme.
   */
  reportLockUnavailable() {
    if (this.lockDenied) return;
    this.lockDenied = true;
    this.updateLookModeLabel();
  }

  /** Blick-Modus umschalten und im HUD anzeigen. */
  setFreeLook(on) {
    if (this.freeLook === on) return;
    this.freeLook = on;
    this._lastMX = null; this._lastMY = null;
    this.lockDenied = false;  // wird nur gesetzt, wenn der Browser wirklich ablehnt
    if (on) {
      if (this.dom && this.dom.lockHint) this.dom.lockHint.style.display = 'none';
      this.audio.init(); this.audio.resume();
    }
    this.updateLookModeLabel();
  }
  updateLookModeLabel() {
    if (!this.dom || !this.dom.lookmode) return;
    this.dom.lookmode.textContent = this.orbit
      ? 'Orbit-Kamera (Maus = drehen, Rad = zoom)'
      : (this.locked ? 'Mauszeiger gesperrt'
        : (this.freeLook ? (this.lookStyle === 'edge'
            ? 'Blick: Maus zur Seite bewegen · G = Drag-Modus'
            : 'Blick: rechte Taste halten + ziehen · G = Kanten-Modus')
        : 'Maus bewegen oder klicken'));
    this.dom.lookmode.dataset.mode = this.orbit ? 'orbit' : (this.locked ? 'lock' : 'free');
  }

  teleport(i) {
    const s = this.level.spots[i]; if (!s) return;
    this.player.spawn(s.p, s.yaw);
    this.player.pitch = (s.pitch || 0) * DEG;   // Spots blicken direkt auf ihr Ziel
    this.rope.detach(); this.hook.state = 'idle';
    this.orbitYaw = s.yaw + 2.4;
    this.spotIndex = i;
    this.markSpot();
  }
  /** Aktiven Level-Spawn in der Leiste hervorheben. */
  markSpot() {
    if (!this.dom || !this.dom.spots) return;
    const btns = this.dom.spots.querySelectorAll ? this.dom.spots.querySelectorAll('button') : [];
    for (let i = 0; i < btns.length; i++) btns[i].classList.toggle('on', i === this.spotIndex);
  }

  /* --------------------------------- Loop -------------------------------- */
  start() {
    let last = performance.now();
    const tick = (now) => {
      let dt = (now - last) / 1000; last = now;
      if (dt > 0.25) dt = 0.25;
      this.perf.fps = this.perf.fps*0.92 + (1/Math.max(1e-4, dt))*0.08;
      const t0 = performance.now();
      this.frame(dt);
      this.perf.frameMs = performance.now() - t0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  frame(dt) {
    this._frameId = (this._frameId || 0) + 1;
    if (this.rec) this.rec.frames.push(this._packFrame(dt));
    // Blick
    if ((this.locked || this.dragLook || this.freeLook) && !this.orbit) {
      // Ohne Mauszeiger-Sperre ist der Weg pro Event durch die Fensterbreite
      // begrenzt — die Empfindlichkeit wird dann automatisch angehoben, damit
      // man sich nicht dauernd neu ansetzen muss.
      const sens = this.sens * (this.locked ? 1 : this.freeLookSensScale);
      this.player.look(this.input.mouseX, this.input.mouseY, sens);
    }
    this.input.mouseX = 0; this.input.mouseY = 0;

    this.time += dt;
    this.acc += dt;
    const h = 1/this.PHYS_HZ;
    let steps = 0;
    const t0 = performance.now();
    while (this.acc >= h && steps < 8) { this._snapshotPrev(); this.physics(h, steps === 0); this.acc -= h; steps++; }
    if (steps >= 8) this.acc = 0;
    this.substeps = steps;
    this.perf.phys = performance.now() - t0;

    this.input.jumpPressed = false;
    this.input.firePressed = false;
    this.input.releasePressed = false;
    this.input.slide = false;
    // fireHeld bleibt, bis die Taste wirklich losgelassen wird

    this.particles.step(dt, this.world.gravity*0.42);
    this._applyInterp(this.acc / h);
    try { this.updateCamera(dt); this.render(dt); }
    finally { this._restoreInterp(); }   // sonst bleibt der Zustand interpoliert
    this.updateHUD(dt);
  }


  /** Seil-Austritt (rechts/unten vor der Kamera). EINE Quelle für Ketten-Pin (Physik)
      UND Darstellung — vorher: Pin = handPoint (0.59 m vom Auge), Render = 0.36 m vom Auge,
      0.29 m Versatz ⇒ kurzes, fast achsparalleles Verbindungsstück = „dicker Schlauch". */
  ropeOriginPoint(o, useCam) {
    const P = this.player, R = this.rope;
    const eye = (useCam && this._camEye) ? this._camEye : P.eyePoint(this._eye || (this._eye = v3()));
    const q = (useCam && this.camQuat) ? this.camQuat : (this._oq || (this._oq = [0,0,0,1]));
    if (!(useCam && this.camQuat)) { qFromYawPitch(q, P.yaw, P.pitch); qRotateLocal(q, q, 0, 0, 1, P.roll*0.055); }
    const fwd = qForward(this._vmF || (this._vmF = v3()), q);
    const right = qRight(this._vmR || (this._vmR = v3()), q);
    const up = qUp(this._vmU || (this._vmU = v3()), q);
    o[0] = eye[0] + right[0]*0.155 + fwd[0]*0.30 - up[0]*0.125;
    o[1] = eye[1] + right[1]*0.155 + fwd[1]*0.30 - up[1]*0.125;
    o[2] = eye[2] + right[2]*0.155 + fwd[2]*0.30 - up[2]*0.125;
    /* Fest in der Kamera, in JEDER Phase, ohne Neigen zum Ziel: solange es
       keinen IK-Arm gibt, ist jeder Ziel-bezogene Versatz des Austritts eine
       zusätzliche Richtungsänderung direkt vor der Linse (Knick) und ein
       Sonderweg pro Phase. Ein Punkt, eine Regel.                          */
    return o;
  }

  /* ---- Render-Interpolation: Physik 120 Hz fix, Darstellung mit alpha = acc/h ---- */
  _interpTargets() {
    const P = this.player, R = this.rope, H = this.hook, C = R.chain, t = this._itT || (this._itT = []);
    t.length = 0;
    const add = (v) => { if (v && t.indexOf(v) < 0) t.push(v); };
    /* `this._hand` statt `R.visualHand`: visualHand wechselt seine Identität
       zwischen Physik (=_hand) und Render (=_ropeOrigin). Je nach Substep-Zahl
       wäre sonst der Snapshot-Slot ein ANDERES Objekt als der Apply-Slot. */
    add(P.pos); add(R.hand); add(this._hand); add(H.pos);
    /* Anker nur dann interpolieren, wenn er an einem bewegten Körper hängt (er fährt
       dann mit dessen interpolierter Position mit). Wechselt die Zielliste, mischt
       _applyInterp in diesem Frame nicht — ein frischer Einhaker verschmiert also nie. */
    if (R.anchorBody && R.attached) add(R.anchor);
    if (C && C.pos) for (let i = 0; i < C.n; i++) add(C.pos[i]);
    for (const b of this.world.bodies) add(b.pos);
    return t;
  }
  _snapshotPrev() {
    const t = this._interpTargets(), a = this._itPrev || (this._itPrev = []);
    a.length = t.length * 3;
    for (let i = 0; i < t.length; i++) { a[i*3] = t[i][0]; a[i*3+1] = t[i][1]; a[i*3+2] = t[i][2]; }
  }
  _applyInterp(alpha) {
    const t = this._interpTargets(), a = this._itPrev, cur = this._itCur || (this._itCur = []);
    this._itApplied = false;
    if (!a || a.length !== t.length*3 || alpha >= 1) return;           // Topologie geändert → nicht mischen
    cur.length = t.length * 3;
    for (let i = 0; i < t.length; i++) {
      const v = t[i];
      const dx = v[0]-a[i*3], dy = v[1]-a[i*3+1], dz = v[2]-a[i*3+2];
      cur[i*3] = v[0]; cur[i*3+1] = v[1]; cur[i*3+2] = v[2];
      if (dx*dx+dy*dy+dz*dz > 4) continue;                              // Teleport (Respawn): nie interpolieren
      v[0] = a[i*3] + dx*alpha; v[1] = a[i*3+1] + dy*alpha; v[2] = a[i*3+2] + dz*alpha;
    }
    this._itApplied = true; this._itTargets = t.slice();
  }
  _restoreInterp() {
    if (!this._itApplied) return;
    const t = this._itTargets, cur = this._itCur;
    for (let i = 0; i < t.length; i++) { t[i][0] = cur[i*3]; t[i][1] = cur[i*3+1]; t[i][2] = cur[i*3+2]; }
    this._itApplied = false;
  }

  /* ------------------------------- Physik -------------------------------- */
  physics(dt, firstStep) {
    const W = this.world, P = this.player, R = this.rope, H = this.hook;

    // Aktionen
    if (firstStep) {
      if (this.input.releasePressed) { H.retractNow(R); this.audio.retract(); }
      if (this.input.firePressed) {
        if (R.phase !== 0) { R.detach(); H.state = 'idle'; }
        const eye = P.eyePoint(this._eye || (this._eye = v3()));
        const hand = this._ropeOrigin || P.handPoint(this._hand || (this._hand = v3()), null);
        qFromYawPitch(P.quat, P.yaw, P.pitch);
        const f = qForward(v3(), P.quat), u = qUp(v3(), P.quat), rr = qRight(v3(), P.quat);
        const res = H.fire(hand, f, u, rr, P.vel, R);
        if (res) {
          this.audio.fire();
          this.particles.burst(hand, vsclNew(f, -1), 8, { speed:2.4, color:[0.8,0.8,0.82,0.5], life:0.28, size:0.07, grav:0.1 });
          P.rollVel += 1.6; P.fovKick += 2.2;
        }
      }
      if (this.input.jumpPressed && !R.attached) this.audio.jump();
    }
    // Pump-/Reel-Eingang
    P.pumpInput = (this.input.forward?1:0) - (this.input.back?1:0);
    P.reelDir = this.input.reelDir || 0;
    if (this.input.slideHeld && R.attached) P.pumpInput *= 0.4;

    // 1) Körper
    W.stepBodies(dt);

    // 2) Haken (ballistisches Projektil)
    const hand = this.orbit ? P.handPoint(this._hand || (this._hand = v3()), R)
                            : this.ropeOriginPoint(this._hand || (this._hand = v3()), false);
    if (H.state !== 'idle') {
      /* Der Haken hängt am Seil, und das Seil kommt aus der Mündung — also
         ist die Mündung in jeder Phase sein Bezugspunkt (Seilzug im Flug,
         Pendelschranke und Einroll-Ende beim Rückholen).                   */
      const ev = H.step(dt, R, hand);
      if (ev) this.onHookEvent(ev);
    }

    // 3) Seil (Pfad, Budget, Impuls, Kette)
    const chest = P.chestPoint(this._chest || (this._chest = v3()));
    R.visualHand = hand;
    R.setPlayerCapsule(P.pos, P.p.radius, P.hh);
    R.step(dt, chest, (H.flying || H.state === 'retract') ? H.pos : null, P.vel);

    // 4) Spieler
    const pev = P.update(dt, this.input, R);
    if (pev) this.onPlayerEvent(pev);

    // 5) Seil-Ereignisse → FX
    for (const e of R.drainEvents()) this.onRopeEvent(e);

    // 6) Audio aus physikalischen Zustandsgrößen
    this.audio.update(R, P.vel);
    W.stats.raycasts = 0;
  }

  onHookEvent(ev) {
    if (ev.type === 'anchor') {
      const s = clamp(ev.speed/60, 0.2, 1);
      this.audio.anchor(s);
      this.particles.burst(ev.p, ev.n, 22, { speed:5.5*s, color:[0.86,0.84,0.78,0.95], life:0.55, size:0.12, spread:0.7 });
      this.particles.burst(ev.p, ev.n, 10, { speed:2.2, color:[1.0,0.72,0.30,0.9], life:0.3, size:0.09, grav:0.2 });
      this.player.fovKick += 3.0*s; this.player.dipVel += 2.0*s;
      this.flash = 0.5*s;
    } else if (ev.type === 'bounce') {
      this.audio.bounce();
      this.particles.burst(ev.p, ev.n, 8, { speed:3.0, color:[1.0,0.85,0.5,0.85], life:0.28, size:0.08 });
    } else if (ev.type === 'miss') {
      this.audio.retract();
    } else if (ev.type === 'retracted') {
      /* Haken ist in der Hand angekommen: jetzt erst wird das Seil gelöst. */
      this.rope.detach();
    }
  }
  onPlayerEvent(ev) {
    if (ev.type === 'land') {
      this.audio.land(ev.strength);
      this.particles.burst([this.player.pos[0], this.player.feetY+0.05, this.player.pos[2]], [0,1,0],
        Math.floor(6+22*ev.strength), { speed:2.2+4*ev.strength, color:[0.82,0.80,0.75,0.6], life:0.5, size:0.16, spread:1.6, up:0.6, grav:0.7 });
    } else if (ev.type === 'jump' || ev.type === 'walljump') {
      this.particles.burst([this.player.pos[0], this.player.feetY+0.05, this.player.pos[2]], [0,1,0],
        7, { speed:1.6, color:[0.85,0.85,0.85,0.45], life:0.35, size:0.13, spread:1.5, grav:0.5 });
    }
  }
  onRopeEvent(ev) {
    if (ev.type === 'detach') { this.audio.retract(); if (this.hook.state === 'stuck') this.hook.state = 'retract'; }
    if (ev.type === 'fire') {}
  }

  /* -------------------------------- Kamera ------------------------------- */
  updateCamera(dt) {
    const P = this.player, R = this.rope;
    const speed = vlen(P.vel);
    let fov = this.fovBase + smoothstep(7, 34, speed)*13 + P.fovKick*0.9;
    if (R.attached && R.slack <= 0) fov += 2.5*R.tensionLevel;
    this.fov = fov;

    if (this.orbit) {
      const cp = Math.cos(this.orbitPitch), sp = Math.sin(this.orbitPitch);
      const cy = Math.cos(this.orbitYaw), sy = Math.sin(this.orbitYaw);
      const cpos = [P.pos[0] + sy*cp*this.orbitDist, P.pos[1] + 0.6 + sp*this.orbitDist, P.pos[2] + cy*cp*this.orbitDist];
      const tgt = [P.pos[0], P.pos[1]+0.35, P.pos[2]];
      this.r.setCameraRaw(cpos, vsubNew(tgt, cpos), [0,1,0], clamp(this.fov-6, 45, 110));
      this.camQuat = null;
    } else {
      const eye = P.eyePoint(this._eye || (this._eye = v3()));
      // Roll aus Spieler-Roll + leichter Seilzug-Neigung
      qFromYawPitch(P.quat, P.yaw, P.pitch);
      qRotateLocal(P.quat, P.quat, 0, 0, 1, P.roll*0.055);
      this.r.setCamera(eye, P.quat, this.fov);
      this.camQuat = P.quat;
      // exakt die Kamera-Transform merken: das Viewmodel wird DARAN starr
      // aufgehängt, damit es nie gegen die Kamera gegenläuft
      if (!this._camEye) this._camEye = v3();
      vcopy(this._camEye, eye);
    }
  }

  /* ------------------------------- Rendering ----------------------------- */
  render(dt) {
    const r = this.r, W = this.world, P = this.player, R = this.rope, H = this.hook;
    const t0 = performance.now();
    r.begin();
    r.drawSky();

    if (!this.orbit) R.visualHand = this.ropeOriginPoint(this._ropeOrigin || (this._ropeOrigin = v3()), true);

    /* Welt */
    for (const b of W.statics) r.pushAABB(b, b.color, 0.22);
    for (const b of W.bodies) {
      r.pushAABB(b, b.color, b.kinematic ? 0.55 : 0.35);
      // Akzentkante auf dynamischen Körpern
      r.pushBoxC([b.pos[0], b.max[1]+0.02, b.pos[2]], [b.half[0]*2.02, 0.05, b.half[2]*2.02], C.yellow, 0.6);
    }
    r.flushBoxes(true);

    /* Anker-Marker + Haken */
    if (H.state !== 'idle') this.drawHook(r);
    if (R.attached) {
      const s = 0.16 + 0.1*R.tensionLevel;
      r.pushBoxC(R.anchor, [s,s*0.6,s], [1.0, 0.35, 0.15], 0.9);
    }

    /* Seil */
    this.drawRope(r);
    r.flushBoxes(false);
    r.flushRope();

    /* Partikel + Debug */
    this.particles.render(r);
    r.flushParticles();
    if (this.debug) { this.drawDebug(r); r.flushBoxes(false); }   // Debug-Boxen
    //                                                        VOR dem Viewmodel-Pass flushen
    r.flushLines();

    /* Kein Viewmodel. Ein First-Person-Arm aus Box-Primitiven erreicht keine
       vertretbare Qualität und verdeckt nur das eigentliche Testobjekt.
       Eine ernsthafte Umsetzung braucht ein geriggtes Mesh (glTF) mit
       Animations-Clips und IK-Retargeting — das wird hier bewusst NICHT
       mit Platzhaltern angetäuscht.                                          */
    if (this.orbit) { this.drawPlayerBody(r); r.flushBoxes(false); }

    this.perf.render = performance.now() - t0;
    if (this.flash > 0) { this.flash = Math.max(0, this.flash - dt*2.6); }
    if (this.dom && this.dom.flashEl) this.dom.flashEl.style.opacity = (this.flash*0.42).toFixed(3);
  }

  drawHook(r) {
    const H = this.hook;
    let dir;
    if (H.state === 'stuck' && H.aimNormal) dir = vnegNew(H.aimNormal);
    else if (vlenSq(H.vel) > 1e-4) dir = vnormSafe(H.vel);
    else dir = [0,-1,0];
    const up = Math.abs(dir[1]) > 0.9 ? [1,0,0] : [0,1,0];
    const side = vnormSafe(vcross(v3(), dir, up));
    const up2 = vcross(v3(), side, dir); vnorm(up2, up2);
    const base = vsubNew(H.pos, vsclNew(dir, 0.10));
    const tip  = vaddNew(H.pos, vsclNew(dir, 0.34));
    // Schaft
    pushOriented(r, base, tip, 0.085, [0.30,0.31,0.34], 0.95);
    // drei Klauen
    for (let i = 0; i < 3; i++) {
      const a = H.spin + i*Math.PI*2/3;
      const off = vaddNew(vsclNew(side, Math.cos(a)*0.11), vsclNew(up2, Math.sin(a)*0.11));
      const p0 = vaddNew(base, off), p1 = vaddNew(vaddNew(tip, vsclNew(dir, 0.10)), vsclNew(off, 0.35));
      pushOriented(r, p0, p1, 0.035, [0.72,0.74,0.78], 1.0);
    }
    // Kopf
    r.pushBoxC(base, [0.16,0.16,0.16], [0.85,0.30,0.12], 0.9);
    // Flugspur
    // Flugspur aus dem Ringpuffer (ältester → neuester Eintrag)
    if (H.flying && H._trailBuf) {
      const N = 14, start = H._trailN;
      for (let k = 1; k <= Math.min(N, start); k++) {
        const idx = ((start - k) % N + N) % N;
        const f = 1 - k/N;
        r.particle(H._trailBuf[idx], [1.0, 0.72, 0.35, 0.40*f], 0.055*f);
      }
    }
  }

  drawRope(r) {
    const R = this.rope;
    if (R.phase === 0) { this._ropeCount = 0; return; }
    const curve = R.buildRenderCurve(this._curve);
    /* Keine Voranstellung: die Kurve beginnt in jeder Phase exakt am
       Ketten-Pin, und der Pin ist die Kamera-Mündung (siehe _stepChain).
       Vorangestellte Punkte wären deckungsgleich mit dem Kurvenstart und
       erzeugten Null-Segmente mit undefinierter Bandgeometrie — sichtbar
       als Knick/Wulst direkt vor der Linse.                                 */
    const n = curve.count;
    const total = n;
    const buf = this._ropeBuf;
    buf.set(curve.buf.subarray(0, n*3), 0);
    this._ropeCount = total;

    const cam = r.camPos;
    const tl = R.tensionLevel;
    r.ropeColA = [0.20,0.19,0.21];
    r.ropeColB = [0.95,0.93,0.89];
    const widthFn = (u, i) => {
      const px = buf[i*3], py = buf[i*3+1], pz = buf[i*3+2];
      const d = Math.sqrt((px-cam[0])**2 + (py-cam[1])**2 + (pz-cam[2])**2);
      // Mindestbreite in Bildschirmpixelnähe → kein Flackern bei Distanz
      const base = Math.max(0.052 + 0.022*tl, Math.max(0.02, d*0.0022)) * (u > 0.965 ? 1.5 : 1.0);
      // Nahfeld: ein 5-cm-Band in 0.4 m Abstand füllt ~8 % der Bildhöhe → zur Kamera hin verjüngen
      const near = Math.min(1, Math.max(0, (d - 0.30) / 1.4));
      return base * (0.25 + 0.75*near*near*(3 - 2*near));
    };
    const tensionFn = (u, i) => tl;
    r.rope(buf, total, widthFn, tensionFn);   // Kollisionsgarantie liegt in buildRenderCurve()
    // Last-Vibration: ein gespanntes Seil unter hoher Last zittert minimal.
    // Rein additive Auslenkung senkrecht zur Blicklinie — verändert keine Physik.
    if (tl > 0.25 && total > 6) {
      const amp = 0.011 * (tl-0.25)/0.75 * Math.min(1, vlen(this.player.vel)/18);
      const ph = this.time * 46;
      for (let i = 2; i < total-1; i++) {
        const w = Math.sin(i/(total-1)*Math.PI);            // an den Enden 0
        buf[i*3+1] += Math.sin(ph + i*1.7) * amp * w;
      }
    }
  }

  drawPlayerBody(r) {
    const P = this.player;
    qFromYawPitch(P.quat, P.yaw, 0);
    const fwd = qForward(v3(), P.quat), right = qRight(v3(), P.quat);
    const feet = P.feetY;
    const h = P.hh*2 + P.p.radius*2;
    // Torso
    r.pushBoxC([P.pos[0], feet + h*0.55, P.pos[2]], [0.42, h*0.52, 0.28], [0.86,0.24,0.16], 0.4);
    // Beine
    r.pushBoxC([P.pos[0], feet + h*0.22, P.pos[2]], [0.34, h*0.44, 0.26], [0.20,0.21,0.24], 0.3);
    // Kopf
    r.pushBoxC([P.pos[0], feet + h*0.88, P.pos[2]], [0.22,0.24,0.22], [0.90,0.88,0.85], 0.3);
    // Arm zum Seil
    const R = this.rope;
    if (R.phase !== 0) {
      const sh = [P.pos[0], feet + h*0.72, P.pos[2]];
      const tgt = R.phase === 1 ? R.hookPos : R.anchor;
      const d = vnormSafe(vsubNew(tgt, sh));
      pushOriented(r, sh, vaddNew(sh, vsclNew(d, 0.62)), 0.07, [0.86,0.24,0.16], 0.4);
    }
  }

  /* -------------------------------- Debug -------------------------------- */
  drawDebug(r) {
    const R = this.rope, P = this.player;
    // Pfad-Polyline
    if (R.phase !== 0 && R.path.pts.length >= 2) {
      for (let i = 0; i < R.path.pts.length-1; i++) {
        const col = (R.path.segLens[i] > 0.01) ? [0.2,1.0,0.45,1] : [1,0.2,0.2,1];
        r.line(R.path.pts[i], R.path.pts[i+1], col);
      }
      // Wrap-Kontakte
      for (const w of R.path.wraps) {
        r.pushBoxC(w.p, [0.22,0.22,0.22], [1.0,0.85,0.1], 0.9);
        r.line(w.p, vaddNew(w.p, vsclNew(w.n, 0.8)), [1,1,0.2,1]);
        r.line(w.p0, w.p1, [0.3,1,1,0.8]);
      }
      // Anker
      r.line(R.anchor, vaddNew(R.anchor, vsclNew(R.anchorNormal, 1.2)), [1,0.3,0.15,1]);
      // Constraint-Normale + Pivot
      const piv = R.pivotPoint(v3());
      r.line(P.pos, piv, [1.0,0.2,1.0,0.9]);
      r.pushBoxC(piv, [0.16,0.16,0.16], [1.0,0.2,1.0], 0.9);
      const nOut = vnegNew(R.path.dirStart);
      r.line(P.pos, vaddNew(P.pos, vsclNew(nOut, 1.6)), [1.0,0.55,0.0,1]);
    }
    // Kette (jeder Node ist frei simuliert; nur die Enden sind gepinnt)
    const Cch = R.chain;
    for (let i = 0; i < Cch.n; i++) {
      const end = (i === 0 || i === Cch.n-1);
      r.particle(Cch.pos[i], end ? [0.2,0.9,1.0,0.98] : [1.0,0.75,0.2,0.7], end ? 0.085 : 0.05);
      if (i > 0) r.line(Cch.pos[i-1], Cch.pos[i], [1.0,0.7,0.2,0.25]);
    }
    // Aim-Kegel
    if (this.aimTarget) {
      r.line(P.eyePoint(v3()), this.aimTarget.p, [1,1,1,0.25]);
      r.pushBoxC(this.aimTarget.p, [0.14,0.14,0.14], [0.3,1,0.5], 0.9);
    }
  }

  /* --------------------------------- HUD --------------------------------- */
  buildUI() {
    const d = {};
    const q = (id) => document.getElementById(id);
    ['phase','budget','required','slack','tension','speed','wraps','fps','phys','ray','nodes','mode','hint','reticle','lockHint','help','panel','spots','barSlack','barTension','lookmode']
      .forEach(id => d[id] = q(id));
    this.dom = d;

    // Tuning-Panel
    const spec = [
      ['Seil / Physik', null],
      ['rope.p.settleReelSpeed','Setz-Einzug (m/s)',2,80,1],
      ['rope.p.tautMargin','Spiel im straffen Zustand (m)',0,1.5,0.01],
      ['rope.p.capacity','Seilvorrat (m)',8,90,1],
      ['rope.p.baumgarteBeta','Constraint-Bias β',0,1,0.01],
      ['rope.p.maxBiasSpeed','max. Bias-Geschw. (m/s)',0,40,0.5],
      ['rope.p.elasticity','Elastizität',0,1,0.01],
      ['rope.p.restitution','Rückprall am Seilende',0,0.6,0.01],
      ['rope.p.wrapClearance','Kanten-Clearance (m)',0,0.6,0.01],
      ['rope.p.wrapReleaseHold','Wrap-Hysterese (s)',0,0.4,0.005],
      ['Seil / Darstellung', null],
      ['rope.p.chainSpacing','Ketten-Node-Abstand (m)',0.15,1.5,0.05],
      ['rope.p.chainIterations','Ketten-Iterationen',1,24,1],
      ['rope.p.chainDrag','Ketten-Luftwiderstand',0,4,0.05],
      ['rope.p.chainFriction','Ketten-Reibung an Geometrie',0,1,0.05],
      ['rope.p.chainNodeRadius','Ketten-Node-Radius (m)',0.02,0.3,0.005],
      ['Bewegung', null],
      ['player.p.groundMaxSpeed','Laufgeschwindigkeit (m/s)',3,18,0.1],
      ['player.p.jumpSpeed','Sprunggeschw. (m/s)',4,16,0.1],
      ['player.p.swingAirAccel','Luftkontrolle am Seil',0,80,1],
      ['player.p.ropeWrapFriction','Capstan-Reibung an Umlenkung',0,6,0.05],
      ['player.p.pumpTorque','Pump-Kraft',0,40,0.5],
      ['player.p.pumpReel','Reel-Pumping (m/s)',0,4,0.05],
      ['Haken', null],
      ['hook.p.speed','Abschussgeschw. (m/s)',20,120,1],
      ['hook.p.inherit','Trägheit (Spielerimpuls)',0,1,0.01],
      ['hook.p.gravityScale','Gravitation am Haken',0,2,0.05],
      ['hook.p.drag','Luftwiderstand',0,0.4,0.0002],
      ['hook.p.assistAngle','Suchkegel (°)',0,30,0.5,DEG],
      ['Welt', null],
      ['world.gravity','Gravitation (m/s²)',-40,-6,0.5],
      ['sens','Maus-Sensitivität',0.0004,0.006,0.0001],
      ['freeLookSensScale','Sensitivität ohne Zeigersperre',0.4,5,0.1],

      ['fovBase','FOV',55,115,1],
    ];
    const panel = d.panel;
    for (const item of spec) {
      if (item[1] === null) {
        const h = document.createElement('div'); h.className = 'grp'; h.textContent = item[0];
        panel.appendChild(h); continue;
      }
      /* [Pfad, Label, min, max, Schritt, Einheit] — `Einheit` ist optional und
         rechnet Anzeige → gespeicherten Wert um (DEG für Winkel). Sie wird beim
         Schreiben UND beim Anzeigen benutzt, damit der Regler immer den echten
         Wert zeigt und der echte Wert immer erreichbar ist. */
      const [path, label, min, max, step, unit] = item;
      const row = document.createElement('label'); row.className = 'row';
      const shown = this._get(path) / (unit || 1);
      const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))));  // Genauigkeit des Schritts
      row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${shown}"><b>${shown.toFixed(digits)}</b>`;
      const inp = row.querySelector('input'), out = row.querySelector('b');
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        this._set(path, v * (unit || 1));
        out.textContent = v.toFixed(digits);
      });
      panel.appendChild(row);
    }
    // A/B-Schalter
    const toggles = [
      ['rope.p.wrapPhysics','Pfad-Wrapping (Physik)','AUS = naive Luftlinien-Constraint'],
      ['rope.p.rigidRod','Starre Stange (zweiseitig)','AUS = korrektes einseitiges Seil'],
      ['rope.p.chainCollideWorld','Ketten-Kollision Welt','AUS = Seil läuft durch feste Geometrie (Referenz)'],
      ['rope.p.chainCollidePlayer','Ketten-Kollision Körper',''],
    ];
    // Anzeige-Schalter (Debug, Orbit)
    const vbox = document.createElement('div'); vbox.className = 'grp'; vbox.textContent = 'Anzeige';
    panel.appendChild(vbox);
    for (const [key, label, note] of [
      ['debug','Debug-Overlay','F1 — Pfad, Kontakte, Kette, Constraint-Normale'],
      ['orbit','Orbit-Kamera','V — Seil von außen betrachten'],
    ]) {
      const row = document.createElement('label'); row.className = 'row tog';
      row.innerHTML = `<span>${label}</span><input type="checkbox" ${this[key]?'checked':''}><b></b>`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => { this[key] = cb.checked; });
      if (note) row.title = note;
      panel.appendChild(row);
    }

    const tbox = document.createElement('div'); tbox.className = 'grp'; tbox.textContent = 'A/B: naive Referenz-Ansätze';
    panel.appendChild(tbox);
    for (const [path, label, note] of toggles) {
      const row = document.createElement('label'); row.className = 'row tog';
      row.innerHTML = `<span>${label}</span><input type="checkbox" ${this._get(path)?'checked':''}><b></b>`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => { this._set(path, cb.checked); });
      if (note) row.title = note;
      panel.appendChild(row);
    }
    // Szenario-Spawns (oben mittig, aktiver Spot hervorgehoben)
    const sp = d.spots;
    this.level.spots.forEach((s, i) => {
      const b = document.createElement('button');
      b.textContent = `${i+1} · ${s.name}`;
      b.title = 'Szenario teleportieren';
      b.onclick = () => this.teleport(i);
      sp.appendChild(b);
    });
    this.spotIndex = -1;
    this.markSpot();
    d.mode.textContent = 'Hybrid';
    this.updateLookModeLabel();
  }
  _get(path) {
    const parts = path.split('.'); let o = this;
    for (const p of parts) o = o[p];
    return o;
  }
  _set(path, v) {
    const parts = path.split('.'); let o = this;
    for (let i = 0; i < parts.length-1; i++) o = o[parts[i]];
    o[parts[parts.length-1]] = v;
  }

  updateHUD(dt) {
    const R = this.rope, P = this.player, d = this.dom;
    // Aim-Reticle (30 Hz)
    this.aimTimer -= dt;
    if (this.aimTimer <= 0) {
      this.aimTimer = 1/30;
      if (!this.orbit && R.phase === 0) {
        const eye = P.eyePoint(this._eye || (this._eye = v3()));
        qFromYawPitch(P.quat, P.yaw, P.pitch);
        const f = qForward(v3(),P.quat), u = qUp(v3(),P.quat), rr = qRight(v3(),P.quat);
        // Reticle zeigt EXAKT das, was der Schuss tun würde: bei aimAssist = 0
        // (Default) ist das schlicht der Strahl durchs Fadenkreuz.
        if (this.hook.p.aimAssist > 0) this.aimTarget = this.hook.findAnchor(eye, f, u, rr);
        else {
          const h = this.world.raycast(eye, f, this.hook.p.maxRange, { hookOnly: true, minT: 0.2 });
          // raycast liefert ein geteiltes Ergebnis → fürs HUD kopieren
          this.aimTarget = h ? World.copyHit(this._aimCopy || (this._aimCopy = this.world.makeHit()), h) : null;
        }
      } else this.aimTarget = null;
    }
    if (this.aimTarget && this.r.project(this.aimTarget.p, this._screen)) {
      const dist = vdist(P.pos, this.aimTarget.p);
      d.reticle.style.display = 'block';
      d.reticle.style.left = this._screen[0] + 'px';
      d.reticle.style.top = this._screen[1] + 'px';
      d.reticle.textContent = `${dist.toFixed(0)}m`;
    } else d.reticle.style.display = 'none';

    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.08;
    d.phase.textContent = PHASE_NAME[R.phase];
    d.phase.dataset.active = R.attached ? '1' : '0';
    d.budget.textContent = R.budget.toFixed(2) + ' m';
    d.required.textContent = R.required.toFixed(2) + ' m';
    d.slack.textContent = (R.slack >= 0 ? '+' : '') + R.slack.toFixed(2) + ' m';
    d.slack.dataset.neg = R.slack < 0 ? '1' : '0';
    d.tension.textContent = (R.activeForce||0).toFixed(0) + ' N';
    d.speed.textContent = vlen(P.vel).toFixed(1) + ' m/s';
    d.wraps.textContent = `${R.path.wraps.length} Kontakt${R.path.wraps.length===1?'':'e'} · ${R.path.pts.length-1} Segm.`;
    d.fps.textContent = this.perf.fps.toFixed(0);
    d.phys.textContent = `${this.perf.phys.toFixed(2)} ms · ${this.substeps} Substeps`;
    d.ray.textContent = `${(this.world.stats.raycasts||0)}`;
    d.nodes.textContent = `${R.chain.n} Nodes · ${R.path.stats.clears} Tests`;
    const slackFrac = clamp01(1 - Math.abs(R.slack)/Math.max(1,R.budget));
    d.barSlack.style.width = (R.phase===0?0:slackFrac*100) + '%';
    d.barTension.style.width = (R.tensionLevel*100).toFixed(0) + '%';
    d.mode.textContent = (!R.p.wrapPhysics ? 'NAIV: Luftlinie' : '') + (R.p.rigidRod ? ' + starre Stange' : '');
    if (!d.mode.textContent) d.mode.textContent = 'Hybrid (Pfad + einseitige Constraint + geführte Kette)';
  }
}

/* --------------------------------- Boot ----------------------------------- */
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('gl');
  const hint = document.getElementById('lockHint');
  let game;
  try {
    game = new Game(canvas);
  } catch (e) {
    hint.innerHTML = '<div><b>FEHLER</b>' + (e && e.message ? e.message : String(e)) +
      '<div class="sm">Dieser Prototyp benötigt WebGL2.</div></div>';
    hint.style.display = 'flex';
    console.error(e);
    return;
  }
  game.dom.flashEl = document.getElementById('flash');

  // Start-Overlay → Pointer-Lock
  hint.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    hint.style.display = 'none';
    // Zeigersperre anfordern. Es wird NICHT vorweggenommen, dass sie scheitert —
    // der Browser meldet das selbst über pointerlockerror / das ausbleibende
    // pointerlockchange, und dann zeigt das HUD den RMB-Fallback an.
    try {
      const pr = canvas.requestPointerLock();
      if (pr && pr.catch) pr.catch(() => game.reportLockUnavailable());
    } catch (err) { game.reportLockUnavailable(); }
    game.audio.init(); game.audio.resume();
  });
  document.addEventListener('pointerlockchange', () => {
    hint.style.display = (document.pointerLockElement === canvas) ? 'none' : 'flex';
  });
  // Panels sollen keinen Pointer-Lock auslösen und keine Schüsse verursachen
  ['tune','spots','uibar','tele','help'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('mousedown', e => e.stopPropagation());
  });

  window.game = game;
  game.start();
});

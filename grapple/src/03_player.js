/* =============================================================================
   03_player.js — Physikbasierter Player-Controller + ballistischer Grapple-Hook
   -----------------------------------------------------------------------------
   Der Controller ist ein klassischer "Accelerate + Gravity + Move-and-Slide"-
   Charakter auf Kapselbasis, aber konsequent IMPULS-basiert: alle externen
   Einflüsse (Seil, Vault, Wallrun) ändern Geschwindigkeit/Kraft, niemals die
   Position. Deshalb kann das Seil den Spieler beliebig schnell schleudern —
   die Quake-artige `accelerate()`-Funktion kappt nur die ZUFUHR oberhalb des
   Tempolimits, nicht den vorhandenen Impuls.
   ========================================================================== */
'use strict';

const PLAYER_DEFAULTS = {
  radius: 0.36, halfHeight: 0.50, eyeOffset: 0.74,
  crouchHH: 0.20,
  groundAccel: 92, groundMaxSpeed: 9.8,
  airAccel: 17,    airMaxSpeed: 11.0,
  groundFriction: 9.0,
  jumpSpeed: 9.5,
  coyoteTime: 0.12, jumpBuffer: 0.15,
  slide: { friction: 1.05, minSpeed: 5.6, time: 1.5, boost: 1.18 },
  wallRun: { enabled: true, minSpeed: 6.4, gravityScale: 0.10, duration: 1.3,
             stick: 11.0, jumpSpeed: 9.2, jumpAway: 6.8, climb: 3.2 },
  vault: { enabled: true, minHeight: 0.30, maxHeight: 2.40, strength: 34, damping: 9.0, duration: 0.6 },
  landHardSpeed: 13.5,
  airDrag: 0.0006,       // 1/m — quadratischer Luftwiderstand (Fallschirmspringer
                         //       wären 0.0032; hier bewusst dezent)
  ropeWrapFriction: 1.6, // 1/(s·rad) — Capstan-Reibung an Umlenkkontakten,
                         //       wirkt nur entlang des Längengradienten.
                         //       Gemessen: 0.55 ergibt ~1.4/s Abklingrate — gegenüber
                         //       groundAccel 92 wirkungslos (Gleichgewicht ~64 m/s).
                         //       1.6 ⇒ ~4/s bei 150° Wrap: Umkreisen fühlt sich an
                         //       wie Reibung, nicht wie Eis.
  // --- Seil-Interaktion ---
  swingAirAccel: 30,     // Luftkontrolle während des Schwingens (deutlich, aber nicht dominant)
  swingMaxSpeed: 26,     // Tempolimit für swing-Accelerate
  pumpTorque: 13.0,      // direktes tangentiales Pumpen (Gewichtsverlagerung)
  pumpBrakeScale: 0.30,  // Anteil, wenn die Eingabe Energie entziehen würde
  pumpReel: 0.55,        // m    Amplitude des Reel-Pumpens (± um das Budget)
  pumpReelMinSpeed: 5.0, // erst ab dieser Tangentialgeschwindigkeit "einziehen"
  detachBoost: 0.0,      // 0 = reiner Impulserhalt (empfohlen)
};

/** Quake-artiges Accelerate: erhält Impuls über dem Limit, füllt nur darunter auf. */
function accelerate(vel, wishDir, wishSpeed, accel, dt) {
  const cur = vdot(vel, wishDir);
  const add = wishSpeed - cur;
  if (add <= 0) return 0;
  const s = Math.min(accel * dt, add);
  vel[0] += wishDir[0]*s; vel[1] += wishDir[1]*s; vel[2] += wishDir[2]*s;
  return s;
}

class Player {
  constructor(world, params) {
    this.world = world;
    this.p = Object.assign({}, PLAYER_DEFAULTS, params || {});
    this.pos = v3(0, 3, 0);
    this.vel = v3(0, 0, 0);
    this.yaw = 0; this.pitch = 0;
    this.quat = qid();
    this.res = { contacts: [], contactCount: 0 };
    this.grounded = false; this.wasGrounded = false;
    this.groundNormal = v3(0,1,0); this.groundBody = null;
    this.wallNormal = null; this.wallBody = null;
    this.coyote = 0; this.jumpBuf = 0; this.ropeJumpUsed = false; this._jumpCut = false;
    this.sliding = false; this.slideT = 0;
    this.wallRunT = 0; this.wallRunSide = 0;
    this.vaultT = 0; this.vaultTarget = v3(); this.vaulting = false;
    this.hh = this.p.halfHeight;
    this.eye = v3(); this.chest = v3(); this.hand = v3();
    this.handSmooth = v3();
    this.bobPhase = 0; this.dip = 0; this.dipVel = 0;
    this.roll = 0; this.rollVel = 0;
    this.fovKick = 0; this.landFlash = 0;
    this.lastLandSpeed = 0;
    this.speed = 0; this.hSpeed = 0;
    this.swingEnergy = 0;
    this.airTime = 0;
    this._wish = v3(); this._tmp1 = v3(); this._tmp2 = v3(); this._tmp3 = v3();
    this._fwd = v3(); this._right = v3(); this._up = v3();
    this.reelDir = 0;
    this.wasAttached = false;
    this.pumpInput = 0;
    this.lastGroundBody = null;
    this.platformDelta = v3();
    this.prevVel = v3();
    this.accel = v3();
    this.bobAmp = 0;
    this._event = null;
  }

  get feetY() { return this.pos[1] - this.hh - this.p.radius; }

  spawn(p, yaw = 0) {
    vcopy(this.pos, p); this.vel[0]=this.vel[1]=this.vel[2]=0;
    this.yaw = yaw; this.pitch = 0;
    this.sliding = false; this.vaulting = false; this.wallRunT = 0;
  }

  look(dx, dy, sens) {
    this.yaw   -= dx * sens;
    this.pitch -= dy * sens;
    this.pitch = clamp(this.pitch, -1.45, 1.45);
    if (this.yaw > Math.PI) this.yaw -= Math.PI*2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI*2;
  }

  /* ---------------------------------------------------------------------- */
  update(dt, input, rope) {
    const P = this.p, W = this.world;
    this._event = null;
    vcopy(this.prevVel, this.vel);
    qFromYawPitch(this.quat, this.yaw, this.pitch);
    qForward(this._fwd, this.quat); qRight(this._right, this.quat); qUp(this._up, this.quat);

    // horizontale Projektion der Blickrichtung für Bodensteuerung
    const fwdH = this._fwdH || (this._fwdH = v3());
    vset(fwdH, this._fwd[0], 0, this._fwd[2]);
    if (vnorm(fwdH, fwdH) < 1e-5) vset(fwdH, 0, 0, -1);
    const rightH = this._rightH || (this._rightH = v3());
    // right = cross(forward, up) = (−fz, 0, fx)
    vset(rightH, -fwdH[2], 0, fwdH[0]);

    let mx = (input.right?1:0) - (input.left?1:0);
    let mz = (input.forward?1:0) - (input.back?1:0);
    const wish = this._wish;
    wish[0] = fwdH[0]*mz + rightH[0]*mx;
    wish[1] = 0;
    wish[2] = fwdH[2]*mz + rightH[2]*mx;
    const wl = vlen(wish);
    if (wl > 1e-5) { wish[0]/=wl; wish[1]/=wl; wish[2]/=wl; } else vset(wish, 0,0,0);

    const attached = rope && rope.attached;
    // Beim Übergang in den Seil-Zustand den Sprung-Puffer verwerfen: ein kurz
    // VOR dem Feuern gedrücktes Space würde sonst im selben Moment das frisch
    // verankerte Seil wieder lösen (spürbar als "Seil reißt sofort ab").
    if (attached && !this.wasAttached) { this.jumpBuf = 0; this.ropeJumpUsed = false; }   // Puffer nicht mitbringen
    this.wasAttached = attached;
    const speed = vlen(this.vel);
    this.speed = speed;
    this.hSpeed = Math.hypot(this.vel[0], this.vel[2]);

    /* ---- Sprung-Puffer & Coyote ---- */
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.coyote  = Math.max(0, this.coyote - dt);
    if (input.jumpPressed) this.jumpBuf = P.jumpBuffer;

    /* ---- Slide ---- */
    if (input.slide && this.grounded && !this.sliding && this.hSpeed > P.slide.minSpeed) {
      this.sliding = true; this.slideT = P.slide.time;
      this.vel[0] *= P.slide.boost; this.vel[2] *= P.slide.boost;
    }
    if (this.sliding) {
      this.slideT -= dt;
      if (!input.slideHeld || this.slideT <= 0 || this.hSpeed < 1.6 || !this.grounded) {
        /* Aufstehen nur, wenn Platz ist. Die Platzprobe MUSS aufliegenden
           Bodenkontakt ignorieren: eine auf dem Boden ruhende Kapsel berührt
           ihn exakt im Abstand radius — jeder POSITIVE Pad macht daraus eine
           "Durchdringung" und das Aufstehen schlägt für immer fehl (gemessen:
           sliding bleibt 6 s+ wahr bei v=0, der Slide wurde endlos). Ein
           NEGATIVER Pad verlangt echte Überlappung (>3 cm), bevor er blockt:
           ruhender Kontakt zählt nicht, eine niedrige Decke schon.
           Getestet wird die STehhaltung UM DEN FUSSPUNKT (Zentrum = aktueller
           Fußpunkt + halfHeight + radius), nicht am eingezogenen Zentrum —
           sonst „durchdringt" die stehende Kapsel den Boden immer, weil sie
           um die Einzugshöhe zu tief sitzt.                                */
        const oldHH = this.hh;
        this.hh = P.halfHeight;
        const tp = this._tmp1;
        vcopy(tp, this.pos); tp[1] += P.halfHeight - oldHH;
        if (W.capsulePenetrates(tp, P.radius, this.hh, -0.03)) this.hh = oldHH;
        else { this.sliding = false; vcopy(this.pos, tp); }
      }
    }
    const targetHH = this.sliding ? P.crouchHH : P.halfHeight;
    const hhPrev = this.hh;
    this.hh = damp(this.hh, targetHH, 22, dt);
    /* Haltungswechsel dreht um die FÜSSE, nicht um den Kapselmittelpunkt:
       ohne Ausgleich hebt das Schrumpfen der Kapsel die Füße an und der
       Spieler gilt für einen Substep als airborne — der Slide ist daran
       sofort gestorben (gemessen: grounded=false im Trigger-Substep, Slide
       endet nach 0.01 s). Der Ausgleich ist keine Teleportie: er hält die
       Aufstandsfläche stetig fest, während die Haltung wechselt.          */
    this.pos[1] -= hhPrev - this.hh;

    /* ---- Wallrun-Erkennung ---- */
    const wr = P.wallRun;
    const canWallRun = wr.enabled && !this.grounded && this.wallNormal &&
                       this.hSpeed > wr.minSpeed && this.vel[1] < 4.5 && wl > 0.1;
    if (canWallRun && this.wallRunT < wr.duration) {
      if (this.wallRunT <= 0) { this.wallRunSide = sign(vdot(this.wallNormal, this._right) || 1); this.rollVel += -this.wallRunSide*3.2; }
      this.wallRunT += dt;
    } else if (this.grounded) this.wallRunT = 0;
    else this.wallRunT += dt * 0.35;
    const wallRunning = canWallRun && this.wallRunT < wr.duration;

    /* ======================= KRÄFTE / BESCHLEUNIGUNGEN ===================== */
    let gScale = 1.0;

    if (this.grounded) {
      /* Bodenbewegung gilt IMMER — auch mit eingehaktem Seil. Das Seil ist eine
         zusätzliche Constraint, kein anderer Bewegungszustand. Man läuft also
         ganz normal los und wird erst abgebremst, wenn das Seil wirklich straff
         wird. (Vorher wurde am Boden mit Seil komplett eingefroren — das war
         falsch und nirgends gefordert.)                                     */
      const fr = this.sliding ? P.slide.friction : P.groundFriction;
      /* Quake-artige Reibung MIT Coulomb-Anteil. Der vorherige Term
         `max(0, speed - 0.6)` hatte eine Totzone: unter 0.6 m/s wirkte gar
         keine Reibung mehr, man rutschte also endlos mit Schritttempo weiter
         — das ist das "Eis"-Gefühl. `control` garantiert eine Mindestdruck-
         kraft, dadurch kommt man tatsächlich zum Stehen.                     */
      const control = Math.max(speed, this.sliding ? 5.0 : 1.4);
      const drop = control * fr * dt;
      const sc = speed > 1e-5 ? Math.max(0, speed - drop) / speed : 0;
      this.vel[0]*=sc; this.vel[1]*=sc; this.vel[2]*=sc;
      const maxS = this.sliding ? P.groundMaxSpeed*1.45 : P.groundMaxSpeed;
      accelerate(this.vel, wish, maxS, this.sliding ? P.groundAccel*0.35 : P.groundAccel, dt);
      // Sprung am Boden: ganz normal, AUCH mit eingehaktem Seil. Das Seil wird
      // dabei ausdrücklich NICHT gelöst — gelöst wird nur bewusst (LMB loslassen / R).
      if (this.jumpBuf > 0) {
        this.vel[1] = P.jumpSpeed;
        if (this.sliding) this.sliding = false;
        this.jumpBuf = 0; this.grounded = false; this.coyote = 0; this._jumpCut = false;
        this._event = { type:'jump', p: vclone(this.pos) };
      }
    } else if (wallRunning) {
      // Wallrun: Gravitation fast aus, Geschwindigkeit an die Wand projizieren,
      // leichter Vortrieb entlang der Wand, Anpresskraft zur Wand.
      gScale = wr.gravityScale;
      const n = this.wallNormal;
      const vn = vdot(this.vel, n);
      if (vn < 0) { this.vel[0]-=n[0]*vn; this.vel[1]-=n[1]*vn; this.vel[2]-=n[2]*vn; }
      // entlang der Wand (Blickrichtung auf die Wandebene projiziert)
      const t = this._tmp1; vcopy(t, this._fwd);
      const tn = vdot(t, n); t[0]-=n[0]*tn; t[1]-=n[1]*tn; t[2]-=n[2]*tn;
      if (vnorm(t, t) > 1e-4) accelerate(this.vel, t, wr.minSpeed*1.55, P.groundAccel*0.8, dt);
      // Anpressen
      this.vel[0] -= n[0]*wr.stick*dt; this.vel[1] -= n[1]*wr.stick*dt; this.vel[2] -= n[2]*wr.stick*dt;
      if (this.vel[1] < -1.2) this.vel[1] += wr.climb*dt*3;
      if (this.jumpBuf > 0) {
        this.vel[1] = wr.jumpSpeed;
        this.vel[0] += n[0]*wr.jumpAway; this.vel[2] += n[2]*wr.jumpAway;
        this.wallRunT = P.wallRun.duration; this.jumpBuf = 0; this._jumpCut = false;
        this.rollVel += this.wallRunSide*4.5;
        this._event = { type:'walljump', p: vclone(this.pos) };
      }
    } else if (attached) {
      /* -------- SEIL-INTERAKTION: Luftkontrolle + Pumpen (siehe Doku) ----- */
      const pivot = rope.pivotPoint(this._tmp2);
      const r = vsub(this._tmp3, this.pos, pivot);          // Pivot → Spieler
      const rLen = vlen(r) || 1e-5;
      const rHat = vscl(this._tmp3, r, 1/rLen);

      // 1) Richtungs-Luftkontrolle (gedämpft, damit Physik dominant bleibt)
      if (wl > 0.1) {
        const t = this._tmp1; vcopy(t, wish);
        const tn = vdot(t, rHat); t[0]-=rHat[0]*tn; t[1]-=rHat[1]*tn; t[2]-=rHat[2]*tn;
        if (vnorm(t, t) > 1e-4) accelerate(this.vel, t, P.swingMaxSpeed, P.swingAirAccel, dt);
      }
      /* 2) Gewichtsverlagerungs-Pumpen: Kraft tangential zur Pendelebene.
            Phasenbewusst: wirkt voll, wenn sie Energie ZUFÜHRT, und nur zu 30 %,
            wenn sie Energie entziehen würde. Ein echter Spieler zieht im
            richtigen Moment — ohne das müsste man auf den Zehntelsekunden-
            genauen Zeitpunkt achten, und Pumpen fühlt sich zufällig an.
            Bewusstes Abbremsen bleibt trotzdem möglich (die 30 %).            */
      if (Math.abs(this.pumpInput) > 0.01) {
        const f = this._tmp1; vcopy(f, this._fwd);
        const fn = vdot(f, rHat); f[0]-=rHat[0]*fn; f[1]-=rHat[1]*fn; f[2]-=rHat[2]*fn;
        if (vnorm(f, f) > 1e-4) {
          const vTan = vslide(this._tmp2, this.vel, rHat);
          const adds = (f[0]*vTan[0] + f[1]*vTan[1] + f[2]*vTan[2]) * this.pumpInput;
          const gain = (vlenSq(this.vel) < 1.0 || adds >= 0) ? 1.0 : P.pumpBrakeScale;
          const a = P.pumpTorque * this.pumpInput * gain;
          this.vel[0]+=f[0]*a*dt; this.vel[1]+=f[1]*a*dt; this.vel[2]+=f[2]*a*dt;
        }
      }
      // 3) Smartes Reel-Pumping: SEIL KÜRZEN am unteren Totpunkt (hohe
      //    Tangentialgeschwindigkeit), NACHLASSEN am Umkehrpunkt.
      //    Das ist exakt die Mechanik eines echten Schaukel-Pumpens:
      //    Arbeit wird nur im richtigen Phasenmoment verrichtet, die Amplitude
      //    wächst über WINKELIMPULS-ERHALTUNG (L·ω = const) — kein Fake-Boost.
      //    Die Modulation ist nullmittelnd, das Budget driftet also nicht.
      if (Math.abs(this.pumpInput) > 0.01) {
        const vTan = vlen(vslide(this._tmp1, this.vel, rHat));
        const phase = smoothstep(P.pumpReelMinSpeed, P.swingMaxSpeed*0.85, vTan);
        rope.pumpOffset = damp(rope.pumpOffset || 0, P.pumpReel * this.pumpInput * (1 - 2*phase), 5.5, dt);
      } else rope.pumpOffset = damp(rope.pumpOffset || 0, 0, 10, dt);
      // 4) manuelles Rollen (Q/E gehalten) — Mausrad wird diskret im Input behandelt
      if (this.reelDir !== 0) rope.reel(this.reelDir * rope.p.manualReelSpeed * dt);
      // 5) Sprung am Seil: KEIN Lösen. Man springt und bleibt eingehakt —
      //    sonst ist Schwingen mit Absprung praktisch unmöglich. Gelöst wird
      //    ausschließlich bewusst (Taste loslassen / R).
      //    ABER: genau EIN Seilsprung pro Einhänge- oder Bodenkontakt. Ohne
      //    diese Schranke war jede neue Sprungflanke (schon der Tastatur-
      //    Autorepeat bei gehaltener Leertaste) ein voller Vertikalimpuls am
      //    Seil = beliebiges Fliegen (Nutzer-Fund).
      if (this.jumpBuf > 0) {
        if (!this.ropeJumpUsed) {
          this.vel[1] = P.jumpSpeed;
          this.ropeJumpUsed = true;
          this._jumpCut = false;
          this._event = { type:'ropejump', p: vclone(this.pos) };
        }
        this.jumpBuf = 0;
      }
      gScale = 1.0;
    } else {
      // freie Luft
      if (wl > 0.1) accelerate(this.vel, wish, P.airMaxSpeed, P.airAccel, dt);
      if (this.jumpBuf > 0 && this.coyote > 0) {
        this.vel[1] = P.jumpSpeed; this.jumpBuf = 0; this.coyote = 0; this._jumpCut = false;
        this._event = { type:'jump', p: vclone(this.pos) };
      }
    }

    /* ---- Vault / Ledge-Assist (Kraft, keine Positions-Teleportie) ---- */
    this.vaulting = false;
    if (P.vault.enabled && !this.grounded && !attached && this.wallNormal && !this.sliding) {
      const vt = this._probeLedge();
      if (vt) { this.vaulting = true; this.vaultT = P.vault.duration; vcopy(this.vaultTarget, vt); }
    }
    if (this.vaulting && this.vaultT > 0) {
      this.vaultT -= dt;
      const k = P.vault.strength, c = P.vault.damping;
      const t = this.vaultTarget;
      this.vel[0] += ((t[0]-this.pos[0])*k - this.vel[0]*c*0.55) * dt;
      this.vel[1] += ((t[1]-this.pos[1])*k - this.vel[1]*c*0.35) * dt;
      this.vel[2] += ((t[2]-this.pos[2])*k - this.vel[2]*c*0.55) * dt;
      gScale *= 0.15;
      if (this.vaultT <= 0) this.vaulting = false;
    }

    /* ---- Jump-Cut: variable Sprunghöhe ----
       Loslassen im Aufstieg kappt die Steiggeschwindigkeit einmalig um 45 %:
       Tippen = kurzer Hopser, Halten = voller Sprung. Standard für gutes
       Plattform-Feel, fehlte bisher völlig.
       `input.jumpHeld === false` bewusst nur bei EXPLIZIT gemeldetem Feld:
       Test-Harnesses ohne jumpHeld behalten das Vollsprung-Verhalten.      */
    if (!this.grounded && input.jumpHeld === false && !this._jumpCut && this.vel[1] > 2.0) {
      this.vel[1] *= 0.55;
      this._jumpCut = true;
    }

    /* ---- Gravitation ---- */
    this.vel[1] += W.gravity * gScale * dt;

    /* ---- Luftwiderstand ----
       Ohne den fühlt sich alles reibungsfrei an: einmal angeschoben, bleibt der
       Impuls ewig. Quadratisch ⇒ bei Lauf-Tempo kaum spürbar, beim schnellen
       Schwingen deutlich.                                                    */
    if (!this.grounded) {
      const sp = vlen(this.vel);
      if (sp > 1e-4) {
        const dec = Math.min(sp, P.airDrag * sp * sp * dt) / sp;
        this.vel[0] -= this.vel[0]*dec; this.vel[1] -= this.vel[1]*dec; this.vel[2] -= this.vel[2]*dec;
      }
    }
    /* ---- Seilreibung an Umlenkkontakten (Capstan-Effekt) ----
       Läuft das Seil um Kanten, kostet das GLEITEN des Seils über die Kante
       Energie — und nur das. Gleiten heißt: die Pfadlänge ändert sich, also
       wirkt die Reibung entlang des Längengradienten n = −dirStart (derselbe
       Vektor, den die Constraint benutzt). Die alte Formel dämpfte die ganze
       Geschwindigkeit und bremste damit Fall und Pendelschwung quer zum Seil
       (Parallel-Befund: „Capstan bremst auch Fall und Pendel"); ein Pendeln
       UM die Umlenkung herum ist aber gleitfrei, solange sich die Länge nicht
       ändert. Gemessen im Wand-Pendel (Test 6b): alt verlor 91 % der
       Tangentialgeschwindigkeit in 1,5 s, neu < 25 %.                      */
    if (attached && rope.tensionLevel > 0.15) {
      const ang = rope.totalWrapAngle();
      if (ang > 0.02) {
        const n = this._capN || (this._capN = v3());
        vneg(n, rope.path.dirStart);
        const vn = vdot(this.vel, n);
        const k = Math.exp(-P.ropeWrapFriction * ang * rope.tensionLevel * dt);
        const cut = vn * (1 - k);
        this.vel[0] -= n[0]*cut; this.vel[1] -= n[1]*cut; this.vel[2] -= n[2]*cut;
      }
    }

    /* ---- SEIL-CONSTRAINT (einseitig, auf Geschwindigkeitsebene) ----
       Mit Bodennormale: solange der Spieler steht, hält das Seil NUR
       horizontal — sonst saugt die Bias-Korrektur ihn am steilen Seil in
       die Luft (gemessen: y 10.9 → 17.3 m beim Rückwärtslaufen).        */
    if (attached) rope.constrainPlayer(this.vel, dt, this.grounded ? this.groundNormal : null);

    /* ---- Integrieren + Kollision ---- */
    this.wasGrounded = this.grounded;
    this.lastGroundBody = this.groundBody;
    W.moveCapsule(this.pos, this.vel, dt, P.radius, this.hh, this.res,
                  { stepHeight: this.sliding ? 0.25 : 0.62 });
    this.grounded = this.res.grounded;
    if (this.grounded) { this.coyote = P.coyoteTime; this.airTime = 0; this.ropeJumpUsed = false; }
    else this.airTime += dt;
    if (this.grounded && this.wallRunT > 0 && !this.res.wallNormal) this.wallRunT = 0;
    this.wallNormal = this.res.wallNormal;
    this.wallBody = this.res.wallBody;
    if (this.grounded) vcopy(this.groundNormal, this.res.groundNormal || [0,1,0]);

    // Mitnahme auf kinematischen Plattformen
    if (this.grounded && this.groundBody && this.groundBody.dynamic) {
      const b = this.groundBody;
      const dx = b.pos[0]-b.prevPos[0], dy = b.pos[1]-b.prevPos[1], dz = b.pos[2]-b.prevPos[2];
      this.pos[0]+=dx; this.pos[1]+=dy; this.pos[2]+=dz;
      vset(this.platformDelta, dx,dy,dz);
    } else vset(this.platformDelta, 0,0,0);

    // Constraint noch einmal NACH der Bewegung (Kollision kann Velocity geändert haben)
    if (attached) rope.constrainPlayer(this.vel, dt, this.grounded ? this.groundNormal : null);

    /* ---- Landung ---- */
    if (this.grounded && !this.wasGrounded) {
      this.lastLandSpeed = Math.abs(this.vel[1]) + this.airTime*2;
      const impact = clamp((this.lastLandSpeed - 6) / 22, 0, 1);
      if (impact > 0.02) {
        this.dipVel -= impact * 9.5;
        this.fovKick -= impact * 7;
        this.landFlash = impact;
        this._event = { type:'land', p: vclone(this.pos), strength: impact };
      }
    }
    if (this.grounded) this.landFlash = damp(this.landFlash, 0, 8, dt);

    /* ---- Kamera-Folgeeffekte (rein visuell, beeinflussen keine Physik) ---- */
    this.dipVel += (-this.dip * 190 - this.dipVel * 22) * dt;
    this.dip += this.dipVel * dt;
    this.dip = clamp(this.dip, -0.55, 0.35);
    this.rollVel += (-this.roll * 130 - this.rollVel * 13) * dt;
    this.roll += this.rollVel * dt;
    // Neigung aus realer lateraler Beschleunigung (G-Kraft-Gefühl)
    const idt = 1/Math.max(1e-5, dt);
    vset(this.accel, (this.vel[0]-this.prevVel[0])*idt, (this.vel[1]-this.prevVel[1])*idt, (this.vel[2]-this.prevVel[2])*idt);
    const latAcc = vdot(this.accel, this._right);
    this.rollVel += clamp(-latAcc*0.010, -0.9, 0.9) * dt * 7;
    // Seilzug → leichte Roll-Neigung zum Anker hin
    if (attached && rope.tensionLevel > 0.2) {
      const toA = vsub(this._tmp2, rope.anchor, this.pos); vnorm(toA, toA);
      const side = vdot(toA, this._right);
      this.rollVel += clamp(side * rope.tensionLevel * 2.2, -2, 2) * dt;
    }
    this.fovKick = damp(this.fovKick, 0, 5.5, dt);
    const bobAmt = (this.grounded && !this.sliding ? 1 : 0.18) * smoothstep(0.5, 9, this.hSpeed);
    this.bobPhase += dt * (5.2 + this.hSpeed * 0.62);
    this.bobAmp = bobAmt * 0.030;
    return this._event || null;
  }

  /** Ledge-Probe: findet eine erreichbare Oberkante vor dem Spieler. */
  _probeLedge() {
    const P = this.p, W = this.world;
    const n = this.wallNormal; if (!n) return null;
    const fwd = this._fwd;
    // vor der Wand, in Blickrichtung
    const px = this.pos[0] - n[0]*(P.radius+0.22) + fwd[0]*0.25;
    const pz = this.pos[2] - n[2]*(P.radius+0.22) + fwd[2]*0.25;
    const feet = this.feetY;
    const top = feet + P.vault.maxHeight + 0.6;
    const hit = W.raycast([px, top, pz], [0,-1,0], P.vault.maxHeight + 1.4, { minT: 1e-3 });
    if (!hit) return null;
    const h = top - hit.t;
    const dh = h - feet;
    if (dh < P.vault.minHeight || dh > P.vault.maxHeight) return null;
    if (this.vel[1] > 3.2) return null;             // wir steigen eh schon
    const target = [px, h + P.halfHeight + P.radius + 0.12, pz];
    // Platz oben?
    if (W.capsulePenetrates(target, P.radius*0.92, P.halfHeight*0.8, 0.0)) return null;
    return target;
  }

  /** Brustpunkt = physikalischer Angriffspunkt des Seils (stabil, kein Blick-Jitter). */
  chestPoint(out) {
    out[0] = this.pos[0]; out[1] = this.pos[1] + this.hh*0.55; out[2] = this.pos[2];
    return out;
  }
  /** Augen-/Kamerapunkt inkl. Bob, Dip und Slide. */
  eyePoint(out) {
    qFromYawPitch(this.quat, this.yaw, this.pitch);
    qRight(this._right, this.quat); qUp(this._up, this.quat);
    const bobY = Math.sin(this.bobPhase*2) * (this.bobAmp||0);
    const bobX = Math.cos(this.bobPhase) * (this.bobAmp||0) * 0.6;
    const h = this.sliding ? this.p.eyeOffset*0.52 : this.p.eyeOffset;
    out[0] = this.pos[0] + this._right[0]*bobX + this._up[0]*(bobY + this.dip*0.35);
    out[1] = this.pos[1] + h + bobY + this.dip;
    out[2] = this.pos[2] + this._right[2]*bobX + this._up[2]*(bobY + this.dip*0.35);
    return out;
  }
  /** Sichtbare Hand (Viewmodel) — streckt sich zum Anker, wenn das Seil hält. */
  handPoint(out, rope) {
    const eye = this.eyePoint(this._tmp1);
    qFromYawPitch(this.quat, this.yaw, this.pitch);
    qRight(this._right, this.quat); qForward(this._fwd, this.quat); qUp(this._up, this.quat);
    let tx, ty, tz;
    if (rope && rope.phase !== 0) {
      const d = vsub(this._tmp2, rope.phase === 1 ? rope.farEndRef() : rope.anchor, eye);
      vnorm(d, d);
      // Arm streckt sich in Richtung Seil, bleibt aber leicht rechts/unten (FPV-Pose)
      const reach = 0.58;
      tx = d[0]*reach + this._right[0]*0.115 - this._up[0]*0.055;
      ty = d[1]*reach + this._right[1]*0.115 - this._up[1]*0.055;
      tz = d[2]*reach + this._right[2]*0.115 - this._up[2]*0.055;
    } else {
      // Arm deutlich VOR dem Körper: bei der engen Viewmodel-Projektion muss
      // alles einen positiven Abstand zur Kameraebene haben, sonst fliegt es
      // perspektivisch aus dem Bild.
      tx = this._fwd[0]*0.62 + this._right[0]*0.185 - this._up[0]*0.155;
      ty = this._fwd[1]*0.62 + this._right[1]*0.185 - this._up[1]*0.155;
      tz = this._fwd[2]*0.62 + this._right[2]*0.185 - this._up[2]*0.155;
    }
    // Trägheit der Hand → sichtbares Nachziehen bei schnellen Bewegungen
    out[0] = eye[0] + tx; out[1] = eye[1] + ty; out[2] = eye[2] + tz;
    this.handSmooth[0] = damp(this.handSmooth[0], out[0], 26, 1/60);
    this.handSmooth[1] = damp(this.handSmooth[1], out[1], 26, 1/60);
    this.handSmooth[2] = damp(this.handSmooth[2], out[2], 26, 1/60);
    return out;
  }
}

/* =============================================================================
   GRAPPLE-HOOK — Projektil mit echter Ballistik
   ========================================================================== */
const HOOK_DEFAULTS = {
  speed: 62,            // m/s Abschussgeschwindigkeit
  inherit: 0.42,        // Anteil der Spielergeschwindigkeit (Trägheit!)
  gravityScale: 1.0,    // volle Gravitation → echte Wurfparabel
  drag: 0.0026,         // quadratischer Luftwiderstand 1/m (Haken = kompaktes Metall)
  maxRange: 46,
  maxFlightTime: 2.6,
  aimAssist: 0,          // 0 = AUS. Der Haken fliegt exakt in Blickrichtung, es wird
                         //     NICHT um-geaimt. >0 schaltet eine optionale Zielhilfe
                         //     in Grad Kegelaufweitung ein (Accessibility, default aus).
  assistAngle: 12 * DEG, // Suchkegel (nur wirksam, wenn aimAssist > 0)
  assistWide: 34 * DEG,  // Suchkegel im 2. Pass
  minAnchorDist: 1.5,    // m — nicht direkt in der eigenen Hand verankern
  assistRays: 26,
  minNormalDot: -1.0,    // KEINE Flächenbeschränkung: jede Oberfläche darf Anker sein
                         //     (Böden, Decken, Rückseiten). Wo die Hand hinzeigt,
                         //     darf das Seil hin — es gibt keine physikalische Grenze.
  stickFacing: 0.12,    // cos(83°) — nur echte Streifschüsse prallen ab
  minStickSpeed: 1.5,
  restitution: 0.34,
  maxBounces: 2,
  retractSpeed: 46,
  mass: 1.6,            // kg — für Seilzug am Haken
  spin: 22,
};

class Hook {
  constructor(world, params) {
    this.world = world;
    this.p = Object.assign({}, HOOK_DEFAULTS, params || {});
    this.state = 'idle';       // idle | flying | stuck | retract
    this.pos = v3(); this.vel = v3();
    this.t = 0; this.bounces = 0; this.spin = 0; this.traveled = 0;
    this.aimPoint = null; this.aimBox = null; this.aimNormal = null;
    this.quat = qid();
    this.lastFireOrigin = v3();
    this.trail = [];           // kurze Positions-Historie für FX
    this.charge = 0;
  }
  get active() { return this.state === 'flying' || this.state === 'stuck' || this.state === 'retract'; }
  get flying() { return this.state === 'flying'; }

  /* -------------------------- Ankerwahl (Aim Assist) --------------------- */
  /**
   * Wählt den besten Anker in einem Suchkegel um die Blickrichtung.
   * Bewertung: Winkelabstand zum Fadenkreuz, Distanz, Flächenorientierung,
   * und ob die ballistische Flugbahn tatsächlich frei ist.
   */
  findAnchor(origin, fwd, up, right, assistDeg) {
    const P = this.p;
    const cone = (assistDeg != null ? assistDeg*DEG : P.assistAngle);
    // 1. Pass: enger Kegel um das Fadenkreuz
    let best = this._scanCone(origin, fwd, up, right, fwd, cone, P.assistRays*1.4);
    if (best) return best;
    // 2. Pass: deutlich weiter fassen. Bewertet wird weiterhin gegen die echte
    //    Blickrichtung, also gewinnt immer noch der Kandidat, der am nächsten
    //    am Fadenkreuz liegt. Ohne diesen Pass findet man beim Blick nach unten
    //    oder knapp daneben gar nichts — der Haken würde dann bloß direkt vor
    //    den Füßen in den Boden schlagen und zurückprallen.
    return this._scanCone(origin, fwd, up, right, fwd, Math.max(cone*2.4, P.assistWide), P.assistRays*3);
  }

  /** Ein Suchkegel (Golden-Angle-Spirale). `refDir` = Referenz für das Scoring. */
  _scanCone(origin, coneDir, up, right, refDir, halfAngle, N) {
    const P = this.p, W = this.world;
    let bestScore = Infinity;
    // raycast() liefert ein WIEDERVERWENDETES Ergebnis — der beste Treffer muss
    // kopiert werden, sonst zeigt `best` am Ende auf den letzten Strahl.
    const best = this._bestHit || (this._bestHit = { t:0, p:v3(), n:v3(), box:null, body:null });
    let haveBest = false;
    const dir = this._scanDir || (this._scanDir = v3());
    for (let i = 0; i <= N; i++) {
      let d;
      if (i === 0) d = coneDir;
      else {
        const ang = halfAngle * Math.sqrt(i / N);
        const phi = i * 2.39996;
        const sa = Math.sin(ang), ca = Math.cos(ang);
        vset(dir,
          coneDir[0]*ca + (right[0]*Math.cos(phi) + up[0]*Math.sin(phi))*sa,
          coneDir[1]*ca + (right[1]*Math.cos(phi) + up[1]*Math.sin(phi))*sa,
          coneDir[2]*ca + (right[2]*Math.cos(phi) + up[2]*Math.sin(phi))*sa);
        d = dir;
      }
      const hit = W.raycast(origin, d, P.maxRange, { hookOnly: true, minT: P.minAnchorDist });
      if (!hit) continue;
      const n = hit.n;
      const facing = -(n[0]*d[0] + n[1]*d[1] + n[2]*d[2]);
      if (facing < P.minNormalDot) continue;          // default −1 ⇒ nie einschränkend
      const angCost = Math.acos(clamp(vdot(d, refDir), -1, 1)) / Math.max(1e-4, P.assistAngle);
      const distCost = hit.t / P.maxRange;
      // Reine Nähe zum Fadenkreuz entscheidet — keine Höhen-/Flächenwertung,
      // die würde die Auswahl wieder in bestimmte Winkel drängen.
      const score = angCost*1.0 + distCost*0.10 - facing*0.05;
      if (score < bestScore) { bestScore = score; World.copyHit(best, hit); haveBest = true; }
    }
    return haveBest ? best : null;
  }

  /* ---------------------- Ballistische Ziellösung ------------------------ */
  /**
   * Exakte Lösung für "mit welchem Startvektor trifft ein Wurfkörper bei
   * gegebener Abschussgeschwindigkeit `s` den Punkt `target`?"
   *   0.25·g²·u² − (dy·g + s²)·u + |d|² = 0 ,  u = t²
   * Kleinere Wurzel = flachere, schnellere Bahn (besseres Spielgefühl).
   */
  solveBallistic(origin, target, speed, out) {
    const g = this.world.gravity * this.p.gravityScale;
    const dx = target[0]-origin[0], dy = target[1]-origin[1], dz = target[2]-origin[2];
    const d2 = dx*dx+dy*dy+dz*dz;
    const A = 0.25*g*g;
    const B = -(dy*g + speed*speed);
    const C = d2;
    const disc = B*B - 4*A*C;
    let tf;
    if (disc < 0 || A < 1e-9) {
      // unerreichbar → direkt anvisieren (Haken fällt dann einfach kürzer)
      const l = Math.sqrt(d2) || 1;
      tf = Math.max(0.05, l / speed);
    } else {
      const sq = Math.sqrt(disc);
      const u1 = (-B - sq) / (2*A);
      const u2 = (-B + sq) / (2*A);
      const u = (u1 > 1e-6) ? u1 : u2;
      tf = Math.sqrt(Math.max(1e-4, u));
    }
    tf = clamp(tf, 0.05, 3.0);
    out[0] = dx/tf;
    out[1] = (dy - 0.5*g*tf*tf)/tf;
    out[2] = dz/tf;
    return tf;
  }

  /**
   * Drag-kompensierte Ziellösung.
   * Die analytische Wurfparabel gilt nur ohne Luftwiderstand. Da der Haken aber
   * spürbar abgebremst werden soll (er darf nicht "mathematisch gerade" wirken),
   * iterieren wir die Startgeschwindigkeit gegen die ECHTE Simulation:
   *   v ← v + (Ziel − Landepunkt) / Flugzeit
   * Das ist eine Fixpunktiteration über eine glatte Abbildung und konvergiert
   * in wenigen Schritten. Ergebnis: physikalisch glaubwürdige Bahn MIT Drag,
   * die trotzdem zuverlässig genau den anvisierten Punkt trifft.
   */
  solveBallisticDrag(origin, target, speed, out, tfGuess) {
    const P = this.p, W = this.world;
    let tf = this.solveBallistic(origin, target, speed, out);
    if (tfGuess) tf = tfGuess;
    const p = v3(), v = v3();
    const g = W.gravity * P.gravityScale;
    const sub = 26;
    for (let it = 0; it < 5; it++) {
      vcopy(p, origin); vcopy(v, out);
      const dt = tf / sub;
      for (let k = 0; k < sub; k++) {
        const sp = vlen(v);
        const df = P.drag * sp * dt;
        v[0] -= v[0]*df; v[1] -= v[1]*df; v[2] -= v[2]*df;
        v[1] += g*dt;
        p[0] += v[0]*dt; p[1] += v[1]*dt; p[2] += v[2]*dt;
      }
      const ex = target[0]-p[0], ey = target[1]-p[1], ez = target[2]-p[2];
      const err = Math.sqrt(ex*ex+ey*ey+ez*ez);
      if (err < 0.01) break;
      out[0] += ex/tf; out[1] += ey/tf; out[2] += ez/tf;
    }
    return tf;
  }

  /** Prüft, ob die berechnete Flugbahn frei ist (sonst nächsten Kandidaten). */
  trajectoryClear(origin, vel, tf) {
    const W = this.world, g = W.gravity * this.p.gravityScale, P = this.p;
    const steps = 12; let prev = vclone(origin);
    const p = v3(), v = vclone(vel); const dt = tf/steps;
    for (let i = 1; i <= steps; i++) {
      const sp = vlen(v), df = P.drag*sp*dt;
      v[0]-=v[0]*df; v[1]-=v[1]*df; v[2]-=v[2]*df; v[1]+=g*dt;
      p[0]+=v[0]*dt; p[1]+=v[1]*dt; p[2]+=v[2]*dt;
      const d = vsubNew(p, prev); const l = vlen(d);
      if (l > 1e-4) {
        const hit = W.raycast(prev, vsclNew(d, 1/l), l*0.97, { minT: 1e-3 });
        if (hit && i < steps) return { clear:false, hit };
      }
      vcopy(prev, p);
    }
    return { clear:true };
  }

  /* --------------------------------- Fire -------------------------------- */
  fire(origin, fwd, up, right, playerVel, rope) {
    const P = this.p;
    if (this.state === 'flying') return false;
    const v = v3();
    /* Der Haken fliegt EXAKT in Blickrichtung. Keine Winkelbegrenzung, kein
       Um-aimen, keine Flächenfilter. Wo die Hand hinzeigt, darf das Seil hin —
       es gibt dafür keine physikalische Grenze. Die Flugbahn entsteht dann
       ausschließlich aus Abschussgeschwindigkeit + Trägheit + Gravitation.
       `aimAssist > 0` ist eine optionale, abschaltbare Zielhilfe (default AUS). */
    let target = null, hit = null;
    if (P.aimAssist > 0) {
      hit = this.findAnchor(origin, fwd, up, right, P.aimAssist);
      if (hit) { target = hit.p; this.solveBallisticDrag(origin, target, P.speed, v); }
    }
    if (!target) vscl(v, fwd, P.speed);
    // Trägheit: Spielergeschwindigkeit wird mitgegeben
    v[0] += playerVel[0]*P.inherit; v[1] += playerVel[1]*P.inherit; v[2] += playerVel[2]*P.inherit;

    vcopy(this.pos, origin);
    vcopy(this.vel, v);
    vcopy(this.lastFireOrigin, origin);
    this.state = 'flying'; this.t = 0; this.bounces = 0; this.traveled = 0;
    this.trail.length = 0;
    rope.beginFlight(this.pos);
    return { v: vclone(v), target: target ? vclone(target) : null, hit };
  }

  retractNow(rope) {
    if (this.state === 'idle') {
      /* Seil hängt ohne aktiven Haken (Randfall/Tests): nichts, was einrollen
         könnte — sofort lösen. */
      if (rope && rope.phase !== ROPE_PHASE.IDLE) rope.detach();
      return;
    }
    this.state = 'retract';
    this.t = 0;
    /* Das Seil bleibt VERBUNDEN und rollt ein (Kabelstaubsauger): der Haken
       hängt am Seilende und folgt dem gelösten Pfad zurück, auch über die
       Kanten, über die das Seil beim Abschuss gelegt wurde. Ein sofortiges
       detach ließ den Haken früher als getrenntes Projektil geradeaus zur
       Hand fliegen, während das Seil verschwand — „als wäre es abgeschnitten". */
    if (rope && rope.startRetract) rope.startRetract();
  }

  /* --------------------------------- Step -------------------------------- */
  step(dt, rope, handPos) {
    const P = this.p, W = this.world;
    if (this.state === 'idle') return null;
    this.t += dt;
    this.spin += dt * P.spin * (this.state === 'flying' ? 1 : 0.1);

    if (this.state === 'retract') {
      const d = this._rt || (this._rt = v3());
      vsub(d, handPos, this.pos);
      const l = vlen(d);
      if (l < 0.55 || this.t > 8) { this.state = 'idle'; return { type:'retracted' }; }
      const amSeil = rope && rope.phase === ROPE_PHASE.RETRACT;
      if (amSeil && rope.retractPos) {
        /* Straffes Seil: der Pfad ist die Autorität — der Haken sitzt auf dem
           Bogenpunkt der verfügbaren Länge und rutscht damit über dieselben
           Kanten zurück, über die das Seil hinausgelegt wurde.             */
        const px = this.pos[0], py = this.pos[1], pz = this.pos[2];
        vcopy(this.pos, rope.retractPos);
        const il = 1/Math.max(1e-6, dt);
        this.vel[0] = (this.pos[0]-px)*il; this.vel[1] = (this.pos[1]-py)*il; this.vel[2] = (this.pos[2]-pz)*il;
      } else if (amSeil) {
        /* Schlaffes Seil: der Haken pendelt als Körper am Ende — Gravitation,
           Luftwiderstand, und die Seilschranke (Abstand zur Hand ≤ Budget). */
        const px0 = this.pos[0], py0 = this.pos[1], pz0 = this.pos[2];
        const g = W.gravity * P.gravityScale;
        this.vel[1] += g * dt;
        const sp = vlen(this.vel);
        const dragF = P.drag * sp * 0.5;
        this.vel[0] -= this.vel[0]*dragF*dt; this.vel[1] -= this.vel[1]*dragF*dt; this.vel[2] -= this.vel[2]*dragF*dt;
        this.pos[0] += this.vel[0]*dt; this.pos[1] += this.vel[1]*dt; this.pos[2] += this.vel[2]*dt;
        /* Pfad-Schranke (nicht Luftlinie!): der Haken bleibt auf der Seite
           der Umlenkungen und folgt beim Einrollen über dieselben Kanten. */
        if (rope.constrainFreeEnd(this.pos, handPos)) {
          const il2 = 1/Math.max(1e-6, dt);
          this.vel[0] = (this.pos[0]-px0)*il2; this.vel[1] = (this.pos[1]-py0)*il2; this.vel[2] = (this.pos[2]-pz0)*il2;
        }
      } else {
        /* Ohne Seil (Fallback): gerade zur Hand, wie früher. */
        const s = P.retractSpeed * dt;
        vscl(d, d, Math.min(1, s/l));
        this.pos[0]+=d[0]; this.pos[1]+=d[1]; this.pos[2]+=d[2];
      }
      return null;
    }
    if (this.state === 'stuck') {
      // Haken sitzt auf einem bewegten Körper → mit dem Anker mitwandern
      if (rope && rope.anchorBody && rope.attached) vcopy(this.pos, rope.anchor);
      return null;
    }

    /* ---- ballistischer Flug mit Substeps + Seilzug ---- */
    const g = W.gravity * P.gravityScale;
    let remaining = dt, guard = 0;
    while (remaining > 1e-6 && guard++ < 8) {
      const sp = vlen(this.vel);
      const sub = sp > 1e-3 ? Math.min(remaining, 0.30/sp) : remaining;

      // Luftwiderstand (quadratisch)
      const dragF = P.drag * sp;
      this.vel[0] -= this.vel[0]*dragF*sub;
      this.vel[1] -= this.vel[1]*dragF*sub;
      this.vel[2] -= this.vel[2]*dragF*sub;
      // Gravitation
      this.vel[1] += g*sub;

      // Seilzug, wenn das ausgegebene Seil zur Neige geht → der Haken wird
      // ausgebremst und baumelt am Seil (echte Kopplung, kein harter Stopp)
      const dHand = vdist(handPos, this.pos);
      if (rope.phase === 1 && dHand > rope.budget + 0.02) {
        const dir = this._d1 || (this._d1 = v3());
        vsub(dir, handPos, this.pos);
        vnorm(dir, dir);
        const vn = vdot(this.vel, dir);
        if (vn < 0) { this.vel[0]-=dir[0]*vn; this.vel[1]-=dir[1]*vn; this.vel[2]-=dir[2]*vn; }
        // leichter Zug zur Hand (Seilgewicht/Durchhang)
        this.vel[0]+=dir[0]*7*sub; this.vel[1]+=dir[1]*7*sub; this.vel[2]+=dir[2]*7*sub;
      }

      const step = this._step || (this._step = v3());
      vset(step, this.vel[0]*sub, this.vel[1]*sub, this.vel[2]*sub);
      const len = vlen(step);
      const sdir = this._sdir || (this._sdir = v3());
      let hit = null;
      // Distanz-basierte Gnadenfrist (0.6 m): die Hand steckt beim Abfeuern
      // gern mal in Geometrie (Wand im Rücken, Decke, enge Nische) — ohne das
      // würde der Haken sofort "an der eigenen Nase" verankern.
      this.traveled += len;
      if (len > 1e-6 && this.traveled > 0.6) {
        hit = W.raycast(this.pos, vscl(sdir, step, 1/len), len, { minT: 1e-5 });
      }
      if (hit) {
        const tt = Math.max(0, hit.t - 0.008);
        this.pos[0]+=(step[0]/len)*tt;
        this.pos[1]+=(step[1]/len)*tt;
        this.pos[2]+=(step[2]/len)*tt;
        const res = this._onHit(hit, rope);
        if (res) return res;
        remaining -= sub;
        continue;
      }
      this.pos[0]+=step[0]; this.pos[1]+=step[1]; this.pos[2]+=step[2];
      remaining -= sub;
    }

    // Trail für FX (fester Ringpuffer, keine Allokation pro Substep)
    if (!this._trailBuf) { this._trailBuf = []; for (let i=0;i<14;i++) this._trailBuf.push(v3()); this._trailN = 0; }
    const ti = this._trailN % 14;
    vcopy(this._trailBuf[ti], this.pos); this._trailN++;

    // Timeout / Reichweite
    const dist = vdist(handPos, this.pos);
    if (this.t > P.maxFlightTime || dist > P.maxRange*1.25 || this.pos[1] < -30) {
      this.state = 'retract'; this.t = 0; if (rope && rope.startRetract) rope.startRetract();
      return { type:'miss', p: vclone(this.pos) };
    }
    return null;
  }

  _onHit(hit, rope) {
    const P = this.p;
    const n = hit.n;
    const impactSpeed = vlen(this.vel);
    const facing = -(n[0]*this.vel[0] + n[1]*this.vel[1] + n[2]*this.vel[2]) / Math.max(0.01, impactSpeed);
    const hookable = hit.box && hit.box.hookable !== false;
    // Zu streifender Auftreffwinkel oder nicht verankerbar → Abprallen
    if (!hookable || facing < P.stickFacing || impactSpeed < P.minStickSpeed || this.bounces >= P.maxBounces) {
      if (this.bounces >= P.maxBounces || impactSpeed < 3) {
        this.state = 'retract'; this.t = 0; if (rope && rope.startRetract) rope.startRetract();
        return { type:'miss', p: vclone(this.pos), n: vclone(n) };
      }
      this.bounces++;
      vreflect(this.vel, this.vel, n, P.restitution);
      vscl(this.vel, this.vel, 0.62);
      // ein Stück von der Fläche weg, damit wir nicht sofort wieder treffen
      this.pos[0]+=n[0]*0.03; this.pos[1]+=n[1]*0.03; this.pos[2]+=n[2]*0.03;
      return { type:'bounce', p: vclone(this.pos), n: vclone(n), speed: impactSpeed };
    }
    // VERANKERT — ab hier ist die Verbindung physikalisch wirksam
    this.state = 'stuck';
    vcopy(this.pos, hit.p);
    vset(this.vel, 0,0,0);
    this.aimBox = hit.box; this.aimNormal = vclone(n);
    const paid = rope.budget;
    rope.attachAt(hit.p, n, hit.box, hit.body, Math.max(paid, vdist(rope.hand, hit.p)));
    return { type:'anchor', p: vclone(hit.p), n: vclone(n), speed: impactSpeed };
  }
}

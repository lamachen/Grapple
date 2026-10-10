/* =============================================================================
   02_rope.js — DAS SEILSYSTEM
   -----------------------------------------------------------------------------
   Architektur-Kerngedanke: Das Seil ist keine Kette aus N Rigidbodies, sondern
   ein HYBRID aus drei sauber getrennten Schichten, die sich dieselbe Wahrheit
   teilen (eine einzige Seil-Zustandsmaschine):

     (1) TOPOLOGIE / PFAD  — "Wo verläuft das Seil?"
         Kürzester kollisionsfreier Pfad Hand→Anker um Hindernisse herum.
         Persistente Wrap-Kontakte mit Gedächtnis + Hysterese (kein Flackern).
         Liefert: requiredLength, Tangenten, Kontakt-Körper für Rückkräfte.
         Das ist reine Geometrie → deterministisch, jitterfrei, ~0.1 ms.

     (2) DYNAMIK / CONSTRAINT — "Was darf der Spieler?"
         EINE einseitige Constraint  g(x) = requiredLength(x) - budget <= 0
         am Spieler-Körper, gelöst auf GESCHWINDIGKEITSEbene (normale Komponente
         wird entfernt, tangentiale bleibt → echtes Pendel, keine Energie-
         injektion, keine Teleportie). Baumgarte-Bias beseitigt Restüberdehnung.
         Weil der Pfad der KÜRZESTE ist, ist d(required)/d(hand) exakt die
         Endtangente (Hüllkurpensatz) → die Constraint-Normale ist trivial.

     (3) VISUALISIERUNG / KETTE — "Wie sieht es aus?"
         Ein echtes physikalisches Seil: Verlet-Kette mit Schwerkraft,
         Abstands-Constraints (die Kette ist exakt so lang wie das Budget)
         und Welt-Kollision. Die Enden sind gepinnt (Hand, Anker/Haken),
         dazwischen ist alles frei. Dadurch ist sie KONSTRUKTIONSgemäß eine
         einzige stetige Kurve: bei Spiel hängt sie durch und stapelt sich
         auf dem Boden, unter Spannung legt sie sich von selbst an Kanten,
         und nichts teleportiert — Node-Positionen ändern sich ausschließlich
         durch Integration, Constraints und Kollisions-Herausdrücken.

   Nur (1) und (2) bestimmen das Spielgefühl. (3) ist reine Darstellung und darf
   deshalb billig sein — das ist der Grund, warum das System stabil UND schön ist.
   ========================================================================== */
'use strict';

/* -------------------------------------------------------------------------- */
/*  Parameter (alle live im Tuning-Panel änderbar)                             */
/* -------------------------------------------------------------------------- */
const ROPE_DEFAULTS = {
  // Seil-Vorrat / Budget
  capacity:        46.0,   // m  — maximales Seil im Werfer
  feedGain:         1.05,  //    — Seilausgabe pro Bogenlänge der Hakenbahn
  feedBias:         0.7,   // m/s— Grundnachschub (Werfer schiebt leicht nach)
  minBudget:        2.0,   // m  — kürzestes ausgegebenes Seil
  tautMargin:       0.05,  // m  — Restspiel nach dem Setzen (weiches Gefühl)
  settleReelSpeed: 30.0,   // m/s — automatisches Einziehen des Überschusses
  manualReelSpeed: 12.0,   // m/s — Mausrad

  // Spannungsniveau (rein für Darstellung/Audio/Kamera — die Mechanik nutzt
  // ausschließlich slack, nie dieses Maß)
  slackRatioSoft:   0.006, // ab wann "straff"
  slackRatioFull:   0.06,  // ab wann "völlig lose"

  // Constraint
  elasticity:       0.00,  // 0 = starr (unelastisch), >0 = Federanteil
  stretchStiffness:1400.0,
  stretchDamping:   90.0,
  restitution:      0.00,  // 0 = kein Abprallen am Seilende
  baumgarteBeta:    0.45,  // Anteil der Überdehnung, der pro Schritt korrigiert wird
  maxBiasSpeed:     6.0,   // m/s — Cap des Baumgarte-Bias. Der Bias ist eine
                           //       Restfehler-Korrektur, KEIN Zugmittel: was das
                           //       Seil wirklich hält, ist das Entfernen der
                           //       Radialkomponente. Ein hohes Cap würde daraus
                           //       einen Schlag machen, sobald die Welt-Pfadlänge
                           //       sprunghaft wächst (Seil fängt neue Kante).   // m/s — Cap gegen harte Korrekturen. Ein echter
                           //       Routenwechsel (Seil rutscht von einer Kante
                           //       auf die andere) ändert die Länge sprunghaft;
                           //       das ist physikalisch, darf aber nicht reißen.
  breakTension:     0.0,   // 0 = unzerreißbar; sonst Kraft in N

  // Wrap-Pfad
  wrapClearance:    0.14,  // m — Abstand Seilmittellinie zur Kante (= Seildicke)
  wrapMaxCount:     6,
  wrapInsertsPerFrame: 1,  // mehrere Kontakte pro Topologie-Update. Der
                           //        Längensprung wird nicht hier gedämpft, sondern
                           //        über das Bias-Cap der Constraint.
  topologyHz:       60,    // Hz — teure Topologie-Prüfung (Clearance/Insert/Release).
                           //        Die analytische Kontakt-Nachführung läuft dagegen
                           //        mit voller Physik-Rate → gleitende Kontakte bleiben
                           //        butterweich, ohne die Raycast-Kosten zu verdoppeln.
  wrapReleaseHold:  0.085, // s — Hysterese vor dem Loslassen einer Kante. Der
                           //       Halt beim Umkreisen kommt NICHT aus einer
                           //       langen Hysterese (die klebt Kontakte fest und
                           //       bricht die Release-Tests), sondern aus dem
                           //       Nachrollen freigesetzten Spiels (tidy) und
                           //       der Capstan-Reibung am Spieler.

  // Kantenenden: Ein Kontakt, der am ENDE seines Kantenverlaufs ankommt,
  // bleibt dort liegen (das Seil wird um den Eckpunkt geführt). Kann das
  // Seil von der Ecke auf angrenzende Geometrie WEITERRUTSCHEN (Route wird
  // strikt kürzer, Zulauf/Ablauf frei), wird dort ein NEUER Kontakt in
  // Ecknähe angelegt; der alte löst sich über die normale Hysterese. Ein
  // bestehender Kontakt wechselt niemals selbst seine Kante — er springt
  // weder zu einer anderen Ecke noch auf die andere Objektseite.
  cornerSlideReach: 0.8,   // m — so NAH an der Ecke muss die Fortsetzung
                           //        liegen (Rutschen, kein Springen)
  cornerSlideGain:  0.02,  // m — die neue Route muss um mindestens so viel
                           //        kürzer sein (Hysterese gegen Hin-und-her)

  // --- A/B-Schalter gegen naive Referenz-Ansätze (siehe ARCHITEKTUR.md) ---
  wrapPhysics:      true,   // false  = "Luftlinie bleibt Seillänge" (naiv)
  rigidRod:         false,  // true   = zweiseitige Stange statt einseitigem Seil

  // Visualisierungskette (physikalisches Seil: Verlet + Constraints + Kollision)
  /* Die Kette IST die Seilform. Ihre Gesamtlänge ist das ausgegebene Budget —
     die Seillänge ist also eine harte Größe: ist das Seil länger als der
     Pfad, hängt es durch und legt sich auf den Boden; ist es gleich lang,
     zieht die Spannung es von selbst um die Geometrie. Die Node-Zahl folgt
     der Seillänge (chainSpacing), Obergrenze ist der Pool (chainMaxNodes). */
  chainSpacing:     0.45,  // m  — Soll-Abstand der Ketten-Nodes
  chainMaxNodes:    96,    //      — Pool-Obergrenze der Node-Zahl
  chainIterations:  14,    //      — Constraint-Durchläufe pro Physik-Schritt.
                           //        Zusammen mit chainSOR bestimmt das die
                           //        Längentreue: gemessen 0.5 % Dehnung unter
                           //        Eigengewicht (14 × 1.6), Durchhang stimmt
                           //        dann auf 7 % mit der Kettenlinie überein.
  chainSOR:         1.6,   //      — Überrelaxations-Faktor der Constraints
                           //        (1 = plain Gauss-Seidel; ~1.6 konvergiert
                           //        etwa 3× schneller, >1.9 wird unruhig)
  chainDrag:        0.55,  // 1/s— Luftwiderstand (ruhiges Hängen, stabile Haufen)
  chainFriction:    0.45,  // 0..1 — tangentiale Bremsung bei Geometriekontakt
  chainCollideWorld:  true,
  chainCollidePlayer: true,
  chainNodeRadius:  0.07,
  renderSpacing:    0.11,  // m  — Zielabstand der Render-Stützpunkte
  renderEdgeClearance: 0.035, // m — Sicherheitsabstand der Stützpunkte zur Fläche
};

/* -------------------------------------------------------------------------- */
/*  Geometrie-Helfer für AABB-Kanten                                          */
/* -------------------------------------------------------------------------- */
const _e0 = [0,0,0], _e1 = [0,0,0], _eOut = [0,0,0], _eTmp = [0,0,0], _NEARBUF = [], _CONT_BUF = [];

/**
 * Kanten-Daten einer AABB: Endpunkte, Einheitsrichtung, äußere Normale.
 * Die äußere Normale einer Kante ist der normalisierte Durchschnitt der beiden
 * angrenzenden Flächen-Normalen — genau da liegt die Seilmittellinie.
 */
function boxEdge(box, edgeIdx, p0, p1, outN) {
  const a = EDGE_PAIRS[edgeIdx][0], b = EDGE_PAIRS[edgeIdx][1];
  const sa = CORNER_SIGNS[a], sb = CORNER_SIGNS[b];
  const mn = box.min, mx = box.max;
  const c0 = [(mn[0]+mx[0])*0.5, (mn[1]+mx[1])*0.5, (mn[2]+mx[2])*0.5];
  const h  = [(mx[0]-mn[0])*0.5, (mx[1]-mn[1])*0.5, (mx[2]-mn[2])*0.5];
  for (let k = 0; k < 3; k++) {
    p0[k] = c0[k] + sa[k]*h[k];
    p1[k] = c0[k] + sb[k]*h[k];
  }
  if (outN) {
    outN[0]=0; outN[1]=0; outN[2]=0;
    for (let k = 0; k < 3; k++) {
      if (sa[k] === sb[k]) outN[k] = sa[k];   // die beiden festen Achsen = Flächennormalen
    }
    const l = vlen(outN) || 1; outN[0]/=l; outN[1]/=l; outN[2]/=l;
  }
}

/**
 * Exakter Berührpunkt einer Strecke A→B mit einer GERADEN (Kante) in 3D.
 * Trick: "Abwickeln" — die Minimierung von |A-P|+|P-B| entlang einer Linie hat
 * die geschlossene Lösung  t* = (aPar·bPerp + bPar·aPerp)/(aPerp + bPerp).
 * Kein Suchen, kein Jitter, und der Kontakt GLEITET sauber entlang der Kante,
 * wenn sich der Spieler bewegt.
 * Das UNGESCHNITTENE t* wird auf [0, elen] geklemmt: am Kantenende bleibt
 * der Kontakt auf dem Eckpunkt liegen (das Seil wird um den Eckpunkt geführt)
 * und löst sich über die normale Hysterese, sobald die direkte Strecke frei
 * ist — er springt niemals auf eine andere Kante. `_TP` merkt sich das
 * ungeschnittene t* und die Kantenlänge; daran erkennt der Solver, ob das
 * Seil über die Ecke auf angrenzende Geometrie WEITERRUTSCHEN kann.
 */
const _TP = { t: 0, elen: 0 };
function edgeTouchPoint(A, B, p0, p1, outN, clearance, out) {
  let ux = p1[0]-p0[0], uy = p1[1]-p0[1], uz = p1[2]-p0[2];
  const elen = Math.sqrt(ux*ux+uy*uy+uz*uz);
  if (elen < 1e-6) { out[0]=p0[0]; out[1]=p0[1]; out[2]=p0[2]; _TP.t = 0; _TP.elen = 0; return elen; }
  const il = 1/elen; ux*=il; uy*=il; uz*=il;
  const ax = A[0]-p0[0], ay = A[1]-p0[1], az = A[2]-p0[2];
  const bx = B[0]-p0[0], by = B[1]-p0[1], bz = B[2]-p0[2];
  const aPar = ax*ux + ay*uy + az*uz;
  const bPar = bx*ux + by*uy + bz*uz;
  const apx = ax-aPar*ux, apy = ay-aPar*uy, apz = az-aPar*uz;
  const bpx = bx-bPar*ux, bpy = by-bPar*uy, bpz = bz-bPar*uz;
  const aPerp = Math.sqrt(apx*apx+apy*apy+apz*apz);
  const bPerp = Math.sqrt(bpx*bpx+bpy*bpy+bpz*bpz);
  let t;
  const sum = aPerp + bPerp;
  if (sum < 1e-6) t = (aPar + bPar) * 0.5;
  else t = (aPar*bPerp + bPar*aPerp) / sum;
  _TP.t = t; _TP.elen = elen;      // ungeschnitten — für die Kantenend-Erkennung
  t = clamp(t, 0, elen);
  out[0] = p0[0] + ux*t + outN[0]*clearance;
  out[1] = p0[1] + uy*t + outN[1]*clearance;
  out[2] = p0[2] + uz*t + outN[2]*clearance;
  return elen;
}

/* -------------------------------------------------------------------------- */
/*  Wrap-Kontakt (mit Gedächtnis)                                              */
/* -------------------------------------------------------------------------- */
function makeWrap(box, edgeIdx) {
  return {
    box, edgeIdx,
    p: v3(),            // aktueller Kontaktpunkt (inkl. Clearance)
    n: v3(),            // äußere Kantennormale
    t: 0.5,             // Position auf der Kante (für Debug/Telemetrie)
    release: 0,         // 0..1 — Hysterese-Counter fürs Loslassen
    age: 0,
    localOff: v3(),   // Offset im Body-Lokalraum (Fallback-Kontakte folgen dem Körper)
    p0: v3(), p1: v3(),
    force: 0,           // Seilkraft an diesem Kontakt (für Rückwirkung + FX)
  };
}

/* -------------------------------------------------------------------------- */
/*  Pfad-Solver                                                               */
/* --------------------------------------------------------------------------
   Kürzester kollisionsfreier Pfad Hand→Anker mit PERSISTENTEN Umlenkkontakten.

   Warum nicht "jedes Frame neu suchen"?  Weil ein Seil, das sich um eine Kante
   legt, dort BLEIBT und an ihr entlang GLEITET. Ein zustandsloser Solver würde
   pro Frame zwischen "gewickelt" und "nicht gewickelt" flackern (sichtbares
   Popping + sprunghafte Seillänge + damit springende Constraint). Deshalb:

     · Kontakte haben ein Gedächtnis (Box + Kante) und überleben Frames.
     · Die Kontaktposition wird ANALYTISCH auf der Kante nachoptimiert
       (Abwickel-Trick) → der Kontakt gleitet kontinuierlich mit.
     · Loslassen erst nach Hysterese UND weichem Ausblenden Richtung Luftlinie.

   Mehrelement-Wicklung: Ein Seil, das ÜBER eine Wand läuft, berührt sie an
   ZWEI Kanten (Eintritts- und Austrittskante). Der Solver erkennt das, weil er
   einen Kandidaten auch dann wählt, wenn er kürzer, aber noch nicht vollständig
   freigemessen ist — die Verfeinerungsschleife setzt dann den zweiten Kontakt.
   ========================================================================== */
class RopePathSolver {
  constructor(world, params) {
    this.world = world;
    // Referenz auf das (gemeinsame) Parameterobjekt; Lücken werden defensiv
    // über ROPE_DEFAULTS geschlossen, damit Teil-Params nie zu NaN führen.
    this.p = params && params.wrapClearance !== undefined ? params
             : Object.assign({}, ROPE_DEFAULTS, params || {});
    this.wraps = [];
    this.pts = [];        // Polylinie: [Hand, ...Kontakte, Anker]
    this.ptsBox = [];     // zugehörige Box je Punkt (für Skip-Logik)
    this.segLens = [];
    this.segHoriz = [];   // horizontaler Anteil je Segment (nur dort kann es durchhängen)
    this.cum = [];
    this.length = 0;
    this.dirStart = v3(0,1,0);
    this.dirEnd   = v3(0,1,0);
    this.insertBudget = 0;
    this.solved = false;
    this._tmpA = v3(); this._tmpB = v3(); this._tmpC = v3();
    this._cpShort = v3(); this._cpClear = v3();
    this.stats = { edgeTests: 0, segTests: 0, inserts: 0 };
    this._topoTimer = 0;
  }

  reset() { this.wraps.length = 0; this.length = 0; this.solved = false; }

  /* ------------------------- Haupt-Solve (pro Substep) --------------------- */
  solve(A, B, dt, boxA, boxB) {
    const P = this.p;
    this._A = A; this._B = B; this._boxA = boxA || null; this._boxB = boxB || null;

    if (!P.wrapPhysics) {
      // NAIVER REFERENZ-MODUS: Luftlinie bleibt Seillänge, keine Umlenkung.
      if (this.wraps.length) this.wraps.length = 0;
      this._buildPts(A, B); this._measure(); this.solved = true;
      return this.length;
    }

    // Topologie-Arbeit (Clearance-Tests, Insert, Release) nur mit topologyHz —
    // das ist der teure Teil. Die analytische Kontakt-Nachführung läuft dagegen
    // mit voller Physik-Rate, damit gleitende Kontakte ruckelfrei bleiben.
    this._topoTimer -= dt;
    const full = this._topoTimer <= 0;
    if (full) this._topoTimer = 1 / Math.max(1, P.topologyHz || 60);

    // 1) Bestehende Kontakte nachführen (rückwärts, dann vorwärts = 2 Sweeps
    //    Koordinatenabstieg; konvergiert in wenigen Frames)
    // Validierung nur im ERSTEN Sweep — der zweite dient allein der
    // Positions-Nachführung mit den aktualisierten Nachbarpunkten.
    for (let pass = 0; pass < 2; pass++) this._updateWraps(dt, pass === 0, full && pass === 0);

    // 2) Polylinie aufbauen
    this._buildPts(A, B);

    if (full) {
      /* 3) Blocker finden, Kontakte einfügen — mit topologyHz (60).
         Bewusst NICHT jeden Substep: ein neu eingefügter Kontakt verlängert
         die Welt-Pfadlänge sprunghaft, und dieser Sprung geht direkt in die
         Constraint → spürbarer Ruck. Ein Frame Verzögerung ist dagegen harmlos,
         weil das BILD durch zwei unabhängige Garantien trotzdem nie durch
         Geometrie läuft: (a) alle Ketten-Nodes kollidieren immer, (b) jeder
         Stützpunkt der Render-Kurve wird aus fester Geometrie herausgeschoben.
         Während eines laufenden Release unterdrückt (sonst Ping-Pong).        */
      this.insertBudget = P.wrapInsertsPerFrame;
      let releasing = false;
      for (const w of this.wraps) if (w.release > 0.001) { releasing = true; break; }
      let guard = 0;
      while (!releasing && this.insertBudget > 0 && guard++ < 5) {
        if (!this._tryInsertWrap()) break;
        this._buildPts(A, B);
        this._updateWraps(dt, false, true);
      }
    }

    this._measure();
    this.solved = true;
    return this.length;
  }

  /**
   * Topologie einmal sofort bis zur Konvergenz treiben (ohne Insert-Budget).
   * Wird direkt nach dem Verankern gebraucht: sonst baut sich die Wicklung über
   * mehrere Topologie-Updates auf, und in diesen ersten Frames läuft sowohl der
   * Pfad als auch das Bild durch das Hindernis.
   */
  converge() {
    if (!this.p.wrapPhysics) return this.length;
    let guard = 0;
    while (guard++ < this.p.wrapMaxCount + 2) {
      if (!this._tryInsertWrap(true)) break;
      this._buildPts(this._A, this._B);
      this._updateWraps(0, false, true);
    }
    this._measure();
    return this.length;
  }

  _prevPt(i) { return (i === 0) ? this._A : this.wraps[i-1].p; }
  _nextPt(i) { return (i === this.wraps.length-1) ? this._B : this.wraps[i+1].p; }
  _prevBox(i) { return (i === 0) ? this._boxA : this.wraps[i-1].box; }
  _nextBox(i) { return (i === this.wraps.length-1) ? this._boxB : this.wraps[i+1].box; }

  /**
   * Ist die Strecke blockiert? Liefert die blockierende Box oder null.
   * Kombiniert Strahltest (fremde Hindernisse) mit Graze-Test (die Boxen, auf
   * denen die Endpunkte selbst liegen — die dürfen nicht durchbohrt werden).
   */
  _segBlocked(a, b, boxA, boxB) {
    const W = this.world, P = this.p;
    const len = vdist(a, b);
    this.stats.segTests++;
    /* Graze-Test: die Stichproben liegen im mittleren Stück, damit Endpunkte,
       die definitionsgemäß AUF einer Fläche liegen, nicht falsch anschlagen.
       WICHTIG: auch dann prüfen, wenn beide Endpunkte auf derselben Box
       liegen. Früher wurde da komplett übersprungen mit der Begründung "das
       Seil läuft entlang der Oberfläche" — stimmt aber nur, wenn es das
       tatsächlich tut. Genau dadurch wählte der Solver eine Kante UNTERHALB
       der Oberkante und das Seil schnitt quer durch den Block.              */
    /* Graze-Test für BEIDE Endpunkt-Boxen, auch wenn es dieselbe ist.
       Die frühere Ausnahme "beide Enden auf derselben Box ⇒ nicht prüfen"
       erlaubte dem Lookahead, zwei Kontakte auf GEGENÜBERLIEGENDEN Flächen
       derselben Box zu setzen — die Verbindung dazwischen lief dann mitten
       durch den Block. Unnötig ist die Ausnahme ohnehin: ein Seil, das an
       einer Fläche anliegt, verläuft im Clearance-Abstand (0.14 m) daran
       entlang, und der Test schlägt nur bei 0.035 m an. Innenliegende
       Strecken werden also erkannt, anliegende nicht.                      */
    if (len > 0.45) {
      /* RUHE-TOLERANZ für die Endpunkt-Boxen: eine Strecke, deren Ende AUF
         einer Box liegt (Anker auf einer Fläche, Nachbarkontakt auf derselben
         Box), darf auf deren Fläche AUFLIEGEN — genau das tut ein Seil, das
         über eine Kante auf die Fläche zum Anker läuft. Der frühere positive
         Pad (0.035) meldete Aufliegen als „blockiert" und vergiftete damit
         Lookahead und Freigabetests: der physikalisch richtige Kontakt
         (Kante derselben Box) wurde verworfen und der Solver nahm einen
         absurden Umweg (gemessen: Anker auf Blockoberkante ⇒ Seil über die
         Säulendecke 4 m daneben, 16.25 m statt 13.3 m; beim Umkreisen bis zu
         10 m Umweg mit Schlaffschlaufe und Freiluft-Knick, Defekt #58).
         Der negative Pad schrumpft das Testvolumen: Aufliegen frei,
         Eintauchen in den Block bleibt blockiert.                          */
      const padRest = -0.05;
      if (boxA && !W.segmentAvoidsBox(a, b, boxA, padRest)) return boxA;
      if (boxB && !W.segmentAvoidsBox(a, b, boxB, padRest)) return boxB;
    }
    if (!W.segmentClear(a, b, { startBox: boxA, endBox: boxB, minT: 1e-3, ropeOnly: true })) {
      const d = this._sbD || (this._sbD = v3());
      vsub(d, b, a);
      const l = vnorm(d, d);
      if (l < 1e-5) return null;
      const hit = W.raycast(a, d, l, { minT: 1e-3, ropeOnly: true });
      // Treffer auf einer Endpunkt-Box direkt am jeweiligen Ende ist legitim
      // (der Punkt liegt auf der Fläche). Alles andere ist ein echter Blocker.
      // Treffer auf der Anker-Box ist legitim, wenn die Strecke nicht wieder
      // aus ihr heraustritt (der Anker liegt in ihr) — ebenso wie in segmentClear.
      if (hit && hit.box === boxB) {
        const inside = W.boxContaining(b, true) === boxB ||
                       (hit.t + 0.02 >= l);
        if (inside) return null;
      }
      if (hit && hit.box === boxA && hit.t < 0.20) return null;

      if (hit) return hit.box;
      // segmentClear hat blockiert, raycast aber nichts gefunden ⇒ ein
      // Endpunkt steckt IN einer Box. Das muss derselben Logik folgen, sonst
      // melden die beiden Prüfungen Widersprüchliches und der Solver bekommt
      // keinen Blocker zum Anlegen eines Kontakts.
      return W.boxContaining(a, true) || W.boxContaining(b, true);
    }
    return null;
  }

  _updateWraps(dt, reverse, full) {
    const P = this.p;
    const n = this.wraps.length;
    for (let k = 0; k < n; k++) {
      const i = reverse ? (n-1-k) : k;
      const w = this.wraps[i]; if (!w) continue;
      const prev = this._prevPt(i), next = this._nextPt(i);
      const prevBox = this._prevBox(i), nextBox = this._nextBox(i);
      w.age += dt;
      const cand = this._tmpC;

      if (w.edgeIdx < 0) {
        // Fallback-Kontakt (Sondergeometrie): folgt dem Körper starr mit.
        if (w.box && w.box.dynamic) vadd(cand, w.box.pos, w.localOff);
        else vcopy(cand, w.p);
      } else {
        boxEdge(w.box, w.edgeIdx, w.p0, w.p1, w.n);
        edgeTouchPoint(prev, next, w.p0, w.p1, w.n, P.wrapClearance, cand);
        w._tRaw = _TP.t; w._tLen = _TP.elen;
        w._atEnd = (_TP.t < 0.05 || _TP.t > _TP.elen - 0.05);
      }

      if (full) {
        // Hysterese: ist der Kontakt noch nötig?
        const directLen = vdist(prev, next);
        const wrapLen   = vdist(prev, cand) + vdist(cand, next);
        const directBlocked = (this._segBlocked(prev, next, prevBox, nextBox) !== null);
        /* Freigabebedingung: die direkte Verbindung ist gangbar. Punkt.
           Früher musste ZUSÄTZLICH gelten, dass das Entfernen weniger als
           `wrapReleaseTol` (5 cm) einspart — das ist fast nie der Fall, denn
           eine echte Umlenkung kostet immer mehr. Folge: Kontakte blieben
           praktisch für immer kleben, häuften sich auf (bis zu 4) und der Pfad
           nahm dauerhaft den teuren Weg herum (gemessen: 27.9 m bei 13.4 m
           Luftlinie), während das Seil 1.74 m tief durch die Geometrie lief.
           Gegen Flackern schützt ausschließlich die Hysterese-Zeit, nicht eine
           zusätzliche Längenbedingung.                                      */
        /* Ein Kontakt wird freigeggeben, wenn das Seil an ihm GERADERADE
           verlaufen kann, also die Strecke zum Nachbarkontakt frei ist.
           Das ist die einzig physikalische Bedingung.

           Eine globale Regel nach dem Muster "Anker ist direkt sichtbar, also
           alle Umlenkpunkte verwerfen" ist FALSCH: ein Seil, das auf einer
           Seite eines Objekts liegt, ist dort gefangen. Dass der Spieler den
           Anker sieht, ändert daran nichts — das Seil wird von beiden Seiten
           gegen die Fläche gezogen und kann nur über eine Kante abrutschen,
           nie durch bloße Sichtfreiheit verschwinden. Mit der globalen Regel
           glitchte das Seil vollständig durch das Objekt.                    */
        const unnecessary = !directBlocked;
        /* Physikalische Plausibilitäts-Schranke.
           Eine Umlenkung um eine Box kann niemals wesentlich mehr Seil kosten
           als die Ausdehnung der Box selbst — das Seil liegt an der Kante an und
           läuft auf der anderen Seite wieder herunter. Ein "Umweg" von 40 m bei
           8 m Abstand ist deshalb keine gültige Wicklung, sondern ein vom
           greedy-Solver erzeugter Unsinnszustand (typisch: Kontakt an einem
           beweglichen Körper, der inzwischen weggeschwungen ist). Solche
           Kontakte werden sofort verworfen, ohne Hysterese.                  */
        if (w.edgeIdx >= 0) {
          const mn = w.box.min, mx = w.box.max;
          const ex = mx[0]-mn[0], ey = mx[1]-mn[1], ez = mx[2]-mn[2];
          /* Der Umweg einer Umlenkung wächst mit den ARMLENGEN der Biegung,
             nicht mit der Box — eine scherenseitige Schranke aus dem Box-
             Querschnitt wäre deshalb falsch (gemessen: echte Wicklung um
             eine 1.4-m-Säule mit 3.8 m „Umweg" bei 90°-Biegung). Die Diagonale
             bleibt daher nur als grobe äußerste Schranke.                  */
          const dx = Math.abs(w.p1[0]-w.p0[0]), dy = Math.abs(w.p1[1]-w.p0[1]), dz = Math.abs(w.p1[2]-w.p0[2]);
          const c1 = dx > 0.01 ? 0 : ex, c2 = dy > 0.01 ? 0 : ey, c3 = dz > 0.01 ? 0 : ez;
          const cross = Math.max(c1, c2, c3);
          const detour = wrapLen - directLen;
          const diag = Math.sqrt(ex*ex + ey*ey + ez*ez);
          /* Ein echter Umlenkkontakt liegt NAH an der Direktlinie prev→next: die
             Umlenkung biegt das Seil um höchstens den Box-Querschnitt aus der
             Geraden. Ein Kontakt 12 m NEBEN der Direktlinie ist keine Umlenkung
             dieser Verbindung, sondern ein Solver-Irrtum (gemessen: Kontakt
             am Kantenende 12 m neben der echten Wicklung ⇒ +15.5 m Pfad).
             Gemessen: echte Mehrfach-Wicklungen bleiben unter 6 m Direktlinien-
             abstand, der Solver-Irrtum lag bei 12 m — Schwelle 9 m.          */
          const dSeg = (closestOnSegment(this._bogT || (this._bogT = v3()), cand, prev, next),
                        vdist(cand, this._bogT));
          if (detour > diag*1.35 + P.wrapClearance*6 || dSeg > Math.max(9, cross*1.5 + 1)) {
            w._dead = true;
            this.stats.bogusDropped = (this.stats.bogusDropped || 0) + 1;
            continue;
          }
        }
        const rel = Math.max(1e-4, P.wrapReleaseHold);
        if (unnecessary) {
          w.release += dt/rel;
        } else if (directBlocked) {
          /* Eindeutiger Fall: die lokale Strecke zum Nachbarkontakt ist
             blockiert — der Kontakt wird gebraucht. Sofort auf null statt
             langsam abzubauen, sonst bleibt das Seil noch Dutzende
             Millisekunden in einem Zustand, in dem es durch das Objekt läuft. */
          w.release = 0;
        } else {
          w.release = Math.max(0, w.release - 2*dt/rel);   // marginale Fälle: Hysterese
        }

        /* Am KantenENDE und weiterhin gebraucht: kann das Seil über die Ecke
           auf angrenzende Geometrie weiterrutschen? Falls ja, wird DORT ein
           neuer Kontakt angelegt — dieser hier bleibt unverändert liegen und
           löst sich über die Hysterese, sobald die Route nicht mehr über ihn
           führt. Bestehende Kontakte ziehen also niemals um.               */
        if (w.release === 0 && w.edgeIdx >= 0 && w._atEnd)
          this._cornerSlide(i, prev, next, prevBox, nextBox, w);

        if (w.release >= 1) { w._dead = true; continue; }
      }

      /* Kontakt bleibt IMMER exakt auf seiner Kante — auch während des
         Loslassens, und er wechselt sie niemals von selbst. Frühere Varianten
         (weiches Überblenden Richtung Luftlinie, Kantenwechsel bei ungültigem
         Zulauf, Übergabe an Kanten anderer Boxen) erzeugten genau die Sprünge,
         die ein Seil nie zeigen darf: quer durch das Objekt, von einer Seite
         auf die andere, oder zu einem fernen Eckpunkt.

         Der einzige Weg, die Route zu ändern, ist die Insert/Release-Pipeline:
         · Wird eine Strecke blockiert, legt _tryInsertWrap einen NEUEN Kontakt
           auf der richtigen Kante an (der alte bleibt einstweilen liegen).
         · Wird die direkte Strecke um einen Kontakt frei, löst er sich nach
           der Hysterese-Zeit — das verkürzt den Welt-Pfad (mehr Spiel), die
           Constraint zieht dabei nie, es gibt also keinen Ruck.
         · Solange der Kontakt gebraucht wird, gleitet er analytisch entlang
           der Kante mit und rutscht von selbst zum Kantenende, wenn das Seil
           kürzer wird. Er verlässt die Kante also dort, wo es physikalisch
           richtig ist, nicht mitten durch die Fläche.                        */
      vcopy(w.p, cand);
    }
    for (let i = this.wraps.length-1; i >= 0; i--) if (this.wraps[i]._dead) this.wraps.splice(i,1);
  }

  /**
   * Weitergleiten über eine Kanten-Ecke (Insert, KEIN Umsetzen des Kontakts).
   *
   * Steht ein Kontakt am Ende seiner Kante und wird weiterhin gebraucht,
   * hängt das Seil um den Eckpunkt. Gibt es eine Kante in der Nähe, auf der
   * die Route (1) strikt kürzer ist und (2) vollständig frei von Zulauf und
   * Ablauf liegt, kann das Seil über die Ecke auf sie weiterrutschen.
   * Angelegt wird dafür ein NEUER Kontakt nahe der Ecke; der alte bleibt
   * liegen, bis die normale Hysterese ihn löst.
   *
   * Garantien — das frühere "Handoff"-Snappen hatte sie nicht, deshalb flog
   * es raus; dies ist die physikalische Version desselben Übergangs:
   *   · Bestehende Kontakte wechseln nie ihre Kante/Box ⇒ nichts springt.
   *   · Der neue Kontakt liegt innerhalb `cornerSlideReach` an der Ecke
   *     ⇒ das Seil rutscht, statt zu einem fernen Punkt zu teleportieren.
   *   · Die Route wird strikt kürzer (gain) ⇒ kein Hin-und-her-Flattern und
   *     kein Längenriss nach oben beim späteren Lösen des alten Kontakts.
   */
  _cornerSlide(i, prev, next, prevBox, nextBox, w) {
    const P = this.p, W = this.world;
    if (this.wraps.length >= P.wrapMaxCount) return false;
    const c = (w._tRaw < w._tLen * 0.5) ? w.p0 : w.p1;    // angesteuertes Kantenende
    const reach = P.cornerSlideReach, gain = P.cornerSlideGain;
    const Lold = vdist(prev, w.p) + vdist(w.p, next);
    let bestBox = null, bestEdge = -1, bestL = Lold - gain;
    const bcp = this._csP || (this._csP = v3());
    const p0 = this._cs0 || (this._cs0 = v3()), p1 = this._cs1 || (this._cs1 = v3());
    const nn = this._csN || (this._csN = v3()), cp = this._csC || (this._csC = v3());

    const consider = (box2, e2) => {
      for (let j = 0; j < this.wraps.length; j++) {
        const o = this.wraps[j];
        if (o.box === box2 && o.edgeIdx === e2) return;     // Kante schon belegt
      }
      boxEdge(box2, e2, p0, p1, nn);
      edgeTouchPoint(prev, next, p0, p1, nn, P.wrapClearance, cp);
      // Muss INNEN auf der Kante landen — an der nächsten Ecke wieder
      // anzustoßen bringt nichts (der Kontakt bliebe einfach hier).
      if (_TP.t < 0.02 || _TP.t > _TP.elen - 0.02) return;
      const L = vdist(prev, cp) + vdist(cp, next);
      if (L > bestL) return;                                // strikt kürzer + Hysterese
      if (vdist(cp, c) > reach) return;                     // Ecknähe: Rutschen, kein Sprung
      if (!W.pointFree(cp, 0.02, true)) return;             // nicht in anderer Geometrie
      if (this._segBlocked(prev, cp, prevBox, box2) !== null) return;
      if (this._segBlocked(cp, next, box2, nextBox) !== null) return;
      // Auch die KOEXISTENZ-Route (alter Kontakt bleibt vorerst) muss frei
      // sein, sonst wäre der Pfad im Übergangszustand einen Tick blockiert.
      if (this._segBlocked(w.p, cp, w.box, box2) !== null) return;
      bestL = L; bestBox = box2; bestEdge = e2; vcopy(bcp, cp);
    };

    // (a) Nachbarkanten derselben Box an dieser Ecke
    const pair = EDGE_PAIRS[w.edgeIdx];
    const cIdx = (w._tRaw < w._tLen * 0.5) ? pair[0] : pair[1];
    for (let e2 = 0; e2 < 12; e2++) {
      if (e2 === w.edgeIdx) continue;
      const pr = EDGE_PAIRS[e2];
      if (pr[0] === cIdx || pr[1] === cIdx) consider(w.box, e2);
    }
    // (b) Kanten anderer Boxen in Ecknähe (Treppenstufen, Versätze)
    const mn = this._csMN || (this._csMN = v3()), mx = this._csMX || (this._csMX = v3());
    vset(mn, c[0]-reach, c[1]-reach, c[2]-reach);
    vset(mx, c[0]+reach, c[1]+reach, c[2]+reach);
    const near = W.queryAABB(mn, mx, _CONT_BUF);
    for (let j = 0; j < near.length; j++) {
      const bx = near[j];
      if (bx === w.box || bx.ropeSolid === false) continue;
      for (let e2 = 0; e2 < 12; e2++) consider(bx, e2);
    }

    if (bestEdge < 0) return false;
    const nw = makeWrap(bestBox, bestEdge);
    vcopy(nw.p, bcp);
    if (bestBox.dynamic) vsub(nw.localOff, bcp, bestBox.pos);
    this.wraps.splice(i + 1, 0, nw);
    this.stats.slides = (this.stats.slides || 0) + 1;
    return true;
  }

  /**
   * Beste Kante an `box` für die Umleitung prev→next (nur bei Insertion).
   * Zweistufig: (a) kürzeste Kante mit sauberem Zulauf — darf noch unvollständig
   * freigemessen sein (die Verfeinerung setzt dann den Folgekontakt), und
   * (b) kürzeste VOLLSTÄNDIG freie Kante als sicherer Fallback.
   * Läuft nur bei Insertion/Reparatur (nicht pro Frame) und darf sich deshalb
   * eigene Puffer allozieren — wichtig, weil der Lookahead REKURSIV in dieselbe
   * Methode geht und geteilte Temps sich sonst gegenseitig überschreiben.
   */
  _findBestEdge(prev, next, box, outPt, opts) {
    opts = opts || {};
    const P = this.p, W = this.world;
    const p0 = v3(), p1 = v3(), nn = v3(), cp = v3();
    const pad = P.wrapClearance*0.25;
    let bShort = -1, bShortL = Infinity;
    let bClear = -1, bClearL = Infinity;
    const cs = v3(), cc = v3();
    for (let e = 0; e < 12; e++) {
      if (opts.exclude === e) continue;
      boxEdge(box, e, p0, p1, nn);
      edgeTouchPoint(prev, next, p0, p1, nn, P.wrapClearance, cp);
      const L = vdist(prev, cp) + vdist(cp, next);
      if (L >= bShortL && L >= bClearL) continue;   // billige Vorabsage
      this.stats.edgeTests++;
      // Kontaktpunkt darf nicht in anderer Geometrie stecken (z. B. Boden)
      if (!W.pointFree(cp, 0.02, true)) continue;
      // Zulauf darf die Box selbst nicht durchbohren. Die frühere Ausnahme
      // "Nachbarpunkt liegt schon auf der Box ⇒ nicht prüfen" war der Eingang
      // für den Fehler: damit akzeptierte der Lookahead zwei Kontakte auf
      // GEGENÜBERLIEGENDEN Flächen derselben Box, verbunden durch eine Strecke
      // mitten durch den Block. Der Graze-Test mit 0.035 m Pad ist gegen den
      // Clearance-Abstand von 0.14 m sicher genug, um anliegende Seile nicht
      // falsch zu verwerfen — die Ausnahme ist nicht nötig.
      /* Liegt der Zulauf-Endpunkt auf dieser Box, ist Aufliegen auf deren
         Fläche erlaubt (Ruhe-Toleranz wie in _segBlocked); sonst muss der
         Zulauf die Box mit Abstand meiden.                                 */
      if (!W.segmentAvoidsBox(prev, cp, box, opts.prevOnBox ? -0.05 : pad)) continue;
      if (!W.segmentClear(prev, cp, { skip1: opts.prevOnBox ? box : null, startBox: opts.prevOnBox ? null : box, minT: 1e-3, ropeOnly: true })) continue;
      // Ablauf: wird NICHT hart verlangt. Ein noch blockierter Ablauf heißt
      // nur, dass ein FOLGEKONTAKT nötig ist (Seil über eine Wand = 2 Kanten,
      // Seil über Wand + Brüstung = 2 Körper). Ob der existiert, klärt der
      // Lookahead unten — würde man hier abbrechen, wäre genau der kürzeste
      // und physikalisch richtige Kandidat immer disqualifiziert.
      const outClear = W.segmentClear(cp, next, { startBox: box, endBox: opts.nextOnBox ? box : null, minT: 1e-3, ropeOnly: true });
      const outGraze = W.segmentAvoidsBox(cp, next, box, opts.nextOnBox ? -0.05 : pad);
      if (L < bShortL) { bShortL = L; bShort = e; vcopy(cs, cp); }
      if (outClear && outGraze && L < bClearL) { bClearL = L; bClear = e; vcopy(cc, cp); }
    }
    // ---- 1-stufiger LOOKAHEAD -------------------------------------------
    // Der kürzeste Kandidat ist oft erst zusammen mit einem FOLGEKONTAKT gültig
    // (Seil über eine Wand = 2 Kanten; Seil über Wand + Brüstung = 2 Körper).
    // Wir prüfen billig, ob dieser Folgekontakt existiert — nur dann darf der
    // kürzere, aber noch unvollständige Kandidat den sicheren schlagen.
    // Ohne Lookahead wählt der Solver stattdessen den teuren Weg ums Ende.
    let shortViable = false;
    if (bShort >= 0) {
      const blk = this._segBlocked(cs, next, box, opts.nextOnBox ? box : null);
      if (!blk) shortViable = true;
      else if ((opts.depth || 0) < 1) {
        const cp2 = v3();
        const folge = this._findContactFor(cs, next, box, opts.nextOnBox ? box : null, cp2, {
          exclude: blk === box ? bShort : -1, depth: 1 });
        shortViable = !!folge;
      }
    }
    if (shortViable && (bClear < 0 || bShortL < bClearL * 0.985)) { vcopy(outPt, cs); return bShort; }
    if (bClear >= 0) { vcopy(outPt, cc); return bClear; }
    return -1;
  }

  /** Boxen in der Nähe der Strecke (für den "äußerste Geometrie"-Fallback). */
  _nearBoxes(a, b, boxA, boxB, exclude, out) {
    out.length = 0;
    const mn = [Math.min(a[0],b[0])-1.4, Math.min(a[1],b[1])-1.4, Math.min(a[2],b[2])-1.4];
    const mx = [Math.max(a[0],b[0])+1.4, Math.max(a[1],b[1])+1.4, Math.max(a[2],b[2])+1.4];
    const all = this.world.queryAABB(mn, mx, _NEARBUF);
    for (const bx of all) {
      if (bx === boxA || bx === boxB || bx === exclude) continue;
      if (bx.ropeSolid === false) continue;
      out.push(bx);
      if (out.length >= 8) break;
    }
    return out;
  }

  /**
   * Kontakt für eine blockierte Strecke finden — zuerst am Blocker selbst,
   * sonst an einer NACHBAR-Box. Grund: die äußerste Geometrie am Blockadepunkt
   * ist nicht immer die zuerst getroffene Box (Brüstung über einem Block,
   * gestapelte Kisten). Ohne diesen Fallback würde das Seil an einer inneren
   * Fläche hängen, obwohl es physisch über die äußere Kante läuft.
   */
  _findContactFor(a, b, boxA, boxB, outPt, opts) {
    opts = opts || {};
    const blocker = this._segBlocked(a, b, boxA, boxB);
    if (!blocker) return null;
    let e = this._findBestEdge(a, b, blocker, outPt, {
      prevOnBox: boxA === blocker, nextOnBox: boxB === blocker,
      exclude: opts.exclude, depth: opts.depth || 0 });
    if (e >= 0) return { box: blocker, edge: e };
    if ((opts.depth || 0) >= 1) return null;
    const nb = this._nearBoxes(a, b, boxA, boxB, blocker, []);
    let best = null, bestL = Infinity;
    for (const bx of nb) {
      const cp = v3();
      const e2 = this._findBestEdge(a, b, bx, cp, {
        prevOnBox: boxA === bx, nextOnBox: boxB === bx, depth: 1 });
      if (e2 < 0) continue;
      const L = vdist(a, cp) + vdist(cp, b);
      if (L < bestL) { bestL = L; best = { box: bx, edge: e2 }; vcopy(outPt, cp); }
    }
    return best;
  }

  _buildPts(A, B) {
    const pts = this.pts, boxes = this.ptsBox;
    pts.length = 0; boxes.length = 0;
    pts.push(A); boxes.push(this._boxA);
    for (const w of this.wraps) { pts.push(w.p); boxes.push(w.box); }
    pts.push(B); boxes.push(this._boxB);
  }

  /** Blocker im aktuellen Pfad finden und einen Kontakt einfügen. */
  _tryInsertWrap(unbudgeted) {
    if (this.wraps.length >= this.p.wrapMaxCount) return false;
    const pts = this.pts, boxes = this.ptsBox;
    for (let i = 0; i < pts.length-1; i++) {
      const a = pts[i], b = pts[i+1];
      const ba = boxes[i], bb = boxes[i+1];
      const blocker = this._segBlocked(a, b, ba, bb);
      if (!blocker) continue;
      // Mehrfachwicklung auf derselben Box ist erlaubt und GEWOLLT (Seil über
      // eine Wand = Ein- UND Austrittskante), nur nicht beliebig oft.
      let sameBox = 0;
      for (const w of this.wraps) if (w.box === blocker) sameBox++;
      if (sameBox >= 3) continue;
      // dieselbe Kante nicht doppelt belegen
      let exclude = -1;
      if (ba === blocker && i >= 1 && this.wraps[i-1] && this.wraps[i-1].box === blocker)
        exclude = this.wraps[i-1].edgeIdx;
      else if (bb === blocker && i < this.wraps.length && this.wraps[i] && this.wraps[i].box === blocker)
        exclude = this.wraps[i].edgeIdx;
      const cp = v3();
      const contact = this._findContactFor(a, b, ba, bb, cp, { exclude });
      const e = contact ? contact.edge : -1;
      const cbox = contact ? contact.box : blocker;
      if (e < 0 && sameBox > 0) continue;   // kein Folgekontakt möglich → nicht erzwingen
      let w;
      if (e < 0) {
        // Fallback: Kontakt auf der Trefferfläche (für nicht-kantenbasierte Fälle)
        const d = vsubNew(b, a); const l = vlen(d) || 1;
        const hit = this.world.raycast(a, vsclNew(d, 1/l), l, { minT: 1e-3, ropeOnly: true });
        if (!hit) continue;
        w = makeWrap(cbox, -1);
        vcopy(cp, hit.p);
        cp[0]+=hit.n[0]*this.p.wrapClearance*2; cp[1]+=hit.n[1]*this.p.wrapClearance*2; cp[2]+=hit.n[2]*this.p.wrapClearance*2;
        w.localOff = cbox.dynamic ? vsubNew(cp, cbox.pos) : v3();
        vcopy(w.p, cp);
      } else {
        w = makeWrap(cbox, e);
        vcopy(w.p, cp);
      }
      this.wraps.splice(i, 0, w);
      if (!unbudgeted) this.insertBudget--;
      this.stats.inserts++;
      return true;
    }
    return false;
  }

  _measure() {
    const pts = this.pts, seg = this.segLens, cum = this.cum;
    seg.length = 0; cum.length = 0;
    let total = 0; cum.push(0);
    this.segHoriz.length = 0;
    for (let i = 0; i < pts.length-1; i++) {
      const L = vdist(pts[i], pts[i+1]);
      const dx = pts[i+1][0]-pts[i][0], dz = pts[i+1][2]-pts[i][2];
      seg.push(L); total += L; cum.push(total);
      // Anteil, der horizontal verläuft: nur dort kann das Seil durchhängen.
      // Ein senkrechtes Segment hängt definitionsgemäß schon.
      this.segHoriz.push(L > 1e-5 ? Math.sqrt(dx*dx+dz*dz)/L : 0);
    }
    this.length = total;
    // Tangenten an den Endpunkten. Weil der Pfad der KÜRZESTE ist, ist die
    // Ableitung der Pfadlänge nach einem Endpunkt exakt die Endtangente
    // (Hüllkurpensatz / Stationarität der inneren Kontakte) → die Constraint-
    // Normale ist ohne zusätzliche Rechnung korrekt, auch bei Umlenkung.
    if (pts.length >= 2) {
      vsub(this.dirStart, pts[1], pts[0]); vnorm(this.dirStart, this.dirStart);
      vsub(this.dirEnd, pts[pts.length-2], pts[pts.length-1]); vnorm(this.dirEnd, this.dirEnd);
    }
  }

  /** Punkt + Tangente bei Bogenlänge s; schreibt auf Wunsch Segment-Index/u raus. */
  pointAtArc(s, outP, outT, outSeg) {
    const pts = this.pts, cum = this.cum;
    if (pts.length < 2) {
      vcopy(outP, pts[0] || [0,0,0]); if (outT) vset(outT, 0,1,0);
      if (outSeg) { outSeg.i = 0; outSeg.u = 0; }
      return;
    }
    s = clamp(s, 0, this.length);
    let i = 0;
    while (i < cum.length-2 && cum[i+1] < s) i++;
    const L = this.segLens[i] || 1e-6;
    const f = clamp((s - cum[i]) / L, 0, 1);
    vlerp(outP, pts[i], pts[i+1], f);
    if (outT) { vsub(outT, pts[i+1], pts[i]); vnorm(outT, outT); }
    if (outSeg) { outSeg.i = i; outSeg.u = f; }
  }

  /** Seilkraft in die Umlenk-Körper und den Ankerkörper einkoppeln (Rückwirkung). */
  distributeReaction(tension, dirStart) {
    if (tension <= 0) return;
    const pts = this.pts;
    for (let i = 0; i < this.wraps.length; i++) {
      const w = this.wraps[i];
      const b = w.box;
      w.force = 0;
      if (!b || !b.dynamic || b.kinematic || !(b.invMass > 0)) continue;
      const idx = i + 1;
      const prev = pts[idx-1], next = pts[idx+1] || pts[idx];
      const d1 = vnormSafe(vsubNew(prev, w.p));
      const d2 = vnormSafe(vsubNew(next, w.p));
      const f = [ (d1[0]+d2[0])*0.5, (d1[1]+d2[1])*0.5, (d1[2]+d2[2])*0.5 ];
      const l = vlen(f); if (l < 1e-6) continue;
      const scale = tension * 0.5 / l;
      b.ropeForce[0] += f[0]*scale; b.ropeForce[1] += f[1]*scale; b.ropeForce[2] += f[2]*scale;
      vcopy(b.ropePoint, w.p);
      b.hasRopeForce = true;
      w.force = tension * 0.5;
    }
    const last = this.ptsBox[this.ptsBox.length-1];
    if (last && last.dynamic && !last.kinematic && last.invMass > 0) {
      const d = vnormSafe(vsubNew(pts[pts.length-2], pts[pts.length-1]));
      last.ropeForce[0] += d[0]*tension; last.ropeForce[1] += d[1]*tension; last.ropeForce[2] += d[2]*tension;
      vcopy(last.ropePoint, pts[pts.length-1]);
      last.hasRopeForce = true;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Visualisierungskette (Verlet, an den Geometrie-Pfad angebunden)            */
/* -------------------------------------------------------------------------- */
class RopeChain {
  constructor(params) { this.p = params; this.allocate((params && params.chainMaxNodes) || 96); }
  /** Pool allozieren (pos + prev + Resampling-Puffer). `n` = aktiv genutzte Nodes. */
  allocate(pool) {
    pool = Math.max(8, pool | 0);
    if (!this.pos) { this.pos = []; this.prev = []; this.tmpA = []; this.tmpB = []; }
    while (this.pos.length  < pool) { this.pos.push(v3());  this.prev.push(v3()); }
    while (this.tmpA.length < pool) { this.tmpA.push(v3()); this.tmpB.push(v3()); }
    this.pool = pool;
    this.n = clamp(this.n || pool, 2, pool);
    this.initialized = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Das Seil — Zustandsmaschine + Kopplung an Spieler und Haken                */
/* -------------------------------------------------------------------------- */
const ROPE_PHASE = { IDLE:0, FLIGHT:1, SETTLING:2, ATTACHED:3, RETRACT:4 };
const PHASE_NAME = ['IDLE','FLIGHT','SETTLING','ATTACHED','RETRACT'];

class Rope {
  constructor(world, params) {
    this.world = world;
    this.p = Object.assign({}, ROPE_DEFAULTS, params || {});
    this.path = new RopePathSolver(world, this.p);
    this.chain = new RopeChain(this.p);
    this.phase = ROPE_PHASE.IDLE;

    this.budget = 0;           // verfügbare Seillänge (m) — DIE zentrale Zustandsgröße
    this.required = 0;         // tatsächlicher Welt-Pfad Hand→Anker (m)
    this.slack = 0;
    this.tension = 0;          // 0..1 (normiert) bzw. Kraft in N
    this.tensionLevel = 0;     // 0..1 für Darstellung/Steifigkeit
    this.overshoot = 0;
    this.hand = v3();          // physikalischer Angriffspunkt (Brust)
    this.visualHand = null;    // sichtbarer Seil-Austritt; null => Brustpunkt
    this.anchor = v3();
    this.anchorBox = null;
    this.anchorBody = null;
    this.anchorNormal = v3(0,1,0);
    this.farPin = v3();

    this.settleActive = false;
    this.stats = { solves: 0, ms: 0 };
    this._tmp1 = v3(); this._tmp2 = v3(); this._tmp3 = v3(); this._tmp4 = v3();
    this.events = [];          // {type, ...} für FX/Sound
  }

  pushEvent(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  reset() {
    this.phase = ROPE_PHASE.IDLE;
    this.path.reset();
    this.budget = 0; this.budgetEff = 0; this.required = 0; this.slack = 0; this.tension = 0;
    this.tensionLevel = 0; this.settleActive = false; this.pumpOffset = 0;
    this._settledOnce = true; this._settleTarget = 0; this._tidyT = 0; this._prevWraps = null;
    this._reqPrev = null; this._dropAccum = 0; this._handAccum = 0; this._tidyHandPrev = null;
  }

  /** Seil am Anker aktivieren (wird vom Haken aufgerufen). */
  attachAt(point, normal, box, body, paidLength) {
    vcopy(this.anchor, point);
    vcopy(this.anchorNormal, normal);
    this.anchorBox = box; this.anchorBody = body || null;
    this.budget = clamp(paidLength, this.p.minBudget, this.p.capacity);
    this.path.reset();
    this.phase = ROPE_PHASE.SETTLING;
    this.settleActive = true;
    /* Setz-Zustand MUSS hier zurückgesetzt werden. Bleibt `_settledOnce` vom
       vorherigen Zyklus auf true und `_settleTarget` auf 0, rollt die Setz-Phase
       das komplette Seil auf null ab — der Spieler hängt dann an einem Seil,
       das es nicht gibt (gemessen: budget 0.00 bei required 8.97 m).         */
    this._settledOnce = false;
    this._settleTarget = 0;
    this._settleT = 0;
    this._tidyT = 0; this._prevWraps = null;
    this._reqPrev = null; this._dropAccum = 0; this._handAccum = 0; this._tidyHandPrev = null;
    /* Kette: nahtlos übernehmen, wenn ihr fernes Ende schon am Haken sitzt
       (Übergang Flug → Verankern, gemessen am Ankerpunkt). Wird dagegen an
       einen anderen Punkt angehängt, neu als Gerade legen — die Enden der
       Kette werden ohnehin gepinnt, sie kann also nicht "hinterherspringen". */
    const C = this.chain;
    if (!C.initialized || C.n < 2 || vdist(C.pos[C.n-1], point) > 0.5) C.initialized = false;
    this.pushEvent({ type: 'anchor', p: vclone(point), n: vclone(normal) });
  }

  /**
   * Flugphase starten: das Seil wird ab jetzt vom Haken aus dem Werfer gezogen.
   * `budget` wächst mit der BOGENLÄNGE der Hakenbahn → weil die Bahn eine
   * Wurfparabel ist und das Seil durchhängt, ist budget > Luftlinie, also
   * entsteht sichtbar ein LOSES Seil, das hinter dem Projektil herläuft.
   */
  beginFlight(hookPos) {
    this.phase = ROPE_PHASE.FLIGHT;
    this.path.reset();
    this.settleActive = false;
    this._settledOnce = false;
    this._settleTarget = 0;
    this._settleT = 0;
    this._tidyT = 0; this._prevWraps = null;
    // Anfangsbudget MUSS den bereits vorhandenen Abstand Hand→Haken abdecken,
    // sonst gilt das Seil sofort als fully paid out und reißt den Haken schon
    // im ersten Substep zurück (der Angriffspunkt Brust und die sichtbare Hand
    // liegen ~0.5 m auseinander).
    const d0 = hookPos ? vdist(this.hand, hookPos) : 0;
    this.budget = Math.max(0.6, d0 + 0.45);
    this._prevHook = hookPos ? vclone(hookPos) : null;
    this.pumpOffset = 0;
    this.required = 0; this.slack = 0; this.tension = 0; this.tensionLevel = 0;
    this.settleActive = false;
    this.hookPos = hookPos ? vclone(hookPos) : vclone(this.hand);
    this.chain.initialized = false;
    this.pushEvent({ type:'fire', p: vclone(this.hand) });
  }

  /** Summe der Umlenkwinkel über alle Kontakte (Rad) — für die Capstan-Reibung. */
  totalWrapAngle() {
    const pts = this.path.pts;
    if (pts.length < 3) return 0;
    let total = 0;
    for (let i = 1; i < pts.length-1; i++) {
      const a = vsubNew(pts[i], pts[i-1]), b = vsubNew(pts[i+1], pts[i]);
      const la = vlen(a), lb = vlen(b);
      if (la < 1e-5 || lb < 1e-5) continue;
      const c = clamp((a[0]*b[0]+a[1]*b[1]+a[2]*b[2])/(la*lb), -1, 1);
      total += Math.acos(c);
    }
    return total;
  }

  /** Wirksamer Pendel-Aufhängepunkt: erster Umlenkpunkt des Pfads bzw. Anker. */
  pivotPoint(out) {
    const pts = this.path.pts;
    if (pts.length >= 2) vcopy(out, pts[1]); else vcopy(out, this.anchor);
    return out;
  }
  /** Entferntes Seilende (Haken im Flug, sonst Anker). */
  farEndRef() { return this.phase === ROPE_PHASE.FLIGHT ? (this.hookPos || this.anchor) : this.anchor; }

  detach() {
    if (this.phase === ROPE_PHASE.IDLE) return;
    this.pushEvent({ type: 'detach', p: vclone(this.hand) });
    this.reset();
  }

  /** Manuelles Auf-/Abrollen (Mausrad / Tastatur). */
  reel(delta) {
    if (this.phase === ROPE_PHASE.IDLE) return;
    this.budget = clamp(this.budget + delta, this.p.minBudget, this.p.capacity);
  }

  get attached() { return this.phase === ROPE_PHASE.ATTACHED || this.phase === ROPE_PHASE.SETTLING; }

  /* ---------------------------------------------------------------------- */
  /*  Physik-Schritt (feste Substep-Rate)                                    */
  /* ---------------------------------------------------------------------- */
  /**
   * @param handPos  aktueller Hand-/Brustpunkt des Spielers
   * @param hookPos  Hakenposition (nur in FLIGHT relevant) oder null
   */
  step(dt, handPos, hookPos, playerVel) {
    const P = this.p;
    vcopy(this.hand, handPos);

    if (this.phase === ROPE_PHASE.IDLE) { this.tensionLevel = 0; this.tension = 0; return; }

    /* ---- 1) Pfad-Topologie -------------------------------------------- */
    if (hookPos) { if (!this.hookPos) this.hookPos = v3(); vcopy(this.hookPos, hookPos); }
    const endPt = (this.phase === ROPE_PHASE.FLIGHT) ? (hookPos || this.hookPos) : this.anchor;
    const endBox = (this.phase === ROPE_PHASE.FLIGHT) ? null : this.anchorBox;
    /* Die Pfadlänge wird UNVERFÄLSCHT übernommen. Ein Rate-Limit hier wäre
       falsch: dieselbe Größe steuert auch das Setzen des Budgets, eine
       verzögerte Länge würde also ein zu kurzes Budget erzeugen und damit
       erst recht große Überdehnungen. Gegen harte Rucke beim Umschlagen einer
       Wicklung hilft stattdessen der gedeckelte Baumgarte-Bias (maxBiasSpeed)
       und die weiche Kontakt-Freigabe.                                      */
    this.required = this.path.solve(handPos, endPt, dt, null, endBox);
    this.stats.solves++;

    /* ---- 2) Budget-Logik (Seil-Vorrat) -------------------------------- */
    if (this.phase === ROPE_PHASE.FLIGHT) {
      /* Seilausgabe = BOGENLÄNGE der Hakenbahn, nicht die Luftlinie.
         Der Haken zieht das Seilende hinter sich her; weil seine Bahn eine
         Wurfparabel ist und das Seil außerdem durchhängt, ist die ausgegebene
         Länge automatisch größer als der Abstand Hand→Haken. Genau dieser
         Überschuss ist das sichtbar lose hinterherlaufende Seil.            */
      const d = vdist(handPos, hookPos);
      const hs = dt > 1e-6 ? vdist(hookPos, this._prevHook) / dt : 0;
      if (!this._prevHook) this._prevHook = vclone(hookPos);
      vcopy(this._prevHook, hookPos);
      this.budget = Math.min(P.capacity, Math.max(this.budget + (hs*P.feedGain + P.feedBias)*dt, d + 0.06));
    } else if (this.settleActive) {
      /* Nach dem Verankern: Überschuss schnell EINZIEHEN, bis die Verbindung
         straff ist. Das ist das "Zusammenziehen" aus dem Zielbild.
         Wichtig: das Budget darf dabei niemals WACHSEN. Wäre der Welt-Pfad
         länger als das bezahlte Seil (z. B. weil es um eine Kante läuft),
         ist das Seil schlicht zu kurz — dann zieht die Constraint, statt dass
         sich das Seil selbst Gratis-Länge auszahlt.                        */
      /* Einmalig beim Setzen: reicht das bezahlte Seil nicht bis zum Anker,
         weil der Pfad um ein Hindernis läuft, wird genau dieser Betrag
         nachgegeben. Das ist keine Gratis-Länge während des Spielbetriebs —
         es geschieht exakt einmal im ersten Solve nach dem Verankern, denn in
         dem Moment etabliert sich die Wicklungs-Konfiguration. Ohne das
         entsteht beim Einhaken ein sofortiger Überschuss von bis zu 1.8 m und
         damit ein harter Ruck.                                             */
      this._settleT = (this._settleT || 0) + dt;
      // Ziel erst festlegen, wenn der Pfad sinnvoll ist. Im ersten Solve kann
      // die Hand praktisch auf dem Anker liegen (required ≈ 0) — daraus ein
      // Ziel zu machen würde das komplette Seil einrollen.
      if (!this._settledOnce && this.required > 0.5) {
        this._settledOnce = true;
        // Topologie einmal vollständig aufbauen, bevor das Seil sichtbar wird
        this.required = this.path.converge();
        // Reicht das bezahlte Seil nicht bis zum Anker (Pfad läuft um ein
        // Hindernis), wird genau dieser Betrag einmalig nachgegeben — in dem
        // Moment etabliert sich die Wicklungs-Konfiguration.
        if (this.required > this.budget) this.budget = this.required + P.tautMargin;
        /* Das Ziel wird EINMAL festgelegt und danach nie mehr nachgeführt.
           Früher war target = required + margin und wurde jeden Substep neu
           berechnet. Bewegt sich der Spieler während des Einziehens auf den
           Anker zu, rollt das Budget immer weiter herunter — es ratchtet.
           Schwingt er danach weg, ist das Seil plötzlich Dutzende Meter zu
           kurz (gemessen: 41.6 m Überdehnung bei 8.1 m Budget). Die
           verfügbare Seillänge muss aber genau das sein, was sie nach dem
           Setzen ist — danach ändert sie nur noch der Spieler selbst.        */
        this._settleTarget = this.required + P.tautMargin;
        this._settleHandMoved = 0;
        this._settleHandPrev = vclone(this.hand);
      }
      /* Topologie-Korrektur WÄHREND des Setzens: wird der Welt-Pfad plötzlich
         deutlich billiger, ohne dass die Hand sich entsprechend bewegt hat,
         dann war der Lock ein unkonvergierter Topologie-Zustand (gemessen:
         Wrap-Kontakt 12 m neben der echten Kante ⇒ 15.5 m Seil als Spiel
         eingefroren, danach keinerlei Halt an der Umlenkung). Der Ratchet-
         Schutz gilt der HANDBEWEGUNG (Spieler läuft ins Seil), nicht dem
         Solver-Irrtum — also in dem Fall neu nach unten locken.            */
      if (this._settledOnce) {
        this._settleHandMoved = (this._settleHandMoved || 0) + vdist(this.hand, this._settleHandPrev || this.hand);
        vcopy(this._settleHandPrev || (this._settleHandPrev = v3()), this.hand);
        const need = this.required + P.tautMargin;
        if (need < this._settleTarget - (this._settleHandMoved + 0.5)) this._settleTarget = need;
      }
      const done = this._settledOnce && (this.budget <= this._settleTarget + 1e-4 || this._settleT > 0.7);
      if (!done) {
        if (this._settledOnce) {
          this.budget = Math.max(this._settleTarget, this.budget - P.settleReelSpeed * dt);
        }
      } else {
        /* Abschluss: einmalig darf das Budget noch NACH OBEN korrigiert werden,
           falls der Pfad inzwischen länger geworden ist. Verlängern erzeugt nie
           einen Ruck (die Constraint zieht nur bei zu KURZEM Seil), verkürzen
           schon — deshalb gibt es hier keine Nachführung nach unten.          */
        const need = this.required + P.tautMargin;
        if (this.budget < need) this.budget = need;
        this.budget = Math.max(this.budget, P.minBudget);
        this.settleActive = false; this.phase = ROPE_PHASE.ATTACHED;
        this._settleT = 0;
      }
    }
    /* Freies Spiel nach Topologie-Release: löst sich ein Wrap-Kontakt, wird
       die in der Wicklung gespeicherte Länge auf einmal frei — das Seil ist
       aus dem Stand „meterweit schlaff" und jeder Halt an der Umlenkung ist
       weg (gemessen: +15.8 m Spiel beim Umkreisen der Wrap-Wand ⇒ Widerstand
       null). Der Werfer rollt genau diese freigesetzte Menge mit Setz-Rate
       nach. Bewusstes Abrollen des Spielers bleibt unberührt, denn verfolgt
       wird nur die Release-Menge, nicht das Spiel selbst.                  */
    // Pump-Modulation wirkt auf das WIRKSAME Budget (nullmittelnd → kein Drift)
    this.budgetEff = this.budget + (this.pumpOffset || 0);
    // Roll-Rate: die Constraint darf den Spieler nie schneller einziehen, als
    // tatsächlich Seil aufgerollt wird — sonst wird Pumpen zum harten Ruck.
    this.budgetRate = (this._prevBudgetEff != null) ? (this.budgetEff - this._prevBudgetEff)/Math.max(1e-6,dt) : 0;
    this._prevBudgetEff = this.budgetEff;
    this.slack = this.budgetEff - this.required;

    this.overshoot = Math.max(0, -this.slack);

    /* Nachroll-Fenster nach Topologie-Release (siehe Defekt #55): das Seil
       findet in dieser Zeit von selbst zurück auf straff, egal wie sich der
       Spieler dabei bewegt (Required ändert sich ja weiter). Eine reine
       Mengenbuchhaltung verfällt mitten im Vorgang (gemessen: 4.1 m Spiel
       bleiben stehen), ein dauerhafter Automatik-Modus würde dagegen das
       bewusste Abrollen und jedes legitime Spiel auffressen. Steht VOR der
       Spannungs-Berechnung und rechnet Slack/BudgetEff deshalb neu.        */
    const wrapCount = this.path.pts.length - 2;
    /* Un erklärte Required-Sprünge nach unten erkennen: wird der Welt-Pfad
       deutlich billiger, ohne dass die Hand sich entsprechend bewegt hat,
       hat sich die Topologie selbst korrigiert (Kontakt ersetzt/gefallen) —
       das freigesetzte Spiel gehört nachgerollt. Läuft der Spieler dagegen
       bewusst näher heran, wächst required-Abfall und Handweg gemeinsam und
       nichts passiert.                                                     */
    const handMove = vdist(this.hand, this._tidyHandPrev || this.hand);
    vcopy(this._tidyHandPrev || (this._tidyHandPrev = v3()), this.hand);
    if (this._reqPrev != null && this.required > this._reqPrev + 1e-9) {
      this._dropAccum = 0; this._handAccum = 0;
    }
    if (this._reqPrev != null) {
      this._dropAccum = (this._dropAccum || 0) + Math.max(0, this._reqPrev - this.required);
      this._handAccum = (this._handAccum || 0) + handMove;
    }
    this._reqPrev = this.required;
    if (this.attached && !this.settleActive) {
      if ((this._prevWraps != null && wrapCount < this._prevWraps ||
           (this._dropAccum || 0) > (this._handAccum || 0) + 0.5) && this.slack > 0.5) {
        this._tidyT = 1.0; this._dropAccum = 0; this._handAccum = 0;
      }
      if (this._tidyT > 0) {
        this._tidyT -= dt;
        const pull = Math.min(P.settleReelSpeed * dt,
                              Math.max(0, this.slack - P.tautMargin),
                              Math.max(0, this.budget - (this.required + P.tautMargin)));
        this.budget -= pull;
        this.budgetEff = this.budget + (this.pumpOffset || 0);
        this.slack = this.budgetEff - this.required;
        this.overshoot = Math.max(0, -this.slack);
      }
    } else this._tidyT = 0;
    this._prevWraps = wrapCount;

    /* ---- 4) Spannungsniveau ------------------------------------------- */
    const ratio = this.slack / Math.max(1, this.required);
    this.tensionLevel = 1 - smoothstep(P.slackRatioSoft, P.slackRatioFull, ratio);
    // Während des Setzens ist das Seil per Definition dabei, sich zu spannen:
    // die Wellenfront soll sichtbar bleiben, auch solange noch Überschuss
    // eingezogen wird.
    if (this.settleActive) this.tensionLevel = Math.max(this.tensionLevel, 0.92);
    if (this.phase === ROPE_PHASE.FLIGHT) this.tensionLevel = Math.min(this.tensionLevel, 0.3);

    /* ---- 5) Constraint-Kraft (wird vom Player-Controller abgefragt) ---- */
    if (this.attached && this.slack <= 0) {
      // Starr + optional elastisch
      const k = P.elasticity > 0 ? P.stretchStiffness * P.elasticity : 0;
      this.tension = Math.max(this.tension, k * this.overshoot);
    } else {
      this.tension = 0;
    }

    /* ---- 6) Rückwirkung auf dynamische Körper ------------------------- */
    if (this.attached && this.tensionLevel > 0.02) {
      const T = Math.max(this.tension, this.tensionLevel * this._estimateLoad(playerVel, dt));
      this.path.distributeReaction(T, this.path.dirStart);
    }

    /* ---- 7) Visualisierungskette -------------------------------------- */
    this._stepChain(dt, hookPos, playerVel);
  }

  /** Grobe Lastabschätzung für die Rückwirkung (Zentrifugal + Gewicht). */
  _estimateLoad(playerVel, dt) {
    const r = Math.max(1, this.required);
    const vt2 = vlenSq(playerVel);
    return (80 * 9.81) * (1 + vt2 / (r * 26));   // Spieler ~80 kg
  }

  /* ---------------------------------------------------------------------- */
  /*  EINSEITIGE CONSTRAINT am Spieler — der einzige Ort, an dem das Seil     */
  /*  Gameplay-Physik macht. Keine Positions-Teleportie.                      */
  /* ---------------------------------------------------------------------- */
  /**
   * @param {number[]} vel       Geschwindigkeit des Spielers (wird korrigiert)
   * @param {number} dt          Substep-Zeit
   * @param {number[]} [groundN] Bodennormale, solange der Spieler steht (sonst null)
   * @returns {number} korrigierte Seilkraft (für HUD / FX / Rückwirkung)
   */
  constrainPlayer(vel, dt, groundN) {
    if (!this.attached || this.slack > 0) { this.activeForce = 0; return 0; }
    const P = this.p;
    // nOut = Richtung, in der die Pfadlänge WÄCHST = -Tangente an der Hand
    const n = this._tmp1;
    vneg(n, this.path.dirStart);
    let impulse = 0;
    const C = this.overshoot;

    /* (a)+(b) in EINER korrekten Formulierung.
       Baumgarte-Stabilisierung heißt: die Normalgeschwindigkeit wird auf einen
       ZIELWERT gesetzt (−bias), nicht um bias ERHÖHT. Wird sie aufaddiert,
       akkumuliert sie über die Substeps und eine große Überdehnung konvergiert
       nie — der Spieler wird dann hin- und hergeschossen statt eingefangen.
       bias = 0 ⇒ rein einseitige Constraint (vn ≤ 0 erlaubt, kein Druck).     */
    const bias = C > 0 ? Math.min(P.maxBiasSpeed, (P.baumgarteBeta * C) / Math.max(1e-5, dt)) : 0;
    // Ziel-Normalgeschwindigkeit = Roll-Rate (≤ 0 beim Einziehen) minus Bias.
    // Damit folgt der Spieler exakt dem aufgerollten Seil — nicht einem Impuls.
    const rate = Math.min(0, this.budgetRate || 0);

    /* AM BODEN: Das Seil ist eine Zugkraft, kein Aufzug. Solange der Boden
       trägt, hebt ein Seilzug den Spieler nicht — die Vertikalkomponente geht
       in die Bodennormalkraft, übrig bleibt die horizontale Zugrichtung.
       Ohne diese Projektion lenkt die einseitige Constraint das Rückwärts-
       laufen am steilen Seil in die Tangente der Pendelbahn um und der
       Spieler steigt schwebend auf (gemessen: +6.4 m Höhengewinn beim
       einfachen Weglaufen, Bodenkontakt verloren nach 0.3 s).
       Die Projektion gilt für Halt UND Bias; NUR bewusstes Einrollen
       (rate < 0 bei steilem Seil) hebt auch am Boden — das ist die Winde.   */
    const nH = this._tmp2;
    let s = 1, hasH = false;
    if (groundN) {
      const d = n[0]*groundN[0] + n[1]*groundN[1] + n[2]*groundN[2];
      const hx = n[0]-groundN[0]*d, hy = n[1]-groundN[1]*d, hz = n[2]-groundN[2]*d;
      s = Math.sqrt(hx*hx + hy*hy + hz*hz);
      if (s > 0.25) { nH[0]=hx/s; nH[1]=hy/s; nH[2]=hz/s; hasH = true; }
    }
    const nUse = hasH ? nH : n;
    // Überdehnungs-Rate in Benutzernormalen-Raum: am Boden ist nur der
    // horizontale Anteil der Bewegung eine Erweiterung des Welt-Pfads.
    const vn = vdot(vel, nUse) * (hasH ? s : 1);
    const targetVn = Math.max(-P.maxBiasSpeed, rate - bias);
    if (vn > targetVn) {
      // Aufprall optional mit Restitution, sonst exakt auf den Zielwert
      const cutFull = (vn > 0 && P.restitution > 0) ? (vn*(1 + P.restitution) + bias) : (vn - targetVn);
      const cut = cutFull / (hasH ? s : 1);
      vel[0] -= nUse[0]*cut; vel[1] -= nUse[1]*cut; vel[2] -= nUse[2]*cut;
      impulse += Math.abs(cutFull);
    } else if (P.rigidRod && vn < 0 && C < 0.02) {
      // A/B-REFERENZ "starre Stange": auch die Annäherung wird blockiert.
      // Zeigt sofort, warum das Seil EINSEITIG sein muss (kein Druck).
      const cut = vn / (hasH ? s : 1);
      vel[0] -= nUse[0]*cut; vel[1] -= nUse[1]*cut; vel[2] -= nUse[2]*cut;
      impulse -= vn;
    }
    // Winde: bewusstes Einrollen hebt am Boden, wenn das Seil steil hängt
    // (Klettern am Seil). Der Bias-Anteil darf das NICHT — er ist eine
    // Restfehler-Korrektur, keine Zugkraft.
    if (groundN && rate < 0 && n[1] < -0.35) {
      const lift = -rate * Math.min(1, -n[1]);
      if (vel[1] < lift) { impulse += lift - vel[1]; vel[1] = lift; }
    }
    // (c) Elastizität (optional, für "Gummi"-Gefühl)
    if (P.elasticity > 0 && C > 0) {
      const f = (P.stretchStiffness * C + P.stretchDamping * Math.max(0, vn)) * P.elasticity * dt;
      vel[0] -= nUse[0]*f; vel[1] -= nUse[1]*f; vel[2] -= nUse[2]*f;
      impulse += f;
    }
    this.activeForce = impulse / Math.max(1e-5, dt) * 80;  // ≈ Newton bei 80 kg
    return this.activeForce;
  }

  /* ---------------------------------------------------------------------- */
  /*  Visualisierungskette: ein echtes physikalisches Seil (Verlet)           */
  /* ---------------------------------------------------------------------- */
  /**
   * MODELL: Die Kette IST die Seilform — es gibt keine berechnete Zielkurve.
   *
   *   · Enden        → gepinnt an Hand und Anker/Haken
   *   · dazwischen   → massebehaftete Nodes: Schwerkraft, Luftwiderstand,
   *                    Abstands-Constraints auf die ausgegebene Seillänge und
   *                    harte Welt-Kollision (kein Node dringt in Geometrie)
   *
   * Warum das die gemeldeten Fehler an der Wurzel beseitigt:
   *   1. Die Länge ist hart: Σ Segmentlängen = Budget. Bei großem Spiel hängt
   *      das Seil bis zum Boden durch und legt sich dort ab. Die alte,
   *      gedeckelte Durchhang-Formel (dip ≤ 0.42·S) konnte das nicht
   *      darstellen — das Seil "vergaß" sichtbar den Großteil seiner Länge.
   *   2. Nichts teleportiert: Node-Positionen ändern sich ausschließlich durch
   *      Integration, Constraints und Kollisions-Herausdrücken. Es gibt keine
   *      Sollkurve mehr, an die Nodes springen könnten (im Flug zog die alte
   *      Kurve die Nodes Richtung ALTEN Anker — das Seil lief mitten aus der
   *      Luft zum Boden und bildete zwei gerade Linien zum Haken).
   *   3. EINE stetige Kurve per Konstruktion: Höhe und Steigung können nicht
   *      springen; ein Knick entsteht nur, wo eine Kante das Seil wirklich
   *      trägt oder führt — genau die geforderte Ein-Kurven-Eigenschaft.
   *   4. Straffheit ist eine Folge der Länge: ist das Budget gleich der
   *      Welt-Pfadlänge, MUSS die Kette der Geometrie folgen (um Kanten
   *      herum), weil die Constraints sonst nicht erfüllbar sind. Zusätzliche
   *      Steifigkeit gibt es nicht — und braucht es nicht.
   *
   * Die Node-Zahl folgt der Seillänge (chainSpacing). Ändert sie sich, werden
   * die Positionen entlang der aktuellen Polylinie neu abgetastet — stetig,
   * ohne Sprung, unter Erhalt der Bahngeschwindigkeit.
   */
  _stepChain(dt, hookPos, playerVel) {
    const P = this.p, C = this.chain, path = this.path;
    if (!C.pos || C.pool < 8) C.allocate(P.chainMaxNodes || 96);
    const flying = (this.phase === ROPE_PHASE.FLIGHT);
    const farPin = flying ? (hookPos || this.hookPos || this.anchor) : this.anchor;
    const handPin = (!flying && this.visualHand) ? this.visualHand : this.hand;
    const pathLen = flying ? Math.max(1e-4, vdist(this.hand, farPin))
                           : Math.max(1e-5, this.required);

    /* Pin-Polylinie: HAND → Wrap-Kontakte → fernes Ende. Der Pfad-Solver misst
       ab Brustpunkt (stabile Constraint), die Kette ist jedoch an der Hand
       gepinnt — ohne diese Polylinie springt das erste Kettensegment von der
       Hand zum Brustpunkt (sichtbarer Knick nur im Ego-Bild, gemessen 6.5 bis
       11°) und die Seillänge zwischen den Pins stimmt um den Brust-Hand-
       Abstand nicht (~0.6 m bei gestrecktem Arm). Genau dieser Überschuss
       hing bei Vollspannung als Katenaar-Durchhang im Bild: 0.6 m Überschuss
       an 15 m Spannweite ergeben ~1.3 m Sichtdurchhang, denn ein fast
       unelastisches Seil verstärkt Längenfehler quadratisch (Defekt #53).  */
    const poly = this._poly || (this._poly = { pts: [], cum: [] });
    const srcPts = path.pts;
    const pn = flying ? 2 : Math.max(2, srcPts.length);
    while (poly.pts.length < pn) poly.pts.push(v3());
    vcopy(poly.pts[0], handPin);
    if (flying) vcopy(poly.pts[1], farPin);
    else {
      for (let i = 1; i < pn-1; i++) vcopy(poly.pts[i], srcPts[i]);
      vcopy(poly.pts[pn-1], farPin);
    }
    poly.cum.length = 0; poly.cum.push(0);
    let polyLen = 0;
    for (let i = 1; i < pn; i++) { polyLen += vdist(poly.pts[i-1], poly.pts[i]); poly.cum.push(polyLen); }
    poly.len = polyLen;

    /* Pin-konsistente Seillänge: der Modell-Offset Brust↔Hand ist KEIN Seil
       und darf zwischen den Pins nicht als Überschuss auftauchen.            */
    const pinCorr = flying ? 0 : Math.max(0, pathLen - polyLen);
    const Lraw = Math.max(pathLen, (this.budgetEff > 0 ? this.budgetEff : this.budget));
    const L = Math.max(polyLen * 0.999, Lraw - pinCorr);
    const slackPin = L - polyLen;
    const h = Math.min(dt, 1/60);

    /* Node-Zahl aus der Seillänge, mit Hysterese: erst wenn der tatsächliche
       Node-Abstand aus dem Band [0.7, 1.4]·chainSpacing fällt, wird neu
       abgetastet — sonst gäbe es beim Aufrollen dauerhaft Resampling.       */
    const spacing = Math.max(0.1, P.chainSpacing);
    let m = C.n;
    if (!C.initialized || m < 2) m = clamp(Math.round(L / spacing) + 1, 8, C.pool);
    else {
      const segNow = L / (m - 1);
      if (segNow > spacing * 1.4 || segNow < spacing * 0.7)
        m = clamp(Math.round(L / spacing) + 1, 8, C.pool);
    }
    if (m !== C.n) this._resampleChain(m);
    const n = C.n;

    /* LÄNGENREGELUNG — die eine Längen-Autorität, exakt eingehalten.
       Gauss-Seidel-Iterationen beseitigen die Dehnung unter Eigengewicht nie
       ganz (gemessen: 2.6 % bei 8 Durchläufen, 1.6 % bei 16 — ein durch-
       hängendes Seil hing dadurch sichtbar tiefer als ein echtes Seil
       derselben Länge). Der Regler misst die tatsächliche Kettenlänge und
       korrigiert die Ruhe-Länge der Segmente: ist die Kette zu lang, werden
       die Segmente etwas kürzer gegeben, ist sie kürzer als das Budget
       (aufgerollt, abgelegt, gestaucht), wandert der Faktor langsam zurück
       auf 1. Stationär gilt damit Σ Segmentlängen = Budget — der Durchhang
       ist exakt der eines echten Seils dieser Länge.                        */
    const seg = (L / (n - 1));

    if (!C.initialized) {
      /* Neulegen: im Flug als Gerade Hand→Haken; EINGEHAKT entlang des
         gelösten Welt-Pfads. Nicht "gerade Linie durchs Hindernis +
         herausdrücken": dann entscheidet der Zufall der Drückrichtung, auf
         welcher Seite das Seil landet, und es bleibt unter Umständen in
         einer energetisch günstigeren, aber falschen Route hängen (gemessen:
         Seil unter der Box statt um die gelöste Kante, 42 % Segment-Dehnung
         an der Unterkante). Der Pfad-Anfang (Hand) und das ferne Ende werden
         exakt gepinnt — dazwischen folgt die Kette der Polylinie und die
         Constraints verteilen sie auf die Seillänge.                        */
      const usePath = !flying && polyLen > 0.5 && pn >= 2;
      for (let i = 0; i < n; i++) {
        const t = i/(n-1);
        if (usePath) this._polyAt(poly, t * polyLen, C.pos[i]);
        else vlerp(C.pos[i], handPin, farPin, t);
        vcopy(C.prev[i], C.pos[i]);
      }
      vcopy(C.pos[0], handPin);   vcopy(C.prev[0], handPin);
      vcopy(C.pos[n-1], farPin);  vcopy(C.prev[n-1], farPin);
      C.initialized = true;
    }

    /* Verlet-Integration: x' = x + (x − x_prev)·damping + g·h².
       Die Enden sind gepinnt und werden nicht integriert. Der Wächter vMax
       ist reine Absturzsicherung (entartete Constraint-Zustände), im
       normalen Betrieb wird er nie erreicht.                               */
    const gh2 = (this.world ? this.world.gravity : -26) * h * h;
    const damp = Math.max(0, 1 - (P.chainDrag || 0) * h);
    const vMax = 2.0, vMax2 = vMax*vMax;
    for (let i = 1; i < n-1; i++) {
      const p = C.pos[i], q = C.prev[i];
      let vx = (p[0]-q[0])*damp, vy = (p[1]-q[1])*damp, vz = (p[2]-q[2])*damp;
      const v2 = vx*vx + vy*vy + vz*vz;
      if (v2 > vMax2) { const f = vMax/Math.sqrt(v2); vx*=f; vy*=f; vz*=f; }
      q[0]=p[0]; q[1]=p[1]; q[2]=p[2];
      p[0]+=vx; p[1]+=vy+gh2; p[2]+=vz;
    }
    vcopy(C.pos[0], handPin);   vcopy(C.prev[0], handPin);
    vcopy(C.pos[n-1], farPin);  vcopy(C.prev[n-1], farPin);

    /* Längen-Constraints + harte Kollision. Die Sweep-Richtung wechselt pro
       Iteration, damit sich Spannung von beiden Enden her ausbreitet.       */
    const iters = Math.max(1, P.chainIterations | 0);
    const R = P.chainNodeRadius;
    const doWorld = P.chainCollideWorld && this.world;
    const cap = (P.chainCollidePlayer && this._playerCapsule) ? this._playerCapsule : null;
    /* Nodes auf den ersten ~0.9 m ab Hand ignorieren die Spielerkapsel: der
       Seil-Austrittspunkt liegt definitionsgemäß IN der Kapsel.            */
    const skipHand = cap ? Math.min(n-2, Math.max(2, Math.ceil(0.9 / seg))) : 0;
    const t = this._chainTmp || (this._chainTmp = v3());
    const fric = P.chainFriction || 0;
    /* Kollision läuft nur im FENSTER der letzten 4 Iterationen: die frühen
       Durchläufe bringen die Form (billig, reine Constraints), die späten
       stellen gegen die Geometrie frei (teuer, aber garantiert ZULETZT —
       nach dem letzten Durchlauf steckt kein Node in fester Geometrie).    */
    const collideFrom = Math.max(0, iters - 4);
    for (let it = 0; it < iters; it++) {
      if (it & 1) { for (let i = n-2; i >= 0; i--) this._relaxSeg(i, seg); }
      else        { for (let i = 0; i < n-1; i++)  this._relaxSeg(i, seg); }
      if (it >= collideFrom) {
        if (doWorld) {
          const last = (it === iters-1);
          for (let i = 1; i < n-1; i++) {
            const p = C.pos[i];
            if (last && fric > 0) {
              /* Kontaktsreibung: wurde der Node aus Geometrie herausgedrückt,
                 wird seine Bahngeschwindigkeit anteilig gebremst (prev zieht
                 Richtung pos). Ohne das würden Seilhaufen auf dem Boden
                 endlos auseinanderfließen.                                 */
              t[0]=p[0]; t[1]=p[1]; t[2]=p[2];
              this.world.collideSphere(p, R, true);
              if (p[0]!==t[0] || p[1]!==t[1] || p[2]!==t[2]) {
                const q = C.prev[i];
                q[0] += (p[0]-q[0])*fric; q[1] += (p[1]-q[1])*fric; q[2] += (p[2]-q[2])*fric;
              }
            } else {
              this.world.collideSphere(p, R, true);
            }
          }
        }
        if (cap) for (let i = skipHand; i < n-1; i++)
          collideCapsuleSphere(cap.pos, cap.radius, cap.hh, C.pos[i], R);
      }
      vcopy(C.pos[0], handPin);
      vcopy(C.pos[n-1], farPin);
    }

    /* Straff-Projektion: bei Spiel ≈ 0 ist die Seilform EINDUTIG bestimmt —
       sie ist der kürzeste freie Pfad (hier: die Pin-Polylinie). Gauss-Seidel
       kann die Katenaar-Toleranz prinzipiell nicht in 14 Durchläufen treffen
       (gemessen: 6 cm Restüberschuss an 45 m ⇒ 1 m Durchhang; gefragt sind
       ≤2 cm). Die exakte Lösung ist bekannt, also wird die Kette darauf
       gesetzt — geschwindigheitserhaltend (gleiches Delta auf pos UND prev),
       damit nichts „mitgezerrt" wird. Mit wachsendem Spiel blendet die
       Projektion aus und die Verlet-Dynamik übernimmt stetig.               */
    const taut = (!flying && this.attached) ? clamp(1 - slackPin / 0.35, 0, 1) : 0;
    if (taut > 0.01) {
      const k = 0.6 * taut;
      const tp = this._tpProj || (this._tpProj = v3());
      for (let i = 1; i < n-1; i++) {
        this._polyAt(poly, (i/(n-1)) * polyLen, tp);
        const p = C.pos[i], q = C.prev[i];
        const ddx = (tp[0]-p[0])*k, ddy = (tp[1]-p[1])*k, ddz = (tp[2]-p[2])*k;
        p[0]+=ddx; p[1]+=ddy; p[2]+=ddz;
        q[0]+=ddx; q[1]+=ddy; q[2]+=ddz;
      }
      vcopy(C.pos[0], handPin);
      vcopy(C.pos[n-1], farPin);
      /* Die Projektion darf die Kollisionsgarantie nicht brechen: steckt die
         Hand (oder der Pfad-Anfang) in Geometrie, liegt auch die Polylinie
         dort kurz innen. Ein letzter Freistell-Durchlauf stellt sicher, dass
         NACH allem weiterhin kein Node in fester Geometrie steckt.          */
      if (doWorld) for (let i = 1; i < n-1; i++) this.world.collideSphere(C.pos[i], R, true);
      if (cap) for (let i = skipHand; i < n-1; i++)
        collideCapsuleSphere(cap.pos, cap.radius, cap.hh, C.pos[i], R);
      vcopy(C.pos[0], handPin);
      vcopy(C.pos[n-1], farPin);
    }
  }

  /** Punkt auf der Pin-Polylinie bei Bogenlänge s. */
  _polyAt(poly, s, out) {
    const cum = poly.cum, pts = poly.pts;
    let i = 0;
    while (i < cum.length-2 && cum[i+1] < s) i++;
    const Ls = (cum[i+1]-cum[i]) || 1e-6;
    vlerp(out, pts[i], pts[i+1], clamp((s-cum[i])/Ls, 0, 1));
    return out;
  }

  /** Ein Abstands-Constraint (Gauss-Seidel). Index 0 und n−1 sind gepinnt. */
  _relaxSeg(i, rest) {
    const C = this.chain, a = C.pos[i], b = C.pos[i+1];
    const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
    const l2 = dx*dx + dy*dy + dz*dz;
    if (l2 < 1e-12) return;
    const l = Math.sqrt(l2);
    /* Überrelaxation NUR im kleinen Fehlerbereich (dort beschleunigt sie die
       Konvergenz ~3×). Große Fehler — Entfalten der Kette, Budget-Sprünge,
       Peitschen — würden mit ω>1 überschießen: die Nodes schießen über den
       Nachbarn hinaus und die Kette reißt kurzzeitig auf (gemessen: 6 m
       Node-Abstand bei ω=1.6 ohne diese Grenze). Große Fehler werden exakt
       zu 100 % korrigiert — das holt jede Lücke in einem Durchlauf zurück. */
    const err = l - rest;
    const sor = (err > -rest && err < rest) ? (this.p.chainSOR || 1) : 1;
    const f = (sor * err) / l;
    const ux = dx*f, uy = dy*f, uz = dz*f;
    if (i === 0)          { b[0]-=ux; b[1]-=uy; b[2]-=uz; }
    else if (i === C.n-2) { a[0]+=ux; a[1]+=uy; a[2]+=uz; }
    else { a[0]+=ux*0.5; a[1]+=uy*0.5; a[2]+=uz*0.5;
           b[0]-=ux*0.5; b[1]-=uy*0.5; b[2]-=uz*0.5; }
  }

  /** Node-Zahl ändern: pos UND prev entlang der aktuellen Polylinie neu
   *  abtasten (Bogenlängen-Interpolation) — Positionen springen nicht und
   *  die Bahngeschwindigkeit bleibt erhalten.                              */
  _resampleChain(m) {
    const C = this.chain, old = C.n;
    m = clamp(m | 0, 2, C.pool);
    if (old < 2 || old === m) { C.n = m; return; }
    const cum = (this._rsCum && this._rsCum.length >= C.pool + 2)
              ? this._rsCum : (this._rsCum = new Float64Array(C.pool + 2));
    let total = 0; cum[0] = 0;
    for (let i = 1; i < old; i++) { total += Math.sqrt(vdistSq(C.pos[i-1], C.pos[i])); cum[i] = total; }
    const put = (dst, src, j) => {
      if (total < 1e-6) { vlerp(dst, src[0], src[old-1], j/(m-1)); return; }
      const sArc = total * j/(m-1);
      let i = 1; while (i < old-1 && cum[i] < sArc) i++;
      const l = cum[i] - cum[i-1];
      vlerp(dst, src[i-1], src[i], l > 1e-9 ? clamp((sArc - cum[i-1]) / l, 0, 1) : 0);
    };
    for (let j = 0; j < m; j++) { put(C.tmpA[j], C.pos, j); put(C.tmpB[j], C.prev, j); }
    for (let j = 0; j < m; j++) { vcopy(C.pos[j], C.tmpA[j]); vcopy(C.prev[j], C.tmpB[j]); }
    C.n = m;
  }

  setPlayerCapsule(pos, radius, hh) { this._playerCapsule = { pos, radius, hh }; }

  /**
   * Geglättete Render-Kurve in einen allokationsfreien Float32Array-Pool.
   *
   * ZENTRIPETALER Catmull-Rom (α = 0.5) über die Ketten-Nodes. Die Nodes sind
   * durch die Abstands-Constraints gleichmäßig verteilt (chainSpacing) — der
   * Spline rundet nur die Polygon-Ecken ab, erfindet aber nichts dazu: was
   * man sieht, ist exakt die simulierte Seilform. Was die Rundung an
   * Geometrie-Ecken übriglässt, räumt die Kollisionsgarantie unten ab
   * (Herausschieben + begrenzte Eck-Reparatur).
   */
  buildRenderCurve(out) {
    const C = this.chain, n = C.n;
    /* Unterteilung PRO SEGMENT nach dessen tatsächlicher Länge. Ein globaler
       Wert aus dem Durchschnitt würde lange Segmente unter-abtasten — und
       genau dort schneidet die Verbindungsgerade am tiefsten in Geometrie.  */
    const spacing = Math.max(0.03, this.p.renderSpacing);
    let subs = this._sub;
    if (!subs || subs.length < n) subs = this._sub = new Uint8Array(Math.max(n, 128));
    let total = 1;
    for (let i = 0; i < n-1; i++) {
      const L = Math.sqrt(vdistSq(C.pos[i], C.pos[i+1]));
      const k = clamp(Math.round(L / spacing), 1, 40);
      subs[i] = k;
      total += k;
    }
    const cap = (total + 64 + 2*96) * 3;   // + Platz für die Eck-Reparatur
    if (!out.buf || out.buf.length < cap) out.buf = new Float32Array(cap);
    const B = out.buf; let w = 0;
    for (let i = 0; i < n-1; i++) {
      const p0 = C.pos[i > 0 ? i-1 : 0], p1 = C.pos[i],
            p2 = C.pos[i+1], p3 = C.pos[i+2 < n ? i+2 : n-1];
      const t1 = Math.pow(vdistSq(p0,p1), 0.25) || 1e-5;
      const t2 = t1 + (Math.pow(vdistSq(p1,p2), 0.25) || 1e-5);
      const t3 = t2 + (Math.pow(vdistSq(p2,p3), 0.25) || 1e-5);
      const i10 = 1/Math.max(1e-9, t1), i21 = 1/Math.max(1e-9, t2-t1), i32 = 1/Math.max(1e-9, t3-t2);
      const i20 = 1/Math.max(1e-9, t2), i31 = 1/Math.max(1e-9, t3-t1);
      const sub = subs[i];
      for (let j = 0; j < sub; j++) {
        const u = t1 + (t2-t1)*(j/sub);
        const w10 = u*i10, w21 = (u-t1)*i21, w32 = (u-t2)*i32;
        const wB1 = u*i20, wB2 = (u-t1)*i31, wC = (u-t1)*i21;
        for (let ax = 0; ax < 3; ax++) {
          const A1 = p0[ax] + (p1[ax]-p0[ax])*w10;
          const A2 = p1[ax] + (p2[ax]-p1[ax])*w21;
          const A3 = p2[ax] + (p3[ax]-p2[ax])*w32;
          const B1 = A1 + (A2-A1)*wB1;
          const B2 = A2 + (A3-A2)*wB2;
          B[w++] = B1 + (B2-B1)*wC;
        }
      }
    }
    B[w++] = C.pos[n-1][0]; B[w++] = C.pos[n-1][1]; B[w++] = C.pos[n-1][2];
    out.count = w/3;

    /* Kollisionsgarantie für das BILD.
       Schritt 1: jeden Stützpunkt aus fester Geometrie herausschieben — zwei
       Durchläufe, weil das Herausschieben aus Box A einen Punkt in die
       benachbarte Box B drücken kann (Wandecke).
       Schritt 2 (ECK-REPARATUR): an einer konvexen Kante landen zwei
       benachbarte Stützpunkte auf UNTERSCHIEDLICHEN Flächen — ihre
       Verbindungsstrecke läuft dann durch die Kante, obwohl beide Enden
       korrekt außerhalb sind. Liegt der Mittelpunkt einer solchen Strecke in
       Geometrie, wird dort ein ebenfalls herausgeschobener Punkt EINGEFÜGT;
       die beiden Hälften bleiben je auf ihrer Fläche. Begrenzt auf 2 Passs ×
       96 Einfügungen — terminiert also by Konstruktion. (Unbegrenztes
       Teilen am Trefferpunkt wurde bewusst verworfen: trifft der eingefügte
       Punkt die Kante noch immer, würde erneut geteilt — ohne Schranke füllt
       so eine Schleife den Puffer mit Unsinn.)                              */
    if (this.p.chainCollideWorld && this.world) {
      const W = this.world, P = this.p;
      const t = this._rcTmp || (this._rcTmp = v3());
      const rr = P.chainNodeRadius + P.renderEdgeClearance;
      const cnt = out.count;
      /* Pass 1 schiebt jeden Punkt heraus und merkt sich den bewegten
         Bereich. Pass 2 läuft NUR über diesen Bereich (+1 Nachbar): das
         Herausschieben aus Box A kann einen Punkt in die benachbarte Box B
         drücken (Wandecke). Wo nichts bewegt wurde, ist nichts zu
         reparieren — das spart im Normalfall die Hälfte der Tests.         */
      let lo = cnt, hi = -1;
      for (let i = 1; i < cnt-1; i++) {
        t[0]=B[i*3]; t[1]=B[i*3+1]; t[2]=B[i*3+2];
        W.collideSphere(t, rr, true);
        if (t[0]!==B[i*3] || t[1]!==B[i*3+1] || t[2]!==B[i*3+2]) {
          if (i < lo) lo = i;
          if (i > hi) hi = i;
          B[i*3]=t[0]; B[i*3+1]=t[1]; B[i*3+2]=t[2];
        }
      }
      for (let i = Math.max(1, lo-1); i <= Math.min(cnt-2, hi+1); i++) {
        t[0]=B[i*3]; t[1]=B[i*3+1]; t[2]=B[i*3+2];
        W.collideSphere(t, rr, true);
        B[i*3]=t[0]; B[i*3+1]=t[1]; B[i*3+2]=t[2];
      }
      const maxIns = 96;
      for (let pass = 0; pass < 2; pass++) {
        let inserted = 0;
        for (let i = 0; i + 1 < out.count && inserted < maxIns; i++) {
          const o1 = i*3, o2 = (i+1)*3;
          if (Math.abs(B[o1]-B[o2]) + Math.abs(B[o1+1]-B[o2+1]) + Math.abs(B[o1+2]-B[o2+2]) < 0.03)
            continue;                                  // Nullsegmente überspringen
          t[0]=(B[o1]+B[o2])*0.5; t[1]=(B[o1+1]+B[o2+1])*0.5; t[2]=(B[o1+2]+B[o2+2])*0.5;
          if (W.pointFree(t, 0.01, true)) continue;    // Mitte frei → nichts zu tun
          W.collideSphere(t, rr, true);
          B.copyWithin(o2 + 3, o2, out.count*3);
          B[o2]=t[0]; B[o2+1]=t[1]; B[o2+2]=t[2];
          out.count++; inserted++; i++;                // repariertes Paar überspringen
        }
        if (!inserted) break;
      }
    }
    return out;
  }

}

/** Kugel gegen Spielerkapsel (Segment) — für das Seil um den eigenen Körper. */
function collideCapsuleSphere(cpos, cr, chh, p, r) {
  const s0y = cpos[1]-chh, s1y = cpos[1]+chh;
  const t = clamp((p[1]-s0y) / Math.max(1e-6, s1y-s0y), 0, 1);
  const cy = s0y + (s1y-s0y)*t;
  const dx = p[0]-cpos[0], dy = p[1]-cy, dz = p[2]-cpos[2];
  const d2 = dx*dx+dy*dy+dz*dz;
  const rr = cr + r;
  if (d2 >= rr*rr || d2 < 1e-12) return;
  const d = Math.sqrt(d2), il = (rr - d)/d;
  p[0]+=dx*il; p[1]+=dy*il; p[2]+=dz*il;
}

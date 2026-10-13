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



  // --- Sackgassen-Neuaufbau -------------------------------------------------
  // Der Solver arbeitet insert-only: pro Tick sucht er das erste blockierte
  // Segment und legt dort einen Kontakt an. Es gibt Konfigurationen, in denen
  // das in eine Sackgasse führt — der neue Kontakt macht zwar sein eigenes
  // Segment frei, hinterlässt aber ein anderes Segment, für das `_findBestEdge`
  // keine tragfähige Kante findet (gegenläufige Kanten derselben Box). Der
  // Zustand ist dann selbst-stabilisierend: jede lokale Sehne ist blockiert,
  // also löst sich kein Kontakt (Release-Regel), und eingefügt werden kann
  // auch nichts mehr. Gemessen im Orbit um die Säule: der Pfad läuft 377 von
  // 5760 Schritten durch die Säule selbst, wächst auf 9,05 m über die
  // konvergierte Referenz und bricht beim Kippen der Konfiguration in 0,36 s
  // um 8,93 m ein — der sichtbare Ruck, bei dem das Seil „sich neu erschafft".
  // Erkennt der Solver zwei Topologie-Ticks in Folge eine eigene Route, die
  // durch Geometrie läuft, baut er die Kontaktmenge deshalb neu auf
  // (gedächtnislos, converge()). Das ist genau der Zustand, den alle Tests als
  // nie auftretend fordern (blocked == 0) — der Neuaufbau kann also gesundes
  // Verhalten nicht stören, er repariert nur den Defektfall.
  rebuildAfter:     6,     // eingefrorene Topologie-Ticks (blockiert, kein
                           //        Release, kein Insert, Kontakte bewegen
                           //        sich < 2 cm) bevor neu aufgebaut wird
                           //        (≈ 100 ms)
  resyncHz:         6,     // Hz — Rate der Drift-Prüfung gegen die
                           //        gedächtnislose Referenzroute
  resyncFade:       4.0,   // m/s — Rate, mit der der Längen-Offset nach einem
                           //        Neuaufbau/Resync abgebaut wird. Der Pfad
                           //        wird dadurch stetig kürzer statt in einem
                           //        Substep (gemessen ohne Fade: 1,65 m Sprung
                           //        pro Substep, Testgrenze 0,6 m).
  resyncDrift:      0.40,  // m — so viel länger als die referenzRoute muss die
                           //        gespeicherte Route sein, bevor übernommen
                           //        wird. Unterhalb davon gilt: Persistenz
                           //        geht vor (kein Flattern zwischen Topologien).

  playerMass:     80,    // kg — Masse des Spielers für die Kraftrechnung der
                         //        einseitigen Constraint (Actio = Reactio)

  // --- Rückholen (Kabelstaubsauger-Prinzip) ---------------------------------
  retractReelSpeed: 16,    // m/s — Rate, mit der die verfügbare Seillänge beim
                           //        Rückholen eingerollt wird. Der Haken hängt
                           //        am Seilende und wird vom Pfad geführt, auch
                           //        über Kanten, über die das Seil liegt.
  flightSag:        0.35,  // m — Schlaffseil, das im Flug höchstens stehen
                           //        bleibt, nachdem der automatische Nachroll
                           //        gearbeitet hat
  flightReelSpeed:  18,    // m/s — Rate des automatischen Nachrollens im Flug

  // --- Pivot-Solver (A/B gegen legacy, siehe wrapSolver) ---------------------
  // Experiment hinter diesem Schalter, NICHT gemergt. Der vollständige Stand —
  // Herleitungen, alle Messungen A/B/C mit Zahlen, die verworfenen Wege und die
  // offene Produktentscheidung — steht in doc/VERLAUF-PIVOT.md. Hier im Code
  // bleiben nur die Fakten, die man beim Ändern dieser Zeilen braucht:
  //   · pivot findet Kontakte zusätzlich per Kanten-Überstreichung (`_pivotSweep`
  //     + `edgeCross2D`), der Blocker-Insert bleibt aber AN (ohne ihn 18,6 %
  //     blockierte Schritte, 243 von 250 ohne jeden Säulenkontakt).
  //   · Freigabe = Kraftkegel UND freie Sehne. Jede Bedingung allein ist
  //     notwendig, keine hinreichend (Kegel allein: 382 von 383 blockierte
  //     Schritte; Sehne allein: der gemeldete Skizzen-Fall).
  //   · Pflaster im pivot-Modus aus: Bogus-Drop, Drift-Resync, `_cornerSlide`
  //     (Schalter `pivotCornerSlide`), Sackgassen-Neuaufbau (`pivotDeadEnd`).
  //     Neuaufbau wieder anzuschalten ist messbar schlechter: 5,4 → 15,9 %
  //     blockiert, 44 → 165 Kontakt-Verwürfe.
  //   · Stand Messung C (tools/probe_wrapclean.js, reine Testwelt): legacy
  //     blockiert 1,30 % / maxSprung 0,053 m, pivot 0,89 % / maxSprung 6,689 m.
  //     pivots größter Rückstand ist die Längenstetigkeit, nicht die Erkennung.
  //   · Umweg 14,4 m („V-Schlaufe") ist in BEIDEN Modi offen und eine
  //     Produktentscheidung: `_pivotCleanup` tauscht die Kontaktmenge nur
  //     innerhalb derselben Homotopieklasse, und die V-Schlaufe ist ein
  //     Topologiewechsel — derselbe Vorgang wie der gemeldete Skizzen-Fall.
  wrapSolver:   'legacy',  // 'legacy' = Insert per Raycast/Greedy + Freigabe per
                           //          Sehne/Sichtlinie (+ Pflaster), 'pivot' =
                           //          Freigabe über den Kraftkegel an der Kante
                           //          und Insert über überstrichene Kanten.
                           //          legacy bleibt Standard, bis W5–W8 grün.
  pivotHoldTol:   0.05,    // -   Toleranz des Kegel-Tests: Reaktionskraft darf
                           //       minimal aus dem Normalenkegel zeigen, ohne
                           //       dass der Kontakt fällt (Rauschen, Gleiten)

  // --- Topologische Freigabeschranke ---------------------------------------
  // Ein Seil, das um ein Objekt HERUM liegt (Umlaufwinkel in der Draufsicht
  // deutlich von null), ist topologisch gefangen: Es kann nur über eine Kante
  // ausgleiten, nie durch bloße Sichtfreiheit verschwinden. Die lokale
  // Release-Regel (`unnecessary = !directBlocked`) ignoriert das — sie gibt
  // einen Kontakt frei, sobald die Sehne zum Nachbarkontakt frei ist, und bei
  // einem gefangenen Seil wird diese Sehne irgendwann frei (Sicht auf den
  // Anker), während das Seil physikalisch noch um die Objektseite liegt.
  // Folge: alle Umlenkpunkte lösen sich binnen weniger Ticks und das Seil
  // steht als direkte Linie neu da — exakt der gemeldete Fehler.
  // (Fundstelle: Nutzerskizze vom 2026-10-12 — zwei Umlenkungen an einer
  // dünnen Säule, Spieler wechselt die Seite, das Seil „ignoriert" das
  // Objekt. Nachgebaut als Regressionstest W9 in tools/test_wrap.js; die
  // Bilddatei selbst ist nicht mehr im Repo, die Beschreibung trägt.)
  // Deshalb: solange der Umlaufwinkel der Route um die Box eines Kontakts
  // über dieser Toleranz liegt, darf dieser Kontakt nicht freigegeben werden
  // (Ausnahme: er steht am KantenENDE, kann also real ausgleiten).
  wrapWindTol:      0.6,   // rad — ≈ 34°; darunter gilt die Route als
                           //        nicht gewickelt (Draping, Geradeaus)
  wrapWindMax:      7.5,   // rad — ≈ 430°: ab hier gilt das Seil als
                           //        DURCHGERUTSCHT. Ein echtes Seil spiralt
                           //        nicht beliebig um einen Mast, es rutscht
                           //        unter Last durch. Ohne diese Obergrenze
                           //        konserviert die Schranke im Dauer-Orbit
                           //        eine Spirale, die das Kantenpunkt-Modell
                           //        gar nicht darstellen kann (gemessen: 59,9 m
                           //        Pfad mit 2 Kontakten nach 8 Runden).

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

/* Ergebnis des letzten edgeCross2D-Aufrufs (vermeidet Objekt-Allokation):
   s = Zeitanteil des Substeps, t = Laufparameter entlang des Seils,
   u/v = ebene Koordinaten des Kreuzungspunkts.                             */
const _EC = { s: 0, t: 0, u: 0, v: 0 };
const _ECR1 = [];       // wiederverwendete Wurzelliste — keine Allokation pro Substep

/**
 * Exakter Test: hat das Seilsegment (a→b), dessen Endpunkte sich linear nach
 * (a2→b2) bewegen, den Punkt q in der (u,v)-Ebene ÜBERSTRICHEN?
 *
 * Die von der Bewegung aufgespannte Fläche ist bilinear:
 *   P(s,t) = a + t·e + s·(f + t·g)      s = Zeit ∈ [0,1], t ∈ [0,1]
 *   e = b−a,  f = a2−a,  g = (b2−a2) − (b−a)      [Ecken a, b, b2, a2]
 * g ist der Anteil der Bewegung, der die RICHTUNG ändert: bei Translation 0
 * (Parallelogramm), bei Schwenk um einen Endpunkt ein Dreieck.
 *
 * Gelöst wird über den Seitenwechsel
 *   f(s) = (a(s) − q) × d(s),   a(s) = a + s·f,   d(s) = e + s·g
 * f ist exakt quadratisch in s, identisch für BEIDE Endpunkte (d × d = 0), und
 * die Koeffizienten werden an den Stützstellen 0, ½, 1 AUSGEWERTET statt
 * symbolisch hergeleitet — vier Herleitungen lieferten jeweils plausible, aber
 * falsche Wurzeln. Zu jeder Wurzel: t = ((q − a(s))·d(s))/|d(s)|²  (|d|², nicht
 * |d|), danach Pflicht-Residual |P(s,t) − q| ≤ 1e−9·Skala. Ohne das Residual:
 * 282 Scheintreffer in 4000 Zufallsfällen.
 *
 * Änderungen hier nur gegen tools/test_edgecross.js (31 Assertions, 8000
 * Zufallsfälle). Herleitung, alle Fehlversuche und der Grund, warum das
 * Quad-Verfahren von v0/v1 zu wenig sah (22 Treffer in 1440 Substeps):
 * doc/VERLAUF-PIVOT.md Abschnitt 6.
 */
function edgeCross2D(au, av, bu, bv, a2u, a2v, b2u, b2v, qu, qv) {
  /* Bewegung der beiden Endpunkte während des Substeps */
  const ma_u = a2u - au, ma_v = a2v - av;
  const mb_u = b2u - bu, mb_v = b2v - bv;

  /* „Seite" der Strecke relativ zu q, bezogen auf die Segmentrichtung:
       f(s) = (p(s) − q) × d(s),   d(s) = (b + s·m_b) − (a + s·m_a)
     Ein Punkt kann von einer Strecke nur überstrichen werden, wenn die
     Strecke im Laufe des Substeps über ihn hinwegläuft — dann ist f an
     dieser Stelle null. f ist exakt quadratisch in s; die Koeffizienten
     werden nicht symbolisch hergeleitet, sondern an den drei Stützstellen
     0, ½, 1 AUSGEWERTET (Vandermonde, exakt). Vier Anläufe mit hergeleiteten
     Koeffizienten lieferten jeweils plausible, aber falsche Wurzeln — die
     Stützstellen-Variante kann sich nicht gegen die Auswertung selbst
     verschieben, und tools/test_edgecross.js prüft zusätzlich bei jedem
     Treffer P(s,t) == q plus 8000 Zufallsfälle.

     f ist übrigens für beide Endpunkte IDENTISCH (p und p + λ·d liefern
     dasselbe Kreuzprodukt, weil d × d = 0), ein Durchlauf genügt also.   */
  const y0 = sideAt(0, au, av, ma_u, ma_v, bu, bv, mb_u, mb_v, qu, qv);
  const yh = sideAt(0.5, au, av, ma_u, ma_v, bu, bv, mb_u, mb_v, qu, qv);
  const y1 = sideAt(1, au, av, ma_u, ma_v, bu, bv, mb_u, mb_v, qu, qv);
  const c0 = y0;
  const c2 = 2 * y0 - 4 * yh + 2 * y1;
  const c1 = -3 * y0 + 4 * yh - y1;

  const roots = _ECR1;
  roots.length = 0;
  quadRootsWide(c2, c1, c0, roots);
  const scale = Math.max(1, Math.abs(qu), Math.abs(qv));
  const tol = 1e-9 * scale;

  /* Jede Wurzel einzeln zu Ende prüfen: f kann in [0,1] ZWEI Nullstellen
     haben, und die betragsgrößere (die zuerst gefunden wird) muss nicht die
     gültige sein — gemessen an einem Zufallsfall mit s = 0,98 (t außerhalb)
     und s = 0,022 (Treffer). Ein frühes `break` auf die erste Wurzel kostete
     dort den Treffer.                                                     */
  for (let ri = 0; ri < roots.length; ri++) {
    const r = roots[ri];
    if (!(r >= -1e-9 && r <= 1 + 1e-9)) continue;
    const s = r < 0 ? 0 : (r > 1 ? 1 : r), ms = 1 - s;
    const su = au + s * ma_u, sv = av + s * ma_v;               // a(s)
    const du = (bu + s * mb_u) - su, dv = (bv + s * mb_v) - sv; // d(s)
    const dl2 = du * du + dv * dv;                              // |d|², nicht |d|
    if (dl2 < 1e-24) continue;                                  // degeneriert
    const t = ((qu - su) * du + (qv - sv) * dv) / dl2;
    if (!(t >= -1e-9 && t <= 1 + 1e-9)) continue;               // ausserhalb der Kante
    const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
    const pu = su + tc * du, pv = sv + tc * dv;
    /* RESIDUAL-PFLICHT: f = 0 beweist Kollinearität — die Kante ist erst
       getroffen, wenn q wirklich AUF dem Segment lag. Ohne diese Prüfung:
       282 Scheintreffer in 4000 Zufallsfällen, mit ihr 0.                */
    if (Math.abs(pu - qu) > tol || Math.abs(pv - qv) > tol) continue;
    _EC.s = s;
    _EC.t = tc;
    _EC.u = pu;
    _EC.v = pv;
    return true;
  }
  return false;
}

/** f(s) = (a(s) − q) × d(s) — direkt ausgewertet, ohne Koeffizienten. */
function sideAt(s, au, av, ma_u, ma_v, bu, bv, mb_u, mb_v, qu, qv) {
  const px = au + s * ma_u - qu, py = av + s * ma_v - qv;
  const dx = (bu + s * mb_u) - (au + s * ma_u);
  const dy = (bv + s * mb_v) - (av + s * ma_v);
  return px * dy - py * dx;
}

/** Reelle Wurzeln von A·x² + B·x + C = 0, gefiltert auf [−0.2, 1.2]
    (Newton/Bereichsprüfung verfeinert danach; der Randpuffer fängt Wurzeln,
    die durch Rundung knapp aus [0,1] rutschen).

    Zahlenstabil und ohne Relativschwelle gegen |A|: die betragsgrößere Wurzel
    wird ohne Differenzbildung gebildet (q = −½(B + sign(B)·√disc)), die
    zweite über Vieta (r2 = C/q). Genau das braucht der Anwendungsfall — eine
    fast gestreckte Bewegung liefert ein winziges A, und die physikalisch
    interessante Wurzel ist dann die KLEINE: eine Relativschwelle
    |A| < 1e−14·max(|A|,|B|,|C|) würde sie als „linear" wegwerfen (gemessen:
    7 von 4000 Zufallsfällen verloren, darunter s = 0,022).               */
function quadRootsWide(A, B, C, out) {
  const LO = -0.2, HI = 1.2;
  const push = r => { if (r >= LO && r <= HI && r === r) out.push(r); };
  if (Math.abs(A) < 1e-300) {                       // exakt linear
    if (Math.abs(B) > 1e-300) push(-C / B);
    return;
  }
  const disc = B * B - 4 * A * C;
  if (!(disc >= 0)) return;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (B + (B >= 0 ? sq : -sq));
  if (Math.abs(q) > 1e-300) {
    push(q / A);                                    // betragsgrößere Wurzel
    push(C / q);                                    // zweite über Vieta
  } else {
    const inv = 1 / (2 * A);
    push((-B - sq) * inv);
    push((-B + sq) * inv);
  }
}
/* Kanten-Topologie für den Sweep: Achse (Kantenrichtung), die beiden Ebenen-
   achsen und die Vorzeichen des Eckpunkts in dieser Ebene. In der Ebene
   senkrecht zur Kante ist die Kante ein PUNKT — dort wird überstrichen.
   v0 hat nur vertikale Kanten (Draufsicht x/z) betrachtet; v1 nimmt alle
   zwölf, damit auch horizontale Kanten (Blockoberkanten, Decken) per Sweep
   entstehen und der legacy-Insert im pivot-Modus ganz wegfallen kann.      */
const EDGE_PL = [], EDGE_SGN = [];
for (let e = 0; e < 12; e++) {
  const sa = CORNER_SIGNS[EDGE_PAIRS[e][0]], sb = CORNER_SIGNS[EDGE_PAIRS[e][1]];
  let ax = -1;
  for (let k = 0; k < 3; k++) if (sa[k] !== sb[k]) ax = k;
  const pl = [0, 1, 2].filter(k => k !== ax);
  EDGE_PL.push(pl); EDGE_SGN.push([sa[pl[0]], sa[pl[1]]]);
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
    this._deadEnd = 0; this._rebuildCool = 0; this._resyncT = 0;
    this._lenOff = 0; this.lengthGeo = 0;
    /* true = „Wirt ist stabil attached". Ohne Wirt (Test-Tools fahren den
       Solver direkt) gilt true; die Rope überschreibt das Flag jeden Step. */
    this._hostSettled = true; this._hostTaut = false;
  }

  reset() { this.wraps.length = 0; this.length = 0; this.solved = false; this._lenOff = 0; this.lengthGeo = 0; }

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

    /* 2b) PIVOT: überstrichene Kanten JEDEN Substep einsammeln. Die Sweep-
       Fläche zwischen altem und neuem Segment ist bei 120 Hz schmal genug,
       dass keine Kante übersprungen wird; bei Topologie-Tick-Auflösung (v0)
       fielen schnelle Bewegungen durchs Raster (gemessen: pivotInserts 0-7
       pro 12-s-Orbit, Blockaden fast alle hand-nah).                       */
    if (P.wrapSolver === 'pivot') {
      this.insertBudget = P.wrapInsertsPerFrame;
      this._pivotSweep();
      /* Aufräumen mit topologischer Schranke (pivot-eigen, nicht der legacy-
         Resync):niedrig frequentiert, nur im Attached-Betrieb, und NIE gegen eine Wicklung. */
      if (this._hostSettled && this.wraps.length > 0) {
        this._resyncT = (this._resyncT || 0) - dt;
        if (this._resyncT <= 0) {
          this._resyncT = 1 / Math.max(1, P.resyncHz || 10);
          this._pivotCleanup();
        }
      }
    }

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
      /* Blocker-Insert bleibt AUCH im pivot-Modus an — aber nur als
         ERGÄNZUNG zum Sweep, nicht als Ersatz.

         Messgrund (tools/probe_orbit2.js, Anker westlich der Säule, also mit
         echtem Wickel-Zwang): Mit reinem Sweep liegt die Polyline in 18,6 %
         der gültigen Schritte in Geometrie, und in 243 von 250 davon sitzt
         überhaut kein Kontakt an der Säule — der Sweep hat also nichts
         anzubieten. Das liegt nicht an seiner Genauigkeit (edgeCross2D ist
         exakt und gegen 20 000 Zufallsfälle geprüft), sondern an seiner
         AUFGABE: Eine Kanten-Überstreichung findet nur in dem Augenblick
         statt, in dem die Sehne exakt durch die Kante läuft. Der Normalfall
         dazwischen ist eine Sehne, die die Box DURCHSCHNEIDET, ohne eine
         Kante zu überstreichen — dort muss ein Kontakt aus der Blockade
         abgeleitet werden (tangentiale Kantenwahl), und genau das tut der
         Blocker-Insert. v1 hatte ihn deshalb abgeschaltet; das war falsch. */
      while (!releasing && this.insertBudget > 0 && guard++ < 5) {
        if (!this._tryInsertWrap()) break;
        this._buildPts(A, B);
        this._updateWraps(dt, false, true);
      }

      /* 4) Sackgassen-Neuaufbau (siehe `rebuildAfter`). Läuft die eigene Route
         nach Update UND Insert-Durchlauf immer noch durch Geometrie, kann kein
         lokaler Mechanismus mehr helfen: die Kontakte stützen sich gegenseitig
         (jede lokale Sehne blockiert ⇒ kein Release), und Insert findet keine
         tragfähige Kante mehr. Dann Kontaktmenge verwerfen und gedächtnislos
         neu aufbauen; `converge()` ist insert-only und kollisionsfrei per
         Konstruktion, solange der Greedy durchkommt; bleibt auch der Neuaufbau
         blockiert, gibt es eine Cooling-Phase statt einer Schleife.

         Läuft NUR im stabilen Attached-Betrieb ohne Setz-Phase: während Flug
         und Setzen ist die Topologie definitionsgemäß im Aufbau, und kurze
         Restblockaden sind dort normal (der Hook zieht das Seilende hinter
         sich her, die Setz-Phase hat ihre eigene Topologie-Korrektur). Ohne
         diese Schranke feuerte der Neuaufbau genau während des Verankerns und
         zerstörte die Wicklung, die sich gerade etabliert (gemessen: 8
         Rebuilds in test_sim.js 13d vor dem Teleport, danach nur noch ein
         Fallback-Kontakt und 5,9 m Spiel statt sauberem Release).          */
      /* `releasing` ist das scharfe Trennkriterium: Ein laufender Release ist
         ein Übergangszustand, der sich selbst auflöst (und dessen Graze-
         Segmente an der Kante für einen Tick wie „blockiert" aussehen — genau
         dort feuerte der Neuaufbau falsch und fraß die Wicklung, gemessen in
         test_sim.js 13d). Die echte Sackgasse dagegen hat release == 0 an
         JEDEM Kontakt, weil jede lokale Sehne „gebraucht" meldet — sie löst
         sich nie von selbst.                                                 */
      /* `settled` steuert Sackgassen-Neuaufbau und Drift-Resync — beides
         Pflaster für den topologie-blinden legacy-Zustandsraum. Im pivot-Modus
         ist die Kontaktfolge selbst die Topologie; ein Neuaufbau würde sie
         unter Last wechseln (genau der gemeldete Snap), ein Resync würde
         Kontakte gegen eine gedächtnislose Referenz tauschen. Beide aus.   */
      /* `settled` steuert Sackgassen-Neuaufbau und Drift-Resync. Beide sind
         im pivot-Modus aus — mit einer Ausnahme, die messbar ist: ohne
         Neuaufbau bleibt eine Route, deren Kontakt nahe am Kantenende klemmt
         und deren Zulauf die Box flach schneidet, für immer blockiert, weil
         (a) der Blocker-Insert für dieselbe Box keine zweite Kante findet
         (Zulauf-Prüfung `segmentAvoidsBox(prev, cp, box, pad)` schlägt an der
         Ecke an) und (b) `_cornerSlide` nie feuert (`_atEnd` ist dort false,
         gemessen 0 Aufrufe in 1704 Kontakt-Schritten, beide Modi).
         Schalter `pivotDeadEnd`: 'off' (v2-Messung) | 'rebuild'.            */
      const settled = !!this._hostSettled &&
        (P.wrapSolver !== 'pivot' || P.pivotDeadEnd === 'rebuild');
      /* Dead-End-Erkennung: blockiert UND kein Release laufend UND kein Insert
         mehr möglich UND die Kontakte BEWEGEN SICH NICHT MEHR. Das letzte
         Kriterium trennt die echte Sackgasse (Kontakte stützen sich gegenseitig,
         nichts gleitet) von einem transienten Eck-Clip: Beim Gleiten um eine
         Kante läuft die Polylinie für wenige Ticks durch die Ecke, aber die
         Kontakte wandern dabei sichtbar (Zentimeter pro Tick). Ohne das
         Bewegungskriterium feuerte der Neuaufbau mitten im Gleiten und wischte
         eine intakte Wicklung weg — gemessen als Snap im Straf-Szenario
         (3 Rebuilds in Folge, Wraps kurzzeitig 0), also genau der Fehler,
         den die Schranke verhindern soll.                                  */
      const bk = this._residualBlockedAt();
      const blockedNow = bk >= 0;
      const pp = this._rbPrev || (this._rbPrev = []);
      let move = 0;
      if (blockedNow && pp.length === this.wraps.length)
        for (let j = 0; j < this.wraps.length; j++) move = Math.max(move, vdist(pp[j], this.wraps[j].p));
      pp.length = this.wraps.length;
      for (let j = 0; j < this.wraps.length; j++) { if (!pp[j]) pp[j] = v3(); vcopy(pp[j], this.wraps[j].p); }
      const inserted = this.stats.inserts !== (this._rbIns || 0);
      this._rbIns = this.stats.inserts;
      if (!settled || releasing || !blockedNow || this.wraps.length === 0) this._deadEnd = 0;
      else if (!inserted && move < 0.02) this._deadEnd = (this._deadEnd || 0) + 1;
      else this._deadEnd = 0;

      /* Halte-Zustand statt Sackgasse: ist das blockierte Segment das hand-nahe
         UND zieht das Seil (Budget kürzer als der Pfad dieser Wicklung) UND
         ist die Route wirklich um die Box gewickelt, dann ist die Blockade
         KEIN Solver-Müll, sondern die physikalisch korrekte Haltung eines zu
         kurzen Seils in seiner Homotopie-Klasse: Die straffe Gerade schneidet
         die Ecke, weil das Seil nicht aus seiner Wicklung heraus kann. Ein
         Neuaufbau würde die Homotopie unter Last wechseln — genau der
         unphysikalische Snap, den der Nutzer sieht („Seil erschafft sich neu
         und wird sofort straff/kurz"). Gemessen im Straf-Szenario mit
         abgerolltem Seil: 3 Rebuilds, Wraps kurzzeitig 0, Snap bei t=1,6 s.
         Der Solver-Müll-Fall (Orbit-Akkumulation) hat sein blockiertes Segment
         dagegen ZWISCHEN zwei Kontakten und bleibt reparierbar.            */
      let holding = false;
      if (bk === 0 && this.wraps.length > 0 && this._hostTaut) {
        const w0 = this.wraps[0];
        if (w0.edgeIdx >= 0 && Math.abs(this._pathWindingXZ(this.pts, w0.box)) > (P.wrapWindTol || 0.6))
          holding = true;
      }
      if (this._rebuildCool > 0) this._rebuildCool--;
      else if (this._deadEnd > 0 && !holding) {
        if (this._deadEnd >= Math.max(2, P.rebuildAfter || 6)) {
          this._deadEnd = 0;
          const liveGeo = this.lengthGeo;
          this.wraps.length = 0;
          this._buildPts(A, B);
          this.converge();
          const gain = Math.max(0, liveGeo - this.lengthGeo);
          this._lenOff = (this._lenOff || 0) + gain;
          this.length = this.lengthGeo + this._lenOff;
          this.stats.rebuilds = (this.stats.rebuilds || 0) + 1;
          pp.length = 0;
          if (this._residualBlocked()) this._rebuildCool = 30;
        }
      }

      /* 5) Drift-Resync. Der Neuaufbau oben greift nur an blockierten Routen.
         Es gibt aber einen zweiten Defektzustand: eine Route, die KOLLISIONSFREI
         und trotzdem absurd ist — über die Decke des Objekts statt um die
         Kante, mit drei Kontakten, die sich gegenseitig stützen (gemessen im
         Orbit: 15,94 m bei 7,29 m Referenz, slack −5,7 m, also fünf Meter
         Seil, das in der Luft hängt und zieht). Solche Zustände sind nie
         blockiert, also sieht der Rebuild sie nicht; und keine lokale Regel
         löst sie auf, weil jede lokale Sehne „gebraucht" meldet.
         Vergleich gegen die gedächtnislose Referenz erkennt sie an der Länge.
         Drei Schutzbedingungen, damit daraus kein Flattern wird:
           · Schwelle `resyncDrift` — kleine Abweichungen rühren nichts an;
           · die Referenz muss streng kollisionsfrei sein (siehe _freshRoute);
           · die Referenz- Kontaktmenge muss eine TEILMENGE der Live-Menge sein:
             übernommen wird also nur ein AUFRÄUMEN, nie ein Umbauen. Ein
             Seil, das um ein Objekt liegt, wechselt dadurch nicht die Seite —
             genau der Sprung, den der Nutzer gemeldet hat, bleibt ausgeschlossen.
             (Ist die Referenz komplett kontaktlos, ist das kein Aufräumen,
             sondern ein Topologiewechsel — dafür bleibt die lokale Release-
             Regel mit ihrer Hysterese zuständig, die den Übergang gleiten
             lässt statt zu teleportieren.)                                */
      this._resyncT = (this._resyncT || 0) - dt;
      if (settled && this._resyncT <= 0 && this.wraps.length > 0) {
        this._resyncT = 1 / Math.max(1, P.resyncHz || 10);
        const liveLen = this.lengthGeo;
        const fr = this._freshRoute();
        /* `fr.length >= 1`: eine kontaktlose Referenz wäre ein Topologiewechsel
           (Seil legt sich komplett gerade) und bleibt der lokalen Release-
           Regel mit ihrer Hysterese überlassen — DIE lässt den Kontakt zuvor
           an seiner Kante entlanggleiten und macht das Entfernen damit weich.
           Ausnahme: liegen live ZWEI oder mehr Kontakte, ist die kontaktlose
           Referenz kein gleitfähiger Einzelkontakt mehr, sondern der Hinweis
           auf gegenseitige Stützung — dort gibt es nichts weich zu machen,
           und der Resync ist der einzige Ausweg aus der Sackgasse.          */
        if (fr && (fr.length >= 1 || this.wraps.length >= 2) &&
            liveLen - fr.len > (P.resyncDrift || 0.4)) {
          let subset = true;
          for (const f of fr) {
            let found = false;
            for (const w of this.wraps) if (w.box === f.box && w.edgeIdx === f.edgeIdx) { found = true; break; }
            if (!found) { subset = false; break; }
          }
          /* Kontakte an Boxen, um die die Route gewickelt ist, dürfen auch
             beim Resync nicht verschwinden — sonst würde der Resync genau den
             Seitenwechsel-Teleport ausführen, den `_releaseTopoOK` der
             Release-Regel verbietet (Skizzen-Fall). Die Referenz muss diese
             Kontakte also identisch enthalten; aufräumen darf sie nur dort,
             wo die Route nicht gewickelt ist.                               */
          if (subset) {
            for (let j = 0; j < this.wraps.length; j++) {
              const w = this.wraps[j];
              const pv = this._prevPt(j), nx = this._nextPt(j);
              const det = vdist(pv, w.p) + vdist(w.p, nx) - vdist(pv, nx);
              if (this._releaseTopoOK(w, det, j)) continue;
              let kept = false;
              for (const f of fr) if (f.box === w.box && f.edgeIdx === w.edgeIdx) { kept = true; break; }
              if (!kept) { subset = false; this.stats.resyncWindHeld = (this.stats.resyncWindHeld || 0) + 1; break; }
            }
          }
          if (subset) {
            const gain = Math.max(0, liveLen - fr.len);
            this.wraps.length = 0;
            for (const f of fr) {
              const w = makeWrap(f.box, f.edgeIdx);
              vcopy(w.p, f.p);
              this.wraps.push(w);
            }
            this._buildPts(A, B);
            this._measure();
            this._lenOff = (this._lenOff || 0) + gain;
            this.length = this.lengthGeo + this._lenOff;
            this.stats.resyncs = (this.stats.resyncs || 0) + 1;
            this.stats.resyncGain = (this.stats.resyncGain || 0) + gain;
          } else {
            /* Schrittweise Müll-Entfernung. Schlägt die Teilmenge-Regel zu
               (die frische Route setzt andere Kanten als die Live-Route),
               liegt meist Solver-Müll vor: Kontakte, deren lokaler Umweg ein
               Vielfaches des Objektumfangs beträgt und die keine echte
               Umlenkung markieren. Ein KOMPLETTTAUSCH teleportiert alle
               Ketten-Pins zugleich und schneidet dabei die Render-Kurve durch
               Geometrie (gemessen: 0,80 m Eindringtiefe in test_sim.js 10f).
               Deshalb pro Resync-Tick genau EINEN solchen Kontakt entfernen:
               die verbleibenden Pins bleiben liegen und die Kette richtet
               sich dazwischen stetig aus; der Längensprung geht in den
               Offset-Fade. Zwei Kontakte Müll sind damit in ~166 ms weg.   */
            let bj = -1, bDet = 0;
            for (let j2 = 0; j2 < this.wraps.length; j2++) {
              const w = this.wraps[j2];
              if (w.edgeIdx < 0) continue;
              const pv = this._prevPt(j2), nx = this._nextPt(j2);
              const det = vdist(pv, w.p) + vdist(w.p, nx) - vdist(pv, nx);
              const mn = w.box.min, mx = w.box.max;
              const per = 2 * ((mx[0] - mn[0]) + (mx[2] - mn[2]));
              if (det > per && det > bDet) { bDet = det; bj = j2; }
            }
            if (bj >= 0) {
              const liveGeo = this.lengthGeo;
              this.wraps.splice(bj, 1);
              this._buildPts(A, B);
              this._measure();
              const gain = Math.max(0, liveGeo - this.lengthGeo);
              this._lenOff = (this._lenOff || 0) + gain;
              this.length = this.lengthGeo + this._lenOff;
              this.stats.resyncGarbage = (this.stats.resyncGarbage || 0) + 1;
            } else this.stats.resyncSide = (this.stats.resyncSide || 0) + 1;
          }
        }
      }
    }

    this._measure();
    /* Offset nach Topologie-Neuaufbau linear abbauen: die Constraint, das
       Budget und alle Tests sehen dadurch eine stetige Pfadlänge, während
       die Geometrie längst korrigiert ist. Das freigesetzte Spiel rollt der
       tidy-Mechanismus parallel nach. */
    if (this._lenOff > 0) {
      this._lenOff = Math.max(0, this._lenOff - (P.resyncFade || 4) * dt);
      this.length = this.lengthGeo + this._lenOff;
    }

    /* Polylinie dieses Substeps für den Sweep-Vergleich des nächsten merken.
       Bewusst am ENDE von solve(): verglichen wird gegen das, was der Solver
       zuletzt wirklich ausgespuckt hat — nicht gegen einen Zwischenstand.   */
    const ppoly = this._prevPoly || (this._prevPoly = { n: 0, p: [] });
    while (ppoly.p.length < this.pts.length) ppoly.p.push(v3());
    ppoly.n = this.pts.length;
    for (let k = 0; k < this.pts.length; k++) vcopy(ppoly.p[k], this.pts[k]);

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

  /* ------------------------------------------------------------------------
     Topologische Wächter
     ------------------------------------------------------------------------ */
  /**
   * Gedächtnislose Referenzroute für dieselbe Hand-/Ankerposition: Kontakte
   * weg, `converge()` (Greedy-Insert bis nichts mehr blockiert), Ergebnis
   * KOPIERT und der Live-Zustand vollständig wiederhergestellt.
   *
   * Die Referenz wird nur dann geliefert, wenn sie STRENG kollisionsfrei ist:
   * `_segBlocked` allein reicht nicht, weil seine Endpunkt-Ausnahmen (Graze
   * mit negativem Pad, `endTol` 0,20 am Anker) eine Luftlinie durchgehen
   * lassen, die meterweit in eine Flanke eintaucht und erst kurz vor dem
   * Anker wieder herauskommt — gemessen in test_sim.js 10i-c, wo der Anker
   * exakt auf der Würfel-Oberkante liegt. Innensegmente werden deshalb
   * zusätzlich mit `segmentClear` und endTol 0,02 geprüft.
   *
   * Rückgabe: Array von { box, edgeIdx, p } mit Zusatz-Feld `len` (Referenzlänge)
   * oder null, wenn die Referenz nicht streng kollisionsfrei ist.
   */
  _freshRoute() {
    const W = this.world;
    const pool = this._frPool || (this._frPool = []);
    const saved = this._frSaved || (this._frSaved = []);
    const n = this.wraps.length;
    saved.length = n;
    for (let i = 0; i < n; i++) {
      const w = this.wraps[i];
      let e = pool[i];
      if (!e) e = pool[i] = { w: null, p: v3(), rel: 0, age: 0 };
      e.w = w; vcopy(e.p, w.p); e.rel = w.release; e.age = w.age;
      saved[i] = e;
    }
    this.wraps.length = 0;
    this._buildPts(this._A, this._B);
    /* BEFUND (Versuch zurückgenommen): `converge()` hier in einer Schleife zu
       wiederholen, bis die Referenz frei ist, hat die Referenz zwar repariert
       (10,66 m quer durch die Säule statt 9,06 m Luftlinie), aber am Ergebnis
       nichts geändert — maxUmweg blieb 14,40 m, Tausch-Quote 2 von 52 — und
       die Kontakt-Verwürfe der Selbst-Durchdringungs-Regel von 125 auf 4805
       getrieben, weil `converge()` in der Schleife Kontakte auf Kanten setzt,
       die live sofort wieder verworfen werden. Kosten: doppelte Laufzeit
       (26 s statt 14 s für denselben Messlauf). Also: einmal `converge()`,
       wie vorher, und die Referenz bleibt, was sie ist — eine grobe.      */
    let out = null;
    let ok = true;
    for (let k = 0; k < this.pts.length - 1 && ok; k++) {
      if (this._segBlocked(this.pts[k], this.pts[k + 1], this.ptsBox[k], this.ptsBox[k + 1]) !== null) { ok = false; break; }
      if (k < this.pts.length - 2 &&
          !W.segmentClear(this.pts[k], this.pts[k + 1],
            { startBox: this.ptsBox[k], endBox: this.ptsBox[k + 1], minT: 1e-3, endTol: 0.02, ropeOnly: true })) ok = false;
    }
    if (ok) {
      out = [];
      for (const w of this.wraps) out.push({ box: w.box, edgeIdx: w.edgeIdx, p: vclone(w.p) });
      out.len = this.length;   // Referenzlänge VOR der Wiederherstellung merken
    }

    this.wraps.length = 0;
    for (let i = 0; i < n; i++) this.wraps.push(saved[i].w);
    for (let i = 0; i < n; i++) {
      const w = this.wraps[i];
      vcopy(w.p, saved[i].p); w.release = saved[i].rel; w.age = saved[i].age;
    }
    this._buildPts(this._A, this._B);
    this._measure();
    return out;
  }

  /**
   * Vorzeichenbehafteter Gesamtwinkel (Bogenmaß), den die Polyline `pts` um
   * den Box-Mittelpunkt in der XZ-Ebene (Draufsicht) überstreicht.
   *
   * Billige Homotopie-Invariante: Zwei Routen, die sich ohne Schnitt mit der
   * Box ineinander überführen lassen, haben denselben Umlaufwinkel. Ein Seil,
   * das links um eine Säule liegt, und eine gerade Linie zum Anker
   * unterscheiden sich um etwa π bis 2π — die Sehne dazwischen müsste durch
   * die Säule. Ein Seil, das nur über eine Kante DRAPIERT ist (Wand, Würfel-
   * oberkante, Schiene), hat dagegen Umlaufwinkel nahe null und darf über die
   * lokale Release-Regel weich loslassen.
   *
   * Dicht genug abgetastet (0,4 m), damit auch ein weiter Bogen um die Box
   * gezählt wird und nicht als gerader Sprung durch sie hindurch durchgeht.
   */
  _pathWindingXZ(pts, box) {
    const cx = (box.min[0] + box.max[0]) * 0.5, cz = (box.min[2] + box.max[2]) * 0.5;
    let sum = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const n = Math.max(1, Math.min(16, Math.ceil(L / 0.4)));
      let px = a[0] - cx, pz = a[2] - cz;
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const qx = a[0] + (b[0] - a[0]) * u - cx, qz = a[2] + (b[2] - a[2]) * u - cz;
        const cross = px * qz - pz * qx, dot = px * qx + pz * qz;
        if (Math.abs(cross) > 1e-12 || dot > 0) sum += Math.atan2(cross, dot);
        px = qx; pz = qz;
      }
    }
    return sum;
  }

  /** Schneidet die eigene Route durch den Grundriss der Box? (Defektzustand) */
  _footprintCrossed(box) {
    const mnx = box.min[0] + 0.1, mxx = box.max[0] - 0.1;
    const mnz = box.min[2] + 0.1, mxz = box.max[2] - 0.1;
    const pts = this.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const n = Math.max(1, Math.min(12, Math.ceil(L / 0.3)));
      for (let k = 1; k < n; k++) {
        const u = k / n;
        const px = a[0] + (b[0] - a[0]) * u, pz = a[2] + (b[2] - a[2]) * u;
        if (px > mnx && px < mxx && pz > mnz && pz < mxz) return true;
      }
    }
    return false;
  }

  /**
   * PIVOT-FREIGABE: lokale, stetige Kraftbedingung statt Sichtlinie.
   *
   * Die beiden Seilsegmente ziehen am Kontakt mit den Einheitsvektoren
   * u_prev und u_next; die Resultante s = u_prev + u_next ist die Kraft, die
   * das Seil auf die Kante ausübt (Spannungsfaktor kürzt sich). Die Kante
   * kann nur dagegenhalten, solange die Reaktion N = −s in ihrem Normalen-
   * kegel liegt, also als nichtnegative Kombination der beiden Flächen-
   * normalen n1, n2 der an die Kante angrenzenden Flächen darstellbar ist
   * (reibungsfreie Kante: die Komponente entlang der Kantenrichtung trägt
   * nichts und wird vorher abprojiziert — das ist genau das analytische
   * Gleiten entlang der Kante).
   *
   * Verlässt −s den Kegel (eine Koordinate wird negativ), drückt das Seil
   * nicht mehr gegen beide Flächen: es rutscht über die Kante ab und der
   * Kontakt wird freigegeben — stetig, mit Vorzeichenwechsel, OHNE dass
   * irgendjemand den Anker sehen muss. Das ist die Regel, die die
   * Skizzen-Fälle der Sichtlinien-Logik physikalisch korrekt entscheidet:
   * Ein um eine Säule liegendes Seil drückt weiterhin gegen beide Flächen
   * seiner Kanten, egal wie frei die Sichtlinie ist.
   */
  _pivotRelease(w, prev, next, c) {
    const e = w.edgeIdx;
    const sa = CORNER_SIGNS[EDGE_PAIRS[e][0]], sb = CORNER_SIGNS[EDGE_PAIRS[e][1]];
    let ax = -1;
    for (let k = 0; k < 3; k++) if (sa[k] !== sb[k]) ax = k;
    if (ax < 0) return true;
    const k1 = (ax + 1) % 3, k2 = (ax + 2) % 3;
    let u1x = prev[0]-c[0], u1y = prev[1]-c[1], u1z = prev[2]-c[2];
    let u2x = next[0]-c[0], u2y = next[1]-c[1], u2z = next[2]-c[2];
    const l1 = Math.hypot(u1x,u1y,u1z), l2 = Math.hypot(u2x,u2y,u2z);
    if (l1 < 1e-6 || l2 < 1e-6) return true;
    u1x/=l1; u1y/=l1; u1z/=l1; u2x/=l2; u2y/=l2; u2z/=l2;
    let sx = u1x+u2x, sy = u1y+u2y, sz = u1z+u2z;
    /* Komponente entlang der Kantenrichtung trägt keine Reaktion
       (reibungsfreie Kante) — das ist genau das analytische Gleiten. */
    const se = (ax===0) ? sx : (ax===1) ? sy : sz;
    if (ax===0) sx -= se; else if (ax===1) sy -= se; else sz -= se;
    const sLen = Math.hypot(sx,sy,sz);
    if (sLen < 1e-3) return true;      // Seil läuft gerade durch: kein Knick, kein Kontakt
    /* Reaktion N = −s muss im Kegel der beiden Flächennormalen liegen:
       n1 = sa[k1]·e_{k1}, n2 = sa[k2]·e_{k2}. Die Koeffizienten sind damit
       einfach die negativen s-Komponenten auf diesen beiden Achsen.       */
    const a1 = -((k1===0?sx : k1===1?sy : sz) * sa[k1]);
    const a2 = -((k2===0?sx : k2===1?sy : sz) * sa[k2]);
    const tol = (this.p.pivotHoldTol != null ? this.p.pivotHoldTol : 0.05) * sLen;
    return !(a1 >= -tol && a2 >= -tol);
  }

  /**
   * Darf dieser Kontakt überhaupt freigegeben werden?
   *
   * Ja, wenn die Route um seine Box nicht gewickelt ist (Draping, Geradeaus,
   * Umlenkung an einer Kante ohne Umschlingung) — dann ist die lokale
   * Sehnen-Regel physikalisch sinnvoll. Nein, wenn die Route um die Box
   * gewickelt ist: Das Seil liegt an einer Objektseite und kann nur über
   * Kanten ausgleiten; dass die Sichtlinie zum Anker frei wird, ändert daran
   * nichts (genau das war der gemeldete Fehler).
   *
   * Zwei Ausnahmen:
   *   · Der Kontakt steht am Ende seiner Kante (`_atEnd`): dort kann das Seil
   *     real über den Eckpunkt ausgleiten — Freigabe ist stetig.
   *   · Die Route schneidet bereits durch den Grundriss der Box: dann liegt
   *     der Defektzustand vor, für den der Sackgassen-Neuaufbau zuständig ist
   *     (`rebuildAfter`); die Release-Regel darf ihn nicht zusätzlich
   *     verschlimmern, aber auch nicht blockieren, was der Neuaufbau braucht.
   */
  _releaseTopoOK(w, detour, idx) {
    if (w.edgeIdx < 0) return true;
    if (w._atEnd) return true;
    /* Entscheidend ist nicht der absolute Umlaufwinkel, sondern seine
       ÄNDERUNG durch das Entfernen dieses einen Kontakts: bleibt die Route
       topologisch dieselbe (Seil bleibt auf derselben Objektseite), ist das
       Entfernen ein stetiges Aufräumen. Dreht sich die Seite, wäre es der
       Teleport durchs Objekt — der gemeldete Fehler.                      */
    const windLive = this._pathWindingXZ(this.pts, w.box);
    if (Math.abs(windLive) <= (this.p.wrapWindTol || 0.6)) return true;   // nicht gewickelt
    if (Math.abs(windLive) > (this.p.wrapWindMax || 7.5)) return true;    // durchgerutscht
    if (idx !== undefined) {
      const red = this._rwRed || (this._rwRed = []);
      red.length = 0;
      for (let k = 0; k < this.pts.length; k++) if (k !== idx + 1) red.push(this.pts[k]);
      const windRed = this._pathWindingXZ(red, w.box);
      if (Math.abs(windLive - windRed) <= (this.p.wrapWindTol || 0.6)) return true;
    }
    if (this._footprintCrossed(w.box)) return true;
    /* Obergrenze: echter Wickel kostet pro Kontakt höchstens etwa den Umfang
       des Grundrisses (eine 90°-Biegung an einer 2,6-m-Säule ≈ 2 m). Ein
       lokaler Umweg vom Vielfachen davon ist kein Wickel, sondern ein falsch
       platzierter Kontakt (gemessen: 28 m pro Kontakt im Orbit-Test).      */
    if (detour !== undefined) {
      const mn = w.box.min, mx = w.box.max;
      const per = 2 * ((mx[0] - mn[0]) + (mx[2] - mn[2]));
      if (detour > per) return true;
    }
    this.stats.windHeld = (this.stats.windHeld || 0) + 1;
    return false;
  }

  /**
   * PIVOT-SWEEP (v2): Für jedes Seilsegment wird geprüft, welche der zwölf
   * Kanten jeder nahen Box es seit dem vorigen Substep ÜBERSTRICHEN hat —
   * exakt, über die bilineare Fläche aus altem und neuem Segment
   * (`edgeCross2D`), nicht über Quad-Containment.
   *
   * Treffer = Kantenkontakt in Pfad-Reihenfolge, mit Orientierung (`side`)
   * aus der Bewegungsrichtung. Damit entfällt die Greedy-Suche vollständig:
   * keine Blocker-Raycasts, keine falschen Reihenfolgen, keine Sackgassen
   * durch gegenläufige Kanten derselben Box.
   *
   * Ausnahmen (bewusst):
   *   · Kanten der Endpunkt-Boxen (Hand/Anker liegen AUF ihrer Box) — dort
   *     „kreuzt" das Segment die Kante, an der es hängt, in jedem Substep.
   *   · Boxen, auf denen schon zwei oder mehr Kontakte liegen (Wicklung
   *     über eine Wand = Ein- und Austrittskante; ein dritter Kontakt wäre
   *     ein Umschlingen, das der Sweep nicht allein entscheiden kann).
   *   · Kreuzungen, deren Berührpunkt außerhalb der Kante liegt oder deren
   *     Zulauf/Ablauf durch die eigene Box läuft (`_segBoxBeyond`) — das
   *     sind Gleit- statt Wickelfälle bzw. unmögliche Zustände.
   */
  _pivotSweep() {
    const P = this.p;
    const ST = this.stats;
    ST.swCalls = (ST.swCalls || 0) + 1;
    const prev = this._prevPoly;
    if (!prev || prev.n !== this.pts.length) { ST.swSkip = (ST.swSkip || 0) + 1; return; }
    if (this.wraps.length >= P.wrapMaxCount) return;

    const ev = this._swEv || (this._swEv = []);
    ev.length = 0;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      const pa = prev.p[i], pb = prev.p[i + 1];
      const near = this._nearBoxes(a, b, this.ptsBox[i], this.ptsBox[i + 1], null, []);
      ST.swSegs = (ST.swSegs || 0) + 1;
      ST.swNear = (ST.swNear || 0) + near.length;
      for (const bx of near) {
        let same = 0;
        for (const w of this.wraps) if (w.box === bx) same++;
        if (same >= 2) continue;
        const mn = bx.min, mx = bx.max;
        for (let e = 0; e < 12; e++) {
          const pl = EDGE_PL[e], sg = EDGE_SGN[e];
          const ax = 3 - pl[0] - pl[1];       // die fehlende Achse = Kantenrichtung
          const u = pl[0], v = pl[1];
          const qu = (sg[0] === 1 ? mx[u] : mn[u]);
          const qv = (sg[1] === 1 ? mx[v] : mn[v]);
          ST.swTests = (ST.swTests || 0) + 1;
          if (!edgeCross2D(a[u], a[v], b[u], b[v], pa[u], pa[v], pb[u], pb[v], qu, qv)) continue;
          ST.swCross = (ST.swCross || 0) + 1;
          /* Kreuzung muss im Achsintervall des Segments liegen: die Kante ist
             endlich, und das Seil kann sie auch „neben" ihrer Spannweite
             schneiden (dann gehört der Kontakt an eine andere Kante).       */
          const s = _EC.s, t = _EC.t, ms = 1 - s, mt = 1 - t;
          const aa = ms * a[ax] + s * pa[ax], bb2 = ms * b[ax] + s * pb[ax];
          const axAt = mt * aa + t * bb2;
          const lo = Math.min(a[ax], b[ax], pa[ax], pb[ax]) - 0.15;
          const hi = Math.max(a[ax], b[ax], pa[ax], pb[ax]) + 0.15;
          if (axAt < lo || axAt > hi) { ST.swAxis = (ST.swAxis || 0) + 1; continue; }
          /* Kantenmitte für die Orientierung: der überstrichene Punkt selbst
             liegt auf dem Eckwert der Kante, also ist q der Kantenpunkt in
             der Ebene; axAt ist seine Koordinate entlang der Kante.         */
          let dup = false;
          for (const w of this.wraps) if (w.box === bx && w.edgeIdx === e) dup = true;
          if (dup) { ST.swDup = (ST.swDup || 0) + 1; continue; }
          let hit = false;
          for (const o of ev) if (o.box === bx && o.e === e) hit = true;
          if (hit) { ST.swDup = (ST.swDup || 0) + 1; continue; }
          ev.push({ i, box: bx, e, ax, axAt, s, t, qu, qv, u, v });
        }
      }
    }
    if (!ev.length) return;
    /* Reihenfolge: hintere Segmente zuerst einsetzen, damit die Indizes der
       vorderen Ereignisse durch das splice gültig bleiben. Innerhalb eines
       Segments nach Kreuzungszeit, damit bei zwei Überstreichungen in einem
       Substep die zeitlich erste auch die vordere im Pfad wird.            */
    ev.sort((p, q) => (q.i - p.i) || (p.s - q.s));

    const p0 = this._pv0 || (this._pv0 = v3()), p1 = this._pv1 || (this._pv1 = v3()), nn = this._pv2 || (this._pv2 = v3());
    const cp = this._pv3 || (this._pv3 = v3());
    const aa = this._pv4 || (this._pv4 = v3()), bb3 = this._pv5 || (this._pv5 = v3());
    for (const o of ev) {
      if (this.insertBudget <= 0) { ST.swBudget = (ST.swBudget || 0) + 1; continue; }
      if (this.wraps.length >= P.wrapMaxCount) break;
      const bx = o.box;
      boxEdge(bx, o.e, p0, p1, nn);
      /* Berührpunkt: Schnitt der Sehne prev→next mit der Kante, mit
         Clearance nach außen — dieselbe Konstruktion wie im Betrieb, damit
         der neue Kontakt ohne Sprung in die analytische Nachführung geht.   */
      const i = o.i;
      const a = this.pts[i], b = this.pts[i + 1];
      const s = o.s, ms = 1 - s;
      for (let k = 0; k < 3; k++) {
        aa[k] = ms * a[k] + s * prev.p[i][k];
        bb3[k] = ms * b[k] + s * prev.p[i + 1][k];
      }
      edgeTouchPoint(aa, bb3, p0, p1, nn, P.wrapClearance, cp);
      if (_TP.t < 0.02 || _TP.t > _TP.elen - 0.02) { ST.swT = (ST.swT || 0) + 1; continue; }
      if (!this.world.pointFree(cp, 0.02, true)) { ST.swFree = (ST.swFree || 0) + 1; continue; }
      /* Der neue Kontakt liegt am ENDE beider Hälften (t = 1 bzw. t = 0);
             Auflagebereich = ein Mehrfaches der Clearance.                  */
          const m1 = (P.wrapClearance * 3) / Math.max(0.2, vdist(aa, cp));
          const m2 = (P.wrapClearance * 3) / Math.max(0.2, vdist(cp, bb3));
          if (this._segBoxBeyond(aa, cp, bx, 0.05, 1, m1) >= 0 ||
              this._segBoxBeyond(cp, bb3, bx, 0.05, 0, m2) >= 0) { ST.swSelf = (ST.swSelf || 0) + 1; continue; }
      const w = makeWrap(bx, o.e);
      vcopy(w.p, cp);
      w.t = _TP.t / Math.max(1e-6, _TP.elen);
      /* Orientierung: auf welcher Seite der Sehne liegt der überstrichene
         Kantenpunkt — daraus folgt, in welche Richtung das Seil abgleiten
         kann (für die Freigabe und für spätere Wickel-Entscheidungen).     */
      const du = bb3[o.u] - aa[o.u], dv = bb3[o.v] - aa[o.v];
      const wu = o.qu - aa[o.u], wv = o.qv - aa[o.v];
      w.side = (du * wv - dv * wu) >= 0 ? 1 : -1;
      this.wraps.splice(i, 0, w);
      this.insertBudget--;
      this.stats.pivotInserts = (this.stats.pivotInserts || 0) + 1;
      this._buildPts(this._A, this._B);
      if (ST.swLog && ST.swLogN < 40) {
        ST.swLogN++;
        ST.swLog.push({ i, e: o.e, box: [bx.min.slice(), bx.max.slice()], cp: cp.slice(), side: w.side });
      }
    }
  }

  /* BEFUND, nicht implementiert — `_pivotEdgeHop` (Kantenwechsel an der Ecke),
     zwei Fassungen gebaut, beide 0 Treffer, wieder entfernt:
     Ein Kontakt auf der senkrechten Nordwest-Kante in halber Höhe
     (Berührpunkt (30,4 | 2,5 | −27,4), Kantenlänge 6 m, Parameter 2,5 m) hat
     BEIDE Kantenenden gleich weit entfernt — es gibt dort keine „nächste"
     Ecke. Fassung 1 wählte die Ecke über `vdist(w.p, w.p0) <= vdist(w.p, w.p1)`
     und nahm damit immer das erste Ende (Südwest-Ecke): beide Kandidaten
     landeten unter dem Boden (y = −0,1) bzw. 1,3 m neben der Ecke. Fassung 2
     wählte über den Kantenparameter — identisches Ergebnis, weil der Parameter
     in der Mitte steht. `_cornerSlide` feuert aus demselben Grund in BEIDEN
     Modi 0 Mal (1561 bzw. 1704 Kontakt-Schritte gezählt, `_atEnd` immer false).
     Nötig ist ein lokales Neulegen der Route um die Box (oder Eckpunkte als
     eigenständige Kontakte), kein Eckübergang.
     Ausführlich mit allen Zahlen: doc/VERLAUF-PIVOT.md Abschnitt 8.        */
  /**
   * PIVOT-Aufräumen: Kontaktmenge ersetzen, wenn die gedächtnislos gelöste
   * Route strenger kürzer UND kollisionsfrei ist — aber NIE gegen eine
   * Wicklung.
   *
   * Der Defekt, den das behebt (tools/probe_wrapclean.js, reine Testwelt:
   * Boden + EIN Quader, Hand auf Kreisbahn, jeder Schritt gültig):
   *   Hand (−3,71 | 2,5 | 1,50), Anker (−9 | 2,5 | 0), freie Route 5,50 m —
   *   der Solver hält 19,70 m, also 14,20 m Umweg, mit drei Kontakten, die
   *   alle auf der ABGEWANDTEN Seite der Säule liegen (Kanten 10, 9, 8 auf
   *   (1,7 | 2,5 | ±1,7) und (−1,7 | 2,5 | −1,7)). In BEIDEN Modi, legacy
   *   wie pivot: maxUmweg 14,36 bzw. 14,40 m. Das ist die gemeldete
   *   „V-Schlaufe".
   *
   * Warum keine lokale Regel daran kommt: Jeder der drei Kontakte ist für
   * sich genommen NOTWENDIG — die Sehne zum Nachbarkontakt läuft durch die
   * Säule, also ist `directBlocked` wahr, Kegel UND Sehne halten ihn. Die
   * Menge ist falsch, nicht das Element. Lokale Freigabe kann das prinzipiell
   * nicht sehen, und genau dafür hatte legacy den Drift-Resync (Vergleich
   * gegen die gedächtnislose Referenz).
   *
   * Warum das hier trotzdem kein Pflaster ist: Die legacy-Variante braucht
   * zwei Zusatzregeln (Teilmenge der Kontaktmenge, sonst „Solver-Müll"
   * schrittweise entfernen), weil sie ohne Topologie-Begriff auskommen muss.
   * Hier entscheidet der UMLAUFWINKEL: liegt die Route um irgendeine der
   * kontaktierten Boxen mit |Winkel| über `wrapWindTol` herum, ist das Seil
   * topologisch gefangen und darf seine Homotopieklasse unter Last nicht
   * wechseln — dann passiert nichts (Zähler `pivotWindHeld`). Liegt sie
   * nirgends herum, sind die Kontakte Reste einer bereits abgewickelten
   * Schleife, und der Tausch ist physikalisch korrekt. Der Längensprung geht
   * wie bei jedem Topologiewechsel in den Offset-Fade (`resyncFade`), die
   * Constraint sieht also eine stetige Länge.
   *
   * Das ist dieselbe Schranke, die `_releaseTopoOK` für die lokale Freigabe
   * setzt — nur eben auf die ganze Kontaktmenge angewandt statt auf einen
   * einzelnen Kontakt.
   */
  _pivotCleanup() {
    const P = this.p;
    const fr = this._freshRoute();
    if (!fr) { this.stats.pcNull = (this.stats.pcNull || 0) + 1; return false; }   // Referenz selbst blockiert
    /* Eine kontaktlose Referenz ist ein Topologiewechsel; bei EINEM Kontakt
       überlässt legacy das der lokalen Freigabe mit ihrer Hysterese. Hier
       gilt dasselbe, aber die Schranke ist der Umlaufwinkel, nicht die
       Kontaktzahl — bei Winkel ≈ 0 darf der Einzelkontakt sofort weg.     */
    if (this.lengthGeo - fr.len <= (P.resyncDrift || 0.4)) {
      this.stats.pcDrift = (this.stats.pcDrift || 0) + 1;
      return false;
    }

    /* Schranke: HOMOTOPIEKLASSE, nicht „Winkel ungleich null".
       Die erste Fassung prüfte |Umlaufwinkel der Live-Route| > wrapWindTol und
       hielt damit 50 von 52 Aufrufen — auch die V-Schlaufe, die sie doch
       aufräumen sollte: deren Zickzack hat selbst einen Umlaufwinkel von
       ±π/2 um die Säule (Hand → (1,7|1,7) → (1,7|−1,7) → (−1,7|−1,7) → Anker,
       drei rechtwinklige Knicke, alle konvex). „Gewickelt" und „Zickzack" sind
       über den Winkel der Live-Route allein also NICHT zu unterscheiden.
       Entscheidend ist der Vergleich: Live-Route und gedächtnislose Referenz
       müssen um jede kontaktierte Box denselben Umlaufwinkel haben. Dann
       bleibt der Tausch in derselben Homotopieklasse — das Seil wechselt nicht
       die Seite, es wird nur kürzer eingerichtet. Weichen die Winkel
       auseinander, ist es ein echter Topologiewechsel, und der bleibt der
       lokalen Freigabe mit ihrer Hysterese überlassen (Skizzen-Fall: das
       topologisch gefangene Seil darf nicht durch die Hintertür des
       Aufräumens teleportieren).                                        */
    const seen = this._pcSeen || (this._pcSeen = []);
    seen.length = 0;
    /* Referenz-Route für den Winkelvergleich nachbauen */
    const rpts = this._pcPts || (this._pcPts = []);
    rpts.length = 0;
    rpts.push(this._A);
    for (const f of fr) rpts.push(f.p);
    rpts.push(this._B);
    const tol = P.wrapWindTol || 0.6;
    for (const w of this.wraps) {
      if (!w.box || w.edgeIdx < 0) continue;
      let known = false;
      for (const b of seen) if (b === w.box) known = true;
      if (known) continue;
      seen.push(w.box);
      const wLive = this._pathWindingXZ(this.pts, w.box);
      const wRef = this._pathWindingXZ(rpts, w.box);
      if (Math.abs(wLive - wRef) > tol) {
        this.stats.pivotWindHeld = (this.stats.pivotWindHeld || 0) + 1;
        return false;                            // echter Topologiewechsel: kein Tausch
      }
    }

    const gain = Math.max(0, this.lengthGeo - fr.len);
    this.stats.pcGainSeen = (this.stats.pcGainSeen || 0) + gain;
    this.wraps.length = 0;
    for (const f of fr) {
      const w = makeWrap(f.box, f.edgeIdx);
      vcopy(w.p, f.p);
      if (f.box.dynamic) vsub(w.localOff, f.p, f.box.pos);
      this.wraps.push(w);
    }
    this._buildPts(this._A, this._B);
    this._measure();
    this._lenOff = (this._lenOff || 0) + gain;
    this.length = this.lengthGeo + this._lenOff;
    this.stats.pivotSwaps = (this.stats.pivotSwaps || 0) + 1;
    this.stats.pivotSwapGain = (this.stats.pivotSwapGain || 0) + gain;
    return true;
  }

  /**

  /**
   * Läuft die Strecke a→b durch die Box — und wenn ja, wie weit weg vom
   * Punkt `nearT` (Parameter des zugehörigen Kontakts auf dieser Strecke)
   * liegt der durchdrungene Bereich?
   *
   * Rückgabe: −1 = frei bzw. nur im Auflagebereich, sonst das Maß des
   * Hinausreichens (in Bruchteilen der Streckenlänge).
   *
   * Warum nicht einfach ein reiner Schnitttest (Strecke↔AABB): Er verbietet
   * genau den Kontakt, der gebraucht wird. Liegt ein Kontakt an der FALSCHEN
   * Ecke, schneidet die Sehne die Box — und die richtige neue Kante wird dann
   * abgelehnt, weil ihre eigene Zulaufhälfte durch die Box läuft (Henne-Ei:
   * gemessen 7 von 22 Sweep-Treffern abgelehnt, 132 Blockaden blieben
   * stehen). Physikalisch korrekt ist: das Seil darf die Box dort berühren,
   * wo es anliegt — der Auflagebereich um den Kontakt ist genau die Stelle,
   * an der es um die Kante läuft. Was darüber hinaus in die Box reicht, ist
   * ein unmöglicher Zustand und fliegt.
   */
  _segBoxBeyond(a, b, box, shrink, nearT, marginT) {
    const r = this._segBoxOverlap(a, b, box, shrink);
    if (!r) return -1;
    const m = marginT || 0;
    const lo = Math.max(r.t0, nearT - m), hi = Math.min(r.t1, nearT + m);
    if (lo >= hi) return Math.max(Math.abs(r.t0 - nearT), Math.abs(r.t1 - nearT));
    const over = Math.max(r.t0 - (nearT - m), (nearT + m) - r.t1);
    return over > 1e-9 ? over : -1;
  }

  /** Slab-Test Strecke↔AABB: null = frei, sonst das Überlappungsintervall
      [t0,t1] in Bruchteilen der Streckenlänge plus die Welt-Tiefe.         */
  _segBoxOverlap(a, b, box, shrink) {
    const sh = shrink || 0;
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 3; k++) {
      const mn = box.min[k] + sh, mx = box.max[k] - sh, d = b[k] - a[k];
      if (Math.abs(d) < 1e-12) {
        if (a[k] <= mn || a[k] >= mx) return null;
      } else {
        let ta = (mn - a[k]) / d, tb = (mx - a[k]) / d;
        if (ta > tb) { const x = ta; ta = tb; tb = x; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 >= t1) return null;
      }
    }
    const o = this._sobP || (this._sobP = v3());
    let depth = 0;
    for (let k = 0; k < 3; k++) { const d = (b[k] - a[k]) * (t1 - t0); o[k] = d; depth += d * d; }
    return { t0, t1, depth: Math.sqrt(depth) };
  }

  /** Läuft die eigene Route durch Geometrie? (Sackgassen-Indikator) */
  _residualBlocked() { return this._residualBlockedAt() >= 0; }

  /** Index des ersten blockierten Segments, −1 wenn keines. */
  _residualBlockedAt() {
    const pts = this.pts, bx = this.ptsBox;
    for (let k = 0; k < pts.length - 1; k++)
      if (this._segBlocked(pts[k], pts[k + 1], bx[k], bx[k + 1]) !== null) return k;
    return -1;
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
        /* Freigabebedingung: die direkte Verbindung ist gangbar UND die
           Topologie erlaubt das Loslassen (`_releaseTopoOK`): ein um die Box
           gewickeltes Seil löst sich nicht, nur weil die Sehne frei ist — es
           muss ausgleiten. Früher musste ZUSÄTZLICH gelten, dass das Entfernen weniger als
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
        /* PIVOT-Freigabe = Kraftkegel OFFEN *UND* Sehne frei. Jede der beiden
           Bedingungen allein ist notwendig, aber nicht hinreichend:
             · Sehne frei allein (legacy) gibt auch pressende Kontakte frei —
               der Skizzen-Fall: Sicht wird frei, Seil liegt noch um die Seite.
             · Kegel offen allein gibt Grazing-Kontakte frei, deren Sehne noch
               durch die Box läuft (gemessen: 382 von 383 blockierte Schritte
               im Orbit, fast alle hand-nah, alle release-verursacht).
           Zusammen: gelöst wird nur, was weder drückt noch geometrisch
           gebraucht wird — und gehalten, was eine der beiden Rollen hat.   */
        const unnecessary = (P.wrapSolver === 'pivot' && w.edgeIdx >= 0)
          ? (this._pivotRelease(w, prev, next, cand) && !directBlocked)
          : (!directBlocked && this._releaseTopoOK(w, wrapLen - directLen, i));
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
          if (P.wrapSolver !== 'pivot' && (detour > diag*1.35 + P.wrapClearance*6 || dSeg > Math.max(9, cross*1.5 + 1))) {
            /* Auch der Bogus-Drop ist ein ENTFERNEN und bekommt deshalb dieselbe
               topologische Schranke wie die Freigabe: ein um die Box gewickeltes
               Seil darf nicht durch eine Plausibilitäts-Schranke verschwinden.
               Echte Solver-Irrtümer (der Fall, für den der Drop existiert:
               Kontakt 12 m neben der echten Wicklung) haben Umlaufwinkel ≈ 0
               und werden weiterhin sofort verworfen.                        */
            if (!this._releaseTopoOK(w, detour, i)) { this.stats.bogusWindHeld = (this.stats.bogusWindHeld || 0) + 1; }
            else {
              w._dead = true;
              this.stats.bogusDropped = (this.stats.bogusDropped || 0) + 1;
              this.stats.releaseEvents = (this.stats.releaseEvents || 0) + 1;
              continue;
            }
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
        /* Eck-Übergang: im pivot-Modus WIEDER AN (v1 hatte ihn als „Pflaster"
           abgeschaltet — das war falsch). Ein Kontakt, der ans Ende seiner
           Kante gleitet, ist dort physikalisch am Eckpunkt; ohne Übergang auf
           die Nachbarkante bleibt er stecken, die Sehne schneidet die Box,
           die Selbst-Durchdringungs-Regel wirft ihn raus, der Insert setzt
           dieselbe Kante neu — ein Kreislauf. Gemessen (West-Anker-Orbit):
           70 von 73 blockierten Schritten OHNE jeden Säulenkontakt, 44
           verworfene Kontakte, maxSprung 2,17 m.                          */
        /* Eck-Übergang. Die legacy-Bedingung verlangt `release === 0`
           („Kontakt wird gebraucht, Hysterese steht still"). Im pivot-Modus
           ist genau das die falsche Tür: dort ist die Freigabe Kegel UND
           Sehne, ein an der Klemme stehender Kontakt hat also fast immer
           release > 0 — und `_cornerSlide` wurde in 1680 Substeps kein
           einziges Mal aufgerufen (Instrumentierung auf der Methode,
           tools/probe_orbit2.js). Folge: der Kontakt läuft ans Kantenende,
           bleibt dort stehen, die Sehne schneidet tief durch die eigene Box,
           die Selbst-Durchdringungs-Regel wirft ihn raus, der Blocker-Insert
           setzt dieselbe Kante neu — ein Kreislauf (70 von 73 blockierten
           Schritten ohne jeden Säulenkontakt).
           `_cornerSlide` selbst ist kein Pflaster, sondern die tangentiale
           Bedingung: strikt kürzer + Hysterese, innerhalb cornerSlideReach an
           der Ecke, Kontakt muss INNEN auf der Nachbarkante landen, und alle
           drei Strecken (Zulauf, Ablauf, Koexistenz) müssen frei sein. Der
           alte Kontakt bleibt dabei liegen und löst sich über die normale
           Freigabe — es springt also nichts.                              */
        if (w.edgeIdx >= 0 && w._atEnd &&
            (P.wrapSolver !== 'pivot' ? w.release === 0 : P.pivotCornerSlide))
          this._cornerSlide(i, prev, next, prevBox, nextBox, w);

        if (w.release >= 1) { w._dead = true; this.stats.releaseEvents = (this.stats.releaseEvents || 0) + 1; continue; }

        /* Selbst-Durchdringung: läuft eines der beiden Ankersegmente dieses
           Kontakts durch seine EIGENE Box, liegt er auf der falschen Seite
           (Hand hat die Box umrundet, der Kontakt ist auf der alten Seite
           geblieben). Kein Kegel- und kein Sehnen-Test beschreibt diesen
           Zustand als fehlerhaft — der Kegel sagt „presst nicht mehr", die
           Sehne „wird geometrisch gebraucht", zusammen hielte sie einen
           unmöglichen Kontakt ewig (gemessen: 686 blockierte Schritte im
           Orbit, 462 davon hand-nah). Das Seil kann nicht durch das Objekt
           laufen, an dem es hängt: solcher Kontakt wird sofort verworfen;
           der Sweep legt bei der nächsten Überstreichung den richtigen an. */
        /* Selbst-Durchdringung — aber nur die TIEFE Variante ist ein
           unmöglicher Zustand. Messung (tools/probe_orbit2.js, Anker süd-
           westlich der Säule, also mit echtem Wickel-Zwang):
             Regel aus            : 22,0 % blockierte Schritte, 0 davon ohne
                                    Säulenkontakt, maxSprung 6,26 m
             Regel „irgendwo"     :  5,4 % blockiert, aber 70 von 73 OHNE
                                    Säulenkontakt und 44 verworfene Kontakte
                                    — die Regel hat die Wicklung selbst
                                    aufgefressen, maxSprung 2,17 m
             Regel „tiefer als die halbe Boxdiagonale im Querschnitt":
                                    siehe Messwert unten im Kommentarkopf.
           Grund: Beim Übergang von einer Kante auf die nächste (Seil rutscht
           um die Ecke) schneidet die Sehne die Box für wenige Ticks flach —
           das ist der normale Gleitzustand, kein unmöglicher.              */
        const wM1 = (P.wrapClearance * 3) / Math.max(0.2, vdist(prev, cand));
        const wM2 = (P.wrapClearance * 3) / Math.max(0.2, vdist(cand, next));
        let selfPenBad = false;
        if (P.wrapSolver === 'pivot' && P.pivotSelfPenRule !== 'off' && w.edgeIdx >= 0 &&
            (this._segBoxBeyond(prev, cand, w.box, 0.05, 1, wM1) >= 0 ||
             this._segBoxBeyond(cand, next, w.box, 0.05, 0, wM2) >= 0)) {
          const mn = w.box.min, mx = w.box.max;
          const ex = mx[0] - mn[0], ez = mx[2] - mn[2];
          const lim = 0.5 * Math.hypot(ex, ez) * (P.pivotSelfPenDepth || 0.5);
          const o1 = this._segBoxOverlap(prev, cand, w.box, 0.05);
          const o2 = this._segBoxOverlap(cand, next, w.box, 0.05);
          const deep = Math.max(o1 ? o1.depth : 0, o2 ? o2.depth : 0);
          selfPenBad = deep > lim;
          if (!selfPenBad) this.stats.pivotSelfPenShallow = (this.stats.pivotSelfPenShallow || 0) + 1;
        }
        if (selfPenBad) {
          w._dead = true;
          this.stats.pivotSelfPen = (this.stats.pivotSelfPen || 0) + 1;
          this.stats.releaseEvents = (this.stats.releaseEvents || 0) + 1;
          continue;
        }
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
      /* Dieselbe Kante derselben Box darf nie ZWEIMAL in der Kontaktliste
         stehen: zwei identische Kontakte erzeugen ein Nullelement plus zwei
         volle Auslenkungen zum selben Punkt, also einen Umweg in Reinform
         (gemessen im West-Anker-Orbit, tools/probe_orbit2.js: Kontaktfolge
         [Kante 8, Kante 9, Kante 8] mit Kante 8 doppelt auf
         (32,6 | 2,5 | −25,4); Pfad 17,64 m bei 15,69 m Referenz und ein
         Längensprung von 1,95 m beim Umräumen).
         Der Sweep prüft das von Haus aus; der Blocker-Insert kannte nur die
         ADJAZENZ-Regel (`exclude` unten), die nicht greift, sobald der
         doppelte Kontakt über einen Nachbarkontakt hinweg eingefügt wird.  */
      const taken = this._takenEdges || (this._takenEdges = []);
      taken.length = 0;
      for (const w of this.wraps) if (w.box === blocker && w.edgeIdx >= 0) taken.push(w.edgeIdx);
      let exclude = -1;
      if (ba === blocker && i >= 1 && this.wraps[i-1] && this.wraps[i-1].box === blocker)
        exclude = this.wraps[i-1].edgeIdx;
      else if (bb === blocker && i < this.wraps.length && this.wraps[i] && this.wraps[i].box === blocker)
        exclude = this.wraps[i].edgeIdx;
      const cp = v3();
      const contact = this._findContactFor(a, b, ba, bb, cp, { exclude });
      let e = contact ? contact.edge : -1;
      const cbox = contact ? contact.box : blocker;
      if (e >= 0 && cbox === blocker && taken.indexOf(e) >= 0) e = -2;   // Kante schon belegt
      if (e === -2) continue;
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
    /* lengthGeo ist die echte geometrische Pfadlänge; `length` darf einen
       abklingenden Offset tragen, damit ein Topologie-Neuaufbau die Länge
       nicht in einem Substep reißt (siehe resyncFade). */
    this.lengthGeo = total;
    this.length = total + (this._lenOff || 0);
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
      /* Reibungsfreie Kante: die Seilspannung T zieht in BOTH Richtungen der
         Segmente, die Resultante auf die Kante ist T·(u1 + u2) — Betrag bis
         2T·cos(θ/2), Richtung auf der Winkelhalbierenden. Früher wurde hier
         T/2 auf die halbe Bisectrix gelegt, also ein Viertel der Physik.   */
      const d1 = vnormSafe(vsubNew(prev, w.p));
      const d2 = vnormSafe(vsubNew(next, w.p));
      const fx = d1[0]+d2[0], fy = d1[1]+d2[1], fz = d1[2]+d2[2];
      const l = Math.hypot(fx, fy, fz);
      if (l < 1e-6) continue;
      b.ropeForce[0] += fx*tension; b.ropeForce[1] += fy*tension; b.ropeForce[2] += fz*tension;
      vcopy(b.ropePoint, w.p);
      b.hasRopeForce = true;
      w.force = tension * l * 0.5;
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
    this.anchorLocal = v3();   // Ankerpunkt relativ zum Körper (nur wenn anchorBody gesetzt)
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
    this.anchorBody = null;
    this.path.reset();
    this.budget = 0; this.budgetEff = 0; this.required = 0; this.slack = 0; this.tension = 0;
    this.retractPos = null; this._reactImpulse = 0;
    this.tensionLevel = 0; this.settleActive = false; this.pumpOffset = 0;
    this._settledOnce = true; this._settleTarget = 0; this._tidyT = 0; this._prevWraps = null;
    this._reqPrev = null; this._dropAccum = 0; this._handAccum = 0; this._tidyHandPrev = null;
    this._prevRelEv = null; this._tidyReeled = 0;
  }

  /** Seil am Anker aktivieren (wird vom Haken aufgerufen). */
  /**
   * Schrankt einen freien Haken (schlaffes Seil beim Rückholen) auf die
   * ERREICHBARE Menge ein: nicht die Luftlinie zur Hand ist die Grenze,
   * sondern die verfügbare Länge abzüglich des bereits um die Umlenkungen
   * verlegten Seils. Ohne diese Pfad-Schranke pendelt der Haken beim
   * Einrollen GERADLINIG durch die Wand zurück, statt über die Kante zu
   * folgen (gemessen in test_sim.js 16b).
   * Wird pos korrigiert, liefert die Funktion true.
   */
  constrainFreeEnd(pos, handPos) {
    if (this.phase !== ROPE_PHASE.RETRACT) return false;
    const wr = this.path.wraps;
    let rem = this.budget;
    let px = handPos[0], py = handPos[1], pz = handPos[2];
    for (let i = 0; i < wr.length && rem > 0; i++) {
      const q = wr[i].p;
      rem -= Math.hypot(q[0]-px, q[1]-py, q[2]-pz);
      px = q[0]; py = q[1]; pz = q[2];
    }
    const dx = pos[0]-px, dy = pos[1]-py, dz = pos[2]-pz;
    const l = Math.hypot(dx, dy, dz);
    let changed = false;
    if (l > rem && l > 1e-6) {
      const sc = Math.max(0, rem) / l;
      pos[0] = px + dx*sc; pos[1] = py + dy*sc; pos[2] = pz + dz*sc;
      changed = true;
    }
    /* Geometrie-Schranke für das letzte Stück: auch die Restlänge darf den
       Haken nicht DURCH ein Objekt legen. Ohne diesen Clip rutschte der Haken
       beim Einrollen geradlinig durch die Wand zurück, sobald die Umlenkung
       kurz freigab (gemessen in test_sim.js 16b: keine Kantenüberquerung).
       Mit Clip gleitet er an der Fläche hoch und über die Kante — der Weg,
       den das Seil genommen hat.                                            */
    const ex = pos[0]-px, ey = pos[1]-py, ez = pos[2]-pz;
    const el = Math.hypot(ex, ey, ez);
    if (el > 0.05) {
      const hit = this.world.raycast([px, py, pz], [ex/el, ey/el, ez/el], el,
                                     { minT: 1e-3, ropeOnly: true });
      if (hit && hit.t < el - 1e-4) {
        const t2 = Math.max(0.02, hit.t - 0.05);
        pos[0] = px + ex/el*t2; pos[1] = py + ey/el*t2; pos[2] = pz + ez/el*t2;
        changed = true;
      }
    }
    return changed;
  }

  /** Rückholen starten: Seil bleibt verbunden und rollt ein (kein detach). */
  startRetract() {
    if (this.phase === ROPE_PHASE.IDLE) return;
    this.phase = ROPE_PHASE.RETRACT;
    this.settleActive = false;
    this._tidyT = 0;
    this.retractPos = null;
  }

  attachAt(point, normal, box, body, paidLength) {
    vcopy(this.anchor, point);
    vcopy(this.anchorNormal, normal);
    this.anchorBox = box;
    /* Sitzt der Anker auf einem bewegten Körper (Kiste, Hebebühne, Pendel-Block),
       wird er body-lokal gespeichert und in step() jedes Mal neu abgeleitet.
       Vorher blieb er als Weltpunkt stehen: eine gezogene Kiste wanderte weg,
       das Seilende hing in der Luft (gemessen: Kiste +2,12 m, Anker +0,00 m).
       Die Körper sind AABBs ohne Rotation, ein reiner Offset genügt. */
    this.anchorBody = body || ((box && box.dynamic) ? box : null);
    if (this.anchorBody) vsub(this.anchorLocal, point, this.anchorBody.pos);
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
    this._prevRelEv = null; this._tidyReeled = 0;
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

    // Anker folgt seinem Körper (die Körper wurden in diesem Substep bereits bewegt)
    if (this.phase !== ROPE_PHASE.FLIGHT && this.anchorBody) vadd(this.anchor, this.anchorBody.pos, this.anchorLocal);

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
    /* Der Pfad-Solver kennt seinen Wirt nicht; die Sackgassen- und Drift-
       Mechanismen dürfen aber nur im stabilen Attached-Betrieb laufen (siehe
       `rebuildAfter`). Deshalb der Zustand hier als Flag mitgeben. */
    this.path._hostSettled = (this.phase === ROPE_PHASE.ATTACHED && !this.settleActive);
    /* Zug-Zustand (Seil überdehnt): Homotopiewechsel wäre unphysikalisch. */
    this.path._hostTaut = (this.overshoot || 0) > 0.05;
    this.required = this.path.solve(handPos, endPt, dt, null, endBox);
    this.stats.solves++;

    /* ---- 2) Budget-Logik (Seil-Vorrat) -------------------------------- */
    if (this.phase === ROPE_PHASE.RETRACT) {
      /* Einrollen: das verfügbare Seil schrumpft mit fester Rate. Der Haken
         wird anschließend auf den Bogenpunkt dieser Länge gesetzt (siehe
         retractPos) — dadurch folgt er dem gelösten Pfad zurück, inklusive
         über jede Kante, über die das Seil beim Abschuss gelegt wurde.    */
      /* Untergrenze 0,3 m statt minBudget: das Seil muss bis in die Hand
         einrollen können, sonst arretiert der Haken meterweit vor dem
         Spieler (gemessen: Stillstand bei 2,0 m = minBudget).             */
      this.budget = Math.max(0.3, this.budget - (P.retractReelSpeed || 16) * dt);
      this.retractPos = null;
    } else if (this.phase === ROPE_PHASE.FLIGHT) {
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
      /* Automatischer Nachroll im Flug: läuft der Spieler auf den Haken zu,
         blieb das über die Hakenbahn bezahlte Seil früher vollständig stehen
         und türmte sich als Schlaffseil (gemessen: mehrere Meter Haufen vor
         dem Einhaken, danach harter Setz-Ruck). Wie beim Kabelstaubsauger
         rollt der Überschuss über der Flughäng-Grenze jetzt mit fester Rate
         nach — das hinter dem Haken herlaufende Seil (feedGain) bleibt
         unberührt, solange es diese Grenze nicht unterschreitet.          */
      /* Nachroll-NUR für den Haufen, nicht für die Fahne: hinter dem Haken
         herlaufendes Seil ist gewollt (feedGain/feedBias) und wächst mit der
         Hakengeschwindigkeit — die Erlaubnis skaliert deshalb mit hs. Erst
         was darüber hinaus hängt (Spieler läuft auf den Haken zu, Haken
         wird langsam), rollt mit fester Rate ein. Ohne den hs-Term würgte
         der Nachroll die Fahne ab und das Seil zerrte mitten im Flug am
         Haken (gemessen: Flug bricht nach 0,17 s ab, Haken fällt vor die
         Wand statt dahinter).                                               */
      const floor = d + 0.06 + (P.flightSag || 0.35) + 0.25 * hs;
      if (this.budget > floor)
        this.budget = Math.max(floor, this.budget - (P.flightReelSpeed || 18) * dt);
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

    /* Bogenpunkt der verfügbaren Länge: ist der gelöste Pfad länger als das
       Budget, liegt das Seilende (und damit der Haken) auf dem Pfad bei
       genau budget Metern ab der Hand — straff, um alle Umlenkungen. Ist der
       Pfad kürzer, bleibt retractPos null und der Haken pendelt schlaff am
       Ende (Schwerkraft + Seilschranke in Hook.step).                      */
    if (this.phase === ROPE_PHASE.RETRACT && this.required > this.budget + 1e-4) {
      const cum = this.path.cum, pts = this.path.pts;
      const want = this.budget;
      let k = 1;
      while (k < cum.length - 1 && cum[k] < want) k++;
      const segL = Math.max(1e-6, cum[k] - cum[k - 1]);
      const u = clamp((want - cum[k - 1]) / segL, 0, 1);
      if (!this.retractPos) this.retractPos = v3();
      vlerp(this.retractPos, pts[k - 1], pts[k], u);
    }

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
      /* Nachroll-Fenster NUR bei echten Topologie-Ereignissen (Kontakt
         gegangen: Release, Bogus-Drop, Resync, Rebuild). Die frühere zweite
         Bedingung `dropAccum > handAccum + 0.5` fraß bewusst abgerolltes
         Spiel: schon das GLEITEN eines Kontakts um eine Kante verkürzt
         `required` ohne Handbewegung, und tidy wertete das als freigesetztes
         Spiel und rollte das Mausrad-Seil des Spielers ein — gemessen im
         Straf-Szenario: 16 m bezahltes Spiel wurden bis auf slack −7 m
         eingerollt, obwohl nie ein Kontakt fiel. Das ist das gemeldete
         „und dann verkürzt es sich auch noch direkt".                     */
      const relEv = this.path.stats.releaseEvents || 0;
      const relNew = this._prevRelEv == null ? false : relEv > this._prevRelEv;
      this._prevRelEv = relEv;
      if ((this._prevWraps != null && wrapCount < this._prevWraps || relNew) && this.slack > 0.5) {
        this._tidyT = 1.0; this._tidyReeled = 0; this._handAccum = 0;
      }
      if (this._tidyT > 0) {
        this._tidyT -= dt;
        /* NACHGEROLLT WIRD NUR DIE FREIGESETZTE MENGE, nicht das ganze Spiel.
           `_dropAccum` summiert die Required-Abfälle seit dem letzten Anstieg
           (also genau das, was die gefallenen Kontakte freigegeben haben,
           inklusive Offset-Fade); davon abgezogen wird, was dieses Fenster
           bereits gerollt hat. Früher zog das Fenster bis auf straff — und
           fraß damit bewusst per Mausrad abgerolltes Seil in dem Moment, in
           dem irgendein Kontakt fiel (gemessen: 25,8 m bezahltes Budget →
           8,1 m in 0,9 s). Das ist das gemeldete „und dann verkürzt es sich
           auch noch direkt".                                                */
        const released = Math.max(0, (this._dropAccum || 0) - (this._tidyReeled || 0));
        const pull = Math.min(P.settleReelSpeed * dt,
                              released,
                              Math.max(0, this.slack - P.tautMargin),
                              Math.max(0, this.budget - (this.required + P.tautMargin)));
        this._tidyReeled = (this._tidyReeled || 0) + pull;
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

    /* ---- 6) Rückwirkung auf dynamische Körper -------------------------
       ACTIO = REACTIO: Die Kraft, die auf die Körper wirkt, ist exakt die
       Kraft, die die Constraint im vorigen Substep auf den Spieler ausgeübt
       hat (activeForce = Impuls/dt · playerMass). Früher stand hier eine
       Schätzung tensionLevel · (80 kg · g · (1 + v²/2gr)) — die zog an der
       Kiste, auch wenn der Spieler ruhig stand und das Seil keinerlei
       Überdehnung hatte (Parallel-Befund). Ein straffes Seil ohne Überdehnung
       übt jetzt definitionsgemäß keine Kraft aus, ein gespanntes genau die,
       die es auch am Spieler zerrt.                                       */
    if (this.attached && (this._reactImpulse || 0) > 0) {
      const T = (this._reactImpulse / Math.max(1e-5, dt)) * (P.playerMass || 80);
      this.path.distributeReaction(T, this.path.dirStart);
    }
    this._reactImpulse = 0;

    /* ---- 7) Visualisierungskette -------------------------------------- */
    this._stepChain(dt, hookPos, playerVel);
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
    /* _reactImpulse wird hier bewusst NICHT zurückgesetzt: ein schlaffer
       Zwischensubstep darf die gesammelte Zugkraft nicht löschen.          */
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
    this.activeForce = impulse / Math.max(1e-5, dt) * (P.playerMass || 80);  // Newton
    /* Impuls zusätzlich SAMMELN: die Constraint chattert um slack = 0 (ein
       Substep schlaff, einer straff), eine Momentan-Abfrage durch die
       Rückwirkung würde die Hälfte der Kraft unterschlagen. Die Reaktion
       liest die Summe seit dem letzten Physik-Schritt.                     */
    this._reactImpulse = (this._reactImpulse || 0) + impulse;
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
    const retract = (this.phase === ROPE_PHASE.RETRACT);
    /* Beim Rückholen liegt die Kette wie im Attached-Zustand auf dem gelösten
       Pfad (inkl. Umlenkungen), nur dass das ferne Ende der Haken ist: das
       Seil wird sichtbar über die Kanten zurückgezogen.                    */
    const farPin = (flying || retract) ? (hookPos || this.hookPos || this.anchor) : this.anchor;
    /* EIN Austrittspunkt in allen Phasen: die Kamera-Mündung (visualHand).
       Bis ein echter IK-Arm existiert, ist jede Körper-„Hand" eine statisch
       nach unten hängende Hilfsposition, an der ein Seil weder sinnvoll
       aussieht noch physikalisch Sinn ergibt (Nutzer-Entscheid 2026-10-13:
       „Seil startet fix leicht rechts unten im Kamerabild"). Der Pfad-Solver
       misst weiterhin ab Brustpunkt (stabile Constraint), der Offset zur
       Mündung wird über pinCorr herausgerechnet.                            */
    const handPin = this.visualHand ? this.visualHand : this.hand;
    const pathLen = flying ? Math.max(1e-4, vdist(handPin, farPin))
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

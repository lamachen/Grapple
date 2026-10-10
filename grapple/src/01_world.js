/* =============================================================================
   01_world.js — Levelgeometrie, Raycasting, dynamische Körper, Character-Sweep
   -----------------------------------------------------------------------------
   Alles ist AABB-basiert (statisch + bewegt). Das ist für Parkour-Level realistisch
   (Architektur = Boxen) und hält Raycasts sowie die Wrap-Geometrie exakt und billig.
   OBB/Mesh-Collider sind ein Drop-in: Ray in den Lokalraum transformieren.
   ========================================================================== */
'use strict';

/* ---------------------------------- Körper --------------------------------- */
let __bodyId = 1;

/**
 * Dynamischer Körper (AABB). `kinematic` => folgt einem Script-Pfad (Plattform),
 * sonst frei mit Gravitation (Kiste). Beide nehmen am Seil-Wrapping teil und
 * werden von Seilkräften beeinflusst (siehe Rope.applyReaction).
 */
function makeBody(opts) {
  const half = opts.half || [0.5, 0.5, 0.5];
  return {
    id: __bodyId++,
    dynamic: true,
    pos: vclone(opts.pos || [0, 0, 0]),
    prevPos: vclone(opts.pos || [0, 0, 0]),
    vel: v3(0, 0, 0),
    half: vclone(half),
    mass: opts.mass != null ? opts.mass : (half[0]*half[1]*half[2]*900),
    invMass: 0,
    kinematic: !!opts.kinematic,
    grounded: false,
    friction: opts.friction != null ? opts.friction : 0.55,
    hookable: opts.hookable !== false,
    ropeSolid: opts.ropeSolid !== false,
    color: opts.color || [0.78, 0.75, 0.70],
    // Script-Bewegung (kinematisch)
    path: opts.path || null,     // [[x,y,z], ...] Wegpunkte
    pathSpeed: opts.pathSpeed || 3,
    pathT: 0, pathDir: 1, pathLoop: opts.pathLoop !== false,
    // Seilkraft-Akkumulator (wird pro Frame von Rope gefüllt)
    ropeForce: v3(0, 0, 0),
    ropePoint: v3(0, 0, 0),
    hasRopeForce: false,
    min: v3(), max: v3(),
    _dragLin: opts.dragLin != null ? opts.dragLin : 0.15,
  };
}

function bodyUpdateAABB(b) {
  b.min[0] = b.pos[0]-b.half[0]; b.min[1] = b.pos[1]-b.half[1]; b.min[2] = b.pos[2]-b.half[2];
  b.max[0] = b.pos[0]+b.half[0]; b.max[1] = b.pos[1]+b.half[1]; b.max[2] = b.pos[2]+b.half[2];
}

/* ----------------------------------- Welt ---------------------------------- */
class World {
  constructor() {
    /** Statische Boxen. `s` ist ein flaches Float32Array: [mnx,mny,mnz,mxx,mxy,mxz] je Box. */
    this.statics = [];      // {min,max,color,tag,hookable,friction, idx}
    this.bodies  = [];      // dynamische Körper
    this.gravity = -26.0;
    this._sflat = null;     // Float32Array(6*N) — cache-freundlich für Raycasts
    this._scol  = null;
    this._dirty = true;
    this.stats = { raycasts: 0, rayBoxTests: 0 };
    // Wiederverwendetes Trefferergebnis: raycast wird pro Frame hunderte Male
    // aufgerufen (Ketten-CCD + Render-Kurve). Frische Objekte/Arrays pro Treffer
    // waren die Quelle der GC-Lag-Spikes.
    this._hit = { t:0, p:v3(), n:v3(), box:null, body:null };
  }

  /* ------------------------------ Authoring ------------------------------ */
  addBox(min, max, opts = {}) {
    const b = {
      min: vclone(min), max: vclone(max),
      color: opts.color || [0.86, 0.86, 0.88],
      tag: opts.tag || 'static',
      hookable: opts.hookable !== false,
      // ropeSolid=false ⇒ reine Zier-/Trim-Geometrie: sichtbar und für den
      // Spieler solid, aber das SEIL legt sich nicht daran fest. Das ist die
      // übliche Collision-Layer-Praxis und verhindert, dass 3 cm dünne Kanten
      // das Wrapping in degenerierte Fälle treiben.
      ropeSolid: opts.ropeSolid !== false,
      friction: opts.friction != null ? opts.friction : 0.75,
      dynamic: false,
      id: 0,
      idx: this.statics.length,
    };
    this.statics.push(b);
    this._dirty = true;
    return b;
  }
  /** Bequem: Box aus Mittelpunkt + Größe. */
  addBoxCS(center, size, opts = {}) {
    const h = [size[0]*0.5, size[1]*0.5, size[2]*0.5];
    return this.addBox([center[0]-h[0], center[1]-h[1], center[2]-h[2]],
                       [center[0]+h[0], center[1]+h[1], center[2]+h[2]], opts);
  }
  addBody(opts) {
    const b = makeBody(opts);
    b.invMass = b.kinematic ? 0 : 1 / Math.max(1e-6, b.mass);
    bodyUpdateAABB(b);
    this.bodies.push(b);
    return b;
  }
  rebuild() {
    const n = this.statics.length;
    this._sflat = new Float32Array(n * 6);
    this._scol  = [];
    for (let i = 0; i < n; i++) {
      const b = this.statics[i];
      this._sflat[i*6+0] = b.min[0]; this._sflat[i*6+1] = b.min[1]; this._sflat[i*6+2] = b.min[2];
      this._sflat[i*6+3] = b.max[0]; this._sflat[i*6+4] = b.max[1]; this._sflat[i*6+5] = b.max[2];
      this._scol.push(b);
    }
    this._dirty = false;
  }

  /* ------------------------------- Raycasting ---------------------------- */
  /**
   * Ray vs. Welt (statische Boxen + dynamische Körper).
   * @returns {{t:number, p:number[], n:number[], box:object}|null}
   */
  raycast(o, d, maxT, opts = null) {
    if (this._dirty) this.rebuild();
    this.stats.raycasts++;
    const skip = opts && opts.skip ? opts.skip : null;
    const skip2 = opts && opts.skip2 ? opts.skip2 : null;
    const minT = opts && opts.minT != null ? opts.minT : 1e-4;
    const hookOnly = opts && opts.hookOnly;
    const ropeOnly = opts && opts.ropeOnly;
    let best = null, bestT = maxT;

    const F = this._sflat, S = this._scol;
    for (let i = 0, n = S.length; i < n; i++) {
      const box = S[i];
      if (box === skip || box === skip2) continue;
      if (hookOnly && !box.hookable) continue;
      if (ropeOnly && !box.ropeSolid) continue;
      const t = rayAABB(o, d, F[i*6], F[i*6+1], F[i*6+2], F[i*6+3], F[i*6+4], F[i*6+5], bestT);
      if (t >= minT && t < bestT) { bestT = t; best = box; }
    }
    if (best) {
      const h = this._hit;
      h.t = bestT; h.box = best; h.body = null;
      h.p[0]=o[0]+d[0]*bestT; h.p[1]=o[1]+d[1]*bestT; h.p[2]=o[2]+d[2]*bestT;
      aabbNormalAt(o, d, bestT, best, h.n);
      return h;
    }
    // dynamische Körper (wenige → direkter Loop)
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b === skip || b === skip2) continue;
      if (hookOnly && !b.hookable) continue;
      if (ropeOnly && !b.ropeSolid) continue;
      const t = rayAABB(o, d, b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], bestT);
      if (t >= minT && t < bestT) { bestT = t; best = b; }
    }
    if (best && best.dynamic) {
      const h = this._hit;
      h.t = bestT; h.box = best; h.body = best;
      h.p[0]=o[0]+d[0]*bestT; h.p[1]=o[1]+d[1]*bestT; h.p[2]=o[2]+d[2]*bestT;
      aabbNormalAt(o, d, bestT, best, h.n);
      return h;
    }
    return null;
  }

  /**
   * Treffer in ein eigenes Objekt kopieren. Nötig, weil raycast() ein
   * wiederverwendetes Ergebnis liefert — wer es länger hält (Aim-Reticle,
   * Anker-Auswahl über mehrere Strahlen) MUSS kopieren.
   */
  static copyHit(dst, src) {
    dst.t = src.t; dst.box = src.box; dst.body = src.body;
    vcopy(dst.p, src.p); vcopy(dst.n, src.n);
    return dst;
  }
  makeHit() { return { t:0, p:v3(), n:v3(), box:null, body:null }; }

  /** Boolesche Sichtverbindung (für Wrap-Validierung) — bricht beim ersten Treffer ab. */
  segmentClear(a, b, opts = null) {
    if (this._dirty) this.rebuild();
    this.stats.raycasts++;
    const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
    const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (len < 1e-6) return true;
    const il = 1/len;
    const d = [dx*il, dy*il, dz*il];
    const skip1 = opts && opts.skip1 ? opts.skip1 : null;
    const skip2 = opts && opts.skip2 ? opts.skip2 : null;
    const skip3 = opts && opts.skip3 ? opts.skip3 : null;
    const ropeOnly = opts && opts.ropeOnly;
    // endBox: die Box, auf der der Endpunkt liegt. Sie darf NICHT global
    // übersprungen werden — sonst schneidet das Seil ungestraft ihre Kante,
    // obwohl es physikalisch über sie drapieren müsste. Erlaubt ist nur ein
    // Eintritt im allerletzten Stück der Strecke (dort liegt der Endpunkt).
    const endBox = opts && opts.endBox ? opts.endBox : null;
    /* endTol muss ABSOLUT klein sein. Ein längenproportionaler Wert (früher
       len*0.12) erlaubte bei 22 m Seil ein Eintauchen von 2.7 m in die
       Anker-Box — das Seil schnitt dann ungehindert deren Oberkante, und es
       wurde nie ein Umlenkkontakt dort angelegt. Erlaubt ist nur das letzte
       Stück bis zum Ankerpunkt selbst, der knapp über der Fläche liegt.      */
    const endTol = opts && opts.endTol != null ? opts.endTol : 0.20;
    // startBox: die Box, auf der der STARTPUNKT liegt. Ein Eintritt ganz am
    // Anfang ist legitim (der Punkt liegt auf der Fläche), mitten in der
    // Strecke nicht. Ohne das würden Segmente zwischen zwei Kontakten auf
    // derselben Box entweder gar nicht oder immer falsch bewertet.
    const startBox = opts && opts.startBox ? opts.startBox : null;
    const startTol = opts && opts.startTol != null ? opts.startTol : 0.20;
    const minT = opts && opts.minT != null ? opts.minT : 1e-4;
    /* Zwei Fälle zählen als blockiert:
         (1) regulärer Eintritt innerhalb der Strecke
         (2) der STARTPUNKT steckt bereits in der Box. rayAABB liefert dann
             tmin = 0, was unter minT fällt und die Box unsichtbar machte —
             genau dadurch wurde eine bestehende Wicklung fälschlich als
             "direkte Verbindung ist frei" bewertet und das Seil sprang
             teleportierend durch das Objekt auf den direkten Weg zurück.   */
    const F = this._sflat, S = this._scol;
    const ix = 1/d[0], iy = 1/d[1], iz = 1/d[2];
    for (let i = 0, n = S.length; i < n; i++) {
      const box = S[i];
      if (box === skip1 || box === skip2 || box === skip3) continue;
      if (ropeOnly && !box.ropeSolid) continue;
      if (rayAABBFlagsInv(a, ix, iy, iz, F[i*6], F[i*6+1], F[i*6+2], F[i*6+3], F[i*6+4], F[i*6+5], len, minT, _SC)) {
        if (box === startBox && _SC.tEntry <= startTol) continue;
        /* endBox-Kriterium über den AUSTRITT, nicht über einen festen Abstand.
           Ein Abstandswert scheitert am Anflugwinkel: läuft das Seil flach auf
           den Anker zu, tritt es schnell einmal 30–40 cm vor dem Ende in dessen
           Box ein, obwohl das völlig legitim ist — es bleibt ja bis zum
           Endpunkt darin. Entscheidend ist allein, ob die Strecke die Box
           wieder VERLÄSST (dann ist es ein echter Schnitt) oder ob der
           Endpunkt in ihr liegt (dann ist es der Anker selbst).             */
        if (box === endBox && _SC.tExit >= len - 1e-3) continue;
        return false;
      }
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b === skip1 || b === skip2 || b === skip3) continue;
      if (ropeOnly && !b.ropeSolid) continue;
      if (rayAABBFlagsInv(a, ix, iy, iz, b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], len, minT, _SC)) {
        if (b === startBox && _SC.tEntry <= startTol) continue;
        if (b === endBox && _SC.tExit >= len - 1e-3) continue;
        return false;
      }
    }
    return true;
  }

  /** Alle Boxen, deren AABB den Sphere-Test besteht (Broadphase für Wrap-Kandidaten). */
  queryAABB(mn, mx, out) {
    out.length = 0;
    if (this._dirty) this.rebuild();
    const S = this._scol, F = this._sflat;
    for (let i = 0, n = S.length; i < n; i++) {
      if (F[i*6] <= mx[0] && F[i*6+3] >= mn[0] &&
          F[i*6+1] <= mx[1] && F[i*6+4] >= mn[1] &&
          F[i*6+2] <= mx[2] && F[i*6+5] >= mn[2]) out.push(S[i]);
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.min[0] <= mx[0] && b.max[0] >= mn[0] &&
          b.min[1] <= mx[1] && b.max[1] >= mn[1] &&
          b.min[2] <= mx[2] && b.max[2] >= mn[2]) out.push(b);
    }
    return out;
  }

  /* ------------------- Punktkollision (für Seil-Kette) -------------------- */
  /**
   * Schiebt einen Punkt (Seil-Node) aus allen überlappenden Boxen heraus.
   * Allokationsfrei, ein Durchlauf über die flache statische Liste + Bodies.
   * Das ist der Grund, warum loses Seil sich über Kanten DRAPIERT statt durch
   * Wände zu hängen — ohne dass wir eine echte Seil-Selbstkollision brauchen.
   */
  collideSphere(p, r, ropeOnly) {
    if (this._dirty) this.rebuild();
    const F = this._sflat, S = this._scol;
    for (let i = 0, n = S.length; i < n; i++) {
      // Konsistenz ist hier entscheidend: der Pfad-Solver ignoriert Zierleisten
      // (ropeSolid=false), also MUSS die Kettenkollision das auch tun. Sonst
      // drückt die Kollision das Seil an Leisten heraus, die der Pfad gar nicht
      // kennt — sichtbares Zittern und Zacken um jede dünne Kante.
      if (ropeOnly && !S[i].ropeSolid) continue;
      const o = i*6;
      const cx = clamp(p[0], F[o], F[o+3]);
      const cy = clamp(p[1], F[o+1], F[o+4]);
      const cz = clamp(p[2], F[o+2], F[o+5]);
      let dx = p[0]-cx, dy = p[1]-cy, dz = p[2]-cz;
      let d2 = dx*dx+dy*dy+dz*dz;
      if (d2 > r*r) continue;
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2), push = (r-d)/d;
        p[0]+=dx*push; p[1]+=dy*push; p[2]+=dz*push;
      } else {
        /* Punkt tief im Inneren → über eine Fläche herausschieben.
           "Nächste Fläche" allein genügt NICHT: an einer konkaven Ecke (Wand
           steht auf dem Boden) schiebt sie den Punkt in die Nachbarbox, die
           schiebt zurück — das Seil liegt dann z. B. UNTER dem Boden
           (gemessen: y = −0.105 m). Deshalb werden die Flächen in
           Distanzreihenfolge probiert und nur ein Ziel akzeptiert, das nicht
           in einer anderen Box liegt. Findet sich keines, entscheidet wie
           bisher die nächste Fläche (Garantie: der Punkt kommt heraus).     */
        const dl = [p[0]-F[o], F[o+3]-p[0], p[1]-F[o+1], F[o+4]-p[1], p[2]-F[o+2], F[o+5]-p[2]];
        const order = this._pushOrder || (this._pushOrder = [0,1,2,3,4,5]);
        for (let a = 1; a < 6; a++) {                  // Insertionsort (6 Elemente)
          const v = order[a]; let b2 = a-1;
          while (b2 >= 0 && dl[order[b2]] > dl[v]) { order[b2+1] = order[b2]; b2--; }
          order[b2+1] = v;
        }
        const q = this._pushQ || (this._pushQ = [0,0,0]);
        const face = (mi, out) => {
          out[0]=p[0]; out[1]=p[1]; out[2]=p[2];
          if (mi===0) out[0]=F[o]-r;   else if (mi===1) out[0]=F[o+3]+r;
          else if (mi===2) out[1]=F[o+1]-r; else if (mi===3) out[1]=F[o+4]+r;
          else if (mi===4) out[2]=F[o+2]-r; else out[2]=F[o+5]+r;
        };
        let placed = false;
        for (const margin of [r*0.9, 0]) {
          for (let a = 0; a < 6; a++) {
            face(order[a], q);
            if (!this._pointInAnyBox(q, i, ropeOnly, margin)) {
              p[0]=q[0]; p[1]=q[1]; p[2]=q[2]; placed = true; break;
            }
          }
          if (placed) break;
        }
        if (!placed) { face(order[0], p); }
      }
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (ropeOnly && !b.ropeSolid) continue;
      const cx = clamp(p[0], b.min[0], b.max[0]);
      const cy = clamp(p[1], b.min[1], b.max[1]);
      const cz = clamp(p[2], b.min[2], b.max[2]);
      let dx = p[0]-cx, dy = p[1]-cy, dz = p[2]-cz;
      const d2 = dx*dx+dy*dy+dz*dz;
      if (d2 > r*r) continue;
      if (d2 > 1e-10) { const d = Math.sqrt(d2), push = (r-d)/d; p[0]+=dx*push; p[1]+=dy*push; p[2]+=dz*push; }
      else p[1] = b.max[1] + r;
    }
    return p;
  }

  /** Liegt q in einer ANDEREN festen Box (um `margin` aufgeblasen)?
   *  `skipIdx` überspringt den Index in der statischen Liste (die Box, aus der
   *  gerade herausgeschoben wird). Nur für den Tief-Im-Inneren-Zweig von
   *  collideSphere — daher selten und ohne Breitenindex.                    */
  _pointInAnyBox(q, skipIdx, ropeOnly, margin) {
    const F = this._sflat, S = this._scol;
    for (let i = 0, n = S.length; i < n; i++) {
      if (i === skipIdx) continue;
      if (ropeOnly && !S[i].ropeSolid) continue;
      const o = i*6;
      if (q[0] > F[o]-margin && q[0] < F[o+3]+margin &&
          q[1] > F[o+1]-margin && q[1] < F[o+4]+margin &&
          q[2] > F[o+2]-margin && q[2] < F[o+5]+margin) return true;
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (ropeOnly && !b.ropeSolid) continue;
      if (q[0] > b.min[0]-margin && q[0] < b.max[0]+margin &&
          q[1] > b.min[1]-margin && q[1] < b.max[1]+margin &&
          q[2] > b.min[2]-margin && q[2] < b.max[2]+margin) return true;
    }
    return false;
  }

  /** Welche Box enthält diesen Punkt? (für "Strahl startet im Inneren") */
  boxContaining(p, ropeOnly) {
    if (this._dirty) this.rebuild();
    const F = this._sflat, S = this._scol;
    for (let i = 0, n = S.length; i < n; i++) {
      if (ropeOnly && !S[i].ropeSolid) continue;
      const o = i*6;
      if (p[0] >= F[o] && p[0] <= F[o+3] && p[1] >= F[o+1] && p[1] <= F[o+4] &&
          p[2] >= F[o+2] && p[2] <= F[o+5]) return S[i];
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (ropeOnly && !b.ropeSolid) continue;
      if (p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] &&
          p[2] >= b.min[2] && p[2] <= b.max[2]) return b;
    }
    return null;
  }

  /** Liegt der Punkt innerhalb `dist` von irgendeiner festen Fläche? */
  nearGeometry(p, dist) { return !this.pointFree(p, dist, true); }

  /** Ist der Punkt frei von jeder Geometrie (inkl. Sicherheitsabstand)? */
  pointFree(p, pad, ropeOnly) {
    if (this._dirty) this.rebuild();
    const F = this._sflat, S = this._scol;
    for (let i = 0, n = S.length; i < n; i++) {
      const o = i*6;
      if (ropeOnly && !S[i].ropeSolid) continue;
      if (p[0] > F[o]-pad && p[0] < F[o+3]+pad &&
          p[1] > F[o+1]-pad && p[1] < F[o+4]+pad &&
          p[2] > F[o+2]-pad && p[2] < F[o+5]+pad) return false;
    }
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (ropeOnly && !b.ropeSolid) continue;
      if (p[0] > b.min[0]-pad && p[0] < b.max[0]+pad &&
          p[1] > b.min[1]-pad && p[1] < b.max[1]+pad &&
          p[2] > b.min[2]-pad && p[2] < b.max[2]+pad) return false;
    }
    return true;
  }

  /**
   * Prüft, ob die Strecke a→b eine bestimmte Box schneidet (Sample-Test).
   * Wird für Wrap-Kandidaten gebraucht, wo der Strahl die Zielbox absichtlich
   * "streifen" darf (Kontaktpunkt liegt mit Clearance auf der Kante).
   */
  segmentAvoidsBox(a, b, box, pad) {
    const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
    const len = Math.sqrt(dx*dx+dy*dy+dz*dz);
    if (len < 0.30) return true;              // zu kurz für eine sinnvolle Prüfung
    const mnx = box.min[0]-pad, mny = box.min[1]-pad, mnz = box.min[2]-pad;
    const mxx = box.max[0]+pad, mxy = box.max[1]+pad, mxz = box.max[2]+pad;
    /* Stichproben im ABSOLUTABSTAND, nicht prozentual. Prozentsätze (früher
       t = 0.2…0.8) sind bei kurzen Segmenten viel zu grob und übersehen ein
       Eintauchen in die Box vollständig — bei 1.7 m Länge lag die erste Probe
       schon 0.34 m tief, und genau dort verlief die kritische Kante.          */
    const margin = Math.min(0.12, len*0.15);
    const span = len - 2*margin;
    if (span <= 0.02) return true;
    const steps = Math.max(1, Math.min(8, Math.ceil(span/0.30)));
    for (let k = 1; k <= steps; k++) {
      const t = (margin + span*(k/(steps+1))) / len;
      const px = a[0]+dx*t, py = a[1]+dy*t, pz = a[2]+dz*t;
      if (px > mnx && px < mxx && py > mny && py < mxy && pz > mnz && pz < mxz) return false;
    }
    return true;
  }

  /* --------------------------- Kapsel-Kollision --------------------------- */
  /**
   * Move-and-slide für eine Kapsel (Character). Keine Positions-Teleportie:
   * es wird iterativ aus Penetration herausgeschoben und die Velocity entlang
   * der Kontaktnormalen gekürzt (Impulserhaltung in Tangentialrichtung).
   * @returns Kontakte/Flags in `res`.
   */
  moveCapsule(pos, vel, dt, radius, halfHeight, res, opts = {}) {
    res.grounded = false; res.groundNormal = null; res.groundBody = null;
    res.wallNormal = null; res.wallBody = null; res.ceiling = false;
    res.contactCount = 0;
    if (!res._gn) { res._gn = v3(); res._wn = v3(); }
    const stepHeight = opts.stepHeight != null ? opts.stepHeight : 0.62;
    const maxSlideIters = opts.slideIters || 4;

    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-6 && guard++ < 6) {
      // Substep-Länge so wählen, dass wir pro Schritt max. ~radius*0.8 wandern
      const speed = vlen(vel);
      const maxStep = Math.max(0.02, radius * 0.8);
      let sdt = speed > 1e-4 ? Math.min(remaining, maxStep / speed) : remaining;
      sdt = Math.min(sdt, remaining);

      // gewünschte Bewegung
      const nx = pos[0] + vel[0]*sdt, ny = pos[1] + vel[1]*sdt, nz = pos[2] + vel[2]*sdt;
      const before = [pos[0], pos[1], pos[2]];
      pos[0] = nx; pos[1] = ny; pos[2] = nz;

      // Penetration auflösen (mit Step-Up)
      this._resolveCapsule(pos, vel, radius, halfHeight, res, stepHeight);
      remaining -= sdt;
      // Keine Nettobewegung → vollständig blockiert, weitere Iterationen bringen nichts.
      if (vdistSq(before, pos) < 1e-14) break;
      if (maxSlideIters && guard > maxSlideIters) break;
    }
    return res;
  }

  _resolveCapsule(pos, vel, radius, hh, res, stepHeight) {
    const seg0 = [pos[0], pos[1]-hh, pos[2]];      // unterer Kugelzentrum
    const seg1 = [pos[0], pos[1]+hh, pos[2]];      // oberer Kugelzentrum
    const mn = [Math.min(seg0[0],seg1[0])-radius, Math.min(seg0[1],seg1[1])-radius, Math.min(seg0[2],seg1[2])-radius];
    const mx = [Math.max(seg0[0],seg1[0])+radius, Math.max(seg0[1],seg1[1])+radius, Math.max(seg0[2],seg1[2])+radius];
    const cand = this.queryAABB(mn, mx, _CAND_BUF);

    let stepCandidate = null;
    for (let iter = 0; iter < 3; iter++) {
      let pushed = false;
      for (let i = 0; i < cand.length; i++) {
        const box = cand[i];
        const c = segAABBClosest(seg0, seg1, box.min, box.max, _SEGPT, _BOXPT);
        if (!c) {
          // ACHSE STECKT IN DER BOX (tiefe Penetration, z. B. durch starken Seilzug).
          // Näherster-Punkt liefert dann keine Normale → wir lösen über die
          // minimale Überlappungsachse auf. Ohne diesen Fall würde der Spieler
          // in dünnen Wänden "stecken bleiben" und hindurchgedrückt werden.
          const ex = Math.min(pos[0]-box.min[0], box.max[0]-pos[0]);
          const ey = Math.min((pos[1]+hh)-box.min[1], box.max[1]-(pos[1]-hh));
          const ez = Math.min(pos[2]-box.min[2], box.max[2]-pos[2]);
          let ax = 0, depth = 0, sgn = 1;
          if (ex <= ey && ex <= ez) { ax = 0; depth = ex + radius; sgn = (pos[0] > (box.min[0]+box.max[0])*0.5) ? 1 : -1; }
          else if (ez <= ey)        { ax = 2; depth = ez + radius; sgn = (pos[2] > (box.min[2]+box.max[2])*0.5) ? 1 : -1; }
          else                      { ax = 1; depth = ey + radius; sgn = (pos[1] > (box.min[1]+box.max[1])*0.5) ? 1 : -1; }
          const nx = ax===0?sgn:0, ny = ax===1?sgn:0, nz = ax===2?sgn:0;
          pos[0]+=nx*depth; pos[1]+=ny*depth; pos[2]+=nz*depth;
          seg0[0]+=nx*depth; seg0[1]+=ny*depth; seg0[2]+=nz*depth;
          seg1[0]+=nx*depth; seg1[1]+=ny*depth; seg1[2]+=nz*depth;
          const vn2 = vel[0]*nx+vel[1]*ny+vel[2]*nz;
          if (vn2 < 0) { vel[0]-=nx*vn2; vel[1]-=ny*vn2; vel[2]-=nz*vn2; }
          if (ny > 0.55) { res.grounded = true; if (!res.groundNormal) { vset(res._gn,nx,ny,nz); res.groundNormal = res._gn; } }
          else if (ny < -0.55) res.ceiling = true;
          else if (!res.wallNormal) { vset(res._wn,nx,ny,nz); res.wallNormal = res._wn; }
          res.contactCount++;
          continue;
        }
        const dx = _SEGPT[0]-_BOXPT[0], dy = _SEGPT[1]-_BOXPT[1], dz = _SEGPT[2]-_BOXPT[2];
        let dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if (dist >= radius) continue;
        let nx, ny, nz;
        if (dist > 1e-6) { const il = 1/dist; nx = dx*il; ny = dy*il; nz = dz*il; }
        else { nx = 0; ny = 1; nz = 0; dist = 0; }   // degeneriert (Mittelpunkt in Box) → nach oben
        const depth = radius - dist;
        // herausschieben
        pos[0] += nx*depth; pos[1] += ny*depth; pos[2] += nz*depth;
        seg0[0] += nx*depth; seg0[1] += ny*depth; seg0[2] += nz*depth;
        seg1[0] += nx*depth; seg1[1] += ny*depth; seg1[2] += nz*depth;

        res.contactCount++;
        if (ny > 0.55) {
          if (!res.grounded || ny > res._gn[1]) { vset(res._gn, nx,ny,nz); res.groundNormal = res._gn; res.groundBody = box.dynamic ? box : null; }
          res.grounded = true;
        } else if (ny < -0.55) {
          res.ceiling = true;
        } else {
          if (!res.wallNormal || Math.abs(ny) < Math.abs(res._wn[1])) { vset(res._wn, nx,ny,nz); res.wallNormal = res._wn; res.wallBody = box.dynamic ? box : null; }
          // Step-Up-Kandidat: Oberkante der Box in Reichweite?
          const feetY = pos[1]-hh-radius;
          const topY = box.max[1];
          if (box.dynamic !== true || box.kinematic) {
            if (topY > feetY + 0.04 && topY - feetY <= stepHeight) {
              if (!stepCandidate || topY > stepCandidate) stepCandidate = topY;
            }
          }
        }
        // Velocity entlang der Normalen kappen (nur wenn wir hineinfliegen)
        const vn = vel[0]*nx + vel[1]*ny + vel[2]*nz;
        if (vn < 0) { vel[0] -= nx*vn; vel[1] -= ny*vn; vel[2] -= nz*vn; }
        pushed = true;
      }
      if (!pushed) break;
    }

    // Step-Up ausführen, falls möglich (sauberer Treppenstieg statt Kanten-Hängenbleiben)
    if (stepCandidate != null && !res.ceiling) {
      // Kapsel-Mittelpunkt so anheben, dass die Füße genau auf der Kante stehen.
      const testY = stepCandidate + 0.02 + hh;
      const saved = [pos[0], pos[1], pos[2]];
      pos[1] = testY;
      if (!this.capsulePenetrates(pos, radius, hh, 0.0)) {
        res.grounded = true;
        if (!res.groundNormal) res.groundNormal = [0,1,0];
        vel[1] = Math.max(vel[1], 0);
      } else {
        pos[0]=saved[0]; pos[1]=saved[1]; pos[2]=saved[2];
      }
    }
  }

  /** Reiner Überlappungstest (für Step-Up-Proben, Anchor-Validierung, Body-Physik). */
  capsulePenetrates(pos, radius, hh, pad = 0) {
    const seg0 = [pos[0], pos[1]-hh, pos[2]];
    const seg1 = [pos[0], pos[1]+hh, pos[2]];
    const r = radius + pad;
    const mn = [pos[0]-r, seg0[1]-r, pos[2]-r];
    const mx = [pos[0]+r, seg1[1]+r, pos[2]+r];
    const cand = this.queryAABB(mn, mx, _CAND_BUF2);
    for (let i = 0; i < cand.length; i++) {
      const box = cand[i];
      const c = segAABBClosest(seg0, seg1, box.min, box.max, _SEGPT2, _BOXPT2);
      if (!c) continue;
      const dx=_SEGPT2[0]-_BOXPT2[0], dy=_SEGPT2[1]-_BOXPT2[1], dz=_SEGPT2[2]-_BOXPT2[2];
      if (dx*dx+dy*dy+dz*dz < r*r) return true;
    }
    return false;
  }

  /* ------------------------ Dynamische Körper bewegen --------------------- */
  stepBodies(dt) {
    for (const b of this.bodies) {
      vcopy(b.prevPos, b.pos);
      if (b.kinematic) {
        this._stepKinematic(b, dt);
      } else {
        // Seilkraft (von Rope gesetzt) + Gravitation
        if (b.hasRopeForce) {
          b.vel[0] += b.ropeForce[0]*b.invMass*dt;
          b.vel[1] += b.ropeForce[1]*b.invMass*dt;
          b.vel[2] += b.ropeForce[2]*b.invMass*dt;
        }
        b.vel[1] += this.gravity*dt;
        // lineare Dämpfung (Luft)
        const dl = Math.exp(-b._dragLin*dt);
        b.vel[0]*=dl; b.vel[2]*=dl;
        // integrieren + Kollision gegen statische Welt (einfach, aber stabil)
        b.pos[0]+=b.vel[0]*dt; b.pos[1]+=b.vel[1]*dt; b.pos[2]+=b.vel[2]*dt;
        this._collideBody(b);
      }
      bodyUpdateAABB(b);
      b.hasRopeForce = false;
      b.ropeForce[0]=b.ropeForce[1]=b.ropeForce[2]=0;
    }
  }

  _stepKinematic(b, dt) {
    if (!b.path || b.path.length < 2) return;
    b.pathT += b.pathDir * b.pathSpeed * dt;
    const segs = b.path.length - 1;
    const total = segs;
    if (b.pathLoop) {
      // hin und her (Ping-Pong) fühlt sich für Plattformen am lesbarsten an
      const cycle = total*2;
      let t = ((b.pathT % cycle) + cycle) % cycle;
      if (t > total) { t = cycle - t; b.pathDir = -1; } else b.pathDir = 1;
      const i = clamp(Math.floor(t), 0, segs-1);
      const f = t - i;
      const A = b.path[i], B = b.path[i+1];
      const nx = lerp(A[0],B[0],f), ny = lerp(A[1],B[1],f), nz = lerp(A[2],B[2],f);
      b.vel[0]=(nx-b.pos[0])/dt; b.vel[1]=(ny-b.pos[1])/dt; b.vel[2]=(nz-b.pos[2])/dt;
      vset(b.pos, nx, ny, nz);
    }
  }

  _collideBody(b) {
    // Boden/Wand: statische Boxen gegen Body-AABB, minimal-invasiv
    const cand = this.queryAABB(b.min, b.max, _CAND_BUF3);
    b.grounded = false;
    for (let i = 0; i < cand.length; i++) {
      const s = cand[i];
      if (s.dynamic) continue;
      // Overlap pro Achse
      const ox = Math.min(b.max[0]-s.min[0], s.max[0]-b.min[0]);
      const oy = Math.min(b.max[1]-s.min[1], s.max[1]-b.min[1]);
      const oz = Math.min(b.max[2]-s.min[2], s.max[2]-b.min[2]);
      if (ox <= 0 || oy <= 0 || oz <= 0) continue;
      if (oy <= ox && oy <= oz) {
        const dir = (b.pos[1] > (s.min[1]+s.max[1])*0.5) ? 1 : -1;
        b.pos[1] += oy*dir;
        if (dir > 0) { b.grounded = true; b.vel[1] = Math.max(0, b.vel[1]); }
        else b.vel[1] = Math.min(0, b.vel[1]);
        // Reibung
        const fr = 1 - clamp(b.friction * 0.9, 0, 1);
        b.vel[0]*=fr; b.vel[2]*=fr;
      } else if (ox <= oz) {
        const dir = (b.pos[0] > (s.min[0]+s.max[0])*0.5) ? 1 : -1;
        b.pos[0] += ox*dir; b.vel[0] = 0;
      } else {
        const dir = (b.pos[2] > (s.min[2]+s.max[2])*0.5) ? 1 : -1;
        b.pos[2] += oz*dir; b.vel[2] = 0;
      }
      bodyUpdateAABB(b);
    }
  }
}

const _CAND_BUF = [], _CAND_BUF2 = [], _CAND_BUF3 = [], _SC = { startInside:false };

/**
 * Wie rayAABB, meldet aber zusätzlich, ob der Strahl INNERHALB der Box startet.
 * Gibt true zurück, wenn die Strecke die Box schneidet (oder in ihr beginnt).
 */
function rayAABBFlags(o, d, mnx, mny, mnz, mxx, mxy, mxz, maxT, minT, flags) {
  return rayAABBFlagsInv(o, 1/d[0], 1/d[1], 1/d[2], mnx, mny, mnz, mxx, mxy, mxz, maxT, minT, flags);
}
function rayAABBFlagsInv(o, ix, iy, iz, mnx, mny, mnz, mxx, mxy, mxz, maxT, minT, flags) {
  let tmin = -Infinity, tmax = maxT;
  let inv = ix;
  let t1 = (mnx - o[0]) * inv, t2 = (mxx - o[0]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return false;
  inv = iy;
  t1 = (mny - o[1]) * inv; t2 = (mxy - o[1]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return false;
  inv = iz;
  t1 = (mnz - o[2]) * inv; t2 = (mxz - o[2]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return false;
  if (flags) {
    flags.startInside = (tmin < minT && tmax > minT);
    flags.tEntry = Math.max(minT, tmin);
    flags.tExit  = tmax;
  }
  // regulärer Eintritt ODER Start im Inneren ⇒ blockiert
  return (tmin >= minT && tmin < maxT) || (tmin < minT && tmax > minT);
}
const _SEGPT = [0,0,0], _BOXPT = [0,0,0], _SEGPT2 = [0,0,0], _BOXPT2 = [0,0,0];

/* ------------------------------ Ray vs. AABB ------------------------------ */
/**
 * Slab-Methode mit VORAB invertierter Richtung.
 * `rayAABB(o, d, …)` würde pro Box drei Divisionen ausführen — bei ~1500
 * Slab-Tests pro Topologie-Update sind das ~4500 Divisionen. Die Inversion
 * gehört einmal pro Strahl berechnet, nicht einmal pro Box.
 */
function rayAABB(o, d, mnx, mny, mnz, mxx, mxy, mxz, maxT) {
  return rayAABBInv(o, 1/d[0], 1/d[1], 1/d[2], mnx, mny, mnz, mxx, mxy, mxz, maxT);
}
function rayAABBInv(o, ix, iy, iz, mnx, mny, mnz, mxx, mxy, mxz, maxT) {
  let tmin = 0, tmax = maxT;
  let inv = ix;
  let t1 = (mnx - o[0]) * inv, t2 = (mxx - o[0]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  inv = iy;
  t1 = (mny - o[1]) * inv; t2 = (mxy - o[1]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  inv = iz;
  t1 = (mnz - o[2]) * inv; t2 = (mxz - o[2]) * inv;
  if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;
  return tmin;
}

/** Kontaktnormale aus dem Eintritts-t (welche Slab-Achse). Allokationsfrei. */
function aabbNormalAt(o, d, t, box, out) {
  const eps = 1e-4;
  const px = o[0]+d[0]*t, py = o[1]+d[1]*t, pz = o[2]+d[2]*t;
  out = out || v3();
  if (Math.abs(px-box.min[0]) < eps) return vset(out,-1,0,0);
  if (Math.abs(px-box.max[0]) < eps) return vset(out, 1,0,0);
  if (Math.abs(py-box.min[1]) < eps) return vset(out,0,-1,0);
  if (Math.abs(py-box.max[1]) < eps) return vset(out,0, 1,0);
  if (Math.abs(pz-box.min[2]) < eps) return vset(out,0,0,-1);
  return vset(out,0,0,1);
}

/* ------------------- Nächster Punkt Segment <-> AABB --------------------- */
/**
 * Alternierende Projektion zwischen Segment und (konvexer) Box. Konvergiert in
 * wenigen Iterationen auf das echte Nächste-Punkte-Paar → korrekte Normalen
 * auch an Kanten/Ecken. Gibt false zurück, wenn das Segment die Box schneidet.
 */
function segAABBClosest(s0, s1, mn, mx, outSeg, outBox) {
  const dx = s1[0]-s0[0], dy = s1[1]-s0[1], dz = s1[2]-s0[2];
  const l2 = dx*dx+dy*dy+dz*dz;
  let t = 0.5;
  if (l2 < 1e-12) { t = 0; }
  let inside = false;
  for (let i = 0; i < 6; i++) {
    const px = s0[0]+dx*t, py = s0[1]+dy*t, pz = s0[2]+dz*t;
    // nächster Punkt auf AABB
    const qx = clamp(px, mn[0], mx[0]), qy = clamp(py, mn[1], mx[1]), qz = clamp(pz, mn[2], mx[2]);
    inside = (qx === px && qy === py && qz === pz);
    if (inside) break;
    // q zurück auf das Segment projizieren
    if (l2 < 1e-12) break;
    const nt = ((qx-s0[0])*dx + (qy-s0[1])*dy + (qz-s0[2])*dz) / l2;
    const tc = clamp(nt, 0, 1);
    if (Math.abs(tc - t) < 1e-6) { t = tc; break; }
    t = tc;
  }
  if (inside) return false;
  outSeg[0]=s0[0]+dx*t; outSeg[1]=s0[1]+dy*t; outSeg[2]=s0[2]+dz*t;
  outBox[0]=clamp(outSeg[0],mn[0],mx[0]); outBox[1]=clamp(outSeg[1],mn[1],mx[1]); outBox[2]=clamp(outSeg[2],mn[2],mx[2]);
  return true;
}

/** Die 12 Kanten einer AABB als [i0,i1]-Paare über die 8 Ecken. */
const CORNER_SIGNS = [
  [-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1],
  [-1, 1,-1],[1, 1,-1],[1, 1,1],[-1, 1,1],
];
const EDGE_PAIRS = [
  [0,1],[1,2],[2,3],[3,0],   // unten
  [4,5],[5,6],[6,7],[7,4],   // oben
  [0,4],[1,5],[2,6],[3,7],   // senkrecht
];
function boxCorners(box, out) {
  out.length = 0;
  const cx=(box.min[0]+box.max[0])*0.5, cy=(box.min[1]+box.max[1])*0.5, cz=(box.min[2]+box.max[2])*0.5;
  const hx=(box.max[0]-box.min[0])*0.5, hy=(box.max[1]-box.min[1])*0.5, hz=(box.max[2]-box.min[2])*0.5;
  for (let i=0;i<8;i++){
    const s = CORNER_SIGNS[i];
    out.push([cx+s[0]*hx, cy+s[1]*hy, cz+s[2]*hz]);
  }
  return out;
}

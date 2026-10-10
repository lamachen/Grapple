/* =============================================================================
   06_level.js — Referenz-Level: jede Zone testet genau eine Seil-Eigenschaft
   -----------------------------------------------------------------------------
   Alles ist architekturtypisch achsenausrichtet (Boxen), damit Raycasts,
   Kanten-Wrapping und Sweep-Kollision exakt und billig bleiben.
   ========================================================================== */
'use strict';

/* --------------------------------- Level ---------------------------------- */
const C = {
  white:[0.905,0.905,0.925], light:[0.80,0.81,0.845], mid:[0.60,0.615,0.66],
  dark:[0.26,0.27,0.31], red:[0.88,0.17,0.15], orange:[0.96,0.53,0.10],
  yellow:[0.98,0.83,0.16], blue:[0.33,0.55,0.75], green:[0.28,0.62,0.44],
  crate:[0.74,0.56,0.33], metal:[0.56,0.58,0.63], black:[0.10,0.10,0.12],
};

function B(w, c, s, col, opts) { return w.addBoxCS(c, s, Object.assign({ color: col }, opts || {})); }
/**
 * Dünne Akzent-/Markierungsleiste (Mirror's-Edge-Kantenmarkierung).
 * `ropeSolid:false` ⇒ für den Spieler und den Haken solid, aber das SEIL legt
 * sich nicht daran fest. Das ist gängige Collision-Layer-Praxis und verhindert,
 * dass wenige Zentimeter dünne Zierkanten das Wrapping in degenerierte Fälle
 * treiben (Kontakt hätte dort keinen Platz mehr).
 */
function TRIM(w, c, sz, col) { return w.addBoxCS(c, sz, { color: col, ropeSolid:false, hookable:false }); }

/** Achsenparallele Treppe aus `n` Stufen. */
function stairs(w, x, y0, z0, stepH, stepD, n, width, col, dir = -1) {
  for (let i = 0; i < n; i++) {
    const h = stepH * (i+1);
    B(w, [x, y0 + h*0.5, z0 + dir*i*stepD], [width, h, stepD], col);
  }
  return y0 + stepH*n;
}

function buildLevel(w) {
  const spots = [];
  // Boden
  B(w, [0,-3,  -60], [340, 6, 400], C.light);
  // Plaza-Akzente
  B(w, [4, 0.6, 6], [3.2, 1.2, 3.2], C.white);
  TRIM(w, [4, 1.25, 6], [3.3, 0.1, 0.5], C.red);
  B(w, [-5, 0.9, 2], [3.6, 1.8, 3.6], C.white);
  TRIM(w, [-5, 1.85, 2], [3.7, 0.1, 0.5], C.red);
  B(w, [9, 0.35, 1], [4, 0.7, 2.6], C.mid);
  B(w, [9, 1.05,-2], [4, 2.1, 2.6], C.mid);
  B(w, [9, 1.90,-5], [4, 3.8, 2.6], C.mid);

  /* --- 1) Treppenturm (West) → Zugang zur Dachroute --- */
  stairs(w, -17, 0, 8, 1.0, 2.2, 10, 6, C.white, -1);
  B(w, [-17, 9.5, -15], [9, 1, 8], C.light);           // Plattform y=10
  TRIM(w, [-17, 10.05,-12.6], [9.1, 0.12, 0.6], C.red);
  spots.push({ name:'Treppenturm', p:[-17, 11.0, -14], yaw: 0 });

  /* --- 2) Dachroute mit Schlucht + Anker-Pylon --- */
  B(w, [0, 8.0, -19], [19, 4, 13], C.white);           // Dach 1, Oberkante y=10, Kante z=-25.5
  TRIM(w, [0, 10.05,-13.0], [19.1, 0.12, 0.7], C.red);
  B(w, [0, 8.0, -42], [17, 4, 15], C.white);           // Dach 2
  TRIM(w, [0, 10.05,-35.0], [17.1, 0.12, 0.7], C.red);
  /* Portal über der Schlucht: zwei Stützen auf Dach 2 + Riegel auf y≈18.
     Das ist der tragfähige Schwung-Anker — weit genug weg und hoch genug,
     dass ein Pendel mit ~12 m Radius über die 9 m breite Schlucht trägt.     */
  B(w, [-5.2, 14.0, -35.4], [1.0, 8, 1.0], C.mid);
  B(w, [ 5.2, 14.0, -35.4], [1.0, 8, 1.0], C.mid);
  B(w, [0, 18.4, -35.4], [11.6, 0.9, 1.1], C.orange);
  TRIM(w, [0, 18.95, -35.4], [11.8, 0.14, 1.3], C.yellow);
  // versetzter Mast westlich der Schlucht als alternativer Anker + Umlenkhindernis
  B(w, [-9.5, 13.0, -30], [1.2, 26, 1.2], C.dark);
  TRIM(w, [-9.5, 26.2, -30], [2.0, 0.4, 2.0], C.yellow);
  spots.push({ name:'Dachroute', p:[0, 11.0, -18], yaw: 0 });
  spots.push({ name:'Schlucht (Schwung)', p:[0, 11.0, -24.4], yaw: 0, pitch: 36 });

  /* --- 3) WRAP-WAND: Anker hinter einer Wand, Seil legt sich über die Kante --- */
  B(w, [15, 3.5, -42], [1.5, 7, 24], C.mid);           // Wand, Oberkante y=7 — überwerfbar,
  //                                                      aber bei seitlichem Weglaufen im Weg
  B(w, [8.0, 6.5, -42], [5.5, 13, 5.5], C.blue);       // Ankerblock hinter der Wand (OK y=13)
  TRIM(w, [8.0, 13.1, -42], [5.7, 0.15, 5.7], C.yellow);
  B(w, [22, 0.5, -42], [10, 1, 22], C.light);          // Podest auf der Ostseite
  TRIM(w, [22, 1.05,-36.4], [10.1, 0.12, 0.6], C.red);
  spots.push({ name:'Wrap-Wand', p:[22, 2.0, -42], yaw: Math.PI*0.5, pitch: 39 });
  spots.push({ name:'Wrap-Wand (seitlich)', p:[22, 2.0, -50], yaw: Math.PI*0.42, pitch: 34 });

  /* --- 4) SÄULE: vertikaler Gleitkontakt --- */
  // Ankerblock (sichtbar, hookbar) und eine Säule ETWAS ÖSTLICH der direkten
  // Sichtlinie. Von hier aus ist die Sicht frei — geht man ein paar Meter nach
  // Osten, schiebt sich die Säule dazwischen und das Seil legt sich um ihre
  // vertikale Kante. Bewegt man sich dann nord/süd, GLEITET der Kontakt an der
  // Kante hoch und runter (geschlossene Lösung, kein Suchen).
  B(w, [33, 3.0, -30], [5, 6, 5], C.green);            // Ankerblock, Oberkante y=6
  TRIM(w, [33, 6.15, -30], [5.2, 0.15, 5.2], C.yellow);
  B(w, [34, 5.0, -24], [2.6, 10, 2.6], C.dark);        // Säule, y 0..10
  TRIM(w, [34, 10.2, -24], [3.1, 0.4, 3.1], C.yellow);
  B(w, [30, 0.6, -17], [10, 1.2, 8], C.light);         // Podest mit freier Sicht
  TRIM(w, [30, 1.25, -13.4], [10.1, 0.12, 0.6], C.red);
  spots.push({ name:'Säulen-Wrap', p:[31, 2.0, -18], yaw: -0.207, pitch: 22 });

  /* --- 5) Bewegliche Objekte --- */
  B(w, [-4, 8.0, -60], [22, 4, 12], C.white);          // Plattform-Dach
  B(w, [-30, 5.0, -60], [10, 10, 14], C.mid);          // Turm daneben
  // kinematische Hebebühne (fährt hin und her)
  const lift = w.addBody({ pos:[-16, 3.0, -60], half:[3.4,0.35,3.4], kinematic:true,
    path:[[-16,3.0,-60],[-16,12.0,-60]], pathSpeed:2.4, color:C.orange, mass:1e6 });
  // kinematisches Pendel (großer Block, den das Seil umfahren/umlegen muss)
  const pend = [];
  for (let i = 0; i <= 16; i++) {
    const a = -1.05 + (2.1*i/16);
    pend.push([-30 + Math.sin(a)*13, 15 - Math.cos(a)*13 + 6, -76]);
  }
  const wreck = w.addBody({ pos:pend[0], half:[1.7,1.7,1.7], kinematic:true,
    path:pend, pathSpeed:5.4, color:C.red, mass:1e6 });
  // freie Kisten (dynamisch, hookable) — das Seil kann sie ziehen
  const crates = [];
  for (let i = 0; i < 4; i++) {
    crates.push(w.addBody({ pos:[-4 + i*2.1, 10.9, -58 - (i%2)*2.4], half:[0.78,0.78,0.78],
      mass:180, color:C.crate, friction:0.6 }));
  }
  // schwerer Container (lässt sich nur langsam ziehen)
  const cont = w.addBody({ pos:[6, 11.1, -63], half:[2.4,1.1,1.3], mass:2200, color:C.metal, friction:0.75 });
  spots.push({ name:'Bewegliche Objekte', p:[-4, 11.0, -55], yaw: Math.PI });

  /* --- 6) Wallrun-Wand + Hochhaus für weite Schwünge --- */
  B(w, [-13, 5.0, -52], [1.3, 10, 28], C.blue);
  TRIM(w, [-13, 10.15,-52], [1.5, 0.3, 28.2], C.yellow);
  B(w, [0, 21, -86], [7, 42, 7], C.dark);              // Hochhaus y 0..42
  TRIM(w, [0, 42.3, -86], [9, 0.6, 9], C.yellow);
  for (let i = 0; i < 5; i++) TRIM(w, [0, 6+i*7.4, -82.4], [7.4, 0.5, 0.6], C.red);
  spots.push({ name:'Hochhaus-Schwung', p:[0, 1.0, -66], yaw: Math.PI });
  spots.push({ name:'Wallrun', p:[-9, 1.0, -42], yaw: -Math.PI*0.5 });

  /* --- 7) Boden-Schlucht (tief) für lange Schwünge --- */
  B(w, [56, 1.5, -40], [26, 3, 26], C.light);
  B(w, [56, 12, -40], [3, 24, 3], C.orange);           // Mast
  spots.push({ name:'Weiter Schwung', p:[56, 3.6, -28], yaw: Math.PI });

  spots.push({ name:'Start', p:[0, 1.2, 12], yaw: 0 });
  return { spots, lift, wreck, crates, cont };
}


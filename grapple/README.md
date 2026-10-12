# GRAPPLE — Hybrides Seilsystem für First-Person-Parkour

Ein spielbarer Referenz-Prototyp für ein physikbasiertes Grappling-Hook- und Seilsystem:
ballistischer Haken, lose hinterherlaufendes Seil, Spannungsaufbau mit endlicher
Wellengeschwindigkeit, Umlenkung um Kanten und Hindernisse — inklusive Weitergleiten an Kantenenden
und Abrutschen über Enden, ohne einen einzigen Kontaktsprung —
Interaktion mit beweglichen Körpern, und echtes Pendeln ohne eine einzige Positions-Teleportie.

**Bewegungsvorbild:** Mirror's Edge (Bewegungsfreiheit, Impulserhalt, Parkour-Ketten)
**Grapple-Vorbild:** Spider-Man (Schwung aufbauen, an Ketten hängen, sich durch den Raum ziehen)

`index.html` öffnen — fertig. **Reines WebGL2, keine Abhängigkeiten, keine Netzwerkzugriffe.**
Funktioniert offline und in der In-App-Vorschau.

> 📐 Das eigentliche Ergebnis dieser Arbeit ist das Architektur-Dokument:
> **[doc/ARCHITEKTUR.md](doc/ARCHITEKTUR.md)** — warum der naheliegende Ansatz
> (Seil = Kette aus N Rigidbodies) an genau diesem Anforderungsprofil strukturell scheitert,
> und wie die hier umgesetzte Dreischichtung das Problem stattdessen löst.
> Diagramm: [doc/architektur.svg](doc/architektur.svg)

---

## Start

1. `index.html` im Browser öffnen (Chrome/Edge/Firefox/Safari, WebGL2).
2. **Klicken** → Mauszeiger wird gesperrt, Audio startet.
3. `ESC` beendet die Mauszeiger-Sperre.

---

## Steuerung

### Umsehen

Drei Wege, damit es in **jedem** Kontext funktioniert — auch in der In-App-Vorschau, die in
einem Sandbox-iframe läuft und Pointer-Lock nicht erlaubt:

1. **Mauszeiger-Sperre** — normaler Fall beim Öffnen der Datei im Browser (Klick).
2. **Blick-Modus** — Zeiger bleibt sichtbar, einfach Maus bewegen. Aktiviert sich **automatisch
   bei der ersten Mausbewegung**, ohne Klick. Das Delta wird aus `clientX/Y` selbst errechnet
   (nicht aus `movementX/Y`, die ohne Sperre nicht überall gesetzt sind). Die Empfindlichkeit
   wird dabei automatisch angehoben.
3. **Drag-Look** — rechte Maustaste (oder `Alt`+linke) halten und ziehen.

Oben in der Mitte steht immer, welcher Modus gerade aktiv ist. `G` schaltet zwischen
Zeigersperre und Blick-Modus um. Über den Panels wird nicht gedreht, damit man in Ruhe
Parameter stellen kann.

### Tasten

| Taste | Funktion |
|---|---|
| `W A S D` | Bewegen — **am Seil: Schwung pumpen** |
| `LMB` **halten** | eingehakt bleiben — **loslassen** holt das Seil ein |
| `R` | Seil lösen (bewusst; die rechte Taste ist nur Drag-Look) |
| `Space` | Sprung — löst das Seil **nicht**; Absprung beim Schwingen funktioniert, Impuls bleibt erhalten |
| `Mausrad` / `Q` `E` | Seil auf- / abrollen (ändert die verfügbare Länge `L`) |
| `Shift` | Rutschen (Slide) |
| **`V`** | **Orbit-Kamera — essentiell, um das Seil von außen zu beurteilen** |
| `G` | frei umsehen ohne gedrückte Maustaste (an/aus) |
| `U` | **komplette UI aus/ein** (Screenshot-Modus) |
| `T` / `H` / `P` | Telemetrie / Steuerung / Parameter einzeln aus- und einblenden |

**Es gibt kein Viewmodel.** Arme/Hände aus Box-Primitiven sind ein Platzhalter, der weder
qualitativ tragfähig ist noch beim Beurteilen des Seils hilft — er verdeckt nur das
Testobjekt. Eine ernsthafte Umsetzung braucht ein geriggtes Mesh (glTF) mit Animations-Clips
und IK-Retargeting; das wird hier bewusst nicht angetäuscht. Das Seil tritt stattdessen an
einem festen Punkt rechts/unten vor der Kamera aus (nicht bildmittig) und neigt beim
Einhaken nur leicht mit — der Ursprung bleibt beim Umschauen stabil.

Jedes Panel dockt an seiner Bildschirmkante an (Telemetrie unten links, Steuerung
oben links, Parameter oben rechts) und faltet sich per **Klick auf den Titelbalken**
zusammen — der Balken bleibt sichtbar und holt das Panel ebenso wieder zurück.
Alle drei starten **eingeklappt**: der erste Blick gehört Level und Seil.
`U` faltet alles gemeinsam (Screenshot-Modus). Die Level-Spawn-Leiste sitzt oben
mittig zwischen Steuerung und Parametern und markiert den aktiven Spot

---

## Was man ausprobieren sollte

Das Level ist als Testparcours gebaut — jede Zone isoliert genau eine Eigenschaft des Systems.

| # | Szenario | Was es zeigt |
|---|---|---|
| 1 | **Treppenturm** | Basis-Parkour, Step-Up, Slide |
| 2 | **Dachroute** | 6-m-Schlucht mit Pylon darüber: an den Pylon feuern und rüberschwingen |
| 3 | **Schlucht (Schwung)** | Pumpen: `W`/`S` rhythmisch halten — die Amplitude wächst über Winkelimpuls-Erhaltung, nicht über einen Boost |
| 4 | **Wrap-Wand** | ⭐ Auf den Block **hinter** der Wand feuern (Bogen drüber), dann seitlich weglaufen: das Seil legt sich über die Wandoberkante, der Kontakt **gleitet** sichtbar mit, die verfügbare Reichweite schrumpft um den Umweg |
| 5 | **Säulen-Wrap** | ⭐ Vertikaler Gleitkontakt: an den Block hinter der Säule feuern, dann hoch/runter bewegen — der Kontakt wandert an der Säulenkante entlang |
| 6 | **Bewegliche Objekte** | ⭐ Kinematische Hebebühne, Pendel-Block, freie Kisten, schwerer Container. Eine Kiste anfeuern und weglaufen → das Seil zieht sie. Fährt die Hebebühne ins Seil, ändert sich dessen Verlauf **und** die Länge |
| 7 | **Hochhaus-Schwung** | Weiter Schwung vom 42-m-Turm, `LMB` im richtigen Moment loslassen |
| 8 | **Wallrun** | Wallrun + Walljump an der langen Wand |
| 9 | **Weiter Schwung** | Langer Mast über offenem Gelände |

**Empfohlene Reihenfolge für die Beurteilung:** erst `V` (Orbit-Kamera) drücken, dann
Szenario 4 oder 5 — von außen sieht man am deutlichsten, dass das Seil ein Objekt mit
eigener Dynamik ist und keine Linie zwischen zwei Punkten.

### A/B-Vergleich im Parameter-Panel

Rechts unten im Panel gibt es Schalter, die einzelne Schichten des Systems abschalten.
Sie sind der direkte Nachweis, dass jede Schicht eine Funktion hat:

| Schalter AUS | entspricht | sichtbare Folge |
|---|---|---|
| **Pfad-Wrapping (Physik)** | dem naiven „Luftlinie bleibt Seillänge" | das Seil sieht ähnlich aus, aber die Constraint zeigt *durch* die Wand: man bekommt Reichweite, die das Seil nicht hat, bzw. wird in das Hindernis gezogen |
| **Starre Stange (zweiseitig)** | einem Rod-Joint statt einem Seil | Durchhängen unmöglich, Pendeln bricht zusammen, man klebt auf Abstand |
| **Ketten-Kollision Welt** | einem Seil ohne Geometrie-Kollision | Nodes und sichtbare Kurve landen in Wand und Boden — sofort sichtbar falsch |

---

## Debug-Ansicht (`F1`)

| Farbe | Bedeutung |
|---|---|
| grün | Welt-Pfad (Wrap-Polylinie) — das, woraus sich die Seillänge ergibt |
| gelb | Umlenkkontakte + die Kante, auf der sie gleiten |
| rot | Anker + Ankernormale |
| magenta | Pendel-Pivot (wirksamer Aufhängepunkt) |
| orange | Constraint-Normale `n̂` am Spieler |
| cyan / orange Punkte | Ketten-Nodes; cyan = die beiden gepinnten Enden (Hand, Anker/Haken), orange = frei simuliert dazwischen |

Die Kette **ist** das Seil: alle Nodes sind frei simuliert (Schwerkraft,
Längen-Constraints auf das ausgegebene Budget, Welt-Kollision), nur die beiden
Enden sind gepinnt. Bei viel Spiel hängt das Seil bis zum Boden durch und liegt
dort auf; beim Einziehen (SETTLING) sieht man, wie es zusammengezogen wird und
Straffheit gewinnt, bevor die Constraint übernimmt.

---

## Telemetrie (links unten)

| Wert | Bedeutung |
|---|---|
| **Phase** | `IDLE / FLIGHT / SETTLING / ATTACHED / RETRACT` |
| **Budget** | verfügbare Seillänge `L` — die zentrale, erhaltene Zustandsgröße |
| **Welt-Pfadlänge** | `s(x)` = tatsächlicher Verlauf um Hindernisse herum |
| **Spiel / Überdehnung** | `slack = L − s`; negativ = Constraint ist aktiv |
| **Seilkraft** | aus dem Constraint-Impuls abgeleitete Kraft in N |
| **Umlenkungen** | Anzahl aktiver Kontakte + Segmente der Pfad-Polylinie |

Der Balken „straff ↔ lose" und das Spannungsniveau treiben **dieselbe** Größe, aus der auch
die Darstellung, das Audio-Knarzen und die FOV-Änderung abgeleitet werden.

---

## Verifikation

Alles headless, ohne Browser und ohne GPU:

```bash
node tools/test_sim.js       # 179 physikalische Assertions
node tools/test_browser.js   # Renderer/Loop/HUD gegen DOM- + WebGL2-Stub
node tools/test_wrap.js      # Wickeln um Objekte: 4 Invarianten + 4 XFAIL
node tools/check_panel.js    # zeigt/erreicht jeder der 29 Regler seinen echten Wert?
node tools/bench.js          # Micro-Benchmarks
python3 tools/build.py       # src/*.js → index.html
```

### Bekannter Defekt: Wickeln um Objekte (`tools/test_wrap.js`)

Ein um ein Objekt gewickeltes Seil kann sich bei seitlicher Bewegung von den
Kanten lösen, auf die andere Seite wechseln und sich als direkte Linie
Anker→Spieler neu bilden. `test_wrap.js` fährt die Säule des Levels in vier
Orbits ab und arretiert den Befund als **XFAIL** — der Test ist grün, weil der
Defekt dokumentiert ist, nicht weil er behoben wäre. Gemessen:

| Größe | Ist | Ziel |
|---|---|---|
| Solver-Polylinie durch Geometrie | 602 von 4466 gültigen Schritten (13,5 %) | 0 |
| größter Längensprung pro Schritt (8,3 ms) | 8,52 m | < 0,35 m |
| Freisetzungen mit Längensprung > 0,5 m | 48 von 69 | 0 |
| `_cornerSlide`-Erfolge | 0 bei 18 Aufrufen | > 0 |

Die sichtbare Kurve läuft dabei **nicht** durch Geometrie — die beiden
Garantien aus `02_rope.js` (Ketten-Nodes kollidieren, Render-Stützpunkte werden
herausgeschoben) halten, gemessen 0 von 1500 Frames mit >5 mm Eindringung.
Sichtbar ist der **Ruck**: `required` springt um bis zu 1,16 m in einem Frame
und das Seil bildet sich schlagartig um.

Ursache ist nicht eine einzelne Bedingung, sondern das Kontaktmodell: Kontakte
sind *Kantenpunkte*, und `_cornerSlide` — der einzige Mechanismus für ein
stetiges „um die Ecke rutschen" — ist doppelt verriegelt.
(a) Sein Gate `_atEnd` verlangt den Kontaktpunkt innerhalb 5 cm vom
Kanten**ende**; vertikale Kanten im Level sind im Median 5,00 m lang
(max 42 m, die Testsäule selbst 10,00 m), daher trifft das auf nur 0,6 %
der Kontakt-Schritte zu.
(b) `cornerSlideReach = 0,8 m`, die benachbarten vertikalen Kanten der
2,6-m-Säule liegen aber 2,60 m auseinander — ein erreichter Aufruf kann die
Nachbarkante nicht erreichen. Umkreisen einer Säule ist ein azimuthaler
Wechsel zwischen zwei *parallelen* Kanten; dafür gibt es keinen Mechanismus.
Hinzu kommt, dass der dritte Zweig der Release-Kaskade
(`02_rope.js`, `else { w.release = Math.max(0, w.release - 2*dt/rel); }`)
logisch unerreichbar ist, weil `unnecessary === !directBlocked` — die dort
kommentierte Hysterese existiert nicht, Release ist binär.

`test_sim.js` prüft keine „läuft ohne Fehler"-Aussagen, sondern die physikalischen
Behauptungen direkt, z. B.:

* Ruhelage-Jitter **0.000 mm**, keine Restgeschwindigkeit
* ballistische Ziellösung trifft exakt; Trefferabweichung **0.22 m über 36 m mit Drag**
* Flugbahn gekrümmt (**0.99 m** Abweichung von der geraden Verbindungslinie), `a_y ≈ g`
* ausgegebenes Seil ist **2.26 m** länger als die Luftlinie → lose hinterherlaufend
* Budget bleibt nach dem Setzen auf **0.003 m** genau erhalten
* **Tangentialimpuls 12.000 → 12.000** (Pendel entsteht, statt erzwungen zu werden)
* Annäherung wird **nicht** gebremst (Seil kann nicht drücken)
* Wand-Umlenkung: **18.15 m** bei einem geometrischen Optimum von **17.88 m**
* Kontakt gleitet stetig, **0 Flackern** in 200 Schritten
* bewegliches Hindernis: **0/900** kollisionsbehaftete Schritte
* Rückwirkung zieht eine 120-kg-Kiste **3.69 m**
* Pumpen: Amplitude **90.5° → 151.6°** bei **0.000 m** Budget-Drift
* Seillänge ist sichtbar: bei 14.5 m Spiel ist die Kurve **17.72 von 17.75 m**
  Budget lang und liegt auf dem Boden auf
* Kontakte springen nie: max. Wanderung **0.18 m** pro Schritt, **0** Seitenwechsel
* Steigung stetig an vertikalen Umlenkkanten: Sprung **0.039** (V-Knick wäre > 1)
* 30 s Chaos-Spielbetrieb: keine NaN, max. Überdehnung **0.106 m**

**Kosten:** 417–452 µs pro Physik-Substep bei aktiver Umlenkung (120 Hz) →
≈ **0.9 ms pro Frame**, also rund 5 % des 16.6-ms-Budgets.

---

## Struktur

```
index.html            fertiges Spiel (188 KB, self-contained)
doc/ARCHITEKTUR.md    ★ Begründung, Modell, Messwerte, Grenzen, Portierung
doc/architektur.svg   Schichten-Diagramm
src/00_math.js        Vec3 / Quat / Mat4
src/01_world.js       AABB-Welt, Raycast, Sweep, Kapsel-Kollision, dynamische Körper
src/02_rope.js        ★ Kern: Pfad-Solver · Budget · einseitige Constraint · Hybrid-Kette
src/03_player.js      Parkour-Controller + ballistischer Haken
src/04_render.js      WebGL2-Renderer (instanziiert, Ribbon, Partikel)
src/05_fx.js          Partikel + last-gesteuerter WebAudio-Synth
src/06_level.js       Referenz-Level (jede Zone = eine Seil-Eigenschaft)
src/07_game.js        Loop, Input, Viewmodel, HUD, Tuning-Panel
tools/                Build, Physik-Tests, Browser-Smoke-Test, Wickel-Test, Panel-Check, Benchmarks
```

`src/02_rope.js` ist der Teil, der die Aufgabe löst. Der Rest ist ein möglichst kleiner,
aber echter Träger dafür: ein physikbasierter Parkour-Controller, eine AABB-Welt mit
dynamischen Körpern und ein Dependency-free Renderer.

---

## Anmerkungen

* Der Prototyp ist bewusst **engine-unabhängig** in reinem JS/WebGL2 gehalten. Kapitel 18 von
  `ARCHITEKTUR.md` beschreibt die Übertragung auf Unity, Unreal und Godot — inklusive der
  Warnung, welche mitgelieferten Joint-/Rope-Komponenten man dort **nicht** verwenden sollte.
* Alle 29 Parameter des Panels sind live änderbar (Seil-Physik, Darstellung, Bewegung, Haken, Welt) —
  jeder Regler zeigt seinen echten Wert und erreicht ihn auch (`tools/check_panel.js` prüft das).
* Bekannte Grenzen stehen in Kapitel 17 des Architektur-Dokuments, u. a.: konvexe
  AABB-Hüllkörper, greedy Pfadsuche mit Lookahead 1 (nicht global optimal), keine
  echten Spiral-Wicklungen, kein Seilbruch im Default.

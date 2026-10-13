# GRAPPLE — Hybrides Seilsystem für First-Person-Parkour

Ein spielbarer Referenz-Prototyp für ein physikbasiertes Grappling-Hook- und Seilsystem:
ballistischer Haken, lose hinterherlaufendes Seil, Spannungsaufbau mit endlicher
Wellengeschwindigkeit, Umlenkung um Kanten und Hindernisse — inklusive Weitergleiten an Kantenenden
und Abrutschen über Enden, ohne einen einzigen Kontaktsprung —
Interaktion mit beweglichen Körpern, und echtes Pendeln ohne eine einzige Positions-Teleportie.

**Bewegungsvorbild:** Mirror's Edge (Bewegungsfreiheit, Impulserhalt, Parkour-Ketten)
**Grapple-Vorbild:** Spider-Man (Schwung aufbauen, an Ketten hängen, sich durch den Raum ziehen)

**Einmal bauen, dann `index.html` öffnen** — fertig:

```bash
python3 tools/build.py     # src/*.js + tools/template.html → index.html (nur Python-Stdlib)
```

`index.html` ist ein gebautes Artefakt und liegt deshalb **nicht** im Repo
(`grapple/.gitignore`); auf GitHub Pages wird es beim Push auf `main` von
`.github/workflows/pages.yml` gebaut. **Reines WebGL2, keine Abhängigkeiten,
keine Netzwerkzugriffe.** Funktioniert offline und in der In-App-Vorschau.

> 📐 Das eigentliche Ergebnis dieser Arbeit ist das Architektur-Dokument:
> **[doc/ARCHITEKTUR.md](doc/ARCHITEKTUR.md)** — warum der naheliegende Ansatz
> (Seil = Kette aus N Rigidbodies) an genau diesem Anforderungsprofil strukturell scheitert,
> und wie die hier umgesetzte Dreischichtung das Problem stattdessen löst.
> Diagramm: [doc/architektur.svg](doc/architektur.svg)

---

## Start

1. `python3 tools/build.py` (einmal, oder nach jeder `src/`-Änderung).
2. `index.html` im Browser öffnen (Chrome/Edge/Firefox/Safari, WebGL2).
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
node tools/test_replay.js    # Replay-Determinismus + Fixture-Fingerabdruck
node tools/test_edgecross.js # Kanten-Überstreichungs-Test des Pivot-Solvers (31 Assertions)
python3 tools/build.py       # src/*.js → index.html (Artefakt, nicht versioniert)

### Deterministisches Replay (F9)

Jeder Seil-Fehler, der sich im Spiel zeigt, lässt sich als Aufnahme sichern:
**F9** startet/stoppt die Aufnahme (Status-Snapshot + ein Input-Record pro
Frame). Der Export landet als `grapple_rec_*.json` im Download-Ordner und
lässt sich headless frame-genau abspielen:

```bash
node tools/replay.js aufnahme.json --runs=2     # Bericht + Determinismus
node tools/replay.js aufnahme.json --write-fingerprint   # Fixture quittieren
```

`tools/fixtures/demo_orbit.json` ist eine solche Aufnahme im Repo; ihr
Fingerabdruck ist der Regressionstest R2 — jede Physik-Änderung, die diese
Trajektorie verschiebt, bricht dort sichtbar.
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

### Teilfix vom 2026-10-13: Sackgassen-Neuaufbau + Drift-Resync

Der Defekt oben ist an der Wurzel gemessen worden, und zwar anders als zuvor
vermutet: Nicht die Release-Regel löscht Kontakte zu früh, sondern der
insert-only-Solver läuft in eine **Sackgasse** und kommt dort nie wieder heraus.
Ein eingefügter Kontakt macht sein eigenes Segment frei, hinterlässt aber ein
anderes Segment durch dasselbe Objekt, für das `_findBestEdge` keine tragfähige
Kante findet. Danach stützen sich die Kontakte gegenseitig — jede lokale Sehne
meldet „gebraucht", also löst sich nichts (Release), und ein Rückbau existiert
nicht. Der Pfad wächst dadurch auf bis zu 9,05 m über die konvergierte Referenz
(die Kette wird 6 m über ihr Budget gezogen), läuft zeitweise durch das Objekt
selbst und bricht beim Kippen der Konfiguration in 0,36 s um 8,93 m ein.
**Dieser Kollaps ist das gemeldete Bild**: Seil hängt schlaff durch, löst sich
schlagartig von allen Kanten und steht als direkte Linie neu da.

Zwei neue Mechanismen in `02_rope.js` (beide nur im stabilen Attached-Betrieb,
nie während Flug, Setzen oder laufendem Release):

* **Sackgassen-Neuaufbau** (`rebuildAfter`): läuft die eigene Route vier
  Topologie-Ticks hintereinander durch Geometrie, ohne dass ein Release läuft,
  wird die Kontaktmenge verworfen und gedächtnislos neu aufgebaut.
* **Drift-Resync** (`resyncHz`, `resyncDrift`): Vergleich gegen eine
  gedächtnislos frisch gerechnete, streng kollisionsfrei validierte Referenz.
  Übernommen wird nur eine **Teilmenge** der eigenen Kontakte — also ein
  Aufräumen, nie ein Umbauen. Ein Seil wechselt dadurch nie die Objektseite
  (genau der Sprung aus der Nutzerskizze vom 2026-10-12 — Spieler wechselt
  die Seite, das Seil nimmt den direkten Weg durch die Säule — bleibt
  ausgeschlossen; nachgebaut als Test W9 in `tools/test_wrap.js`). Eine kontaktlose Referenz gilt erst ab zwei Kontakten,
  denn der Einzelkontakt hat mit der lokalen Release-Hysterese seinen eigenen,
  gleitenden Mechanismus.
* Die Pfadlänge wird nach beiden Eingriffen über einen linear abklingenden
  Offset stetig gemacht (`resyncFade`), damit Constraint und Budget keinen
  Substep-Sprung sehen; das freigesetzte Spiel rollt der bestehende
  tidy-Mechanismus nach.

Gemessen, Orbit um die Säule wie im Nutzervideo (r = 3,2 m, eine Umdrehung,
Rope-Ebene inkl. Kette):

| Größe | vorher | nachher |
|---|---|---|
| größter Längensprung (neben dem Einhaken) | 4,47 m | 0,04 m |
| größter Umweg über konvergierte Referenz | 9,05 m | 2,18 m |
| Schritte mit Pfad durch Geometrie | 377 | 0 |
| Schritte mit stale-Pfad (Sicht frei, Pfad zu lang) | 36 % | 11,7 % |

`tools/test_wrap.js` (Solver-Ebene, vier Orbits): Polylinie durch Geometrie
**602 → 47 von 4466** gültigen Schritten (13,5 % → 1,1 %). W6–W8 bleiben
XFAIL: der Neuaufbau repariert die Sackgasse als Polylinien-Sprung (bis 9,3 m
in einem Solver-Schritt); sichtbar wird daraus auf Rope-Ebene kein Ruck mehr,
weil Kette und Längen-Offset glätten, aber die Solver-Messgröße springt
weiter. Preis: `bench.js` D (nur Pfad-Solver) 58,7 → 105,5 µs/Aufruf für die
Referenzrechnung, C +11 % — absolut ≈ 1,5 ms/s Laufzeit.

**Folge-Commit: topologische Freigabeschranke.** Der Skizzen-Fall
(zwei Umlenkungen an einer dünnen Säule, Spieler wechselt die Seite, Sicht auf
den Anker wird frei; nachgebaut als Test W9 in `tools/test_wrap.js`) war damit
noch nicht erfasst — er
entsteht nicht in der Sackgasse, sondern in der Release-Regel selbst: die
lokale Sehne wird frei, sobald die Sichtlinie frei ist, und alle Kontakte
lösen sich binnen weniger Ticks, obwohl das Seil topologisch um die
Objektseite liegt (Umlaufwinkel in der Draufsicht ≈ π). Neu gilt deshalb
`_releaseTopoOK`: ein Kontakt an einer Box, um die die Route gewickelt ist,
wird nicht freigegeben (Ausnahmen: er steht am Kantenende und kann real
ausgleiten, die Route ist bereits durch den Grundriss defekt, oder der
lokale Umweg überschreitet den Objektumfang — dann ist er kein Wickel,
sondern Solver-Müll). Dieselbe Schranke gilt für den Bogus-Drop und den
Resync; oberhalb `wrapWindMax` (≈ 430°) gilt das Seil als durchgerutscht,
damit die Schranke im Dauer-Orbit keine Spirale konserviert, die das
Kantenpunkt-Modell nicht darstellen kann.

Regressionstest `test_wrap.js` W9 arretiert den Skizzen-Fall (dünner Mast,
Seitenwechsel bei freier Sicht): Basisbauart verletzt W9b/W9d/W9e (0 Kontakte,
1,61 m Sprung, 12 blockierte Segmente), der aktuelle Stand hält (2 Kontakte,
Umlaufwinkel 181° erhalten, 0,04 m Sprung, 0 blockierte Segmente).

`test_sim.js` bleibt vollständig grün (179/179); in 13d wurde die
Messvorbedingung `slackMax > 2` auf `> 1,2` korrigiert, weil 4,2 m
freigesetztes Spiel ein Symptom des Defekts waren und kein Ziel — mit dem
Resync sind es 1,6 m, straff in 0,25 s (kommentiert im Test).

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
index.html            fertiges Spiel — GEBAUT, nicht versioniert (345 KB, self-contained)
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

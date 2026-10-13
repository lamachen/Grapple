# Entwicklungsverlauf — Pivot-Solver-Fortsetzung (Session 2026-10-13)

**Zweck dieser Datei.** Sie dokumentiert eine einzelne Arbeitssession lückenlos: was vorgefunden
wurde, was getan wurde, was dabei gemessen wurde, und was fehlschlug. Sie ist geschrieben für
einen Leser — Mensch oder LLM-Agent — der **keinen Zugang zum Chatverlauf** hat, aber **Zugriff
auf dieses Repo**. Alle Zahlen sind Messwerte aus den genannten Werkzeugen, nicht Schätzungen.

**Branch:** `feature/pivot-solver` — Stand am Ende dieser Session `077c1cf`.
**`main`:** `728226f`, in dieser Session **nicht** verändert.
**Ausgelieferter Modus:** `wrapSolver: 'legacy'`. Der pivot-Modus ist ein Experiment hinter einem
Schalter und ist **nicht** gemergt.

---

## 0. Ausgangslage — was diese Session war

Die Session begann damit, dass der Nutzer den **vollständigen Chatverlauf einer vorherigen Session
als Textdatei** übergab (ca. 256 KB, im Arbeitsbereich jener Session unter `uploads/`)
und fragte, ob die Arbeit fortgesetzt werden kann, „auch wenn das Repo nicht ganz
den neuesten Stand hat, mit dem dieser Verlauf endete".

> **Nachtrag Aufräumen:** Die Bilddateien, auf die dieser Verlauf und mehrere Kommentare
> verwiesen (`uploads/`, 7 PNG/JPG, 618 KB = 34 % des Working Trees), sind aus dem Repo entfernt.
> Sie waren ausschließlich in Kommentaren referenziert, die denselben Inhalt längst in Worten
> trugen; die maschinenlesbare Form der Skizze ist Test **W9** in `tools/test_wrap.js`. In der
> Git-Historie bleiben sie erhalten (kein History-Rewrite), der Working Tree und damit jeder
> Kontext-Import ist sie los.

Die vorherige Session hatte an genau diesem Repo gearbeitet. Ihr Verlauf enthielt:

1. **Commits, die auf GitHub lagen** — bis `728226f` (Körper-Kollisionen). Die waren vollständig.
2. **Einen Branch `feature/pivot-solver` mit einem Commit `232bf29`** („Pivot-Solver v0 (WIP)").
   Der lag ebenfalls auf GitHub, war aber von `c3db832` abgezweigt — also **vor** den vier
   main-Commits `d1a3d2d`, `7619606`, `2256b98`, `728226f`.
3. **Vier weitere Editierrunden am pivot-Modus, die nie committet wurden.** Die vorherige Session
   endete mitten in der Arbeit (letzte Zeile des Verlaufs: „Der aktuelle Inhalt ist leer, bitte
   neu generieren."). Dieser uncommittete Stand — dort „v1" genannt — existierte **nur** im
   Arbeitsverzeichnis jener Session und war verloren.

**Aufgabe dieser Session:** den verlorenen v1-Stand rekonstruieren, auf den aktuellen main-Stand
setzen und die Arbeit am pivot-Solver weiterführen.

Das war möglich, weil der übergebene Verlauf die Editierbefehle jener Session **im Wortlaut**
enthielt: Python-Skripte mit exakten `old`/`new`-Stringpaaren. Die Semantik war damit vollständig
rekonstruierbar; nur die Formatierung (Zeilenumbrüche, Einrückung) fehlte, weil der Verlauf flach
ohne Newlines überliefert war.

---

## 1. Glossar — Begriffe, die in dieser Datei und im Code verwendet werden

Ohne diese Begriffe sind die Befunde nicht lesbar. Sie stehen hier, weil sie im Code teils als
deutsche Kommentare, teils als englische Bezeichner vorkommen.

| Begriff | Bedeutung |
|---|---|
| **Welt-Pfad / Route** | Die Polyline Hand → Knickpunkte → Anker. Ihre Länge ist `lengthGeo`; `length` darf einen abklingenden Offset `_lenOff` tragen, damit ein Topologiewechsel nicht in einem Substep reißt (`resyncFade`). |
| **Kontakt / Wrap / Umlenkpunkt** | Ein Punkt, an dem das Seil an einer Kante anliegt. Gespeichert als `wraps[i] = { box, edgeIdx, p, n, release, age, side, … }` (siehe `makeWrap`). |
| **Kante** | Eine der 12 Kanten einer AABB-Box, indexiert über `EDGE_PAIRS[e]` = zwei Eckpunkt-Indizes aus `CORNER_SIGNS` (`01_world.js`). `boxEdge(box, e, p0, p1, outN)` liefert die Endpunkte **und** `outN` = **Bisectrix** der beiden angrenzenden Flächennormalen (nicht eine einzelne Normalenrichtung!). |
| **Berührpunkt** | `edgeTouchPoint(A, B, p0, p1, outN, clearance, out)` — der Punkt auf der Kante, an dem die Sehne `A→B` die Kante mit `clearance` Abstand berührt. Schreibt `_TP.t` (Parameter, **ungeschnitten**) und `_TP.elen` (Kantenlänge). |
| **Blockade** | Ein Polyliniensegment läuft durch feste Geometrie. Das sichtbare Symptom: das Seil steckt im Objekt. |
| **Umweg / detour** | `length` minus der Länge einer gedächtnislos neu gelösten Referenz-Route für dieselbe Handposition. Der „V-Schlaufe"-Zustand zeigt sich hier, ohne dass ein Segment blockiert wäre. |
| **Längensprung / maxJump** | Größte Änderung von `solve()`-`length` zwischen zwei aufeinanderfolgenden Substeps. Geht direkt in die Constraint, ist also der sichtbare **Ruck**. |
| **legacy-Modus** | `wrapSolver: 'legacy'` (Voreinstellung). Kontakte finden per Blocker-Raycast + Greedy-Kantensuche (`_tryInsertWrap`, `_findBestEdge`), Freigabe per „lokale Sehne frei" + Hysterese, dazu die Pflaster: `_releaseTopoOK` (Umlaufwinkel-Schranke), Sackgassen-Neuaufbau (`_deadEnd`/`rebuildAfter`), Drift-Resync (`_freshRoute`/`resyncHz`), Bogus-Drop, `_cornerSlide`, Längen-Offset-Fade. |
| **pivot-Modus** | `wrapSolver: 'pivot'`. Die Idee (aus einer Fremd-Analyse, die der Nutzer in die vorherige Session eingebracht hatte): (a) Kontakte entstehen dort, wo das Seil eine Kante **überstrichen** hat, nicht per Suche; (b) Freigabe über den **Kraftkegel** an der Kante statt über Sichtlinie; (c) die Kontaktfolge **ist** die Topologie, wodurch die Pflaster überflüssig werden. Vorbild: Worms-Ropes, aber für 3D-Kanten. |
| **Kraftkegel / force cone** | `_pivotRelease(w, prev, next, c)`: Die beiden Seilsegmente ziehen mit `u_prev + u_next = s`. Die Kante kann nur dagegenhalten, solange die Reaktion `−s` als nichtnegative Kombination der beiden Flächennormalen darstellbar ist. Die Komponente entlang der Kantenrichtung wird vorher abprojiziert (reibungsfreie Kante = analytisches Gleiten). Toleranz `pivotHoldTol`. |
| **Sehne / chord** | Die direkte Verbindung `prev → next` um einen Kontakt herum. `directBlocked` = sie läuft durch Geometrie. |
| **Sweep** | `_pivotSweep()`: prüft pro Substep für jedes Segment und jede Kante jeder nahen Box, ob das Segment diese Kante seit dem vorigen Substep überstrichen hat. |
| **Selbst-Durchdringung** | Ein Kontakt, dessen eigenes Zulauf- oder Ablaufsegment durch **seine eigene** Box läuft — liegt auf der falschen Seite, ist ein unmöglicher Zustand. |
| **Umlaufwinkel / winding** | `_pathWindingXZ(pts, box)`: vorzeichenbehafteter Gesamtwinkel, den die Polyline in der Draufsicht um den Box-Mittelpunkt überstreicht. Billige Homotopie-Invariante. Schwelle `wrapWindTol` (0,6 rad ≈ 34°). |
| **V-Schlaufe** | Der Zustand, in dem die Route kollisionsfrei, aber absurd lang ist: 19,70 m bei 5,50 m freier Route, mit Kontakten auf der abgewandten Objektseite. In **beiden** Modi. Siehe Abschnitt 9. |
| **XFAIL** | `tools/test_wrap.js` arretiert den bekannten Wickel-Defekt als „erwartet fehlerhaft" (4 Zeilen), statt ihn schönzurechnen. Nach einem Fix werden daraus echte `ok(...)`-Grenzen. |

---

## 2. Repo-Zugang und Werkzeuge (Kurzfassung für Agenten)

```
grapple/
  src/00_math.js 01_world.js 02_rope.js 03_player.js 04_render.js 05_fx.js 06_level.js 07_game.js
  tools/            Tests, Sonden, Build
  doc/ARCHITEKTUR.md  das eigentliche Ergebnisdokument (mit Defekt-Nummern #35…#53)
  index.html        aus src/ gebaut — NIE von Hand editieren
```

**Test-Batterie (vor jedem Commit, in dieser Reihenfolge):**

```bash
cd grapple
node tools/test_sim.js        # erwartet: 208 bestanden, 0 fehlgeschlagen
node tools/test_wrap.js       # erwartet: 9 bestanden, 0 fehlgeschlagen, 4 XFAIL
node tools/test_replay.js     # erwartet: ✔ Replay-Regression sauber.
node tools/test_browser.js    # erwartet: Browser-Smoke-Test bestanden
node tools/check_panel.js     # erwartet: 29 Slider + 6 Schalter … alle zeigen … ihren echten Wert
node tools/test_edgecross.js  # erwartet: 31 bestanden, 0 fehlgeschlagen   (neu in dieser Session)
python3 tools/build.py        # index.html neu bauen; Größe in den Commit
```

**Sonden (diese Session neu, alle deterministisch, alle mit `MODE=legacy|pivot`):**

| Werkzeug | Frage, die es beantwortet |
|---|---|
| `tools/probe_wrapclean.js` | **Das Abnahme-Kriterium.** Reine Testwelt (Boden + EIN Quader), jeder Schritt gültig. `V R T` als Argumente. Meldet `maxJump` (maskiert), `maxJumpGeo` (ungefiltert) und `maxLenOff` getrennt — siehe Abschnitt 10b.3. |
| `tools/probe_windoracle.js` | **Topologie-Erhaltung.** Umlaufwinkel des Solvers gegen den von der Handbahn erzwungenen Winkel, plus Ereignisprotokoll (Rebuild/Resync/Release/SelfPen mit `lengthGeo` und `_lenOff`). `V R T` als Argumente, `MAXCOUNT`/`WINDMAX` als Umgebungsvariablen. |
| `tools/probe_orbit2.js` | Orbit um die Levelsäule mit **echtem Wickel-Zwang** (Anker frei stehend süd-westlich). Liefert `corner` (Eckübergang-Instrumentierung), `sweep` (Sweep-Zähler), `jumpInfo` (Kontext des größten Längensprungs), `detourTrace` (Umweg-Verlauf). ⚠ Messgeometrie: die Handbahn läuft durch die Levelgeometrie, siehe Abschnitt 9.1. |
| ~~`tools/probe_worst.js`~~ | **wieder entfernt** (Aufräumen): `probe_orbit2.js` liefert denselben Befund über `jumpInfo` (Kontext des größten Längensprungs) und `detourTrace` (Umweg-Verlauf), und `probe_blocked.js` liefert Geometrie + Kontakte + `_segBlocked`-Antwort für blockierte Schritte. Der Befund aus Abschnitt 9.1 bleibt gültig und ist hier festgehalten. |
| `tools/probe_blocked.js` | Erster blockierter Schritt + **Insert-Probe**: fragt `_tryInsertWrap` direkt, ob es eine Lösung gäbe. |
| `tools/test_edgecross.js` | Unit- + Zufallstest für `edgeCross2D` (31 Assertions, 8000 Zufallsfälle). |
| `tools/ref_edgecross.js` | Langsame Referenzfassung mit Residual-Prüfung — der Maßstab für die schnelle in `src`. |
| `tools/test_wrap.js` (bestehend) | Vier Level-Orbits, 9 Assertions + 4 XFAIL. |

**Git:** Identität ist repo-lokal gesetzt (`lamachen` / `165836303+lamachen@users.noreply.github.com`).
Push lief in dieser Session über einen PAT, der im übergebenen Chatverlauf im Klartext stand;
der Nutzer wurde aufgefordert, ihn zu widerrufen. **Kein Token ist im Repo gespeichert.**

**Zwei Arbeitsfallen, die in dieser Session mehrfach Zeit gekostet haben:**

1. `process.env.SRC` kann in der Sandbox der wörtliche String `"$ARENA_WORKSPACE"` sein, wenn die
   Variable leer ist. Alle Werkzeuge prüfen deshalb mit `fs.existsSync`, bevor sie `SRC`
   übernehmen, und fallen sonst auf `path.join(__dirname, '..', 'src')`:
   ```js
   const SRC = (process.env.SRC && fs.existsSync(path.join(process.env.SRC, '02_rope.js')))
     ? process.env.SRC : path.join(__dirname, '..', 'src');
   ```
2. Editierskripte, die **alle** Ersetzungen sammeln und erst am Ende schreiben, verlieren bei einem
   fehlgeschlagenen Anker **lautlos alle** vorherigen Schritte (`AssertionError` am Ende, Datei
   unverändert). Besser: indexbasierte Anker (`s.index(...)`) und Kontrolle mit `grep -c` direkt
   danach. In dieser Session ist das dreimal passiert.
3. **`.git` kann verschwinden, während der Arbeitsbaum liegen bleibt.** Belegt ist das für zwei
   verschiedene Zeitpunkte, und die beiden sind nicht dasselbe Ereignis:
     * **Selbst beobachtet (Session 2026-10-13):** zwischen zwei aufeinanderfolgenden Antworten
       desselben Agenten. Am Ende der einen war `.git` intakt (Push von `00b4aec`, `git ls-remote`
       ausgeführt), zu Beginn der nächsten lag nur noch der Arbeitsbaum da. Es ging nichts
       verloren, weil alles gepusht war.
     * **Aus dem übergebenen Verlauf der Vorsession (Zeile 331), also fremdbeobachtet:**
       „The .git directory was lost during the session handoff (this has happened before in this
       project)." Dort half derselbe Ausweg: sauberer Clone von `main`, Zwischenstand in ein
       `proj_wip/` geschoben. Der Zusatz „schon vorher passiert" ist in keiner der beiden Quellen
       weiter belegt und wird hier nicht als Tatsache geführt.
   Gemein ist beiden: Der Arbeitsbaum überlebt, `.git` nicht. Wiederherstellung:
   ```bash
   cd ~ && git clone -q https://github.com/lamachen/Grapple.git proj_new
   cd proj_new && git checkout -b feature/pivot-solver origin/feature/pivot-solver
   git config user.name lamachen && git config user.email 165836303+lamachen@users.noreply.github.com
   diff -rq --exclude=.git ~/proj ~/proj_new      # muss leer sein, sonst Arbeitsbaum übernehmen
   cd ~ && mv proj proj_wip && mv proj_new proj
   ```
   **Lehre:** nach jeder Änderung sofort committen **und** pushen — der lokale Arbeitsbaum ist
   keine Sicherung, und ein Clone ist in ~1 s neu gezogen. Außerdem vor jeder Git-Aktion kurz
   `git rev-parse --git-dir` oder `git status` prüfen statt blind drauflos zu editieren: Ein
   `git add`/`commit` ohne `.git` meldet nur „not a git repository" und ändert nichts, aber ein
   Editierskript dazwischen läuft trotzdem und erzeugt einen Arbeitsbaum, dessen Bezug zu HEAD
   niemand mehr prüfen kann.

---

## 3. Schritt 1 — Branch auf den aktuellen main-Stand setzen

Vorgefunden: `origin/main = 728226f`, `origin/feature/pivot-solver = 232bf29`, Merge-Base `c3db832`.
`git merge-tree` meldete 0 Konflikte (der Branch fasst nur `src/02_rope.js` an, +141 Zeilen).

```bash
git clone https://github.com/lamachen/Grapple.git proj
cd proj && git checkout -b feature/pivot-solver origin/feature/pivot-solver
git config user.name lamachen && git config user.email 165836303+lamachen@users.noreply.github.com
git rebase origin/main          # brach ab: fehlende Identität, dann fehlende .git/rebase-merge/message
git rebase --abort
git reset --hard origin/main && git cherry-pick 232bf29      # → 06479a4
```

Ergebnis: `06479a4` = v0 auf `728226f`. Inhaltliche Identität mit `232bf29` belegt durch

```bash
git range-diff origin/feature/pivot-solver~1..origin/feature/pivot-solver 06479a4~1..06479a4
# 1:  232bf29 = 1:  06479a4 Pivot-Solver v0 (WIP): …
```

**Konsequenz für den Push:** Der Branch ist damit umgeschrieben; er kann nur mit
`--force-with-lease` aktualisiert werden (beim ersten Push dieser Session so gemacht, danach
normale Fast-forwards).

Suite auf dem rebasierten Stand: 208/208, 9+4 XFAIL, Replay grün. Legacy unverändert.

---

## 4. Schritt 2 — Rekonstruktion des verlorenen v1-Standes

Die vier uncommitteten Runden der Vorsession wurden aus dem Verlauf nachgebaut. Alle Anker
standen dort wörtlich; übernommen wurden sie sinngemäß mit wiederhergestellter Formatierung.

| # | Änderung | Wo |
|---|---|---|
| 1 | Sweep läuft **jeden Substep** (nicht nur am Topologie-Tick) und über **alle 12 Kanten** (nicht nur vertikale). Dafür die Tabellen `EDGE_PL`, `EDGE_SGN` (die Kantenachse ist `3 − pl[0] − pl[1]`). | `solve()` Schritt 2b, `_pivotSweep()` |
| 2 | `_prevPoly` wird am **Ende** von `solve()` gemerkt, nicht mehr mitten im Topologie-Block — verglichen wird gegen das, was der Solver zuletzt wirklich ausgespuckt hat. | `solve()` |
| 3 | Pflaster im pivot-Modus **aus**: Bogus-Drop, `_cornerSlide`, und `settled` (damit Sackgassen-Neuaufbau **und** Drift-Resync). | `_updateWraps`, `solve` |
| 4 | legacy-Blocker-Insert im pivot-Modus **aus** (Kontakte nur noch per Sweep). | `solve()`, Insert-Schleife |
| 5 | Freigabe = **Kraftkegel UND freie Sehne**: `(this._pivotRelease(…) && !directBlocked)`. | `_updateWraps` |
| 6 | **Selbst-Durchdringung**: Kontakt wird sofort verworfen, wenn eines seiner Ankersegmente durch seine eigene Box läuft (`stats.pivotSelfPen`). | `_updateWraps` |
| 7 | Helfer `_segThroughBox(a, b, box, shrink)` (Slab-Test) — in der Vorsession als „ungenutzt aufgeräumt" verloren, wieder eingefügt. | Methode |

Danach: `node --check`, 208/208, 9+4 XFAIL, Replay grün. **Legacy unberührt** (pivot ist hinter
dem Schalter inaktiv).

> **Hinweis für Nachfolger:** Schritt 4 und Schritt 7 sind in dieser Form **nicht** stehen
> geblieben — siehe Abschnitte 7 und 8. Der Rekonstruktionsstand war der Ausgangspunkt, nicht das
> Ergebnis.

---

## 5. Schritt 3 — Diagnose: warum der Sweep fast nichts findet

Wiederhergestellt aus dem Verlauf: `work/probe_pivot.js` (A/B über die vier `test_wrap`-Orbits)
und `work/probe_pivot_diag.js` (klassifiziert blockierte Schritte in *release-verursacht* gegen
*insert-miss*). Beide liefen mit und ohne die Messhygiene-Maske aus `test_wrap.js`.

**Erste Messung, ohne Maske** (enger Orbit, V=9,8 m/s, R=3,2 m, 12 s = 1440 Schritte):

| | blockiert | release-verursacht | insert-miss | davon hand-nah | Sweep-Treffer |
|---|---|---|---|---|---|
| legacy | 55 | 49 | 6 | 51 | – |
| pivot | 219 | 14 | **205** | **218** | **22** |

**Mit Maske** (ungültige Handpositionen zählen nicht — der Orbit mit Radius 3,2 m führt die Hand
selbst durch die Säule, halbe Diagonale im Grundriss ist 3,68 m):

| | blockiert | insert-miss |
|---|---|---|
| legacy | **1** | 0 |
| pivot | 140 | 132 |

Zwei Dinge wurden dabei klar:

1. **Die Zahlen der Vorsession („legacy 19,0/22,4 % blockiert") sind nicht vergleichbar.** Deren
   Sonde hatte die Maske nicht. Mit Maske meldet dieselbe Strecke legacy 0,3 % statt 19 %.
2. **94 % der pivot-Blockaden sind insert-misses** — der Sweep legt den Kontakt gar nicht erst an.

Die Zähler im Sweep zeigten, wo es hängt: 1441 Aufrufe, 1796 Segmente, 1552 nahe Boxen,
**18624 Kanten-Tests, 22 Treffer**, 13 Skips (Topologiewechsel), 2 × `t`-Grenze,
7 × Selbst-Durchdringung, 13 Inserts, 0 × Budget/Achse/Duplikat/frei.

**Ursache:** Die Erkennung von v0/v1 testete, ob der Eckpunkt einer Kante in der **aufgespannten
Fläche** (Quad aus altem und neuem Segment) liegt. Das schlägt nur an, wenn sich ein **Endpunkt**
des Segments am Eckpunkt vorbeibewegt. Der Normalfall beim Wickeln ist der andere: die Hand
gleitet seitlich und das Segment **schneidet** die Kante mitten in seiner Länge. Bei 6 m Sehne und
8 cm Handweg pro Substep ist das Quad dann ein dünner Streifen, der den Eckpunkt fast nie enthält.

---

## 6. Schritt 4 — `edgeCross2D` exakt neu gebaut (vier Fehlversuche)

**Gesucht:** Läuft das Segment `(a→b)`, dessen Endpunkte sich linear nach `(a2→b2)` bewegen, in
der Ebene senkrecht zu einer Kante über den Punkt `q` (den Eckwert der Kante in dieser Ebene)?
Das ist kontinuierliche Kollisionserkennung Strecke↔Punkt unter beidseitiger linearen Bewegung —
die von der Bewegung aufgespannte Fläche ist **bilinear**:

```
P(s,t) = a + t·e + s·(f + t·g)        s = Zeit ∈ [0,1], t = Laufparameter ∈ [0,1]
e = b − a,   f = a2 − a,   g = (b2 − a2) − (b − a)
```

Ecken in Reihenfolge `a, b, b2, a2`. `g` ist der Anteil der Bewegung, der die **Richtung** ändert:
bei reiner Translation ist `g = 0` (Parallelogramm), bei Schwenk um einen Endpunkt ein Dreieck.

> ⚠ `g = (b2 − b) − f` ist **identisch** zu `(b2 − a2) − e`. In der Session stand zeitweise
> `g = (b2 − b) − (a2 − a) − f`, was `f` doppelt abzieht und die Vorzeichen von `G` und `K` kippt.

### 6.1 Endgültige Fassung (so steht sie im Code)

Statt die Koeffizienten der quadratischen Gleichung symbolisch herzuleiten, wird die Funktion

```
f(s) = (a(s) − q) × d(s)      mit  a(s) = a + s·f,  d(s) = e + s·g,  × = 2D-Determinante
```

an **drei Stützstellen** ausgewertet (Funktion `sideAt`, Zeile ~528) und das exakte
Vandermonde-System gelöst:

```
y0 = f(0),  yh = f(0,5),  y1 = f(1)
c0 = y0
c2 = 2·y0 − 4·yh + 2·y1
c1 = −3·y0 + 4·yh − y1                    →   c2·s² + c1·s + c0 = 0
```

Dann pro Wurzel `s ∈ [−1e−9, 1+1e−9]`:

```
a(s) = a + s·f                                     (Startpunkt zum Zeitpunkt s)
d(s) = (b + s·(b2−b)) − a(s)                       (Richtung zum Zeitpunkt s)
t    = ((q − a(s)) · d(s)) / |d(s)|²               ← |d|², NICHT |d|
P    = a(s) + t·d(s)
Abbruch, wenn t ∉ [0,1] oder |P − q| > 1e−9 · max(1,|q|,|P|)
sonst Treffer: _EC = { s, t, u: P_u, v: P_v }
```

Wurzelbildung ohne Auslöschung (`quadRootsWide`): betragsgrößere Wurzel `q = −½(B + sign(B)·√disc)`,
`r1 = q/A`, zweite über Vieta `r2 = C/q`. **Keine Relativschwelle gegen `|A|`** — bei fast
gestreckter Bewegung ist `A ≈ 1e−15` und die physikalisch interessante Wurzel ist die **kleine**
(gemessen: `A = 1,1e−15`, echte Wurzel `s = 0,854`; die Schulformel lieferte `1`).

Zwei praktische Eigenschaften, die beim Bauen gefunden wurden:

* **`f(s)` ist für beide Endpunkte identisch** — `p` und `p + λ·d` liefern dasselbe Kreuzprodukt,
  weil `d × d = 0`. Ein Durchlauf genügt (der doppelte war reine Rechenzeit).
* **Die Residual-Prüfung `P == q` ist Pflicht, keine Deko.** Ohne sie: 282 Scheintreffer in 4000
  Zufallsfällen. Der Seitenwechsel beweist nur, dass die Bahn des Endpunkts die Gerade durch `q`
  gekreuzt hat — die **Kante** ist erst getroffen, wenn `q` wirklich auf dem Segment lag.

### 6.2 Die vier Fehlversuche (nicht wiederholen)

Jede dieser Varianten lieferte **plausible, aber falsche** Treffer. Aufgefallen sind sie nur an
der Residual-Prüfung bzw. an `tools/test_edgecross.js`.

| Versuch | Formel | Warum falsch |
|---|---|---|
| 1 | Determinanten `E = e×w, F = e×f, G = e×g, H = w×f, K = g×w`, dann `G·t² + (E+F−K)·t + H = 0`, `s = −(E+tG)/(F+tG)` | Herleitungsfehler beim Zusammenfassen; Wurzeln außerhalb, `P ≠ q` |
| 2 | `H = f×w` statt `w×f`, `B = F − H − K`, `disc = B² + 4GH`, `s = +(E+tG)/(F+tG)` | dito, andere Vorzeichenkombination |
| 3 | `B = F + K − H`, `s = −(E+tG)/(F+tG)` | dito |
| 4 | `B = 2F + K`, dazu Newton-Politur auf `(s,t)` | Newton brach ab: die Jacobi-Determinante der bilinearen Fläche liegt im Wickel-Fall bei ~1e−13 |

Zusätzlich falsch und gefunden: `c1 = yh − y0 − ¼·c2` (richtig `−3·y0 + 4·yh − y1`) — das kostete
4000/4000 Zufallstreffer, während alle achsparallelen Unit-Fälle grün blieben.

**Lehre, die auch als Kommentar im Code steht:** Fünf Vorzeichenvarianten derselben Formel liefern
jeweils plausible Treffer. Wer hier etwas ändert, ändert es **gegen** `tools/test_edgecross.js`,
nicht gegen das eigene Kopfrechnen.

### 6.3 Test

`tools/test_edgecross.js` — **31 Assertions**:

* 20 handgerechnete Fälle: Translation quer (Mitte / daneben / außerhalb / neben dem Segmentende),
  Schwenk um einen Endpunkt (Dreieck getroffen / andere Seite / außerhalb nahe a / nahe b),
  beide Endpunkte bewegt (gekippt), Rückwärts, schräges Segment, lange Sehne mit kleinem Hub,
  Degenerationen (keine Bewegung, Translation längs des Segments).
* Konsistenz: bei **jedem** Treffer muss `P(s,t) == q` gelten.
* 4000 Zufallspunkte **auf** der bilinearen Fläche → müssen alle erkannt werden (0 verpasst).
* 4000 Zufallspunkte **außerhalb** der Hüllbox → dürfen nicht treffen (0 falsch positiv).

> ⚠ Zwei der handgerechneten Fälle waren anfangs **selbst falsch konstruiert** und mussten
> korrigiert werden: Beim „Orbit-Fall" lag `q` zu keinem Zeitpunkt auf dem Segment (`f(s)` linear
> ohne Nullstelle), und beim „gekippt"-Fall war `f(s) ≡ 4`, also ebenfalls keine Inzidenz.
> Konstruierte Fälle müssen die Inzidenz erfüllen — am zuverlässigsten erzeugt man sie als
> `q = P(s,t)` aus gewürfelten `(s,t)`.

---

## 7. Schritt 5 — Sweep v2 und zwei Korrekturen an der pivot-Architektur

### 7.1 Sweep v2 (`_pivotSweep`, Zeile ~1218)

* Pro Segment: `_nearBoxes(a, b, ptsBox[i], ptsBox[i+1], null, [])` (Marge 1,4 m, max. 8 Boxen).
* Boxen, auf denen schon **≥ 2** Kontakte liegen, werden übersprungen (Wicklung über eine Wand =
  Ein- und Austrittskante; eine dritte wäre ein Umschlingen, das der Sweep allein nicht entscheiden
  kann). Endpunkt-Boxen sind über `boxA/boxB` ausgeschlossen.
* Pro Kante `e`: Ebene `pl = EDGE_PL[e]`, Vorzeichen `sg = EDGE_SGN[e]`, Achse `ax = 3 − pl[0] − pl[1]`;
  `q` = Eckwert der Kante in dieser Ebene. Test mit `edgeCross2D`.
* **Achsenintervall:** Die Kante ist endlich. Der Kreuzungspunkt wird bilinear interpoliert
  (`aa/bb3` aus `s`, `axAt` aus `t`) und muss innerhalb `[min − 0,15, max + 0,15]` der
  Segment-Achskoordinaten liegen (`stats.swAxis`).
* Ereignisse werden gesammelt und **nach Segmentindex absteigend** sortiert eingesetzt, damit die
  Indizes der vorderen Ereignisse durch `splice` gültig bleiben; innerhalb eines Segments nach
  Kreuzungszeit `s`.
* Berührpunkt: `edgeTouchPoint(aa, bb3, p0, p1, nn, wrapClearance, cp)` auf der Sehne zum
  Kreuzungszeitpunkt — dieselbe Konstruktion wie im Betrieb, damit der neue Kontakt ohne Sprung in
  die analytische Nachführung geht. Danach die Filter `_TP.t`-Grenze, `world.pointFree`,
  Selbst-Durchdringung (s. u.).
* Orientierung: `w.side = Vorzeichen von (d × (q − a))` in der Kantenebene.
* Zähler: `stats.swCalls, swSkip, swSegs, swNear, swTests, swCross, swDup, swAxis, swT, swFree,
  swSelf, swBudget, pivotInserts`.

### 7.2 Korrektur 1: Der Blocker-Insert muss im pivot-Modus **an** bleiben

v1 hatte ihn abgeschaltet (Rekonstruktionsschritt 4). Messung (`probe_orbit2.js`, Anker damals
noch westlich der Säule):

| | blockiert | davon **ohne** jeden Säulenkontakt |
|---|---|---|
| pivot, Insert aus | 18,6 % | **243 von 250** |
| pivot, Insert an | 5,4 % | 70 von 73 |

Der Grund ist grundsätzlich und steht als Kommentar im Code: **Eine Kanten-Überstreichung findet
nur in dem Augenblick statt, in dem die Sehne exakt durch die Kante läuft.** Der Normalfall
dazwischen ist eine Sehne, die eine Box **schneidet**, ohne eine Kante zu überstreichen — dort
muss der Kontakt aus der Blockade abgeleitet werden (tangentiale Kantenwahl), und genau das tut
`_tryInsertWrap`/`_findBestEdge`. Der Sweep ersetzt den Insert nicht, er ergänzt ihn um die
richtige Reihenfolge und um die Fälle, die der Insert übersieht.

### 7.3 Korrektur 2: Doppelkante in der Kontaktliste (betrifft **beide** Modi)

Gefunden über `jumpInfo` in `probe_orbit2.js`: Kontaktfolge `[Kante 8, Kante 9, Kante 8]`, Kante 8
doppelt auf demselben Punkt `(32,6 | 2,5 | −25,4)`. Zwei identische Kontakte = ein Nullelement
plus zwei volle Auslenkungen zum selben Punkt, also reiner Umweg: **Pfad 17,64 m bei 15,69 m
Referenz**, dazu ein Längensprung von 1,95 m beim Umräumen.

Ursache: `_tryInsertWrap` kannte nur die **Adjazenz**-Regel (`exclude` für den Nachbarkontakt
derselben Box). Das greift nicht, sobald der doppelte Kontakt über einen Nachbarkontakt hinweg
eingefügt wird. Fix: Belegungsliste `taken` aller Kanten derselben Box; Kandidat `e` wird zu `-2`
und übersprungen, wenn `cbox === blocker && taken.indexOf(e) >= 0`. Der Sweep prüfte das längst.

### 7.4 Selbst-Durchdringung: nur die **tiefe** Variante killt

`_segThroughBox` (harter Schnitttest) wurde ersetzt durch `_segBoxBeyond` + `_segBoxOverlap`:
Slab-Test liefert das Überlappungsintervall `[t0,t1]` und die Welt-Tiefe; „frei" gilt, solange die
Durchdringung im **Auflagebereich** um den Kontakt liegt (`wrapClearance · 3` als Bogenlänge,
umgerechnet in den Streckenparameter). Kill erst, wenn die Tiefe über
`pivotSelfPenDepth · ½ · Querschnittsdiagonale` liegt. Zähler: `pivotSelfPen` (Kill),
`pivotSelfPenShallow` (flach, erlaubt).

Messung (`probe_orbit2.js`, Anker westlich):

| Selbst-Durchdringungs-Regel | blockiert | davon ohne Säulenkontakt | maxSprung | Verwürfe |
|---|---|---|---|---|
| aus | 22,0 % | 0 | 6,26 m | 0 |
| „irgendwo" (hart) | 5,4 % | **70 von 73** | 2,17 m | 44 |
| „tiefer als ½ Diagonale" | 5,4 % | 70 von 73 | 2,17 m | 44 |

Die Tiefenstaffelung (`pivotSelfPenDepth` 1,0 / 0,5 / 0,25 / 0,1) änderte an diesen Zahlen
**nichts** — die Durchdringungen sind tief (die Sehne läuft durch die ganze Box), nicht flach.
Schalter `pivotSelfPenRule: 'margin' | 'off'` bleibt für A/B stehen.

---

## 8. Schritt 6 — Eckübergang als Ursache **ausgeschlossen**

Hypothese war: Ein Kontakt gleitet ans Kantenende und findet dort keinen Übergang auf die
Nachbarkante. Drei Messungen haben sie widerlegt.

### 8.1 `_cornerSlide` feuert in beiden Modi nie

Instrumentierung in `probe_orbit2.js` (Kennzahl `corner`), Methode und `_atEnd` gezählt:

| | Aufrufe | Treffer | Kontakt-Schritte | Schritte mit `_atEnd` |
|---|---|---|---|---|
| legacy | 0 | 0 | 1561 | **0** |
| pivot | 0 | 0 | 1704 | **0** |

Die Methode ist also nicht wirkungslos — sie wird **nie erreicht**, weil `_atEnd` in diesen
Schritten `false` ist. (In `test_wrap.js` hatte die Vorsession 59 Aufrufe und 0 Erfolge gezählt;
das war ein anderer Messaufbau.)

Die pivot-Bedingung dafür war trotzdem falsch und wurde korrigiert: sie verlangte `release === 0`
(„Hysterese steht still"), aber im pivot-Modus ist die Freigabe Kegel **UND** Sehne — ein
klemmender Kontakt hat dort fast immer `release > 0`. Jetzt:
`w.edgeIdx >= 0 && w._atEnd && (legacy ? release === 0 : pivotCornerSlide)`.
Messbar ohne Unterschied (0 Aufrufe vorher wie nachher), aber die Tür stimmt.

### 8.2 `_pivotEdgeHop` — zwei Fassungen, beide 0 Treffer, wieder entfernt

Gebaut wurde ein Übergang auf eine Nachbarkante **derselben Ecke**, mit dem Eckpunkt als
zulässigem Ziel. Das ist physikalisch richtig: Ein Seil um eine Boxecke berührt den **Eckpunkt**;
„Kante" ist dort nur Buchführung. `_cornerSlide` verlangt dagegen „innen auf der Kante"
(`t ∈ [0,02 … elen−0,02]`) und kann an einer Ecke deshalb **prinzipiell** keinen Kandidaten
finden — die Tangente an eine Nachbarkante liegt von einer Ecke aus auf der Ecke, `t = 0`.

* **Fassung 1** wählte die Ecke über `vdist(w.p, w.p0) <= vdist(w.p, w.p1)`. Bei einem Kontakt in
  Kantenmitte sind beide Abstände gleich (gemessen 2,50 m gegen 2,50 m an einer 6-m-Kante) — der
  Vergleich nimmt dann immer das **erste** Ende, an der Nordwest-Kante der Box also die
  **Südwest**-Ecke. Beide Kandidaten landeten folglich unter dem Boden (`y = −0,1` →
  `pointFree` ⇒ nein) und 1,3 m neben der Ecke (`reach` ⇒ nein). 0 Hops.
* **Fassung 2** wählte über den Kantenparameter `_TP.t`. Identisches Ergebnis — der Parameter
  steht bei 2,5 von 6 m, also in der Mitte.

**Das ist kein Implementierungsfehler, sondern die Aussage:** An einer senkrechten Kante in halber
Höhe gibt es keine „nächste" Ecke. Die richtige Route führt **über** die obere Ecke und wieder
hinunter, braucht also einen zusätzlichen Kontakt auf einer horizontalen Kante — ein lokales
Neulegen der Route um diese Box, kein Eckübergang.

Der Befund steht als Kommentarblock bei `_segBoxBeyond` im Code (Methodenname im Kommentar:
`_pivotEdgeHop`), damit niemand denselben Weg zweimal geht. Die Methode selbst ist entfernt.

### 8.3 Eck-Bisectrix in `edgeTouchPoint` — gebaut, gemessen, verworfen

Vermutung war: `edgeTouchPoint` versetzt den Berührpunkt am Kantenende entlang **einer**
Flächennormale und setzt ihn damit schräg neben die angrenzende Fläche; korrekt wäre die
Eck-Bisectrix. Gebaut (optionale Parameter `box, edgeIdx`), gemessen — **keine Änderung**.

Grund, per Instrumentierung belegt: `boxEdge` liefert `outN` für eine Kante **bereits** als
Bisectrix der beiden angrenzenden Flächennormalen. Gemessen an der senkrechten Nordwest-Kante
(Kante 11 von Box 26): `n = (−0,71 | 0 | 0,71)`, Berührpunkt `(30,401 | 2,5 | −27,401)` bei Ecke
`(30,5 | y | −27,5)` — das ist die Clearance von 0,14 m entlang `(−1,0,1)/√2`, also korrekt. Und
`_TP.t = 2,5` von `_TP.elen = 6`: **der Kontakt stand gar nicht am Kantenende.** Änderung
zurückgenommen (`git checkout -- src/02_rope.js`).

### 8.4 Sackgassen-Neuaufbau im pivot-Modus: messbar schlechter

Neuer Schalter `pivotDeadEnd: 'off' | 'rebuild'` (steuert `settled` und damit Neuaufbau **und**
Drift-Resync):

| | blockiert | maxSprung | Verwürfe |
|---|---|---|---|
| `off` | 73 (5,4 %) | 2,17 m | 44 |
| `rebuild` | **214 (15,9 %)** | 0,74 m | **165** |

`converge()` liefert Kontakte, die die pivot-Regeln im selben Tick wieder verwerfen. Der
Neuaufbau ist kein Ausweg, sondern ein Verstärker. Voreinstellung bleibt `off`.

---

## 9. Schritt 7 — reine Testwelt und die V-Schlaufe

### 9.1 Warum eine neue Messwelt nötig war

`probe_orbit2.js` fährt die Hand auf Radius 4,5 m um die Levelsäule. Die Levelgeometrie reicht
dort 3,54 m (Box 26: `[30,5 … 35,5] × [0 … 6] × [−32,5 … −27,5]`) bzw. 3,68 m (Box 27) von der
Säulenmitte. Die Maske „gültige Hand" (0,4 m Abstand) sortiert diese Schritte aus — und damit
**genau die**, in denen die Sehne die Boxecke schneidet.

`tools/probe_worst.js` hat das aufgedeckt: Der „schlimmste blockierte Schritt" lag

* bei **legacy** (t = 10,41, Tiefe 0,37 m) an einer Hand `(35,53 | 2,5 | −28,23)` — **0,03 m
  innerhalb** von Box 26 (`max[0] = 35,5`);
* bei **pivot** (t = 3,06, Tiefe 5,37 m) an einer Hand `(37,62 | 2,5 | −26,67)` — **1,7 m
  innerhalb** derselben Box. Die Maske griff dort nicht mehr, weil
  `37,624 > 35,5 + 0,4 = 35,9`.

Beide „Eindringtiefen" sind Testaufbau. Ein früherer Ankerplatz (`[CX − 7,5 | 2,5 | CZ]`, also
**auf** der Handbahn) erzeugte zusätzlich 6,6-m-Sprünge aus reiner Messgeometrie, weil die Hand
fast durch den Anker lief (Seillänge → 0 und zurück).

### 9.2 `tools/probe_wrapclean.js` — das künftige Abnahme-Kriterium

Welt: Boden `[-40,-2,-40]…[40,0,40]` + **ein** Quader `[-1,6,0,-1,6]…[1,6,10,1,6]`
(3,2 × 10 × 3,2 m, halbe Diagonale 2,26 m). Anker frei stehend bei `(−9 | 2,5 | 0)`. Hand auf
Kreisbahn Radius 4,0 m (≥ 1,74 m Luft), 5 m/s, 16 s = 1920 Schritte, **0 ungültige**. Deterministisch;
zweimal hintereinander identisch gelaufen.

**Messung C:**

| | blockiert | maxTiefe | **maxSprung** | maxUmweg | Kontaktwechsel |
|---|---|---|---|---|---|
| legacy | 25 (1,30 %) | 1,76 m † | **0,053 m** ‡ | 14,59 m @ t=6,06 | 11 |
| pivot | **17 (0,89 %)** | 4,53 m | **6,689 m** ‡ | 14,40 m @ t=11,04 | 14 |

> † **Nicht mehr reproduzierbar.** Am selben Tag später zweimal hintereinander neu gemessen:
> legacy `maxTiefe` = **2,38 m** @ t=6,06 (nicht 1,76 m), pivot unverändert 4,53 m @ t=6,02,
> Blockaden unverändert 25 bzw. 17. Die Sonde ist deterministisch (zwei Läufe, identische
> Ausgabe), die 1,76 m stammen aus einem Lauf vor `19e0775`. Ich kann den Unterschied **nicht**
> erklären — `_pivotCleanup`, der in `a86db17` verloren ging und in `19e0775` wiederhergestellt
> wurde, läuft nur im pivot-Modus, und die Kommentar-Kürzungen desselben Commits ändern keinen
> Code-Pfad. Wer diese Zahl braucht, misst sie neu (`MODE=legacy node tools/probe_wrapclean.js`)
> und trägt ein, was herauskommt. Alle übrigen Zahlen dieses Abschnitts sind zweimal identisch
> nachgemessen.
>
> ‡ **`maxSprung` ist in dieser Tabelle der maskierte Wert** (`S.length` = `lengthGeo + _lenOff`)
> und damit als Stetigkeitsmaß ungeeignet. Ungefiltert: legacy **14,610 m**, pivot 6,689 m.
> Siehe §10b.3 — dort ist auch erklärt, warum die Reihenfolge damit umgekehrt ist.

pivot-Zusatzwerte: `selfPen 5`, `releases 6 (3 mit Sprung)`, `pivIns 3`, `legIns 7`.
legacy-Zusatzwerte: `selfPen 0`, `releases 6 (0 mit Sprung)`, `legIns 27`, `resyncs 0`,
`rebuilds 0`.

⇒ pivot ist bei Blockaden leicht besser und bei der **Längenstetigkeit um zwei Größenordnungen
schlechter**. Ursache: die 5 Verwürfe der Selbst-Durchdringungs-Regel nehmen ihre Auslenkung
**sofort** aus der Pfadlänge, ohne Offset-Fade. **Das ist der nächste Hebel.**

### 9.3 Die V-Schlaufe (betrifft **beide** Modi, also auch das ausgelieferte Spiel)

Zustand bei t ≈ 6 s: Hand `(−3,71 | 2,5 | 1,50)`, Anker `(−9 | 2,5 | 0)`.

* freie Route: **5,50 m**
* vom Solver gehalten: **19,70 m** — 14,20 m Umweg
* drei Kontakte, **alle auf der abgewandten Säulenseite**: Kante 10 auf `(1,7 | 2,5 | 1,7)`,
  Kante 9 auf `(1,7 | 2,5 | −1,7)`, Kante 8 auf `(−1,7 | 2,5 | −1,7)`
* `maxUmweg` am Ende identisch: legacy 14,59 m, pivot 14,40 m

Jeder der drei Kontakte ist **einzeln notwendig**: die Sehne zum Nachbarkontakt läuft durch die
Säule, also `directBlocked` wahr — und damit halten sowohl Kegel als auch Sehne ihn. **Die Menge
ist falsch, nicht das Element.** Lokale Freigabe kann das prinzipiell nicht sehen; das ist exakt
die Zustandsraum-Kritik der Fremd-Analyse, die den pivot-Ansatz angestoßen hat.

### 9.4 `_pivotCleanup` — gebaut, misst, erreicht die V-Schlaufe nicht

Neue Methode (Zeile ~1403), pivot-eigen, 10 Hz (`resyncHz`), nur im Attached-Betrieb
(`_hostSettled`) und nur bei `wraps.length > 0`:

1. `fr = this._freshRoute()` — gedächtnislose Referenz (legt `wraps` beiseite, `converge()`,
   prüft kollisionsfrei, stellt den Live-Zustand exakt wieder her).
2. Abbruch, wenn `lengthGeo − fr.len <= resyncDrift` (0,40 m).
3. **Homotopie-Schranke:** Für jede kontaktierte Box muss
   `|_pathWindingXZ(live) − _pathWindingXZ(referenz)| <= wrapWindTol` (0,6 rad) gelten.
   Sonst `stats.pivotWindHeld++` und kein Tausch.
4. Tausch: Kontaktmenge durch `fr` ersetzen, `gain` in `_lenOff` (Fade mit `resyncFade`),
   `stats.pivotSwaps++`, `stats.pivotSwapGain += gain`.

Zähler: `stats.pcNull` (Referenz selbst blockiert), `pcDrift` (Drift zu klein), `pcGainSeen`,
`pivotSwaps`, `pivotSwapGain`, `pivotWindHeld`.

**Messung:** 76 Aufrufe → **30 × `pcNull`, 46 × `pcDrift`, 0 × Tausch**, `maxUmweg` unverändert
14,40 m.

* **Erste Fassung** prüfte stattdessen „Live-Winkel ≈ 0" und hielt damit **50 von 52** Aufrufen:
  das Zickzack windet selbst ±π/2 um die Säule. „Gewickelt" und „Zickzack" sind über den Winkel
  der **Live-Route allein** nicht zu unterscheiden — erst der Vergleich mit der Referenz trennt sie.
* **Versuch, die Referenz zu reparieren:** `converge()` in `_freshRoute` in einer Schleife (≤ 40)
  wiederholen, bis die Referenz frei ist. Die Referenz war tatsächlich Müll (10,66 m bei 9,06 m
  Luftlinie und **0 Kontakten** — also eine Route quer durch die Säule, weil `converge()` nach
  `wrapMaxCount + 2` Runden abbricht). Die Schleife reparierte sie, änderte am Ergebnis aber
  **nichts** (0 Tausch, 14,40 m), trieb die Kontakt-Verwürfe von **125 auf 4805** und die Laufzeit
  desselben Messlaufs von 14 auf 26 s. **Zurückgenommen**; der Befund steht als Kommentar bei
  `_freshRoute`.

**Schlussfolgerung (steht so im Code):** Der V-Schlaufen-Zustand **ist** ein Topologiewechsel —
Live-Winkel −4,48 rad gegen Referenz +1,80 rad. Ein Topologiewechsel unter Last ist aber exakt
der gemeldete Skizzen-Fehler („Spieler wechselt die Seite, das Seil löst alle Umlenkpunkte und
nimmt den direkten Weg"). **„V-Schlaufe aufräumen" und „Wicklung nicht teleportieren" sind
dieselbe Entscheidung mit umgekehrtem Vorzeichen.** Das ist eine Produktentscheidung, keine
fehlende Zeile Code. Ausgeliefert wird die konservative Seite.

---

## 10. Alle Messungen auf einen Blick

**Messung A** — vier `test_wrap`-Orbits, `work/probe_pivot.js` **mit** Maske. Anker steht hier
`[33 | 4,5 | −27,5]`, also **auf** der Säule: die Sehne kann sie nie schneiden, es gibt nichts zu
wickeln. Trotzdem aufgeführt, weil es der Messaufbau der Vorsession war.

| Lauf | blockiert legacy → pivot | maxSprung legacy → pivot | maxUmweg legacy → pivot | Releases (m. Sprung) legacy → pivot |
|---|---|---|---|---|
| enger Orbit | 0,0 % → 1,3 % | 8,89 → 4,57 m | 8,81 → 11,30 m | 7 (1) → 13 (12) |
| enger Orbit schnell | 7,1 % → 2,5 % | 11,59 → **2,54** m | 59,53 → **11,70** m | 7 (4) → 24 (13) |
| weiter Orbit | 0,3 % → **0,1 %** | 8,49 → 2,50 m | 11,95 → 10,91 m | 7 (1) → 9 (3) |
| weiter Orbit schnell | 2,5 % → 0,8 % | 4,94 → 3,35 m | 39,30 → **11,20** m | 12 (4) → 16 (11) |

**Messung B** — `tools/probe_orbit2.js`, Anker `[CX − 10 | 2,5 | CZ − 8]` = `(24 | 2,5 | −32)`,
frei stehend süd-westlich, also mit echtem Wickel-Zwang. Radius 4,5 m, 5 m/s … 6 m/s, 14 s.
⚠ Die schlimmsten Schritte sind Testaufbau (s. 9.1).

| | blockiert | maxTiefe | maxSprung | maxUmweg | ohne Säulenkontakt | Verwürfe | Rebuilds |
|---|---|---|---|---|---|---|---|
| legacy | 3 (0,2 %) | 0,37 m | 0,07 m | 15,4 m | 0 | 0 | 3 |
| pivot | 73 (5,4 %) | 5,37 m | 2,17 m | 15,4 m | 70 | 44 | 0 |
| pivot, Insert aus | 269 (18,6 %) | – | – | – | 243 | – | 0 |
| pivot, `pivotDeadEnd: rebuild` | 214 (15,9 %) | 5,37 m | 0,74 m | 15,4 m | 211 | 165 | 3 |
| pivot, Selbst-Durchdringung aus | 296 (22,0 %) | 3,00 m | 6,26 m | 15,4 m | **0** | 0 | 0 |

**Messung C** — `tools/probe_wrapclean.js`, reine Welt: siehe 9.2.

**Sweep-Zähler** (Messung B, pivot): 1441 Aufrufe, 13 Skips, 1796 Segmente, 1552 nahe Boxen,
18624 Kanten-Tests, **22 Treffer** (v0/v1-Quad-Erkennung) bzw. 15 (nach Umbau, anderer Anker),
0 Duplikate, 0 Achsen-Ablehnungen, 2–3 × `t`-Grenze, 0 × `pointFree`, 3–7 × Selbst-Durchdringung,
0 × Budget.

---

## 10b. Externe Nachprüfung — zwei meiner eigenen Schlüsse waren falsch

Ein zweites Modell hat denselben Stand (`main` = `50bb257`) unabhängig vermessen. Ich habe seine
Befunde gegen `main` nachgebaut (`tools/probe_windoracle.js`) statt sie zu übernehmen. Ergebnis:
**die Zahlen stimmen auf die Nachkommastelle**, und zwei Deutungen von mir waren falsch.

### 10b.1 Das Oracle: Umlaufwinkel gegen den topologisch erzwungenen Winkel

Hand auf Kreisbahn (θ_H = −t·V/R), Anker fest ⇒ die Route muss den Winkelunterschied als echte
Windung mitzählen. Gemessen (legacy, `main`), 16 s:

| t [s] | Runden | `Wsol` [rad] | `lengthGeo` [m] | `_lenOff` [m] | Kontakte |
|---|---|---|---|---|---|
| 1 | 0,20 | 0,32 | 5,35 | 0,00 | 0 |
| 3 | 0,60 | −2,18 | 11,75 | 0,00 | 0 |
| 5 | 0,99 | −4,68 | 17,07 | 0,00 | 3 |
| 6 | 1,19 | −5,93 | 19,75 | 0,00 | 3 |
| **7** | **1,39** | **−0,90** | **7,21** | **10,84** | **0** |
| 11 | 2,19 | −5,90 | 19,70 | 0,00 | 3 |
| **12** | **2,39** | **−0,86** | **7,08** | **10,87** | **0** |

Der Winkel folgt der Handbahn exakt — und fällt bei t = 6,07 s **schlagartig um 6,27 rad ≈ 2π**,
zweimal im Lauf, jeweils mit `rebuilds 0→1`, `wraps 3→0`, `lengthGeo 19,87 → 5,26 m`.
Größter Winkelsprung pro Substep: **6,27 rad bei t = 6,07** (legacy) bzw. **t = 11,05** (pivot).

### 10b.2 Korrektur 1 — die „V-Schlaufe" ist keine Fehlstelle

Ich hatte `maxUmweg 14,4 m` als Defekt gedeutet („das Seil behält eine Wicklung, die geometrisch
nicht mehr nötig ist") und `_pivotCleanup` gebaut, um sie aufzuräumen. **Falsch.** Bei t = 6 s ist
die Hand 1,19 Runden gelaufen; das Seil IST um die Säule gewickelt, und 19,75 m sind die korrekte
Länge für ~1,2 Windungen. Der „Umweg" ist eine Differenz gegen eine **gedächtnislose Referenz**,
die per Konstruktion keine Windung kennen kann — die Messgröße misst also die Windung und nennt
sie Müll. `_pivotCleanup` war damit ein Mechanismus, der korrekte Topologie gegen falsche
Referenz hätte „reparieren" sollen; dass er 0 von 76 Aufrufen tauschte, ist kein Versagen,
sondern Glück.

Der echte Defekt ist der **2π-Verlust** in derselben Zeile der Tabelle — und der ist in beiden
Modi derselbe Vorgang: Topologiewechsel unter Last, also exakt Meldung **M2**
(`doc/MELDUNGEN.md`).

### 10b.3 Korrektur 2 — „legacy ist bei der Längenstetigkeit 126× besser" war ein Messartefakt

`probe_wrapclean.js` maß `S.length`. Das ist `lengthGeo + _lenOff` — also der **maskierte** Wert.
Nachgemessen mit `lengthGeo`:

| | blockiert | Sprung `length` | **Sprung `lengthGeo`** | max `_lenOff` |
|---|---|---|---|---|
| legacy | 25 (1,30 %) | 0,053 m | **14,610 m** | **14,58 m** |
| pivot | 17 (0,89 %) | 6,689 m | **6,689 m** | 0,00 m |

legacy verliert also **14,61 m Geometrie in einem Substep** und versteckt das im Offset: die
Constraint zieht danach ~3,6 s lang (`resyncFade` = 4 m/s) mit 14,58 m Geisterseil, das es
geometrisch nicht gibt. pivot verliert 6,69 m und versteckt nichts. Die Reihenfolge ist damit
umgekehrt zu dem, was ich berichtet hatte: **pivot ist der ehrlichere, legacy der kaschierte
Sprung** — und beide sind weit jenseits dessen, was physikalisch zulässig wäre
(Handweg pro Substep: 0,042 m).

`probe_wrapclean.js` meldet seitdem `maxJump` (maskiert), `maxJumpGeo` (ungefiltert) und
`maxLenOff` getrennt. Alle älteren `maxSprung`-Zahlen in dieser Datei sind maskierte Werte und
damit als Stetigkeitsmaß **ungeeignet**; die Blockaden- und Umweg-Zahlen bleiben gültig.

### 10b.4 Die Kappen: welche bindet wirklich?

Drei Obergrenzen standen im Verdacht, eine Windung strukturell zu verhindern:

| Kappe | Wert | Erhöht auf | Effekt |
|---|---|---|---|
| `wrapMaxCount` | 6 | 24 | **keiner** — 7 Rebuilds, `maxKontakte` 3, Sprung 6,27 rad |
| `wrapWindMax` | 7,5 rad | 99 | **keiner** — identisch |
| `sameBox >= 3` (hartkodiert in `_tryInsertWrap`, Zeile ~1889, **kein Parameter**) | 3 | 12 | `maxKontakte` 3 → **4**, aber 7 Rebuilds und Sprung 6,27 rad bleiben |

Eine volle Runde um einen Quader braucht 4 Kantenkontakte — `sameBox >= 3` schließt sie also
strukturell aus. Das Hochsetzen ist **notwendig, aber nicht hinreichend**: Der 2π-Verlust bleibt.
Das deckt sich mit dem, was das externe Modell selbst berichtet hatte („hält zwar länger, springt
aber trotzdem um 2π. Die Obergrenze ist also nicht die einzige Ursache.").

### 10b.5 Was aus dem externen Prototyp zu lernen ist (nicht übernommen, nicht verifiziert)

Dort lief ein rein ereignisbasierter Prototyp außerhalb des Repos, der laut dessen Protokoll
10 Runden vor/zurück mit `maxWindingDiff = 0`, `blocked = 0`, `maxLenExcessOverHandStep = 0`
hielt, plus einen Fuzz über 60 Zufallswelten/216 000 Schritte mit 2,5 % blockierten Schritten.
Vier Mechanismen unterscheiden ihn von diesem Repo — drei davon decken sich mit Befunden, die
hier unabhängig erhoben wurden:

1. **Dieselbe Kante darf mehrfach vorkommen** (Windungen). Hier durch `sameBox >= 3` und die in
   `5d9d57a` eingebaute Doppelkanten-Schranke ausgeschlossen. ⚠ Meine Doppelkanten-Schranke ist
   damit **nicht** eindeutig richtig: Sie hat einen echten Defekt behoben (dieselbe Kante zweimal
   auf *demselben Punkt*, 17,64 m bei 15,69 m Soll), blockiert aber möglicherweise echte Windungen.
   Unterscheiden ließe sich das über die Windungs-Zahl pro Box statt über die Kanten-Identität.
2. **Skip-Liste:** eine gerade freigegebene Kante darf im selben Schritt nicht sofort wieder
   eingefügt werden. Ohne sie: 495 Einfügungen/Freigaben statt 15.
3. **Kontakte auf Eckpunkten als eigener Feature-Typ** mit Übergängen Kante→Ecke→Kante, gesteuert
   über `tRaw`/`elen` — nicht über „welches Kantenende ist näher". Genau das war der Grund, warum
   `_pivotEdgeHop` hier 0 Treffer hatte (Abschnitt 8.2): Er suchte die nächste *Kante* von einem
   Punkt in Kantenmitte, wo es keine gibt. Der Prototyp fragt stattdessen, ob der Berührpunkt über
   das Kantenende **hinauswandert**, und wandelt dann in einen Eckpunkt-Kontakt um.
4. **Clearance 0** in der Topologie (Seildicke gehört in die Darstellung). Hier: 0,14 m überall,
   inklusive Berührpunkt.

⚠ **Nicht übernommen, weil nicht überprüfbar:** Die Prototyp-Zahlen stammen aus dessen
Sitzungsprotokoll, der Code lag in einem Scratchpad außerhalb des Repos. Die Säulen-Ergebnisse
sind außerdem mit Vorsicht zu lesen: Dort war `toV: 0, toE: 0` — die Feature-Übergänge wurden in
der Säulenwelt also **nie ausgeübt**; die Fälle, in denen der Fuzz scheiterte (Kantenenden, Ecken),
sind genau die, die dort nicht vorkamen.

### 10b.6 Nachmessung auf `19e0775` (alle Zahlen zweimal, identisch)

Damit niemand ältere Tabellenwerte weiternutzt: Das ist der Stand nach der Wiederherstellung von
`_pivotCleanup` und nach dem Umbau von `probe_wrapclean.js` auf `lengthGeo`.

`tools/probe_wrapclean.js` (reine Welt, 1920 Schritte, `V=5 R=4 T=16`):

| | blockiert | maxTiefe | Sprung `length` | **Sprung `lengthGeo`** | max `_lenOff` | maxUmweg |
|---|---|---|---|---|---|---|
| legacy | 25 (1,30 %) | 2,38 m @ t=6,06 | 0,053 m | **14,610 m** | **14,58 m** | 14,59 m |
| pivot | 17 (0,89 %) | 4,53 m @ t=6,02 | 6,689 m | **6,689 m** | 0,00 m | 14,40 m |

`tools/probe_windoracle.js` über **40 s = 8 Runden** (`V=5 R=4 T=40`):

| | größter Winkelsprung | Rebuilds | Kontakt-Verwürfe | max Kontakte | max `_lenOff` |
|---|---|---|---|---|---|
| legacy | 6,27 rad @ t=21,13 | **7** | 0 | 3 | **11,40 m** |
| pivot | 6,27 rad @ t=16,08 | 0 | **17** | 3 | 0,00 m |

`test_sim.js` 20c (1,6 Runden, arretiert als XFAIL):

| Assertion | legacy | pivot | Ziel |
|---|---|---|---|
| Wicklung erhalten | 6,27 rad @ t=6,07 (1 Rebuild, max 3 Kontakte) | 3,13 rad @ t=6,03 (3 Verwürfe) | < 0,5 rad |
| Pfadlänge springt nicht weiter als die Hand läuft | 14,610 m @ t=6,07 | 6,689 m @ t=6,03 | < 0,083 m |

Beide Modi verlieren **dieselbe** Windung, nur über verschiedene Mechanismen: legacy über den
Sackgassen-Neuaufbau (mit `_lenOff`-Kaschierung), pivot über die Selbst-Durchdringungs-Regel
(ohne Kaschierung). `max Kontakte = 3` in beiden — das ist die hartkodierte `sameBox >= 3`-Kappe.

### 10b.7 Wohin das geführt hat

Aus diesem Stand ist **`doc/HANDOFF.md`** entstanden: der Einstieg für jemanden, der das Repo ohne
Chatverlauf übernimmt (neues Modell im App Builder, frische Agent-Session, Mensch nach Pause).
Dort stehen Erste Amtshandlung, Lesereihenfolge, die fünf Prioritäten mit ihren Zahlen, die
„nicht anfassen"-Liste, die Werkzeugtabelle, die Arbeitsregeln und die Pages-Bedienung.

---

## 11. Commits dieser Session

| Commit | Inhalt |
|---|---|
| `06479a4` | v0 (`232bf29`) unverändert auf `728226f` cherry-picked (Range-Diff `=`) |
| `5d9d57a` | **Pivot-Solver v2**: `edgeCross2D` exakt; `tools/test_edgecross.js`, `tools/ref_edgecross.js`, `tools/probe_orbit2.js`; Doppelkanten-Schranke im Blocker-Insert; Sweep jeden Substep über alle 12 Kanten; Freigabe = Kegel UND Sehne; Selbst-Durchdringung nur tief; Blocker-Insert bleibt an; Messprotokoll A+B im Kommentarkopf von `ROPE_DEFAULTS` |
| `e87ab17` | **Eckübergang als Ursache ausgeschlossen**: Befunde 8.1–8.4; `_pivotEdgeHop` gebaut, gemessen, entfernt (Befund-Block bleibt); `pivotDeadEnd`-Schalter; `tools/probe_blocked.js`; pivot-Bedingung für `_cornerSlide` korrigiert |
| `077c1cf` | **Reine Testwelt + V-Schlaufe**: `tools/probe_wrapclean.js`, `tools/probe_worst.js`; `_pivotCleanup` mit Homotopie-Schranke; `_freshRoute`-Schleifenversuch zurückgenommen (Befund im Kommentar); Messung C und V-Schlaufen-Befund im Kommentarkopf; `index.html` 360,8 KB |

Suite am Ende: `test_sim` 208/208, `test_wrap` 9 + 4 XFAIL, `test_replay`, `test_browser`,
`check_panel` (29 Slider + 6 Schalter), `test_edgecross` 31/31 — alle grün.
`index.html` gebaut: 372 116 Bytes auf Platte (build.py meldet 360,8 KB).

### Repo-Aufräumen (zwei Runden, auf Rückmeldung des Nutzers)

Anlass: Bilddateien und Dopplungen blähen das Repo auf, wenn es als Kontext geladen wird.
Inventur vorher: **42 Dateien, 1800,8 KB** Working Tree, `.git` 1,4 MB.

| Runde | Was | Größe |
|---|---|---|
| `a86db17` | `uploads/` gelöscht (7 Bilder: Nutzerskizze, zwei weitere Skizzen, drei Videoframes vom 2026-10-10). Referenziert ausschließlich in Kommentaren, die denselben Inhalt in Worten trugen; die Skizze ist als Test **W9** in `test_wrap.js` maschinenlesbar vorhanden. 4 Referenzen umgeschrieben. | −618 KB |
| `a86db17` | Messprotokoll aus `src/02_rope.js` in diese Datei verlegt: 148 Zeilen über `wrapSolver`, 148 Zeilen Befund-Block bei `_segBoxBeyond`, Prosa der `edgeCross2D`-Doku. Im Code bleiben die ~20 Zeilen, die man zum Ändern braucht (Schalterzustände, Kopfzahl jeder Messung, Formel + die beiden Fallen `|d|²` und Residual-Pflicht). `02_rope.js` 173,5 → 157,4 KB, Kommentaranteil 25 % → 22 %. | −16 KB |
| `a86db17` | `tools/probe_worst.js` gelöscht — `probe_orbit2.js` (`jumpInfo`, `detourTrace`) und `probe_blocked.js` liefern dasselbe. | −4 KB |
| Folge-Commit | `grapple/index.html` nicht mehr versioniert (345 KB, enthielt den gesamten `src`-Code noch einmal). Stattdessen `.github/workflows/pages.yml`: baut beim Push auf `main` mit `python3 grapple/tools/build.py` (nur Python-Stdlib) und veröffentlicht das Repo auf GitHub Pages. `grapple/.gitignore` neu, Wurzel-`.gitignore`-Hinweis korrigiert, README an drei Stellen. | −345 KB |

**Nachher: 35 Dateien, 804,7 KB** — von 1800,8 KB, also **−55 %**, ohne dass eine Information
verloren ging. Bilder bleiben in der Git-Historie (kein Rewrite, kein Force-Push auf `main`).

Bewusst behalten: `doc/architektur.svg` (11,6 KB, von README und ARCHITEKTUR verlinkt, SVG ist
Text) und `tools/fixtures/demo_orbit.json` (64,7 KB, Replay-Regression R2).

⚠ **Pages-Voraussetzung:** im Repo unter *Settings → Pages* muss „Source: GitHub Actions" stehen.
Der Workflow triggert nur auf `push` nach `main` (plus manuell), weil exakt der main-Stand
veröffentlicht werden soll — bis zum nächsten Merge nach `main` liefert Pages den zuletzt
dort gebauten Stand.

**Keine „vielen Maps":** Das Repo hat eine Level-Datei (`src/06_level.js`, 7,4 KB) und das Spiel
baut genau **eine** Welt (`07_game.js`: `new World()` + `buildLevel()` je einmal). Die „Zonen"
dort sind Bereiche derselben durchgehend begehbaren Karte, und `spots` sind **Teleport-Marker**
(Name + Position + Blickwinkel, anwählbar über die Zifferntasten 1–9 und Buttons im HUD) — keine
umschaltbaren Umgebungen. Was wie mehrere Welten aussieht, sind die Test-Suiten: `test_sim.js`
baut 45 Mini-Welten (je Assertion Boden + ein Hindernis), und drei Werkzeuge bauen eine eigene
Welt (`probe_wrapclean`, `test_edgecross`, `test_replay`).

---

## 12. Aktueller Stand der Schalter (`ROPE_DEFAULTS` in `src/02_rope.js`)

```js
pivotSelfPenRule:  'margin',  // 'margin' = Auflagebereich-Regel, 'off' = aus
pivotDeadEnd:      'off',     // Sackgassen-Neuaufbau + Resync im pivot-Modus; 'rebuild' = an
pivotCornerSlide:  false,     // Eck-Übergang im pivot-Modus (gemessen: 0 Aufrufe, wirkungslos)
pivotSelfPenDepth: 0.5,       // Anteil der Querschnittsdiagonale, ab dem Selbst-Durchdringung killt
wrapSolver:        'legacy',  // ← ausgeliefert. 'pivot' ist das Experiment.
pivotHoldTol:      0.05,      // Toleranz des Kraftkegel-Tests
wrapWindTol:       0.6,       // rad — Umlaufwinkel-Schwelle (lokale Freigabe UND _pivotCleanup)
```

Die pivot-Schalter sind **nicht** im UI-Panel verdrahtet (`check_panel.js` zählt unverändert
29 Slider + 6 Schalter). A/B läuft über Umgebungsvariablen der Sonden
(`MODE`, `DEADEND`, `SELFPEN`, `DEPTH`, `CORNER`) bzw. über `Object.assign` auf `ROPE_DEFAULTS`.

**Aufgabenteilung Code ↔ Doku (seit `00b4aec` + Aufräum-Commit):** Der Kommentarkopf über
`wrapSolver` in `ROPE_DEFAULTS` enthält nur noch die ~20 Zeilen, die man beim Ändern dieser
Schalter braucht (was an/aus ist, die Kopfzahl jeder Messung, wo der Rest steht). Herleitungen,
Einzelzahlen, Fehlversuche und die offene Entscheidung stehen **nur hier**. Dasselbe gilt für den
Befund-Block bei `_segBoxBeyond` (`_pivotEdgeHop`) und die Doku von `edgeCross2D` (Formel +
die beiden Fallen `|d|²` und Residual-Pflicht bleiben im Code, der Rest hier).

Grund: `src/02_rope.js` war auf 173,5 KB angewachsen, davon 18,3 KB Messprotokoll, das inhaltlich
identisch in dieser Datei stand. Wer das Repo als Kontext lädt, zahlt das doppelt. Nach dem
Umräumen: 157,4 KB, Kommentarzeilen 25 % → 22 %.

---

## 13. ~~Offene Entscheidung~~ — gegenstandslos, siehe 10b.2

**Dieser Abschnitt ist überholt.** Die V-Schlaufe war keine Fehlstelle, sondern die korrekte
Windung nach einer vollen Runde; die Frage „darf das Seil sich gerade ziehen?" stellte sich damit
nicht. Der echte Defekt ist der 2π-Verlust pro Runde (Abschnitt 10b.1), und der ist **keine**
Produktentscheidung, sondern ein Bug: Das Seil verliert eine Windung, die es hat, und die
Constraint zieht danach Sekunden mit Geisterseil. Ursprünglicher Text zur Nachvollziehbarkeit:

**Die V-Schlaufe.** Hand und Anker auf derselben Seite, direkte Linie frei, das Seil hat 14,20 m
Umweg um die falsche Seite. Vier Möglichkeiten, die dem Nutzer vorgelegt wurden (Antwort stand am
Ende dieser Session noch aus):

| Option | Verhalten | Risiko |
|---|---|---|
| **Nur bei schlaffem Seil** *(Vorschlag)* | Gerade ziehen, wenn das Budget deutlich länger als der Pfad ist (keine Spannung). Unter Zug bleibt die Wicklung. | Trennt die Fälle physikalisch statt über Sichtlinien; braucht einen sauberen Slack-Begriff im Solver (liegt in `Rope`, nicht im `RopePathSolver`). |
| Immer gerade ziehen | Direkte Linie frei + beide Enden auf derselben Seite ⇒ entwirren. | Reintroduziert den gemeldeten Skizzen-Fehler. |
| Nichts ändern | Status quo. | Kein Teleport, aber die Schlaufe bleibt sichtbar. |
| Hinter einem Panel-Schalter | Beide Varianten einbauen, Nutzer spielt beide. | Aufwand; Panel muss erweitert werden (`check_panel.js` anpassen). |

---

## 13b. Neue Prioritäten nach 10b

1. **Den 2π-Verlust beheben** — das ist Meldung M2 und betrifft **beide** Modi, also das
   ausgelieferte Spiel. Arretiert als `test_sim.js` 20c (4 XFAIL). Ansatzpunkt: eine volle Runde
   um einen Quader braucht 4 Kantenkontakte, `sameBox >= 3` erlaubt 3. Hochsetzen allein reicht
   nicht (10b.4) — nötig ist, dass der Neuaufbau die Windung **erhält** statt sie zu verwerfen,
   oder dass er gar nicht erst auslöst.
2. **`_lenOff` als Kaschierung prüfen.** 14,58 m Geisterseil über ~3,6 s sind ein eigener Befund,
   unabhängig von der Ursache des Sprungs. Die Constraint zieht mit einer Länge, die die Geometrie
   nicht hergibt.
3. **Doppelkanten-Schranke aus `5d9d57a` überprüfen.** Sie blockiert möglicherweise echte
   Windungen (10b.5, Punkt 1). Kriterium müsste Windungszahl pro Box sein, nicht Kanten-Identität.
4. Eckpunkt-Kontakte als eigener Feature-Typ mit Übergängen über `tRaw`/`elen` (10b.5, Punkt 3) —
   das ist der Mechanismus, an dem `_pivotEdgeHop` gescheitert ist.
5. Längenstetigkeit von pivot: nur noch 6,689 m gegen legacy 14,610 m — **und** legacy kaschiert
   seinen Sprung, pivot nicht. Der alte Punkt 1 („pivot auf 0,053 m bringen") war auf einem
   Messartefakt gebaut und ist gestrichen.
6. Unverändert: Biegesteifigkeit der Kette plus Nahfeld-Pass (rein visuell).

## 14. ~~Nächste Schritte, priorisiert~~ (überholt durch 13b)

1. **Längenstetigkeit von pivot** (größter messbarer Rückstand). Wenn die Selbst-Durchdringungs-
   Regel einen Kontakt verwirft, muss seine Auslenkung in `_lenOff` (Fade mit `resyncFade`) gehen
   statt sofort aus `lengthGeo` zu verschwinden. Ziel: `maxJump` von 6,689 m in die Nähe der
   legacy-0,053 m. Zweiter Beiträger: `releases` mit Sprung (pivot 3 gegen legacy 0 in Messung C;
   12–13 gegen 1–4 in Messung A) — dieselbe Baustelle.
2. **V-Schlaufe** — Entscheidung abwarten (Abschnitt 13), dann in **beiden** Modi umsetzen und an
   `probe_wrapclean.js` messen. Das betrifft das ausgelieferte Spiel, nicht nur den Versuchsbranch.
3. **Lokales Neulegen der Route** um eine blockierende Box (kürzeste freie Route bei gleicher
   Homotopieklasse) **oder** Eckpunkte als eigenständige Kontakte. Das ist der Punkt, an dem pivot
   architektonisch weiterkommt; beides ist größer als eine Reparatur. Ohne diesen Schritt bleibt
   pivot auf den Blocker-Insert plus die legacy-Pflaster angewiesen und ist damit nicht besser als
   legacy — nur anders.
4. Erst wenn 1–3 stehen: Pflaster-Abbau im pivot-Modus, und zwar nur gegen grüne W5–W8 in
   `test_wrap.js` (Prozessregel aus der Fremd-Analyse). Dann `_releaseTopoOK`, Bogus-Drop und
   Sackgassen-Neuaufbau streichen.
5. Offen aus der Fremd-Analyse, von der Vorsession nicht mehr angefasst: Biegesteifigkeit der Kette
   plus Nahfeld-Pass (Node `i ↔ i+2`-Abstands-Constraint, tangential gepinnter Start) gegen den
   Knick direkt hinter der Kamera.

---

## 15. Nicht wiederholen — Liste der verworfenen Wege

| Versuch | Ergebnis |
|---|---|
| pivot **ohne** Blocker-Insert (nur Sweep) | 18,6 % blockiert, 243 von 250 ohne jeden Säulenkontakt |
| `pivotDeadEnd: 'rebuild'` (Neuaufbau + Resync im pivot-Modus) | 15,9 % blockiert, 165 Verwürfe — schlechter als `off` |
| Selbst-Durchdringungs-Regel ganz aus | 22,0 % blockiert (die falsche Wicklung bleibt dann ewig stehen) |
| Selbst-Durchdringung als harter Schnitttest (`_segThroughBox`) | frisst die Wicklung: 7 von 22 Sweep-Treffern abgelehnt, 132 Blockaden ohne Kontakt |
| Tiefenstaffelung der Selbst-Durchdringung (0,1 … 1,0 × ½ Diagonale) | keine Änderung — die Durchdringungen sind tief, nicht flach |
| `_pivotEdgeHop` (Kantenwechsel an der Ecke), zwei Fassungen | 0 Treffer; an einer senkrechten Kante in halber Höhe gibt es keine „nächste" Ecke. **Nachtrag 10b.5:** der externe Prototyp löst genau das anders — Eckpunkt als eigener Kontakt, Übergang gesteuert über `tRaw`/`elen` statt über „welches Ende ist näher". Der Weg war also nicht falsch, nur unvollständig |
| Eck-Bisectrix in `edgeTouchPoint` | wirkungslos; `boxEdge` liefert `outN` längst als Bisectrix |
| `_freshRoute` in einer Schleife frei lösen | Referenz repariert, Ergebnis unverändert, 125 → 4805 Verwürfe, 14 s → 26 s |
| `_pivotCleanup` mit Schranke „Live-Winkel ≈ 0" | hält 50 von 52 Aufrufen; das Zickzack windet selbst ±π/2 |
| `edgeCross2D` über Determinanten-Koeffizienten (`E,F,G,H,K`), vier Varianten | plausible, aber falsche Treffer; `P ≠ q`. Erst die Residual-Pflicht hat es gezeigt |
| `edgeCross2D` über bilineares Flächen-Schnittverfahren (Patch in `s,t` + Newton) | bricht ab: Jacobi-Determinante ~1e−13 im Wickel-Fall |
| Newton-Politur auf `(s,t)` als Ersatz für gute Startwerte | konvergiert nicht zuverlässig; die exakte Bestimmung über `t = ((q−a(s))·d)/|d|²` ist billiger und stabiler |
| Orbit-Messung **ohne** Maske „gültige Hand" | misst den Testaufbau: 19 % „blockiert" bei legacy sind die Hand in der Säule |
| `maxJump` aus `S.length` als Stetigkeitsmaß | **Messartefakt** — `length` ist `lengthGeo + _lenOff` und damit maskiert. legacy: 0,053 m statt 14,610 m. Seit 10b.3 wird `lengthGeo` gemessen |
| „V-Schlaufe" als Defekt gedeutet und `_pivotCleanup` dagegen gebaut | War die korrekte Windung nach einer vollen Runde; die Referenz kennt per Konstruktion keine Windung. Siehe 10b.2 |
| Orbit mit Anker **auf** der Säule (`test_wrap.js`-Spot) | die Sehne kann die Säule nie schneiden — es gibt dort nichts zu wickeln |
| Orbit mit Anker **auf der Handbahn** | 6,6-m-Sprünge aus reiner Messgeometrie (Hand läuft fast durch den Anker) |

---

*Stand: 2026-10-13, `feature/pivot-solver` = `077c1cf`, `main` = `728226f`.*

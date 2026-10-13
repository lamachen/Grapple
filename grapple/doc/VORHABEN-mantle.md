# Vorhaben — Mantle/Vault: Ergebnis folgt aus den Kontaktbedingungen

**Status: geplant, nicht gebaut.** Dieses Dokument ist die Spezifikation. Es wurde bewusst
*vor* der Implementation geschrieben, auf ausdrücklichen Wunsch des Projekteigners.

**Autor des Entwurfs:** Projekteigner (Vorgabe und beide Referenzszenarien), 2026-10-13.
**Niedergeschrieben und mit Messwerten unterlegt** am Stand `main` = `426a166`.

---

## 1. Ist-Zustand, gemessen

`tools/probe_vault.js` (Commit `426a166`) hat die Mechanik zum ersten Mal überhaupt vermessen.
Vorher: **0 Tests, 0 Doku, 0 Panel-Schalter.**

| Szenario | Wandkontakt | `_probeLedge` | Vault-Auslösungen | maxY | über die Kante |
|---|---|---|---|---|---|
| aus dem Stand, 2,0-m-Block | 9 Schritte | 8 | 1 | 1,37 m | **nein** |
| Anlauf, 1,2-m-Block, kein Sprung | 262 | 0 | 0 | 0,86 m | nein |
| Anlauf + voller Sprung, 2,4-m-Block | 40 | 28 | 3 | 3,26 m | **ja**, landet bei x = 16,03 |
| Anlauf + Jump-Cut, 2,4-m-Block | 243 | 0 | 0 | 1,36 m | nein |

Code: `src/03_player.js` ~317 (`/* ---- Vault / Ledge-Assist (Kraft, keine
Positions-Teleportie) ---- */`) und `_probeLedge()` ~451. Parameter seit dem Initial-Commit
`2815ae3` **zeichenidentisch**:

```js
vault: { enabled: true, minHeight: 0.30, maxHeight: 2.40, strength: 34, damping: 9.0, duration: 0.6 }
```

### 1.1 Historische Prüfung: Gab es je eine Nick-Animation?

**Nein.** Beleg, nicht Vermutung:

* `vault` kommt in **allen 36 Commits ausschließlich in `03_player.js`** vor — in `07_game.js`
  und `04_render.js` kein einziges Mal (Zählung je Commit: `game=0 render=0 player=16`).
* `dip` (der einzige Kamera-Kanal, der ein Nicken erzeugen könnte) wird an genau zwei Stellen
  angestoßen: Landung (`this.dipVel -= impact * 9.5`, `03_player.js:416`) und Seilzug
  (`this.player.dipVel += 2.0*s`, `07_game.js:589`). **Nie vom Vault.**
* `pitch` wird ausschließlich von `look()` geschrieben (`03_player.js:101–107`), also nur durch
  Spieler-Input. Die Kamera entsteht aus `qFromYawPitch(P.quat, P.yaw, P.pitch)` plus Roll
  (`07_game.js:635`).

### 1.2 Warum es sich trotzdem „schwächer als zu Beginn" anfühlt

Drei Ursachen, alle im Code belegbar — es fehlt nichts, es war nie mehr da:

1. **`gScale *= 0.15`** während des Vaults (`03_player.js:330`). Die Schwerkraft wird auf 15 %
   gesenkt. Zusammen mit einer Feder, die 0,6 s sanft gegen ein Ziel zieht, ist „levitieren"
   / „rüber rutschen" / „kaum merklich" die zutreffende Beschreibung des Ist-Zustands.
2. **Null Kamera-Feedback.** Der Vault schreibt keinen der vier vorhandenen Kanäle: kein `dip`,
   kein `roll`, kein `pitch`, kein `fovKick`. Jede andere markante Bewegung im Spiel tut das
   (Landung: dip + fovKick + landFlash; Wallrun: rollVel; Seilzug: rollVel + dipVel + fovKick).
3. **Relativer Kontrast.** `07603b7` hat die übrige Charakter-Physik umgebaut (Jump-Cut,
   `ropeJumpUsed`, griffiger Sprint-Stopp 9,8 m/s → 0 in 0,32 s). Der Vault blieb unberührt und
   ist damit der weichste Teil der Bewegung.

**Gemeinsame Wurzel:** Es gibt genau EIN Verhalten für alle Kantenhöhen und alle
Ankunftsgeschwindigkeiten — eine Feder mit fester Stärke und fester Dauer. Die empfundene
„Stärke" kann deshalb nicht zur Situation passen, sie ist immer dieselbe.

---

## 2. Zielbild

> **Authentizität. Das Ergebnis folgt aus dem Arbeitsaufwand, der für diese Bewegung
> realistisch nötig ist.**

Nicht „Stärke hoch/runter", sondern: **Verschiedene Bedingungen beim Kontakt ergeben
verschiedene Bewegungen.** Die Mechanik ist eine Familie von Ergebnissen, keine Zahl.

### Die beiden Referenzszenarien des Projekteigners (im Wortlaut)

**A — der Misserfolgsfall.** „Wer an eine Kante springt und sich nur mit ausgestreckten Armen
noch so eben an der Oberkante greifen kann, der knallt erst einmal lediglich gegen die Wand im
ersten Moment — da kann kein Nach-oben-Ziehen stattfinden."

**B — der Erfolgsfall mit Schwung.** „Ganz anders ist es, wenn man quasi ‚von Dach zu Dach'
springt und bereits mit Vorwärtsgeschwindigkeit und auf Bauchhöhe an die Kante der Wand ankommt:
Da wäre es authentisch, durch die Vorwärtsbewegung und deren Schwung und ein kurzes Abstützen der
Hände, einem Bein vielleicht bereits oben auf der Kante stehend, mit dem anderen Bein vielleicht
mit dem Knie gegen die oberste Wandfläche ankommend, durch ein kurzes Verlangsamen der
Vorwärtsgeschwindigkeit in einer Art Hocke an der Oberkante anzukommen und direkt in einer
durchgehenden Bewegung wieder aufzurichten und weiterzurennen."

Der entscheidende Unterschied zwischen A und B ist **nicht** die Kante — beide haben dieselbe
Höhe. Er liegt in der **Ankunft**: Wo am Körper die Kante getroffen wird, und wie viel
Vorwärtsimpuls vorhanden ist.

---

## 3. Bedingungsraum

Vier Größen entscheiden. Alle sind zur Kontaktzeit bereits verfügbar oder billig zu erheben:

| Größe | Bedeutung | Quelle |
|---|---|---|
| `dh` | Höhendifferenz Fuß → Oberkante (heute `minHeight 0.30 … maxHeight 2.40`) | `_probeLedge` |
| `dBody` | **NEU:** Höhe der Kante relativ am Körper — Fuß / Knie / Hüfte / Bauch / Brust / ausgestreckte Arme | `hit.t` gegen `feetY`, `pos[1]`, `eyeY` |
| `vFwd` | Vorwärtsimpuls in Wandrichtung | `vdot(vel, wallNormal)` bzw. `hSpeed` |
| `vUp` | vertikale Geschwindigkeit beim Kontakt (heute als Gate `vel[1] > 3.2`) | `vel[1]` |

`dBody` ist der Punkt, der heute fehlt: `_probeLedge` misst nur `dh` gegen die **Füße** und
verwirft alles über 2,40 m. Damit ist Szenario A (Kante auf Armlänge über dem Kopf, `dh` ≈ 2,4 m,
aber `dBody` = „nur noch mit den Fingerspitzen") von einem hohen Sprung an eine niedrige Kante
nicht zu unterscheiden.

---

## 4. Ergebnisklassen

Kein Kontinuum mit einer Stärke, sondern unterscheidbare Ausgänge. Reihenfolge nach
`dBody` von „Kante weit über dem Körper" nach „Kante unter Bauchhöhe", bei jeweils passendem `vFwd`:

| # | Bedingung | Ergebnis | Kamera |
|---|---|---|---|
| **A** | `dBody` = Arme ausgestreckt, `vFwd` gering | **Misserfolg.** Impakt an der Wand, kein Zug nach oben. Greifen mit den Fingerspitzen trägt das Körpergewicht nicht. Abprallen/Hängenbleiben und Fallen ist das korrekte Ergebnis | Lande-`dip`, kein Ziel-Look |
| **A′** | `dBody` = Arme, aber `vFwd` hoch | **Dyno/Überschwung.** Der Vorwärtsimpuls trägt den Körper über die Kante, die Hände sind nur Führung. Kein Hang, kein Drücken | Blick folgt der Kante, `roll` aus lateraler Beschleunigung |
| **B** | `dBody` ≈ Bauch, `vFwd` hoch | **Speed-Vault (Szenario B).** Kurzes Abstützen der Hände, ein Bein oben auf der Kante, anderes Knie gegen die Wandfläche, Vorwärtsgeschwindigkeit kurz verlangsamt, Landung in der Hocke, **durchgehende Bewegung** ins Weiterrennen | `dip` in der Hocke, Aufrichten mit `dip` zurück, kein erzwungener Blick |
| **C** | `dBody` ≈ Hüfte/Brust, `vFwd` mittel | **Vault.** Aufstützen, Beine durchschwingen, ein Bewegungsfluss | leichte `dip` |
| **D** | `dh` groß, `vFwd` gering, `dBody` ≈ Brust/Kopf | **Mantle.** Hang mit Geschwindigkeitsverlust bis kurzem Stillstand, dann Drücken nach oben — langsam anlaufend, schneller werdend, mit Schwung | **Blick zur Kante**, `dip`-Kick beim Drücken (das Nicken) |
| **E** | `dh` > Obergrenze | kein Vault, Wandimpakt, fallen | Lande-`dip` |

Kern der Unterscheidung: **A und B haben dieselbe Kante und sehen völlig anders aus.**

---

## 5. Bewegung je Klasse (Skizze, keine fertigen Zahlen)

* **Impakt (A, A′, E):** Horizontaler Impuls wird an der Wand umgesetzt — bestehender
  Kapsel-Resolver, plus `dipVel`-Kick proportional zu `|vFwd|`. Kein Zug nach oben, wenn
  `dBody` = Arme und `vFwd` gering: Die Kraft reicht physikalisch nicht, und das Spiel soll das
  sagen, statt es zu kaschieren.
* **Hang (D):** Horizontaler Impuls geht `dh`-abhängig verloren (0,3 m → ~70 % behalten,
  2,4 m → ~0 %, kurzer Stillstand). **`gScale` bleibt 1,0** — wer hängt, hängt. Das ist die
  direkte Korrektur an `gScale *= 0.15`.
* **Drücken (D):** Aufwärtskraft mit **Ease-in** (langsam anlaufend, dann schneller, Schwung nach
  oben), Dauer `dh`-abhängig. Dazu `dipVel`-Kick = das Nicken, und kleiner `fovKick`.
* **Flow (B, C):** Kein Hang, keine Feder mit fester Dauer. Vorwärtsgeschwindigkeit wird kurz
  reduziert (Hocke), dann in **einer** durchgehenden Bewegung wieder aufgerichtet. `dip` für die
  Hocke, zurück fürs Aufrichten. Ziel: „weiterrennen", nicht „ankommen und neu anfangen".
* **Fang:** Kurzes Abfedern beim Aufkommen, Übergabe an die normale Laufphysik ohne
  Geschwindigkeitsbruch.

---

## 6. Kamera: `aimLayer` als wiederverwendbarer Baustein

Vom Projekteigner vorgeschlagen und ausdrücklich als **genereller Mechanismus** gedacht, nicht als
Vault-Sonderlösung:

> „Die allgemeine Richtung gibt manchmal das System vor in gewissen Situationen, und definiert
> auch vielleicht die Stärke der Abweichung, die erlaubt wird im lokalen Raum. […] Der Spieler
> kann aber stets eine Art ‚lokale Orientierung' weiterhin steuern, damit es sich nicht steif und
> vom System gesteuert anfühlt."

Und die Grenze, die nicht überschritten werden darf:

> „Nie sollte der Kopf komplett von einer Animation gesteuert werden."

### Entwurf

`this.aim = null` im Normalfall — dann verhält sich die Kamera **exakt** wie heute (wichtig für
Replay-Determinismus und für die bestehenden Blick-Modi: Pointer-Lock, Blick-Modus, Drag-Look,
Orbit-Kamera).

```js
aim = {
  dir,        // Welt-Zielrichtung (Einheitsvektor), z. B. Auge → Kantenpunkt
  w,          // 0…1 Einblendgewicht
  coneYaw,    // erlaubte lokale Abweichung in rad (immer > 0 — nie volle Übernahme)
  conePitch,
  centerRate, // 1/s — wie schnell die lokale Abweichung von selbst zur Mitte driftet
  rate,       // 1/s — wie schnell die Kopplung ein- und ausblendet
}
```

* Maus-Input geht während des Zielens in `aimLocal{Yaw,Pitch}` **statt** in `yaw/pitch`
  (`look()` in `03_player.js:101` ist der einzige Schreibort heute).
* Lokale Abweichung wird auf den Kegel begrenzt und driftet mit `centerRate` zur Mitte.
* Beim Ausblenden wird der Restwert **stetig** in `yaw/pitch` zurückgefaltet, damit der Blick
  nicht springt.
* `pitch`-Grenze heute: `clamp(pitch, −1.45, 1.45)`.

### Anwendungsfälle (derselbe Baustein, verschiedene `dir`)

| Situation | `dir` | `w` | Kegel |
|---|---|---|---|
| Mantle (D) | Auge → Kantenpunkt | hoch während Griff+Drücken | eng, z. B. ±25° yaw / ±15° pitch |
| Speed-Vault (B) | Flugbahn / Landepunkt | niedrig | weit |
| Landung | Horizont | sehr niedrig, kurz | sehr weit |
| Seilschwung | Anker | niedrig | weit |
| Wallrun | Wandrichtung | niedrig | mittel |

### Bestehende Kanäle, die angezapft werden können

`dip`/`dipVel` (Feder-Dämpfer, `clamp(−0.55, 0.35)`, wirkt auf `eyePoint` **Position**, nicht auf
Pitch — also ein Ducken, kein Nicken), `roll`/`rollVel` (Feder-Dämpfer, wirkt über
`qRotateLocal(..., P.roll*0.055)`), `fovKick`, `landFlash`. **Ein echtes Nicken braucht den
`aimLayer`** (oder einen Pitch-Offset-Kanal), weil `dip` nur die Augenhöhe verschiebt.

---

## 7. Was es zu erhalten gilt

| Baustelle | Warum |
|---|---|
| `test_replay.js` **R2 bricht** | Physik ändert sich ⇒ Fingerabdruck ändert sich. Bewusst neu aufnehmen mit `node tools/replay.js tools/fixtures/demo_orbit.json --runs=2 --write-fingerprint` und **im Commit begründen** (README, Falle 3) |
| `test_sim.js` Sektion 18 | Sprung-Integrität, Jump-Cut, Sprint-Stop — muss grün bleiben |
| `test_sim.js` 20a | Struktur-Integrität: fängt fehlende Methoden. Gerade erst nötig geworden, weil `_pivotCleanup` unbemerkt gelöscht wurde |
| Bestehende Blick-Modi | Pointer-Lock, Blick-Modus (`freeLookSensScale`), Drag-Look, Orbit-Kamera (`07_game.js:625`) dürfen nicht kippen |
| `probe_feel.js`, `probe_vault.js` | Vorher/Nachher damit messen, nicht nach Gefühl urteilen |

---

## 8. Abnahmekriterien — messbar, nicht gefühlt

Jede Zeile wird eine Assertion in `tools/test_sim.js` (neue Sektion) und/oder ein Szenario in
`tools/probe_vault.js`. Die Idee: **Klassen müssen unterscheidbar sein**, sonst ist nichts gewonnen.

1. **A:** hohe Kante (`dh` ≈ 2,4 m), geringer `vFwd` ⇒ `vaulting` bleibt false, Spieler berührt
   die Wand, `maxY` < Kante, endet am Boden vor der Wand.
2. **B:** `dh` ≈ Bauchhöhe, `vFwd` hoch ⇒ Spieler ist nach ≤ 1,5 s hinter der Kante **und** behält
   ≥ 70 % seines `hSpeed`.
3. **C:** `dh` ≈ 1,2 m, `vFwd` mittel ⇒ oben in ≤ 1,0 s, ≥ 80 % `hSpeed` behalten.
4. **D:** `dh` ≈ 2,0 m, `vFwd` gering ⇒ Hang-Phase messbar (≥ 0,15 s mit `|vel|` < 0,5 m/s),
   danach `maxY` > Kante, und `dip` schlägt während des Drückens aus.
5. **Klassen unterscheidbar:** A, B und D liefern **verschiedene** Kennzahlen (Hang-Dauer,
   `hSpeed`-Erhalt, `dip`-Amplitude) — nicht nur verschiedene Konstanten desselben Verlaufs.
6. **Kamera bleibt beim Spieler:** Während des Mantle beträgt die maximale Abweichung zwischen
   tatsächlichem `pitch` und freier `pitch`-Eingabe ≤ Kegel + Toleranz; nach Ende der Kopplung ist
   die Abweichung stetig abgebaut (kein Sprung größer als ein Substep-Input).
7. **Kein Levitieren:** Während des Hangs ist `gScale` = 1,0 (Assertion auf den Zustand, nicht auf
   das Gefühl).
8. **Replay:** R1 deterministisch (zwei Läufe identisch), R2 mit **neu begründetem** Fingerabdruck,
   R3 keine tiefe Penetration.

---

## 9. Offene Fragen und Risiken

1. **Kein IK, kein Viewmodel.** `07_game.js` trägt den Kommentar „Kein Viewmodel — bewusste
   Entscheidung, kein Platzhalter aus Box-Primitiven". Szenario B („ein Bein oben auf der Kante,
   anderes Knie gegen die Wand") ist ohne IK **nicht sichtbar** — es lässt sich nur über Kamera
   (`dip`, `roll`, `aimLayer`) und über die Bewegung des Körpers transportieren. Zu klären:
   reicht das, oder ist ein Viewmodel/IK-Arm eine Voraussetzung?
2. **`dBody` braucht Körperreferenzpunkte.** `feetY` und `eyeY` gibt es; Knie/Hüfte/Brust müssten
   als Anteile von `halfHeight`/`radius` definiert werden. Das ist Konvention, keine Messung —
   die Zahlen müssen einmal festgelegt und dann begründet werden.
3. **Bestehende Gates widersprechen dem Entwurf.** `if (this.vel[1] > 3.2) return null;`
   (steigt schon ⇒ kein Vault) und `!attached` (am Seil kein Ledge-Assist, seit dem
   Initial-Commit) sind heute harte Ausschlüsse. Ob sie im neuen Modell bleiben, ist offen —
   `!attached` insbesondere: Am Seil an eine Kante zu kommen ist ein realistischer Fall.
4. **`maxHeight = 2.40`** schließt Szenario A aus, bevor es unterschieden werden kann. Die Grenze
   muss fallen oder `dBody` muss sie ersetzen.
5. **Umfang.** Geschätzt 250–350 Zeilen über `03_player.js` und `07_game.js` plus Tests. Der
   `aimLayer` ist davon der Teil, der später mehrfach trägt — er sollte zuerst gebaut und an
   *einer* Situation bewiesen werden, nicht an fünf gleichzeitig.
6. **Nicht mit dem Solver-Experiment koppeln.** Der 2π-Windungsverlust (`HANDOFF.md` §3 P1) ist
   die drängendere Baustelle und betrifft das ausgelieferte Seil. Mantle und `aimLayer` berühren
   `02_rope.js` nicht und sollten unabhängig davon landen.

---

## 10. Vorschlag zur Reihenfolge (nicht beschlossen)

1. `aimLayer` bauen, **nur** mit `aim = null`-Pfad aktiv — Verhalten muss bit-identisch bleiben
   (Replay-Fingerabdruck unverändert als Beweis).
2. `probe_vault.js` um die Klassen A/A′/B/C/D/E erweitern, **Ist-Zustand** für alle fünf messen
   und eintragen. Damit steht die Nullmessung, bevor etwas geändert wird.
3. `dBody` in `_probeLedge` ergänzen und die Klassengrenzen festlegen.
4. Klasse D (Mantle) zuerst: Hang + Drücken + Nicken + Blick zur Kante. Das ist die Klasse, die
   heute am deutlichsten fehlt („levitiert so komisch über die Kante").
5. Klasse B (Speed-Vault) danach — sie ist diejenige, die den Fluss im Spiel hält.
6. A/A′/E zum Schluss; sie sind vor allem Ausschluss- und Impaktfälle.
7. Jede Stufe mit den Abnahmekriterien aus §8 messen und den Replay-Fingerabdruck bewusst
   nachziehen.

---

*Stand: `main` = `426a166`, 2026-10-13. Alle Messwerte in §1 sind mit `tools/probe_vault.js` auf
diesem Stand erhoben und deterministisch reproduzierbar.*

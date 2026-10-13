# HANDOFF — Stand und Auftrag

**Für wen.** Jemand übernimmt dieses Repo **ohne Chatverlauf**: ein neues Modell in einem App
Builder, eine frische Agent-Session, oder ein Mensch nach längerer Pause. Diese Datei ist der
Einstieg. Sie ist kurz gehalten und verweist statt zu wiederholen.

**Stand:** `main` = `19e0775`, 2026-10-13. Arbeitsbaum sauber, alles gepusht.
**Ausgeliefert wird:** `wrapSolver: 'legacy'`. Der pivot-Modus ist ein Experiment hinter einem
Schalter und nicht abgenommen.

---

## 1. Erste Amtshandlung (drei Minuten)

```bash
cd grapple
node tools/test_sim.js        # → 213 bestanden, 0 fehlgeschlagen, 4 bekannter Defekt (XFAIL)
node tools/test_wrap.js       # →   9 bestanden, 0 fehlgeschlagen, 4 bekannter Defekt (XFAIL)
node tools/test_replay.js     # → ✔ Replay-Regression sauber.
node tools/test_browser.js    # → Browser-Smoke-Test bestanden
node tools/check_panel.js     # → 29 Slider + 6 Schalter geprüft
node tools/test_edgecross.js  # →  31 bestanden, 0 fehlgeschlagen
python3 tools/build.py        # → gebaut: index.html (8 Dateien, ~350 KB)
```

Weicht auch nur eine Zeile ab: **erst das klären, bevor irgendetwas geändert wird.** Die acht
XFAIL-Zeilen sind gewollt (README, Falle 2).

Alles läuft headless. Kein Browser, keine GPU, keine Netzwerkzugriffe, keine Secrets, keine
Abhängigkeiten außer Node und Python-Standardbibliothek.

---

## 2. Lesen in dieser Reihenfolge

| # | Datei | Warum |
|---|---|---|
| 1 | `README.md` → „Orientsierung" | Die **vier Fallen**. Jede hat schon einmal jemanden hereingelegt |
| 2 | `doc/MELDUNGEN.md` | Welche Symptome gemeldet wurden und ihr Status (M1…M9), welche externe Befunde abgearbeitet sind, was offen hängt |
| 3 | **diese Datei**, §3–§5 | Der konkrete Auftrag und was dazwischenkommt |
| 4 | `doc/ARCHITEKTUR.md` | Warum das System so gebaut ist. 20 Kapitel. §17 „Ehrliche Grenzen" und §20 |
| 5 | `doc/VERLAUF-PIVOT.md` | Arbeitsverlauf: Glossar, jede Messung mit Zahlen, **§10b (die beiden Korrekturen eigener Schlüsse)**, §13b (Prioritäten), §15 (15 verworfene Wege) |

`doc/ARCHITEKTUR.md` ist das eigentliche Ergebnisdokument dieses Projekts. Wer nur eine Datei
liest, liest diese — aber **nicht bevor** README „Orientsierung" und `MELDUNGEN.md` durch sind.

---

## 3. Der Auftrag, priorisiert

### P1 — Der 2π-Windungsverlust. Beide Modi. Betrifft das ausgelieferte Spiel.

Das ist Meldung **M2** und der älteste offene Defekt des Projekts: „Ein um ein Objekt gewickeltes
Seil löst alle Umlenkpunkte und nimmt den direkten Weg."

**Gemessen** (`tools/probe_windoracle.js`, reine Testwelt, Hand auf Kreisbahn um einen Quader):
Der Umlaufwinkel des Solvers folgt der Handbahn **exakt** — 0,32 → −0,93 → −2,18 → −3,43 → −4,68
→ −5,93 rad über 1,19 Runden, `lengthGeo` wächst korrekt 5,35 → 19,75 m — und fällt dann
schlagartig um **6,27 rad ≈ 2π**. Zweimal pro 16-s-Lauf. Über 40 s (8 Runden):

| | größter Winkelsprung | Rebuilds | Kontakt-Verwürfe | max Kontakte | max `_lenOff` |
|---|---|---|---|---|---|
| legacy | 6,27 rad @ t=21,13 | **7** | 0 | 3 | **11,40 m** |
| pivot | 6,27 rad @ t=16,08 | 0 | **17** | 3 | 0,00 m |

* **legacy** verliert die Windung über den Sackgassen-Neuaufbau: `wraps 3→0`,
  `lengthGeo 19,87 → 5,26 m` in einem Substep.
* **pivot** verliert sie über die Selbst-Durchdringungs-Regel: 3 Verwürfe in einem Tick.

Arretiert als `test_sim.js` **20c** (4 XFAIL, Zielwerte stehen im Detail-String). Wer den Defekt
behebt, verschärft diese vier Zeilen zu `ok(...)` — und sonst nichts.

**Was ausgeschlossen ist** (gemessen, `doc/VERLAUF-PIVOT.md` §10b.4):

| Kappe | Wert | Erhöht auf | Effekt |
|---|---|---|---|
| `wrapMaxCount` | 6 | 24 | keiner — 7 Rebuilds, max Kontakte 3, Sprung 6,27 rad |
| `wrapWindMax` | 7,5 rad | 99 | keiner — identisch |
| `sameBox >= 3` (**hartkodiert** in `_tryInsertWrap`, ~Zeile 1889, kein Parameter) | 3 | 12 | max Kontakte 3 → **4**, aber 7 Rebuilds und Sprung 6,27 rad bleiben |

Eine volle Runde um einen Quader braucht **4** Kantenkontakte; `sameBox >= 3` schließt sie
strukturell aus. Hochsetzen ist also **notwendig, aber nicht hinreichend** — der Neuaufbau
verwirft die Windung unabhängig davon.

### P2 — `_lenOff` kaschiert den Sprung, statt ihn zu beheben

legacy springt 14,610 m in `lengthGeo` und versteckt das im Offset (max 14,58 m). Die Constraint
zieht danach `14,58 / resyncFade(4 m/s) ≈ 3,6 s` mit **Geisterseil**, das die Geometrie nicht
hergibt. pivot springt 6,689 m und versteckt nichts.

| | blockiert | Sprung `length` | **Sprung `lengthGeo`** | max `_lenOff` |
|---|---|---|---|---|
| legacy | 25 (1,30 %) | 0,053 m | **14,610 m** | **14,58 m** |
| pivot | 17 (0,89 %) | 6,689 m | **6,689 m** | 0,00 m |

⚠ **`S.length` ist als Stetigkeitsmaß unbrauchbar**, weil es `lengthGeo + _lenOff` ist. Frühere
Berichte („legacy 126× besser") beruhten darauf und sind zurückgenommen. `probe_wrapclean.js`
meldet inzwischen `maxJump`, `maxJumpGeo` und `maxLenOff` getrennt.

### P3 — Doppelkanten-Schranke aus `5d9d57a` überprüfen

Sie wurde gegen einen echten Defekt gebaut (dieselbe Kante zweimal auf *demselben Punkt*:
17,64 m Seil bei 15,69 m Soll) — blockiert aber möglicherweise **echte Windungen**, denn eine
zweite Runde um denselben Quader berührt dieselben vier Kanten erneut. Kriterium müsste die
**Windungszahl pro Box** sein, nicht die Kanten-Identität. Liegt auf dem Weg zu P1.

### P4 — Eckpunkt-Kontakte als eigener Feature-Typ

`_pivotEdgeHop` scheiterte (0 Treffer, zwei Fassungen), weil er die nächste **Kante** von einem
Punkt in Kantenmitte suchte — dort gibt es keine. Ein externer Prototyp löste das anders: Kontakt
auf einem **Eckpunkt** als eigener Typ, Übergang Kante→Ecke→Kante gesteuert über `tRaw`/`elen`
(also „wandert der Berührpunkt über das Kantenende hinaus?"), nicht über „welches Ende ist näher".
Details und die ausdrückliche Kennzeichnung als *nicht überprüfbar*: `doc/VERLAUF-PIVOT.md` §10b.5.

### P5 — Rein visuell, unberührt seit der externen Analyse

Biegesteifigkeit der Kette (Abstands-Constraint Node `i ↔ i+2`), tangential gepinnter Start,
Nahfeld-Pass oder Breitenbegrenzung im Bildschirmraum — gegen den Knick direkt hinter der Kamera.

---

## 4. Nicht anfassen

| Was | Warum |
|---|---|
| `wrapSolver` auf `'pivot'` stellen | Der Modus ist nicht abgenommen: 2π-Verlust (P1), 6,69-m-Sprung (P2). `legacy` ist, was ausgeliefert wird |
| `edgeCross2D` ohne `tools/test_edgecross.js` | Vier verschiedene Herleitungen derselben Formel lieferten jeweils **plausible, aber falsche** Treffer. Aufgefallen sind sie nur an der Residual-Pflicht `P(s,t) == q`. Formel und die beiden Fallen (`|d|²` statt `|d|`, Residual) stehen im Funktionskopf |
| Die 8 XFAIL-Zeilen „grün" machen | `test_wrap.js` (4) und `test_sim.js` 20c (4) arretieren Defekte. Sie auf `ok(...)` zu biegen, ohne den Defekt zu beheben, zerstört das einzige Frühwarnsystem |
| `index.html` editieren | Gebautes Artefakt, liegt nicht im Repo. `python3 tools/build.py` |
| Den Replay-Fingerabdruck stillschweigend neu schreiben | `test_replay.js` R2 bricht bei jeder Trajektorie-Änderung **absichtlich**. Bewusst neu aufnehmen mit `--write-fingerprint` und im Commit begründen |
| `maxUmweg`/`detourMax` als Defektmaß lesen | Die Referenz ist gedächtnislos und kennt per Konstruktion keine Windung. Die 14,4 m „Umweg" sind die **korrekte** Windung nach 1,19 Runden. Siehe §10b.2 — dort steht auch, dass ich das selbst einmal falsch gedeutet und `_pivotCleanup` dagegen gebaut habe |
| Mess-Sonden ohne Maske „gültige Hand" fahren | Die Handbahn der Level-Orbits läuft durch die Levelgeometrie. Ohne Maske misst man den Testaufbau: 19 % „blockiert" bei legacy waren die Hand in der Säule. Der schlimmste blockierte Schritt lag einmal bei einer Hand **1,7 m innerhalb** einer Box. `probe_wrapclean.js` ist die Welt ohne dieses Problem |

---

## 5. Werkzeuge

**Tests (nehmen ab — rot heißt kaputt):**
`test_sim.js` (213 + 4 XFAIL) · `test_wrap.js` (9 + 4 XFAIL) · `test_replay.js` (R1 Determinismus,
R2 Fingerabdruck, R3 Penetration) · `test_browser.js` · `check_panel.js` · `test_edgecross.js` (31)

**Sonden (messen — keine Abnahme, alle mit `MODE=legacy|pivot`):**

| Werkzeug | Frage |
|---|---|
| `probe_wrapclean.js` | **Abnahme-Kriterium.** Reine Welt (Boden + EIN Quader), 1920 Schritte, alle gültig. `V R T` als Argumente. Meldet `maxJump` (maskiert), `maxJumpGeo`, `maxLenOff` |
| `probe_windoracle.js` | **Topologie-Erhaltung.** Umlaufwinkel gegen den von der Handbahn erzwungenen Winkel + Ereignisprotokoll (Rebuild/Resync/Release/SelfPen mit `lengthGeo` und `_lenOff`). `MAXCOUNT`, `WINDMAX` als Umgebungsvariablen |
| `probe_blocked.js` | Warum bleibt ein blockierter Schritt blockiert? Fragt den Solver selbst: `_segBlocked`, `_tryInsertWrap`-Entscheidung, Budget, Kontakte, `sameBoxCount` |
| `probe_orbit2.js` | Level-Orbit mit Wickel-Zwang. ⚠ Messgeometrie problematisch (§9.1) — für Historie, nicht als Abnahme |
| `probe_feel.js`, `probe_orbit.js`, `bench.js` | Spielgefühl, alter Orbit, Micro-Benchmarks |

**Replay:** Im Spiel **F9** (Start/Stop), Export landet als `grapple_rec_*.json` im
Download-Ordner. Abspielen: `node tools/replay.js <datei>.json`. Damit wird aus „beschrieben" ein
frame-genauer Replay — der Unterschied zwischen Nachbauen und Reproduzieren.

---

## 6. Arbeitsregeln

1. **Reproduzieren vor interpretieren.** Erst Sonde oder Replay, dann Änderung. Jede Behauptung
   in diesem Repo hat eine Zahl und ein Werkzeug dahinter.
2. **Als Test arretieren, bevor repariert wird.** Unbehebt = XFAIL mit Zielwert im Detail-String,
   nicht schöngerechnet.
3. **Vor jedem Commit alle sechs Suiten**, danach `python3 tools/build.py`.
4. **Sofort committen UND pushen.** `.git` ist in diesem Projekt schon zweimal verschwunden,
   während der Arbeitsbaum liegen blieb (einmal selbst beobachtet zwischen zwei Nachrichten,
   einmal fremdberichtet beim Session-Handoff). Rezept: `doc/VERLAUF-PIVOT.md` §2, Arbeitsfalle 3.
5. **Fehlversuche dokumentieren.** `doc/VERLAUF-PIVOT.md` §15 führt 17 verworfene Wege mit ihrem
   Ergebnis. Eine Messung, die nicht zum gewünschten Ergebnis führt, wird eingetragen — nicht
   wiederholt, bis sie passt.
6. **Eigene Schlüsse gegen fremde Messungen prüfen.** In §10b stehen zwei Schlüsse, die ein
   externes Oracle widerlegt hat („V-Schlaufe ist ein Defekt", „legacy ist 126× stetiger"). Beide
   waren mit Zahlen belegt und trotzdem falsch — weil die Messgröße maskiert bzw. die Referenz
   windungsblind war. **Messgröße zuerst hinterfragen, dann das Ergebnis.**

---

## 7. GitHub Pages

Das Spiel liegt als gebautes Artefakt **nicht** im Repo (`.github/workflows/pages.yml` baut es).

* **Wann gebaut wird:** bei jedem `push` auf `main`, plus manuell
  (*Actions → build-and-pages → Run workflow*). Feature-Branches bauen **nicht** — veröffentlicht
  wird exakt der Stand von `main`.
* **URL:** `https://lamachen.github.io/Grapple/` → leitet weiter auf
  `https://lamachen.github.io/Grapple/grapple/index.html` (die Weiterleitung ist die versionierte
  `index.html` im Repo-Wurzelverzeichnis).
* **Einmalige Voraussetzung — IST ERLEDIGT (2026-10-13, 20:18 UTC).**
  *Settings → Pages → Build and deployment → Source* steht auf **„GitHub Actions"**.
  Verifikation: `GET /repos/lamachen/Grapple/pages` liefert `build_type: "workflow"`, und
  `https://lamachen.github.io/Grapple/grapple/index.html` liefert 361 243 Bytes, byte-identisch
  zum lokal gebauten Artefakt (sha256 gleich), ohne `Jekyll SEO tag`.

  ⚠ **Lehre für die nächste Session:** Diese Einstellung ist **keine** reine UI-Sache. Der
  PAT des Projekts hat `admin: true` auf dieses Repo, also geht es per API:
  ```
  PUT /repos/{owner}/{repo}/pages   {"build_type": "workflow"}   → 204
  ```
  (`POST` ist falsch und liefert 409 „already enabled".) Danach einmal
  `POST /repos/{owner}/{repo}/actions/workflows/pages.yml/dispatches {"ref":"main"}`, damit das
  Artefakt deployt wird. **Erst nachmessen, ob etwas geht, statt es zu behaupten** — hier war
  die Auskunft „das musst du im UI klicken" schlicht falsch, und die Live-Demo war dadurch
  für eine Stunde ein 404.
* ⚠ **Was passiert, wenn sie nicht gesetzt ist** (am 2026-10-13 real vorgefunden): GitHub baut die
  Seite dann selbst mit Jekyll aus dem Zweiginhalt. Weil `grapple/index.html` nicht mehr versioniert
  ist, erzeugt Jekyll eine HTML-Ansicht der README — **40 KB Jekyll-Seite statt 350 KB Spiel**.
  Tückisch daran: `build-and-pages` meldet `success` (alle 8 Schritte, inkl. deploy) und parallel
  läuft ein `pages build and deployment`-Job, der ebenfalls `success` meldet. Grün heißt also
  **nicht** „das Spiel ist live".
* **Status prüfen — beides:**
  1. Tab *Actions* → `build-and-pages` → Build-Schritt protokolliert `gebaut: … Bytes` (~350 KB).
  2. **Und die URL:** `https://lamachen.github.io/Grapple/grapple/index.html` muss ~350 KB liefern
     und darf **kein** `Jekyll SEO tag` im `<head>` haben.

* **Gemessene Zustandsfolge am 2026-10-13** (Source stand durchgehend auf „Deploy from a branch"):

  | Zeit (UTC) | Stand | Was die URL lieferte |
  |---|---|---|
  | vor `02e5ef6` | `grapple/index.html` versioniert | das Spiel — aber aus dem **letzten Commit, der die Datei enthielt**, nicht aus dem aktuellen `src/` |
  | 19:21, `5d25a77` | Datei nicht versioniert, ohne `.nojekyll` | **HTTP 200, 40 049 Bytes, Jekyll-HTML-Ansicht der README** — kein Spiel |
  | 19:24, `c9b31e5` | dito, **mit** `.nojekyll` | **HTTP 404** — Jekyll unterdrückt, aber die Datei fehlt im Zweig |
  | **20:18, `66e869d`** | **`build_type: workflow`** (per API gesetzt) | **HTTP 200, 361 243 Bytes — das Spiel**, byte-identisch zum lokalen Build |

  Alle drei Zeilen hatten `build-and-pages` **und** `pages build and deployment` auf `success`.
  Die `.nojekyll` hat damit nichts repariert, sondern das Symptom von „falsche Seite" auf
  „keine Seite" geändert — was die Diagnose bestätigt: Ausgeliefert wird der **Zweiginhalt**,
  nicht das Artefakt des Workflows. Es gibt genau eine Lösung, und die ist eine Einstellung:
  **Source = „GitHub Actions"**. Danach deployt `actions/deploy-pages@v4` das Artefakt, in dem die
  gebaute Datei liegt.
  Wenn diese Einstellung nicht gesetzt werden soll, muss `grapple/index.html` wieder versioniert
  werden (`git rm --cached` rückgängig, Eintrag aus `grapple/.gitignore` raus) — dann funktioniert
  der Branch-Modus wieder,zum Preis von 345 KB Duplikat im Repo und eine Demo, die beim Bauen hinkt.
* **Lokal ohne Pages:** `python3 tools/build.py`, dann `grapple/index.html` öffnen.

---

## 8. Offene Fragen an den Projekteigner

1. **P1 angehen?** Der 2π-Verlust ist der älteste offene Defekt und betrifft das ausgelieferte
   Spiel. Er ist arretiert und messbar, aber nicht trivial: `sameBox`-Kappe hochsetzen allein
   reicht nachweislich nicht.
2. **`_lenOff`-Kaschierung (P2)** getrennt von P1 behandeln oder zusammen?
3. **Soll der pivot-Zweig weiterlaufen**, jetzt wo klar ist, dass er beim größten Sprung
   *ehrlicher* ist als legacy (6,69 m unkaskiert gegen 14,61 m kaskiert) — oder wird die
   Topologie-Erhaltung direkt in legacy gebaut und das Experiment beendet?

---

*Letzte Aktualisierung: 2026-10-13, `main` = `19e0775`. Alle Zahlen in dieser Datei sind am
selben Tag auf diesem Stand neu gemessen worden (jeweils zweimal, identisch).*

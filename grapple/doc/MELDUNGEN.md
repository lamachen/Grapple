# Meldungen und Befunde — was berichtet wurde, was davon erledigt ist

**Zweck.** Diese Datei ist der Einstieg für jemanden, der das Projekt **ohne Chatverlauf**
übernimmt — Mensch oder Agent. Sie beantwortet drei Fragen, die sonst nirgends zusammenstehen:

1. Welche **Symptome** wurden vom Nutzer gemeldet, und was ist ihr Status?
2. Welche **Befunde** kamen aus einer externen Code-Analyse, und was ist ihr Status?
3. Was ist **bekannt offen**, ohne dass es jemand gemeldet hätte?

Belege sind Commits (mit `git show <hash>` vollständig lesbar), Testnamen und Dateiverweise.
Wo ein Beleg fehlt, steht das dabei.

**Reihenfolge zum Einlesen:** diese Datei → [`README.md`](../README.md) (Start, die vier Fallen)
→ [`doc/ARCHITEKTUR.md`](ARCHITEKTUR.md) (warum das System so gebaut ist)
→ [`doc/VERLAUF-PIVOT.md`](VERLAUF-PIVOT.md) (Arbeitsstand des laufenden Solver-Experiments).

---

## 1. Gemeldete Symptome (Nutzer)

| # | Symptom, wie es gemeldet wurde | Status | Beleg |
|---|---|---|---|
| M1 | Seil löst sich bei seitlicher Bewegung von den Kanten, springt auf die andere Objektseite und bildet sich als direkte Linie neu. „Ein links um ein Objekt gewickeltes Seil löst sich … quasi durch das Objekt hindurch." | **teilbehoben** | `3b87251` (Regressionstest), `805fa70`, `2c1b1ec`, `6bf9208` (topologische Freigabeschranke), `fd49fe3`. Test **W9** in `tools/test_wrap.js` ist die maschinenlesbare Form der Skizze |
| M2 | Skizzen-Fall, präzisiert: **zwei** Umlenkungen an einer **dünnen Säule**, Spieler wechselt die Seite, Sicht auf den Anker wird frei — das Seil löst *alle* Umlenkpunkte und nimmt den direkten Weg. Passiert nur bei dünnen Objekten. | **offen, Mechanismus jetzt bekannt** | Beschreibung in `src/02_rope.js` bei `wrapWindTol`; Test W9; `doc/VERLAUF-PIVOT.md` §9.3 und **§10b.1**. Nachgemessen mit `tools/probe_windoracle.js`: Der Solver verliert pro Runde **exakt 2π** Umlaufwinkel — legacy über den Sackgassen-Neuaufbau (`rebuilds`, alle 3 Kontakte weg, `lengthGeo` 19,87 → 5,26 m, kaschiert durch `_lenOff` 14,58 m), pivot über die Selbst-Durchdringungs-Regel (3 Verwürfe in einem Tick, unkaskiert, deshalb sichtbar als 6,69-m-Sprung). Arretiert als `test_sim.js` 20c (4 XFAIL) |
| M3 | „Wieso macht das Seil diesen komischen Knick direkt vor der Kamera?" | **behoben** | `cecc34f` (Seil-Mündung vereinheitlicht), `65d6d80` (Verbindungsstück Mündung→Hand bedingt wiederhergestellt) |
| M4 | Seil „verkürzt sich direkt" beim Halten, und Mausrad-Verstellen erzeugt Sprünge — aber nur, wenn vorher genug Seil abgerollt war. | **behoben** | `fd49fe3` (zwei Snap-/Verkürzungs-Quellen beseitigt) |
| M5 | „Solange ein verankertes Seil existiert, kann man durch andauerndes Drücken der Leertaste jederzeit fliegen." | **behoben** | `07603b7`. Ursache war eine Kette aus zwei Lücken: `keydown` feuert bei gehaltener Taste per Autorepeat immer wieder (also jeden Frame eine neue Sprungflanke), **und** der Seilsprung-Zweig gab pro Flanke 9,5 m/s ohne Zähler. Jetzt: Input-Kante (`jumpPressed` nur bei `!e.repeat`), `ropeJumpUsed` (genau ein Seilsprung pro Einhänge- oder Bodenkontakt), dazu Jump-Cut. Tests 18a–18d |
| M6 | Rückholen ist „mega schlecht und grundlegend falsch umgesetzt": ein starres, unphysikalisches Objekt, das „wie ein außerirdisches Raumschiff" in direkter Linie und zu langsam heranschwebt, mit einem buggy Seil dazwischen; es bewegt sich nicht um Kanten; keine Masse, keine Schwerkraft, keine Kollision. | **offen** | Der Kritik folgte ein Umbau zum Massekörper am einrollenden Seil. Er ist in mehreren Varianten an Deadlocks und Aufschaukeln gescheitert (Seilende und Körper liefen auseinander; Energie-Pumpe an Kollisionskanten bis 500 m/s) und wurde **nicht ausgeliefert**. Ausgeliefert ist weiterhin das stabile Pfadfolgen-Rückholen aus `6bf12a0`. Die Begründung steht in der Commit-Message von `07603b7` („in eigener Sache, ehrlich") |
| M7 | Seil-Zappeln beim Rückholen. | **offen** | In derselben Commit-Message als „ebenso offen aus derselben Kritik" vermerkt. Kein eigener Test |
| M8 | Kisten kollidieren nicht untereinander und nicht mit dem Spieler — „für *zieht Kiste durch den Spieler* nicht tragbar". | **behoben** | `728226f`: `_collideBodies()` für Paare dynamischer AABBs, plus Gegenwirkung bei Kapsel-Kontakt. Tests 19a–19c |
| M9 | Repo bläht den Kontext auf: Bilddateien, gebautes `index.html` als Duplikat von `src/`, Dopplungen zwischen Code-Kommentaren und Doku. | **behoben** | `a86db17`, `02e5ef6`. Working Tree 1800,8 KB → 812,1 KB (−55 %), 42 → 35 Dateien |

> **Hinweis zu M1/M2.** `fd49fe3` dokumentiert ausdrücklich, dass der Skizzen-Fall *nach*
> `6bf9208` weiter auftrat. Der aktuelle Stand ist: `test_wrap.js` meldet **9 bestanden,
> 0 fehlgeschlagen, 4 XFAIL** — die vier XFAIL-Zeilen sind der arretierte Defekt, nicht ein
> grüner Test. Wer M2 angeht, verschärft diese vier Zeilen zu echten Grenzen; sie zu „reparieren",
> ohne den Defekt zu beheben, zerstört das Frühwarnsystem (README, Falle 2).

---

## 2. Befunde aus der externen Code-Analyse

Ein zweites Modell hatte das Projekt analysiert und die Befunde als Chatverlauf übergeben; der
größte Teil wurde in der Vorsession abgearbeitet. Kernthese der Analyse — sie ist der Grund, warum
es den pivot-Modus überhaupt gibt:

> „Freigabe per Sichtlinie + viele Reparatur-Pflaster klingt auf jeden Fall mehr nach
> Symptombekämpfung anstatt zukunftssicherer, sauberer Umsetzung."
>
> Die Pflaster seien nicht dumm — jedes habe einen echten Defekt gemessen und behoben —, aber sie
> sicherten einen Zustandsraum ab, den die Datenstruktur (Kontakte ohne Orientierung, Release nach
> Sichtbarkeit) **falsch aufspannt**. Das Gegenmittel sei kein weiteres Pflaster, sondern ein
> Austausch der Release- und Insert-Regel.

Gegenentwurf („Pivot-Solver", nach Worms-Ropes, aber für 3D-Kanten):

1. **Insert über überstrichene Kanten** — nicht suchen, wo ein Blocker ist, sondern beobachten,
   welche Kante das Seilsegment zwischen zwei Zeitschritten tatsächlich überstrichen hat.
2. **Freigabe über den Kraftkegel** — ein Kontakt löst sich erst, wenn `u_prev + u_next` die Kante
   nicht mehr in ihren Normalenkegel drückt. Lokal, stetig, mit Vorzeichenwechsel, ohne Sichtlinie.
3. **Wicklung als Zustand** — die Folge orientierter Kontakte *ist* die Topologie; Winding-Heuristik,
   Rebuild und Resync werden überflüssig.

Dazu die Prozessregel, an die sich dieses Repo hält: **Der neue Solver läuft auf einem Branch mit
einem A/B-Schalter, die alte Logik bleibt erhalten, und die Pflaster fliegen erst raus, wenn die
Messwerte (W5–W8) grün sind.**

| Befund der Analyse | Status | Beleg |
|---|---|---|
| Anker folgt bewegten Körpern nicht (`anchor` wurde nur in `attachAt` gesetzt; Kiste wanderte 2,12 m, Anker 0,00 m) | **behoben** | `9dde6d6` (body-lokaler Anker), `c77b2f9` (Render-Interpolation), Merge `c3db832`. Tests 9b/9c |
| `World.raycast` ignoriert dynamische Körper, sobald irgendeine statische Box im Strahl liegt — der Pfad-Solver bekam die Wand *hinter* der Kiste als Blocker | **behoben** | `6323d26`, Merge `c3db832` |
| Rückwirkung auf Kisten ist geschätzt (`tensionLevel · _estimateLoad`, grob 80 kg · g), nicht der echte Constraint-Impuls — verletzt Actio = Reactio; ein straffes Seil zieht auch dann an der Kiste, wenn der Spieler stillsteht | **behoben** | `d1a3d2d`: Impuls-Sammlung `_reactImp` aus `constrainPlayer`, `T = Impuls/dt · playerMass`; Kraft an der reibungsfreien Kante korrekt `T·(u1+u2)` statt `T/2` auf die halbe Bisectrix. Tests 9a/9b |
| Capstan-Reibung `exp(−μ·θ·T·dt)` bremst die **gesamte** Geschwindigkeit, also auch Fall und Pendeln quer zum Seil, nicht nur das Gleiten über die Kante | **behoben** | `2256b98` (richtungsaufgelöst: Reibung nur entlang des Seilgleitens). Test 6b |
| Kisten kollidieren nicht untereinander und nicht mit dem Spieler | **behoben** | `728226f`, Tests 19a–19c — siehe M8 |
| Doku und Code driften auseinander (ARCHITEKTUR §3/§8.3 behaupteten, die Kette wisse im Betrieb nichts vom Pfad; Testzahlen und Dateigrößen stimmten nicht) | **teilweise behoben** | `d1a3d2d` (§3/§8.3 + Zahlenstände), `00b4aec` (§14 Verifikation: 179 → 208 Assertions, fehlende Suiten ergänzt). **Offen:** §17 „Ehrliche Grenzen" und §20 wurden in dieser Session nicht gegen den Code geprüft |
| **Prozess-Idee:** Physik läuft mit festen 120 Hz, also Input pro Substep aufzeichnen und headless deterministisch abspielen — damit wird jede Bildschirmaufnahme zu einem frame-genauen Regressionstest | **umgesetzt** | `7619606`: **F9** nimmt auf (Zustands-Snapshot + Input pro Frame), Export als `grapple_rec_*.json`; `tools/replay.js` spielt ab; `tools/test_replay.js` prüft R1 Determinismus, R2 Fingerabdruck gegen `tools/fixtures/demo_orbit.json`, R3 keine tiefe Penetration |
| Nahfeld-Seil: dicker Schlauch mit Knick direkt hinter der Hand; der Kette fehlt Biegesteifigkeit. Vorschlag: Abstands-Constraint zwischen Node `i` und `i+2`, tangential gepinnter Start, Breitenbegrenzung im Bildschirmraum oder eigener Nahfeld-Pass | **offen** | Nur erwähnt in `doc/VERLAUF-PIVOT.md` §14 Punkt 5. Rein visuell, kein Test |
| Pivot-Solver selbst | **in Arbeit, nicht ausgeliefert** | `wrapSolver: 'pivot'`, Stand und Zahlen in `doc/VERLAUF-PIVOT.md` |

---

## 3. Bekannt offen, ohne dass es gemeldet wurde

| Thema | Stand | Wo es steht |
|---|---|---|
| ~~**V-Schlaufe**~~ | **Gegenstandslos.** Die Route mit 19,70 m bei 5,50 m „freier" Route war kein Müll, sondern die korrekte Windung nach 1,19 Runden — die Referenz kann per Konstruktion keine Windung kennen. Der echte Defekt ist der 2π-Verlust, siehe M2 | `doc/VERLAUF-PIVOT.md` §10b.2 |
| **2π-Verlust pro Runde** — in **beiden** Modi, betrifft das ausgelieferte Spiel | Neu erhoben und arretiert (`test_sim.js` 20c, 4 XFAIL). Ursache nicht die Kappen `wrapMaxCount`/`wrapWindMax`, sondern `sameBox >= 3` (hartkodiert) **plus** ein Neuaufbau, der die Windung verwirft. Hochsetzen der Kappe hebt Kontakte von 3 auf 4, der Verlust bleibt | `doc/VERLAUF-PIVOT.md` §10b.1, §10b.4, §13b |
| **`_lenOff` kaschiert einen 14,58-m-Sprung** über ~3,6 s | Die Constraint zieht in dieser Zeit mit Geisterseil, das die Geometrie nicht hergibt. Eigener Befund, unabhängig von der Sprungursache | `doc/VERLAUF-PIVOT.md` §10b.3, §13b Punkt 2 |
| **pivot: Längenstetigkeit** — 6,689 m Sprung | ~~Größter Rückstand gegen legacy (0,053 m)~~ — **korrigiert**: legacy springt ungefiltert 14,610 m und versteckt es im Offset, pivot 6,689 m und versteckt nichts. Der Rückstand ist kleiner und andersherum, als berichtet | `doc/VERLAUF-PIVOT.md` §10b.3 |
| **pivot: Kantenwahl am Ende eines Gleitvorgangs** | `_cornerSlide` feuert in beiden Modi 0 Mal (`_atEnd` ist in den relevanten Schritten false); ein Eckübergang hilft nicht, weil ein Kontakt in halber Höhe einer senkrechten Kante **keine** nächste Ecke hat. Nötig: lokales Neulegen der Route um die Box, oder Eckpunkte als eigenständige Kontakte | `doc/VERLAUF-PIVOT.md` §8, Befund-Block bei `_segBoxBeyond` in `src/02_rope.js` |
| **4 XFAIL in `test_wrap.js`** | Der arretierte Wickel-Defekt (M1/M2). Zielwerte stehen als Kommentar dabei | `tools/test_wrap.js`, Kopfkommentar |
| ARCHITEKTUR §17/§20 gegen den Code prüfen | Nicht gemacht; §14 und §3/§8.3 sind korrigiert | `doc/ARCHITEKTUR.md` |

---

## 4. Was **nicht** im Repo liegt, und warum das vertretbar ist

| Was | Wo es ist | Warum es nicht ins Repo gehört |
|---|---|---|
| Chatverlauf der Vorsession (~256 KB, enthält den vollständigen Analyse-Text des zweiten Modells) | Übergabedatei, nicht versioniert | Die **Befunde** daraus sind alle abgearbeitet und mit Commit-Beleg in Abschnitt 2; der Rohtext wäre toter Kontext |
| Nutzerskizze und drei Videoframes (7 Dateien, 618 KB) | Git-Historie bei `a86db17^` | Waren ausschließlich in Kommentaren referenziert, die denselben Inhalt in Worten trugen. Die maschinenlesbare Form der Skizze ist **Test W9** |
| Gebautes `index.html` (345 KB) | entsteht beim Build | Enthält `src/*.js` noch einmal. Wird beim Push auf `main` von `.github/workflows/pages.yml` gebaut |
| Messprotokoll des pivot-Experiments | `doc/VERLAUF-PIVOT.md` | Stand doppelt (18,3 KB identischer Text in `src/02_rope.js`). Im Code blieben die ~20 Zeilen, die man zum Ändern der Schalter braucht |

---

## 5. Wie man eine neue Meldung abarbeitet (bewährter Weg)

1. **Reproduzieren, nicht interpretieren.** Liegt eine Aufnahme vor (**F9** im Spiel, nochmal F9
   zum Stoppen, Export landet im Download-Ordner): `node tools/replay.js <datei>.json`. Damit wird
   aus „beschrieben" ein frame-genauer Replay — das ist der Unterschied zwischen Nachbauen und
   Reproduzieren.
2. **Als Test arretieren, bevor repariert wird.** Neue Assertion in `tools/test_sim.js` (Sektion
   fortlaufend nummerieren) oder `tools/test_wrap.js`. Ist der Defekt noch nicht behoben: als
   **XFAIL** mit Zielwert im Kommentar, nicht als schöngerechnetes `ok`.
3. **Messen, welche Schicht betroffen ist.** Pfad/Topologie → `tools/probe_wrapclean.js`
   (reine Welt, das Abnahme-Kriterium) und `tools/probe_blocked.js` (warum bleibt ein Schritt
   blockiert). Spielgefühl → `tools/probe_feel.js`. Längen-/Umweg-Verlauf → `tools/probe_orbit2.js`.
4. **Erst dann ändern.** Alle sechs Suiten müssen grün bleiben (README, „Orientsierung").
5. **Sofort committen und pushen.** `.git` ist in diesem Projekt zweimal beim Session-Handoff
   verschwunden, während der Arbeitsbaum liegen blieb (`doc/VERLAUF-PIVOT.md` §2, Arbeitsfalle 3).
6. **Fehlversuche dokumentieren.** `doc/VERLAUF-PIVOT.md` §15 führt 15 verworfene Wege mit ihrem
   Ergebnis. Das ist Absicht: Eine Messung, die nicht zum gewünschten Ergebnis führt, wird
   eingetragen — nicht wiederholt, bis sie passt.

---

*Stand: 2026-10-13, `main` = `72797f2`. Belege für Abschnitt 1 sind die Commit-Messages
(`git show <hash>`), für Abschnitt 2 der übergebene Analyse-Verlauf plus die genannten Commits,
für Abschnitt 3 die Messungen in `doc/VERLAUF-PIVOT.md`.*

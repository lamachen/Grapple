# GRAPPLE — Architektur eines glaubwürdigen Seilsystems

**Zielbild:** First-Person-Parkour (Mirror's-Edge-Bewegungsfreiheit) + Spider-Man-Grapple.
Vollständig physikbasierter Spieler. Der Haken ist ein Projektil mit eigener Trägheit, das
Seil ein physisches Objekt, das sich um Kanten legt, mit beweglichen Körpern interagiert,
spannt, entspannt und den Spieler schwingen lässt.

**Kernergebnis:** Das Seil wird *nicht* als Kette aus Rigidbodies simuliert. Stattdessen wird
das Problem in drei Teile zerlegt, die jeweils mit der Methode gelöst werden, die sie am
besten kann — und die über **eine einzige gemeinsame Zustandsgröße** gekoppelt sind.

---

## 1. Die zentrale These

> **Ein Seil ist im Spiel zwei völlig verschiedene Dinge, die man nicht mit derselben
> Technik lösen sollte.**
>
> 1. **Eine Nebenbedingung** („du kommst nicht weiter als L entlang des Welt-Verlaufs") —
>    das bestimmt das *Spielgefühl* und muss exakt, deterministisch und jitterfrei sein.
> 2. **Ein sichtbares Objekt** („es hängt durch, peitscht, legt sich um Kanten") — das
>    bestimmt die *Glaubwürdigkeit* und darf dafür approximativ, aber lebendig sein.
>
> Wer beides mit einem einzigen Verfahren löft, bekommt von beidem nur die Hälfte.

Genau das ist der Grundfehler des naheliegenden Ansatzes. Eine Kette aus 40 Segmenten mit
Abstands-Constraints *ist* gleichzeitig Darstellung **und** Constraint — und scheitert daran,
dass diese beiden Anforderungen sich widersprechen:

| Anforderung an die Constraint | Anforderung an die Darstellung |
|---|---|
| hart, nicht nachgiebig | weich, durchhängend, peitschend |
| deterministisch, rauschfrei | lebendig, leicht chaotisch |
| billig (läuft pro Substep) | darf Auflösungen haben |
| darf **nie** Energie zuführen | darf Energie dissipieren (Drag) |
| muss Kanten-Umlenkung *exakt* kennen | muss Kanten-Umlenkung nur *plausibel* zeigen |

Eine Verlet-Kette kann die erste Spalte nicht liefern: ihre Steifigkeit ist eine Funktion von
Iterationszahl und Substep-Größe, ihre Endpunkt-Distanz rauscht um mehrere Zentimeter pro
Frame, und diese Rauschamplitude wird direkt zur Rauschamplitude der Spielerbewegung.

**Die Lösung:** Die Constraint kommt aus reiner Geometrie (exakt, billig, rauschfrei).
Die Darstellung kommt aus einer kleinen Simulation (lebendig). Beide lesen und schreiben
dieselbe Zustandsgröße — das **Seil-Budget**. Deshalb fühlt es sich wie *ein* Phänomen an
und nicht wie zwei Tricks.

---

## 2. Warum der naheliegende Ansatz hier konkret scheitert

Nicht als Pauschalurteil, sondern an den 16 Anforderungen des Zielbilds gemessen:

| # | Anforderung | Kette aus N Rigidbodies/Verlet-Segmenten |
|---|---|---|
| 1 | ballistisches Projektil | ✅ lösbar (Projektil ist separat) |
| 2 | loses Seil läuft hinterher | ✅ sogar natürlich |
| 3 | **schnelles, plausibles Straffen** | ⚠️ nur über sehr steife Constraints → Jitter oder XPBD-Substepping (teuer) |
| 4 | **dauerhaft verfügbare Seillänge** | ❌ die „Länge" ist nur implizit über N·Segmentlänge vorhanden und driftet (Constraints sind nie exakt starr) |
| 5 | entspannt bei Annäherung | ✅ |
| 6 | Spannung bei Überschreitung | ⚠️ Kraft entsteht aus Constraint-Restfehler → weich, unkalibrierbar, frameabhängig |
| 7 | **Umlegen um Kanten** | ❌ emergent nur mit echter Selbst- und Weltkollision aller Segmente; kostet O(N) Broadphase-Queries pro Substep und erzeugt Kanten-Rattern |
| 8 | **Umwickeln (mehrere Windungen)** | ❌ praktisch nicht stabil lösbar |
| 9 | bewegliche Objekte | ⚠️ Segmente werden mitgeschoben → Energieeinträge, Explosionen |
| 10 | **Länge = realer Welt-Verlauf** | ❌ die Luftlinie Spieler↔Anker ist nicht die Kettenlänge; bei Umlenkung stimmt beides nicht überein |
| 11 | glaubwürdiges Pendel | ⚠️ Pendel wird über ein nachgiebiges, rauschendes Seil gefiltert |
| 12 | **keine künstliche Positionskorrektur** | ❌ der Standardweg ist „Position des Spielers auf Kettenende projizieren" = genau das |
| 13 | Zusammenspiel mit Controller | ⚠️ Zwei-Wege-Kopplung zweier Solver → Oszillation |
| 14 | Stabilität | ❌ Steifheit ↔ Stabilität sind gegeneinander gekoppelt |
| 15 | Performance im Webgame | ❌ 40 Segmente × (Constraint-Iterationen + Kollision) × 120 Hz |
| 16 | überzeugend in komplexen Situationen | ✅ (wenn alles andere gelöst wäre) |

Die fatalen Punkte sind 4, 7, 10, 12 und 14 — und zwar *strukturell*, nicht durch Tuning.

**Der entscheidende Einschnitt:** Punkt 10. Sobald das Seil um eine Kante läuft, ist die
relevante Länge nicht mehr der Abstand zweier Punkte, sondern die **Länge eines Pfades durch
die Welt**. Eine Partikelkette kennt diesen Pfad nicht — sie *ist* ihn höchstens zufällig.
Man braucht also in jedem Fall eine explizite Repräsentation des Seilverlaufs. Und sobald man
die hat, ist die Constraint daraus fast geschenkt — und die Kette nur noch Dekoration.

---

## 3. Architektur: drei Schichten, eine Wahrheit

```
                 ┌──────────────────────────────────────────────────────┐
                 │            SEIL-ZUSTAND (eine State-Machine)          │
                 │  IDLE → FLIGHT → SETTLING → ATTACHED → (RETRACT)      │
                 └──────────────────────────────────────────────────────┘
                        │                    │                    │
        ┌───────────────▼──────┐  ┌──────────▼───────────┐  ┌─────▼──────────────┐
        │ (1) TOPOLOGIE        │  │ (2) DYNAMIK          │  │ (3) DARSTELLUNG    │
        │ Welt-Pfad + Budget   │  │ einseitige Constraint│  │ physik. Seilkette  │
        ├──────────────────────┤  ├──────────────────────┤  ├────────────────────┤
        │ kürzester kollisions-│  │ g(x) = s(x) − L ≤ 0  │  │ Verlet-Kette,      │
        │ freier Pfad um       │  │ auf VELOCITY-Ebene,  │  │ Σ Segmente = L:    │
        │ Hindernisse, mit     │  │ einseitig, mit       │  │ Enden gepinnt an   │
        │ persistenten,        │  │ Baumgarte-Bias als   │  │ Hand + Anker/Haken,│
        │ gleitenden Kontakten │  │ Restfehler-Korrektur │  │ dazwischen Schwerk.│
        │                      │  │                      │  │ + Weltkollision    │
        ├──────────────────────┤  ├──────────────────────┤  ├────────────────────┤
        │ reine Geometrie      │  │ reine Mechanik       │  │ reine Optik, aber  │
        │ exakt, rauschfrei    │  │ exakt, energieneutral│  │ Länge exakt:       │
        │ ~0.06–0.07 ms        │  │ ~0.001 ms            │  │ Durchhang + Boden- │
        │                      │  │                      │  │ auflage von selbst │
        │                      │  │                      │  │ ~0.3 ms            │
        └──────────┬───────────┘  └──────────▲───────────┘  └─────────▲──────────┘
                   │  s(x), Tangente,        │                        │ Endpunkte + Pfad
                   │  Kontaktpunkte          │                        │ (nur fürs Neulegen)
                   └─────────────────────────┴────────────────────────┘
                              gemeinsame Größe: L (Budget)
```

**Kopplung:** Schicht 1 liefert die Welt-Pfadlänge `s(x)`, die Endtangente und die
Positionen der Umlenkkontakte. Schicht 2 vergleicht `s(x)` mit dem Budget `L` und
beeinflusst *ausschließlich* die Geschwindigkeit des Spielers. Schicht 3 bekommt von
Schicht 1 **nur die Endpunkte und — einmalig beim Neulegen — den Pfad**: keine Zielkurve,
keine Durchhangvorgabe, keine Steifigkeit, keine Pins an Kontakten. Im laufenden Betrieb
weiß die Kette nichts vom Pfad; was das Seil tut, ergibt sich aus Gravitation, Trägheit,
den Längen-Constraints und der Weltkollision. Keine Schicht greift der anderen in die
Zustände.


---

## 4. Schicht 1a — Der Haken: Ballistik, die trotzdem zuverlässig trifft

**Problem:** „echte Wurfparabel" und „verankert unmittelbar und zuverlässig" widersprechen
sich. Ein frei ballistisches Projektil trifft selten genau das, was das Fadenkreuz markiert.

**Lösung — drei getrennte Entscheidungen:**

**(a) Zielwahl ist großzügig, der Flug ist physikalisch.**
Ein Suchkegel (Golden-Angle-Spirale, Default 26 Strahlen, 11°) bewertet Kandidaten nach
Winkelabstand zum Fadenkreuz, Distanz, Flächenorientierung (`n·(−d) > 0.1`) und einer leichten
Präferenz für Oberseiten. Das ist Aim-Assist — aber er entscheidet nur, *wohin* geworfen wird.

**(b) Exakte ballistische Ziellösung.** Für „mit welcher Startgeschwindigkeit trifft ein
Wurfkörper bei gegebenem Betrag `v₀` den Punkt `T`?" gilt mit `u = t²`:

```
¼g²·u² − (Δy·g + v₀²)·u + |Δ|² = 0
```

Die kleinere Wurzel ergibt die flachere, schnellere Bahn (besseres Spielgefühl).

**(c) Drag-kompensierte Fixpunktiteration.** Luftwiderstand ist *gewünscht* (der Haken soll
spürbar abbremen und die Bahn soll gekrümmt sein), aber er macht die analytische Lösung
ungültig. Also wird die Startgeschwindigkeit gegen die **echte Simulation** iteriert:

```
v ← v + (Ziel − Landepunkt(v)) / Flugzeit        (5 Iterationen à 26 Teilschritte)
```

Eine Fixpunktiteration über eine glatte Abbildung — konvergiert reliably.

**Gemessen:** Trefferabweichung **0.22 m** über 36 m Flug *mit* Luftwiderstand,
maximale Abweichung von der Luftlinie **0.99 m** (die Bahn ist sichtbar gekrümmt, nicht gerade).

**Sonstige Physik des Projektils:** eigene Masse, quadratischer Drag, **Miterben von 42 % der
Spielergeschwindigkeit** (Trägheit — aus der Bewegung heraus schießt man anders), substepped
Raycast-Kollision (max. 0.30 m pro Schritt, kein Tunneln), Abprallen bei streifendem
Auftritt oder nicht verankerbarer Oberfläche (Restitution 0.34, max. 2 Bounces), und —
wichtig — **Kopplung an das Seil schon im Flug**: ist das ausgegebene Seil am Ende, wird die
Radialkomponente der Hakengeschwindigkeit entfernt. Der Haken wird also real ausgebremst und
baumelt am Seil, statt hart zu stoppen.

---

## 5. Schicht 1b — Seilausgabe: Warum das Seil von selbst lose hinterherläuft

Der naive Weg wäre `ausgegeben = Abstand(Hand, Haken)`. Dann ist das Seil immer straff — genau
das, was *nicht* gewünscht ist.

**Die physikalisch richtige Größe ist die Bogenlänge der Hakenbahn:**

```
L(t) = ∫ |v_Haken| dt · feedGain + feedBias·t      (feedGain ≈ 1.05)
L    = max(L, Abstand(Hand, Haken))                (niemals kürzer als nötig)
```

Weil die Hakenbahn eine Wurfparabel ist, ist ihre Bogenlänge *automatisch* größer als die
Luftlinie — der Überschuss ist exakt das Seil, das sichtbar durchhängend hinterherläuft. Es ist
kein separater Trick, sondern eine Konsequenz der Ballistik. Zusätzlich zwingt die
Visualisierungskette den Überschuss in einen natürlichen Kettenlinien-Durchhang.

**Gemessen:** 2.26 m Überschuss auf einem typischen Wurf; 31 von 36 Ketten-Nodes hängen
messbar unter der Luftlinie.

---

## 6. Schicht 1c — Der Welt-Pfad: Umlenkung mit Gedächtnis

Das ist der Teil, der am meisten Sorgfalt braucht, und der Ort der meisten unkonventionellen
Entscheidungen.

### 6.1 Warum zustandslos nicht funktioniert

Ein Seil, das sich um eine Kante legt, **bleibt** dort und **gleitet** an ihr entlang. Ein
Solver, der jede Frame neu sucht, flackert zwischen „gewickelt" und „nicht gewickelt" — mit
drei sichtbaren Folgen: springende Seillänge, springende Constraint-Normale, springende
Kräfte. Das fühlt sich sofort nach Game-Mechanik und nicht nach Physik an.

Deshalb: **Umlenkkontakte sind persistente Objekte** `{ Box, Kantenindex, Parameter t,
Freigabe-Counter }`. Sie überleben Frames, sie gehören zum Seil-Zustand.

### 6.2 Gleitkontakt durch geschlossene Lösung (statt Suche)

Wo auf einer Kante berührt das Seil sie? Für eine Gerade mit Stützpunkt `O`, Richtung `u`
und den Zerlegungen `a∥, a⊥` bzw. `b∥, b⊥` der Vektoren zu den beiden Endpunkten gilt exakt:

```
t* = (a∥·|b⊥| + b∥·|a⊥|) / (|a⊥| + |b⊥|)
```

Das ist der „Abwickel"-Trick (Entfalten in die Ebene): die Summe zweier Abstände zu einer
Geraden ist konvex, das Minimum hat diese geschlossene Form. **Kein Suchen, kein Iterieren,
kein Jitter.** Der Kontakt gleitet dadurch kontinuierlich mit — an senkrechten Säulenkanten
nach oben/unten, an Wandoberkanten seitlich.

*Gemessen:* bei 3 m Seitwärtsbewegung des Spielers wandert der Kontakt 1.63 m stetig entlang
der Kante; an einer Säule folgt er 2.97 m vertikal.

### 6.3 Mehrfach-Wicklung mit Lookahead

Ein Seil, das **über eine Wand** läuft, berührt sie an **zwei** Kanten (Eintritt und Austritt).
Ein greediger Solver, der pro Blocker eine Kante wählt, findet das nicht: die beste Einzelkante
ist entweder ungültig (Ablauf taucht in dieselbe Box wieder ein) oder er wählt den viel teureren
Weg ums Ende.

Zwei Mechanismen lösen das:

1. **Der Ablauf darf blockiert sein.** Ein blockierter Ablauf heißt nicht „falsche Kante",
   sondern „Folgekontakt fehlt". Kandidaten werden also *nicht* disqualifiziert, nur weil
   hinter ihnen noch etwas im Weg ist.
2. **Ein-stufiger Lookahead.** Bevor der kürzere, aber unvollständige Kandidat den sicheren
   schlägt, wird geprüft, ob der Folgekontakt tatsächlich existiert (rekursiv, Tiefe 1).

**Ergebnis (gemessen):** Seil über eine 1.5 m dicke, 8 m hohe Wand:
`Pfad = 18.15 m` bei einem geometrischen Optimum von `17.88 m` — **1.5 % über dem Optimum**,
und deutlich besser als der naive Weg ums Wandende (22.6 m). Zwei Kontakte, beide auf echten
Kanten.

### 6.4 „Äußerste Geometrie gewinnt"

Der zuerst getroffene Körper ist nicht immer der, an dem das Seil sich legt. Steht eine
Brüstung auf einem Block, trifft der Strahl den Block — das Seil läuft aber über die
Brüstungskante. Deshalb sucht der Solver bei Bedarf zusätzlich unter den Nachbar-Boxen im
Broadphase-Umfeld der blockierten Strecke und nimmt den global kürzesten gültigen Kontakt.

Zusätzlich gibt es ein **`ropeSolid`-Flag** pro Box (das übliche Collision-Layer-Prinzip):
dünne Zierleisten sind für Spieler und Haken solid, aber nicht seilrelevant. Ohne das
degeneriert das Wrapping an 3-Zentimeter-Kanten, weil ein Kontaktpunkt dort geometrisch
gar keinen Platz mehr hat.

### 6.5 Freigabe: ein Seil ist topologisch GEFANGEN, bis es über eine Kante abrutscht

Die einzig gültige Freigabebedingung ist **lokal**: ein Kontakt verschwindet, wenn das Seil
an ihm geradlinig verlaufen kann, also die Strecke zu seinem Nachbarkontakt frei ist.
Gegen Flackern schützt die Hysterese-Zeit (`wrapReleaseHold`, 85 ms).

Zwei naheliegende Erweiterungen dieser Regel sind falsch und waren zeitweise eingebaut:

**(a) „Anker direkt sichtbar ⇒ alle Kontakte verwerfen."**
Ein Seil, das auf einer Seite eines Objekts liegt, ist dort **gefangen**: beide Abschnitte
ziehen es gegen die Fläche, es kann nur über eine Kante (oben/unten/vorne/hinten) abrutschen.
Dass der Spieler den Anker auf einmal sieht, ändert daran physikalisch nichts. Die Regel
ließ das Seil vollständig durch das Objekt auf die Direktverbindung springen — exakt der
gemeldete Fehler. Sie ist ersatzlos entfernt; Test 10h bildet die gezeichnete Situation
jetzt dauerhaft ab (Anker oben, Objekt mittig, Spieler wandert von links nach rechts):

```
✔ Seil wickelt sich links, solange der Spieler links steht
✔ Szenario erreicht den kritischen Zustand (Direktlinie frei, Seil noch gewickelt)
✔ Seil bleibt gewickelt, obwohl der Anker sichtbar ist — min. 1 Kontakt über die ganze Wanderung
✔ der Pfad läuft dabei nie durch das Objekt   (0 blockierte Segmente)
✔ die Wicklung kostet messbar Seil             (bis 7.11 m mehr als die Luftlinie)
```

**(b) „Topologie von null neu aufbauen und den kürzeren Pfad übernehmen."**
Kürzer ist nicht dasselbe wie erreichbar. Ein Neu-Einfädeln ist ein diskreter Sprung *durch*
das Objekt hindurch auf die andere Seite. Beim Wandern des Spielers von x=2 nach x=4 wechselte
das Seil so von der linken auf die rechte Seite. Entfernt. Der kürzeste Pfad ist nur dort die
richtige Frage, wo das Seil frisch verlegt wird — beim ersten Einfügen eines Kontakts.

Der früher vermutete „gegenseitige Blockade"-Fall zweier Kontakte existiert übrigens nicht,
wenn die lokale Bedingung korrekt ist: beim Seil über einer Wand wird der erste Kontakt frei,
sobald die Strecke Hand→zweiter Kontakt über die Kante läuft; danach der zweite. Sie geben
sequenziell frei, nicht gemeinsam.

### 6.6 Zwei Zeitskalen

Der teure Teil (Clearance-Tests, Insert, Release, Reparatur) läuft mit `topologyHz = 60`.
Der billige, analytische Teil (Kontakt auf der Kante nachlösen, Polylinie vermessen) läuft
mit der vollen Physik-Rate von 120 Hz. Gleitende Kontakte bleiben dadurch butterweich, ohne
dass sich die Raycast-Kosten verdoppeln.

*Gemessen:* Pfad-Solver 156 µs → **92 µs** pro Substep (1.7×), Raycasts 21 → 5.

### 6.7 Kantenenden: weitergleiten — ohne Snappen

Ein Kontakt gleitet analytisch entlang seiner Kante — aber was passiert am **Ende** des
Kantenverlaufs? `edgeTouchPoint` begrenzt `t` auf `[0, elen]`, der Kontakt steht dann auf
der Ecke. Physikalisch kann das Seil jetzt zwei Dinge tun, und beides passiert genau so:

**(a) Am Ende läuft nichts weiter → darüber rutschen und lösen.**
Der Kontakt bleibt auf der Ecke liegen (das Seil wird um den Eck*punkt* geführt — korrekt),
und sobald die direkte Strecke zum Nachbarn frei ist, rutscht er mit 85 ms Hysterese ab
(6.5). Test 10i-a: der Kontakt gleitet bis ans Schienenende (max. x = 6.10 m bei Ende 6.0),
der Pfad ist dabei nie blockiert, am Ende bleiben 0 Restkontakte, kein Längensprung nach
oben.

**(b) Das Seil kann von der Ecke auf angrenzende Geometrie weiterrutschen → `_cornerSlide`.**
(Treppenstufen, Wandecken, Versätze, Würfel-Umrundung.) Gibt es innerhalb
`cornerSlideReach` (0.8 m) um die Ecke eine Kante, auf der die Route **strikt kürzer**
wird (mindestens `cornerSlideGain` = 2 cm), deren Berührpunkt **innen** auf der Kante
liegt und deren Zulauf, Ablauf *und* Koexistenzstrecke (alter → neuer Kontakt) vollständig
frei sind, wird dort ein **neuer** Kontakt angelegt — direkt neben dem alten. Der alte
Kontakt bleibt liegen und geht über die normale Hysterese weg, sobald die direkte Strecke
über ihn hinweg frei ist.

**Ein Kontakt wechselt niemals selbst seine Kante.** Das ist der entscheidende Unterschied
zum früheren „Handoff“, der den Kontakt an eine andere Kante *umsetzte* — bis zu 1.2 m
weit, auch an Kanten anderer Boxen. Sichtbare Folge waren Kontaktsprünge bis 0.82 m;
zusammen mit der damals an Kontakte gepinnten Darstellung sprang das Seil damit „zu einem
Eckpunkt oder Bodenpunkt“ — genau das verbotene Verhalten. Ebenso flog die „Reparatur“
heraus, die einen Kontakt bei blockiertem Zulauf auf die global kürzeste Kante setzte —
sie warf das Seil auf die andere Objektseite. Beim Slide-Insert gilt stattdessen:

* Kontaktpositionen sind stetig — gemessen wandert derselbe Kontakt (Box + Kante) pro
  Beobachtungsschritt höchstens **0.18 m** (Würfel-Umrundung 360°), **0** Sprünge > 0.5 m,
  **0** Seitenwechsel, in allen vier 10i-Szenarien **0** blockierte Segmente.
* Die Route wird bei jedem Slide strikt kürzer ⇒ kein Hin-und-her-Flattern, und das
  spätere Lösen des alten Kontakts verkürzt den Pfad weiter (mehr Spiel — die einseitige
  Constraint zieht dabei nie).
* Der Umweg während der Koexistenz ist der ehrliche Preis: Würfel-Umrundung 46.7 m·Schritte
  Pfad-Überschuss (Handoff: 2.2, reines Festkleben: 31.3) — kurzzeitig, stetig, ohne
  Längensprung nach oben (max. +0.17 m/Schritt, von der Constraint über den gedeckelten
  Bias getragen).


---

## 7. Schicht 2 — Die Constraint: ein Seil kann ziehen, aber nie drücken

### 7.1 Formulierung

```
g(x) = s(x) − L ≤ 0        s = Welt-Pfadlänge, L = Budget
```

Das ist eine **einseitige** (unilaterale) Distanz-Constraint auf der *Pfadlänge*, nicht auf
der Luftlinie. Gelöst wird auf **Geschwindigkeitsebene**, nie auf Positionsebene:

```
n̂    = −Tangente am Spieler-Ende des Pfads        (Richtung wachsender Pfadlänge)
v_n  = v · n̂
wenn v_n > 0:   v ← v − n̂ · v_n · (1 + e)          e = 0 default: kein Abprallen
wenn s − L > 0: v ← v − n̂ · min(v_max, β·(s−L)/Δt) (Baumgarte-Bias)
```

**Konsequenzen, die genau die Anforderungen treffen:**

* **Kein Teleport, kein hartes Setzen der Position.** Es wird ausschließlich Impuls geändert.
* **Tangentialgeschwindigkeit bleibt vollständig erhalten** — und genau das *ist* Pendeln.
  Aus einer geraden Bewegung wird automatisch eine Kreisbahn, ohne dass irgendwo „Swing-Code"
  stünde. Das Schwingen ist keine implementierte Mechanik, sondern die Abwesenheit einer
  Störung.
* **Einseitigkeit:** `v_n < 0` (Annäherung) wird nie angetastet. Das Seil kann nicht drücken.
  Bewegt sich der Spieler nach innen, wird das Seil lose — und die Darstellung hängt durch.
* **Baumgarte-Bias statt Positionskorrektur:** eine vorhandene Überdehnung wird über mehrere
  Frames als *Geschwindigkeit* abgebaut. Das ist stabil, frame-raten-unabhängig und fühlt
  sich nach Masse an statt nach Gummiband-Teleport.

### 7.2 Warum die Constraint-Normale trivial ist (Hüllkurpensatz)

Die Normalenrichtung ist `∂s/∂x` am Spieler-Ende. Obwohl `s` über Umlenkkontakte läuft, deren
Positionen selbst von `x` abhängen, gilt:

> Weil der Pfad der **kürzeste** ist, stehen die inneren Kontaktpunkte an einer stationären
> Stelle. Nach dem Hüllkurpensatz fällt der Ableitungsbeitrag der inneren Freiheitsgrade weg,
> und es bleibt exakt die **Endtangente**.

Die Constraint-Normale ist also einfach die Richtung des ersten Pfadsegments — auch bei
mehrfacher Umlenkung. Keine numerische Differenzierung, keine Näherung, keine Zusatzkosten.
(Deshalb ist „kürzester Pfad" hier nicht nur physikalisch richtig, sondern auch numerisch
die Voraussetzung.)

### 7.3 Attack-Point: Brust statt Hand

Die Constraint greift am **Körperschwerpunkt** (Brustpunkt) an, die Darstellung beginnt an der
**sichtbaren Hand**. Bewegt sich die Kamera beim Umsehen, wandert die Hand — würde die Constraint
dort angreifen, änderte sich die Seillänge beim bloßen Umschauen (spürbares Rucken). Die
Differenz beträgt ~0.4 m bei typisch 20 m Seil und ist optisch unsichtbar, physikalisch aber
die richtige Trennung: **Blick steuert nicht die Mechanik.**

---

## 8. Die Form des Seils

### 8.1 Die Regel

Der Seilverlauf ist **eine einzige kontinuierliche Kurve** über seine Bogenlänge.
Ein Hinderniskontakt darf die horizontale Orientierung des Seils ändern, erzeugt
aber **keine zweite, unabhängige Durchhangkurve**. An einem solchen Kontakt sind
Höhe und Steigung stetig:

```
z(s_c⁻) = z(s_c⁺)        dz/ds(s_c⁻) = dz/ds(s_c⁺)
```

Getrennt wird nur dort, wo eine Kante das Seil **vertikal trägt** — Ober- oder
Unterkante. Dort ist die Höhe erzwungen und die Steigung darf knicken, weil die
Kante Last aufnimmt. Eine vertikale Kante lenkt dagegen nur horizontal ab.

### 8.2 Was vorher falsch war

Drei Ansätze sind ausprobiert und verworfen:

1. **Guide + künstlicher Durchhang.** Der Durchhang wurde nach einer
   Kettenlinien-Formel über die Luftlinie gerechnet und als Zielkurve benutzt.
   Bei Umlenkung über eine Kante lag der Guide *in* der Wand, während der
   Constraint-Solver das Seil nach außen drückte. Zwei Autoritäten für dieselbe
   Länge → das Seil zuckte.

2. **Verlet-Kette mit Pins.** Die Kette simulierte den Durchhang physikalisch
   korrekt, aber jeder Pin (Hand, Umlenkkontakt, Anker) trennte eine eigene
   Spannweite ab, die für sich durchhing. An einer vertikalen Kante entstanden
   dadurch zwei Kurven mit V-Knick — das Bild „das Seil hängt an der Ecke wie an
   einem Haken“ — und der Kontaktpunkt konnte in der Höhe nicht wandern, weil er
   an seine eigene Spannweite genagelt war.

3. **Analytische Ein-Kurven-Form** (Parabel je Spannweite zwischen Tragpunkten,
   Nodes per Feder daran geführt). Erfüllte 8.1 by construction, scheiterte aber
   an zwei Messfehlern mit Ansage:
   * **Deckel auf dem Durchhang.** `d = min(0.42·S, √(3Se/8))` konnte großen
     Seilüberschuss nicht darstellen: bei 14.5 m Spiel waren nur **4.0 m von
     17.75 m** Budget sichtbar, der tiefste Punkt schwebte 0.96 m über dem Boden
     — „das Seil hat keine Länge mehr, es hängt nicht auf dem Boden“. Durchhang
     ist in Wahrheit unbegrenzt; jede Formel mit Deckel zerstört genau den
     Effekt, den ein Seil transportieren soll: Spiel, Durchhängen, Aufliegen,
     sich Stapeln.
   * **Flug gegen den alten Anker.** In der Flugphase (`path = null`)
     interpolierte die Zielkurve zwischen Hand und **`this.anchor`** — dem
     *vorigen* Anker. Das Seil lief vom fliegenden Haken in zwei geraden Linien
     zu einem Punkt am Boden (gemessen: Ketten-Node 5.3 m neben der Fluglinie,
     bei y = −3.7 m unter dem Boden).

Konsequenz: **keine berechnete Form mehr.** Das Seil ist die Simulation.

### 8.3 Umsetzung: die physikalische Kette

| Größe | Wert |
| --- | --- |
| Nodes | folgen der Seillänge: `L/chainSpacing` (0.45 m), Pool 96. Ändert sich die Zahl, wird entlang der Polylinie neu abgetastet (Position **und** Geschwindigkeit) — stetig, ohne Sprung |
| Integration | Verlet: `x' = x + (x−x_prev)·damping + g·h²`, `chainDrag` 0.55/s, Verschiebung pro Schritt auf 2 m begrenzt (reine Absturzsicherung) |
| Länge | Abstands-Constraints auf `L/(n−1)` — `chainIterations` 14 Gauss-Seidel-Sweeps im Richtungswechsel, mit Überrelaxation `chainSOR` 1.6 |
| Überrelaxation | **nur** bei `|Fehler| < Ruhelänge`. Große Fehler (Entfalten, Budget-Sprünge, Peitschen) werden zu 100 % korrigiert — ω > 1 würde dort überschießen und die Kette aufreißen (gemessen: 6 m Lücken, Defekt #49) |
| Enden | jede Iteration gepinnt: sichtbarer Seil-Austritt (Hand) und Anker bzw. fliegender Haken. Sonst ist alles frei |
| Kollision | Welt-Kollision im Fenster der letzten 4 Iterationen (nach dem letzten Sweep steckt kein Node in Geometrie), Spielerkapsel, Kontaktsreibung `chainFriction` 0.45 (stabilisiert Seilhaufen auf dem Boden) |
| Neulegen | Flug: Gerade Hand→Haken. Eingehakt: **entlang des gelösten Welt-Pfads** — nicht als Gerade durchs Hindernis, sonst entscheidet der Zufall der Herausdrück-Richtung, auf welcher Seite das Seil landet (gemessen: Seil unter der Box statt um die gelöste Kante, Defekt #51) |
| Render | zentripetaler Catmull-Rom über die Nodes + Kollisionsklammer + begrenzte Eck-Reparatur (8.5) |

**Warum das 8.1 by construction erfüllt:** eine Verlet-Kette ist *eine* stetige Kurve —
die Höhe kann nirgends springen (benachbarte Nodes trennt genau ein Segment; gemessen
max. 0.47 m bei 0.45 m Soll), und die Steigung springt nur, wo eine Kante das Seil
wirklich trägt. An einer *vertikalen* Umlenkkante hängt sich das Seil so lange um, bis
die Steigung beidseitig gleich ist — gemessener Steigungssprung **0.039** an der
Kontaktstelle (ein V-Knick wäre > 1). Genau die geforderte `dz/ds`-Stetigkeit, nur eben
physikalisch erreicht statt per Formel erzwungen.

**Die Länge ist die eine Autorität:** Σ Segmentlängen = Budget. Gemessen: bei 17.75 m
Budget und 14.5 m Spiel ist die sichtbare Kurve **17.72 m** lang und der tiefste Punkt
liegt auf dem Boden (y = 0.07 m = Node-Radius); straff folgt die Kurvenlänge dem
Welt-Pfad (11.93 m bei 11.82 m Pfad). Dehnung unter Eigengewicht: **0.8 %**; der
Durchhang stimmt auf 0.14 m mit der Kettenlinien-Referenz überein (0.66 m gemessen,
0.52 m Referenz bei 0.05 m Spiel über 14.7 m Spannweite — die Referenz ist eine
Näherung, und die Kette ist das, was ein echtes Seil tut).

### 8.4 Was der Constraint-Layer macht — und was nicht

Die Spieler-Physik hat eine einseitige Velocity-Constraint auf `g(x) = s(x) − L`:
wird die Pfadbogenlänge größer als das Budget, wird nur die Radialkomponente der
Geschwindigkeit entfernt; der Tangentialimpuls bleibt exakt erhalten. Das ist der
Teil, der Schwingen und Pumpen trägt. Er hat nichts mit der sichtbaren Form zu
tun: die Form kommt aus 8.3.

Das **Setzen** (`settleActive`) ist ein einmaliger Vorgang: Nach dem Verankern
wird ein Ziel `required + tautMargin` gesetzt und der Überschuss mit
`settleReelSpeed` eingezogen. Es wird nicht nachgezogen, sobald der Spieler
wegläuft — das wäre ein Gummiband. Der Anker darf das Budget nur erhöhen, nie
senken.

### 8.5 Kollisionsgarantie

Der Pfad-Solver nimmt nur Kontakte, deren Gerade den betroffenen Körper mit
Absolutabstand meidet (`segmentAvoidsBox`, 16 Samples). Graze gilt auch dann,
wenn Start- und Endbox derselbe Körper sind — Ausnahmen davon haben Kontakte auf
gegenüberliegenden Flächen erlaubt, also Strecken quer durch einen Block.
`collideSphere` ignoriert dieselben Körper wie der Pfad-Solver (`ropeSolid`).

Kette und Bild haben drei unabhängige Stufen:

1. **Nodes.** `collideSphere` in jeder späten Constraint-Iteration — nach dem
   letzten Sweep steckt kein Node in fester Geometrie (Test 10f: 0 von 225 600).
   Der Tief-im-Inneren-Zweig schiebt dabei nicht blind über die kürzeste Achse
   heraus: an einer konkaven Ecke (Wand auf Boden) drückt die den Punkt in die
   Nachbarbox und zurück — unter den Boden (gemessen: y = −0.105 m, Defekt #50).
   Stattdessen werden Flächen-Kandidaten in Distanzreihenfolge probiert und nur
   ein Ziel akzeptiert, das nicht in einer anderen Box liegt (zwei
   Margin-Stufen, Fallback = kürzeste Fläche).
2. **Render-Stützpunkte.** Jeder Spline-Sample wird aus der Geometrie geschoben
   (`chainNodeRadius + renderEdgeClearance`); ein zweiter Pass läuft nur über den
   Bereich, den der erste bewegt hat (Herausschieben aus Box A kann in Box B
   drücken).
3. **Eck-Reparatur.** An einer konvexen Kante landen zwei benachbarte
   Stützpunkte auf *verschiedenen* Flächen — beide korrekt draußen, aber ihre
   Verbindungsstrecke läuft durch die Kante. Liegt die Mitte eines Segments in
   Geometrie, wird dort ein ebenfalls herausgeschobener Punkt eingefügt.
   Begrenzt auf 2 Passs × 96 Einfügungen — terminiert by Konstruktion.
   (Unbegrenztes Teilen am Trefferpunkt wurde verworfen: trifft der eingefügte
   Punkt die Kante immer noch, wird erneut geteilt — ohne Schranke füllt so eine
   Schleife den Puffer mit Unsinn.)

### 8.6 Zahlen

| Messung | Ergebnis |
| --- | --- |
| Steigungssprung an vertikalen Umlenkkanten | **0.039** (V-Knick wäre > 1) |
| Dehnung unter Eigengewicht (frei hängend) | **0.8 %** |
| Durchhang gegen Kettenlinien-Referenz | 0.66 m vs. 0.52 m |
| Sichtbare Länge vs. Budget (14.5 m Spiel) | **17.72 / 17.75 m**, Auflage auf dem Boden |
| Sichtbare Länge vs. Welt-Pfad (straff) | 11.93 / 11.82 m |
| Eindringtiefe der sichtbaren Kurve | ≤ **0.009 m** |
| Segmente, die Geometrie berühren | 173 / 741 417 (**0.023 %**) |
| Ketten-Node in Geometrie | **0** / 225 600 |
| Kette pro Substep (49 Nodes / 96 Nodes) | 314 µs / 640 µs |


## 9. Schwingen: es entsteht, es wird nicht gemacht

### 9.1 Pendel

Es gibt keinen Pendel-Code. Der Spieler ist ein Körper unter Gravitation mit einer einseitigen
Radial-Constraint. Daraus folgt automatisch:

* Aufhängen unter dem Anker → Gravitation erzeugt Tangentialbeschleunigung → Pendeln.
* Seitwärts bewegen → Schwung aufbauen; am Umkehrpunkt wird Bewegungsenergie zu Lageenergie.
* Dämpfung ausschließlich über Luftwiderstand und die (bewusst kleine) Luftkontrolle.

*Gemessen:* über 15 s Pendel bleibt `r ≤ 12.26 m` bei `L = 12 m` (Überdehnung ≤ 2.2 %, vom
Baumgarte-Bias sofort wieder abgebaut), `r_min = 11.93 m` (kein Kollaps nach innen),
keine NaN, Geschwindigkeitsverhältnis früh/spät = 1.105 (Fenster-Artefakt der Messung,
kein systematischer Energieeintrag — die Constraint entfernt nur Radialkomponenten).

### 9.2 Einfluss ohne Physik-Bruch

Der Spieler behält Kontrolle, aber sie ist **tangential projiziert**:

```
t̂ = normalize( wishDir − r̂·(wishDir·r̂) )        r̂ = Richtung Pivot→Spieler
v += t̂ · accel · Δt      (accel = swingAirAccel, capped bei swingMaxSpeed)
```

Radial wirkt die Eingabe nicht — das Seil „frisst" sie. Damit bleibt jede Eingabe mit der
Constraint verträglich: sie kann das Seil nicht dehnen und nicht stauchen.

### 9.3 Pumpen über Winkelimpuls-Erhaltung (statt Fake-Boost)

Der eleganteste Teil. Echtes Schaukel-Pumpen funktioniert so: **Seil kürzen am unteren
Totpunkt, nachlassen am Umkehrpunkt.** Wegen `L·ω = const` steigt die Winkelgeschwindigkeit
beim Kürzen — die Amplitude wächst, weil Arbeit gegen die Zentrifugalkraft verrichtet wird.

Genau das wird modelliert, und zwar **nullmittelnd**, damit das Budget nicht driftet:

```
phase   = smoothstep(v_min, v_max, |v_tangential|)      // 1 am Totpunkt, 0 am Umkehrpunkt
pumpOff = pumpReel · input · (1 − 2·phase)              // −pumpReel … +pumpReel
L_wirksam = L + pumpOff                                  // nur für Constraint + Kettenlänge
```

Es wird also nichts „hinzugefügt" — die Amplitude wächst ausschließlich aus dem, was die
Physik hergibt. Wer aufhört zu pumpen, hört auf zu wachsen.

**Zusätzlich** gibt es ein direktes Gewichtsverlagerungs-Drehmoment (`pumpTorque`), das
tangential zur Pendelebene wirkt. Begründung: das Seil greift an der *Hand über* dem
Schwerpunkt an — sich nach vorne lehnen erzeugt real ein Drehmoment um den Aufhängepunkt.
Es ist also keine Game-Behelfskraft, sondern die Abstraktion einer echten Körperbewegung.

*Gemessen (A/B, Luftkontrolle deaktiviert, damit nur das Pumpen variiert):*
Amplitude **ohne** Pumpen 85.4° → 90.5°, **mit** Pumpen 132.1° → **151.6°**.
Budget-Drift: **0.000 m**. Seillänge eingehalten: `r = 10.35 m` bei `L = 11 m`.

### 9.4 Lösen mit Impulserhalt

`Space` am Seil löst die Verbindung und ändert **keine** Geschwindigkeit (`detachBoost = 0`
per Default). Schwungketten funktionieren, weil der Impuls real vorhanden ist — nicht weil
ein Boost aufgeschlagen wird. Wer höher will, muss vorher höher schwingen.

---

## 10. Bewegliche Körper und Rückwirkung

* **Kinematische Körper** (Plattformen, Pendel-Block) nehmen am Wrapping teil. Ihre Kontakte
  speichern die Box-Referenz, wandern also automatisch mit. Der Spieler wird auf kinematischen
  Körpern mitgenommen ( Positions-Delta, kein Geschwindigkeits-Hack).
* **Dynamische Körper** (Kisten, Container) erhalten die **Rückwirkung der Seilkraft**:
  an jedem Umlenkkontakt wird die Kraft entlang der Winkelhalbierenden der beiden angrenzenden
  Segmente eingekoppelt, am Anker entlang der Seilrichtung. Damit zieht ein gespanntes Seil
  eine Kiste real zu sich heran — und eine Kiste, die in ein gespanntes Seil fährt, ändert
  dessen Verlauf *und* verkürzt die verfügbare Reichweite.
* **Länge folgt dem Welt-Verlauf.** Weil `s(x)` aus der Polylinie um alle Kontakte herum
  berechnet wird, kostet jede Umlenkung automatisch Budget. Man bekommt „weniger Seil", wenn
  man um eine Säule herum muss — ohne dass das irgendwo kodiert wäre. Es ist dieselbe Zahl.

*Gemessen:* bewegliches Hindernis auf Kollisionskurs → Pfadlänge pendelt zwischen 14.00 m
(Luftlinie, Hindernis weg) und 21.85 m (Umlenkung), in **0 von 900** Schritten kollisionsbehaftet;
eine 120-kg-Kiste wird über 3.69 m gezogen.

---

## 11. Warum das *ein* System ist und nicht mehrere Tricks

Der entscheidende Punkt ist nicht, dass drei Techniken kombiniert werden, sondern dass sie
**über dieselbe physikalische Zustandsgröße gekoppelt** sind und nicht über Ereignis-Übergaben:

| Phänomen | entsteht aus |
|---|---|
| loses Seil im Flug | `L >` Luftlinie, weil Bogenlänge > Luftlinie |
| sichtbares Straffen | Setz-Einzug verkürzt `L` auf `s + tautMargin`; die Kette hat dann keine andere Lösung als die Gerade |
| Durchhängen bei Annäherung | `L > s` ⇒ die Constraints sind nur noch als Kettenlinie erfüllbar |
| Zug am Spieler | `slack ≤ 0` ⇒ Constraint aktiv |
| kürzere Reichweite bei Umlenkung | `s` wächst ⇒ `slack` schrumpft |
| Kiste wird gezogen | `tensionLevel` ⇒ `distributeReaction` |
| Seil knarzt | `tensionLevel · |v|` ⇒ Filterfrequenz + Gain |
| Seil zittert unter Last | `tensionLevel · |v|` ⇒ Render-Amplitude |
| FOV-Kick beim Verankern | Impact-Geschwindigkeit des Hakens |

Es gibt **eine** Quelle der Wahrheit (`s`, `L`, `slack`, `tensionLevel`), und jedes Subsystem
— Mechanik, Darstellung, Audio, Kamera — liest daraus ab. Deshalb wirkt nichts angeklebt.

Der Zustandsautomat `IDLE → FLIGHT → SETTLING → ATTACHED → RETRACT` ist dabei *kein*
Zustandsautomat im Gameplay-Sinn (er schaltet keine Kräfte um), sondern beschreibt nur,
**wo das ferne Seilende gerade befestigt ist** (Haken / Anker) und ob noch Überschuss
eingezogen wird. Constraint, Pfad und Kette laufen in allen Zuständen durch dasselbe Code-Pfad.

---

## 12. Numerik und Stabilität

| Aspekt | Entscheidung | Begründung |
|---|---|---|
| Physik-Rate | fix 120 Hz, Akkumulator, max. 8 Substeps | Constraint-Lösen ist ratenabhängig; variable Raten würden das Seilgefühl ändern |
| Constraint-Ebene | Velocity, nie Position | keine Teleportie, Impulserhaltung tangential |
| Überdehnungsabbau | Baumgarte `β = 0.45`, gedeckelt auf 18 m/s | stabil bei jeder Framerate, kein hartes Einrasten |
| Kette | Verlet, Ruhelängen = Budget/(n−1), 14 Sweeps mit SOR 1.6 — Überrelaxation nur bei kleinen Fehlern | unbedingt stabil; ω > 1 auf große Fehler würde die Kette aufreißen (gemessen: 6 m Lücken, #49) |
| Ketten-Kollision | `collideSphere`, allokationsfrei, im Fenster der letzten 4 Sweeps; Push-out aus dem Box-Inneren nur auf geprüfte Flächen-Kandidaten | lose Seile drapieren sich statt zu clippen; kein Hin-und-her-Schieben an konkaven Ecken (#50) |
| Render-Kurve | Catmull-Rom + Klammer + begrenzte Eck-Reparatur (2 × 96 Insertionen) | Stützpunkte nie in Geometrie; gerade Verbindungen über konvexe Kanten werden einmal mittig geteilt (#51) |
| Charakter-Sweep | Move-and-Slide mit Substeps ≤ 0.8·r | kein Tunneln |
| Tiefe Penetration | Min-Achsen-Pushout | **wichtig:** ohne diesen Fall bleibt die Kapsel in dünnen Wänden stecken, wenn starker Seilzug sie hineindrückt |
| Solver-Zustände | `NaN`-sichere Defaults | Teil-Parameter dürfen nie zu `NaN`-Timern führen |
| Selbstkollision des Seils | bewusst **nicht** | bei ~45 Nodes und Seildicke 5 cm nie sichtbar; Kosten unverhältnismäßig |

**Stabilität gemessen:** 30 s Chaos-Spielbetrieb (randomisiertes Laufen, Springen, Feuern,
Lösen über 10 Szenarios, 3600 Substeps) — keine NaN, maximale Constraint-Überdehnung
**0.106 m**, Ruhelage-Jitter **0.000 mm**.

---

## 13. Performance (Node 20, gemessen, 49 statische + 7 dynamische Boxen)

| Messung | Kosten |
|---|---|
| Kompletter Physik-Substep, Seil um Wand+Block (2 Kontakte, gleitend) | **452 µs** |
| … davon Pfad-Solver isoliert (2 Kontakte, eingeschwungen) | 68 µs |
| … davon Seilkette isoliert (49 Nodes) | 314 µs |
| Substep ohne Seil (Spieler + 7 Körper + Kollision) | 61 µs |
| Substep mit straffem Seil, freie Sicht (0 Kontakte) | 417 µs |
| Würfel-Umrundung (gleitender Kontakt + Ecken-Fortsetzungen) | 292 µs |
| Kette mit 96 Nodes (Nahaufnahme-Qualität, `chainSpacing` 0.15) | 640 µs |
| **Pro Frame bei 60 Hz (2 Substeps)** | **≈ 0.9 ms** |

Bei einem 16.6-ms-Budget sind das **rund 5 %**. Drei Hebel halten die Kette bezahlbar:

* Die Node-Zahl **folgt der Seillänge** (`chainSpacing` 0.45 m) statt fest zu sein —
  ein 8-m-Seil rechnet mit ~19 Nodes, nicht mit 96.
* Welt-Kollision läuft nur im **Fenster der letzten 4 von 14 Iterationen**; die frühen
  Sweeps sind reine (billige) Constraints. Die Garantie „kein Node in Geometrie“ gilt
  trotzdem, weil der letzte Sweep kollidiert.
* Die teure Topologie-Arbeit (Clearance-Tests, Insert, Release, Ecken-Fortsetzung)
  läuft mit `topologyHz` = 60 statt mit der Physik-Rate; die analytische
  Kontakt-Nachführung dazwischen kostet fast nichts.

Die Ecken-Fortsetzung selbst ist billig: sie wird nur für Kontakte ausgelöst, die
wirklich am Ende ihres Kantenverlaufs stehen, und prüft dann 2 Nachbarkanten plus die
12 Kanten jeder Box in einem 0.8-m-Fenster. Im gemessenen Umrundungs-Benchmark
(47 Fortsetzungen) liegt der ganze Substep bei 292 µs.

Der Renderer des Prototyps braucht pro Frame 4 Draw-Calls (instanziierte Boxen,
Seil-Ribbon, Partikel, Linien).

**Skalierung:** Die Solver-Kosten skalieren mit der Zahl *aktiver Umlenkkontakte*, nicht mit
der Levelgröße (Broadphase über flaches `Float32Array`). Die Kettenkosten skalieren mit
Node-Zahl × Kollisionsfenster; `collideSphere` ist ein flacher Lauf über alle Boxen —
für Levels mit >5000 Boxen: Uniform-Grid oder BVH für `raycast`/`segmentClear`/
`collideSphere`, der Rest bleibt unverändert.


---

## 14. Verifikation

Alles headless (kein Browser, keine GPU nötig):

```
node tools/test_sim.js       # 179 physikalische Assertions
node tools/test_browser.js   # Renderer/Loop/HUD gegen DOM-+WebGL2-Stub
node tools/check_panel.js    # 29 Regler + 6 Schalter: zeigt/erreicht jeder seinen echten Wert?
node tools/bench.js          # Micro-Benchmarks
```

`test_sim.js` prüft nicht „läuft ohne Fehler", sondern die **physikalischen Behauptungen**:

* Ruhelage exakt auf der Kapsel, Jitter 0.000 mm, keine Restgeschwindigkeit
* ballistische Ziellösung trifft exakt (0.0000 m Fehler ohne Drag, 0.219 m mit Drag über 36 m)
* Bahn ist gekrümmt (0.99 m Abweichung von der Luftlinie), `a_y ≈ g`
* ausgegebenes Seil ist länger als die Luftlinie (2.26 m Überschuss), Kette hängt durch (31/36 Nodes)
* Setzen erreicht ATTACHED in 0.44 s, Budget = Pfad + definiertes Spiel
* Budget bleibt erhalten, Annäherung erzeugt Spiel, `tensionLevel` fällt auf 0
* **Tangentialimpuls bleibt zu 100 % erhalten** (|v| 12.000 → 12.000)
* Radialkomponente wird entfernt; **Annäherung wird nicht gebremst** (einseitig!)
* Pendel über 15 s: `r_max ≤ L + 0.26`, kein Kollaps, keine NaN
* Wand-Umlenkung: 2 Kontakte, 18.15 m vs. Optimum 17.88 m
* Kontakt gleitet stetig, kein Flackern (0 Wechsel / 200 Schritte), vollständige weiche Freigabe
* Säulen-Umlenkung mit vertikalem Gleitkontakt
* bewegliches Hindernis: 0/900 kollisionsbehaftete Schritte, Pfadlänge folgt der Bewegung
* Rückwirkung zieht eine 120-kg-Kiste 3.69 m
* Pumpen vergrößert die Amplitude (90.5° → 151.6°) mit 0.000 m Budget-Drift
* **Kantenenden** (10i): Kontakt gleitet bis ans Ende (max. x 6.10 bei Ende 6.0), rutscht
  darüber ab und löst sich (0 Restkontakte, kein Längensprung nach oben); an der Stufe
  übernimmt die Nachbarbox über Koexistenz (neuer Kontakt auf B, alter auf A löst sich);
  Würfel-Umrundung und Seitenwanderung: derselbe Kontakt wandert max. **0.18 m** pro
  Schritt, **0** Sprünge, **0** Seitenwechsel, **0** blockierte Segmente
* **Seillänge ist sichtbar** (10j): bei 14.5 m Spiel hängt das Seil bis auf den Boden
  (tiefster Node y = 0.07 m = Radius) und die sichtbare Kurve ist **17.72 m von 17.75 m**
  Budget lang; im Flug bleibt jeder Node im Korridor Hand→Haken, innerhalb der bezahlten
  Länge, außerhalb jeder Geometrie, und bewegt sich ≤ Hakenvorschub pro Substep (kein
  Teleport); der alte Anker wird ignoriert
* **Ein-Kurven-Stetigkeit** (10g2): lückenlose Kette (max. 0.47 m bei 0.45 m Sollsegment),
  Steigungssprung an der vertikalen Umlenkkante **0.039** (V-Knick > 1)
* 30 s Chaos-Betrieb: keine NaN, Überdehnung ≤ 0.106 m

---

## 15. A/B gegen die naiven Referenz-Ansätze

Die drei Schichten lassen sich einzeln abschalten — im laufenden Betrieb über das
Parameter-Panel rechts, oder per Flag. Das ist keine Spielerei, sondern der Nachweis, dass
jede Schicht eine messbare Funktion hat:

| Flag | aus = | gemessener Effekt |
|---|---|---|
| `wrapPhysics` | „Luftlinie bleibt Seillänge" | **1181 Regelverletzungen** (Spieler ist legal zu weit, bis zu 6.0 m) gegenüber **1** beim Hybrid |
| `rigidRod` | zweiseitige Stange | `r_min = 12.00 m` (fixiert) statt `6.93 m` — Durchhängen unmöglich, Pendeln bricht zusammen |
| `chainCollideWorld` | Seil ohne Geometrie-Kollision | Nodes und Render-Punkte landen in Wand und Boden — die Kollisionsgarantie (8.5) ist abgeschaltet, das Bild sofort sichtbar falsch |

`wrapPhysics = false` ist der interessanteste Fall: das Seil sieht *ähnlich* aus, aber die
Constraint benutzt die Luftlinie. Der Spieler läuft um eine Wand herum und bekommt plötzlich
Reichweite, die das Seil physikalisch nicht hat — bzw. wird durch die Wand gezogen, weil die
Constraint-Normale durch sie hindurchzeigt. Genau die Anforderung „die tatsächliche Länge soll
sich aus dem realen Verlauf ergeben" ist damit nicht erfüllbar.

---

## 16. Parameter-Guide (Auszug)

| Parameter | Default | Wirkung / wie einstellen |
|---|---|---|
| `settleReelSpeed` | 30 m/s | wie schnell der Überschuss nach dem Verankern eingezogen wird — das ist das sichtbare „Zusammenziehen" |
| `chainSpacing` | 0.45 m | Node-Abstand der Seilkette — die Auflösung des sichtbaren Seils. Kleiner = glatter und teurer (Kosten ∝ Node-Zahl) |
| `chainIterations` / `chainSOR` | 14 / 1.6 | Längentreue der Kette: Default = 0.8 % Dehnung unter Eigengewicht. Weniger Iterationen = weicher, gummiartiger |
| `chainDrag` | 0.55/s | Luftdämpfung der Kette. Höher = ruhigeres Hängen, niedriger = langlebigere Peitschen |
| `chainFriction` | 0.45 | tangentiale Bremsung bei Geometriekontakt — stabilisiert Seilhaufen auf dem Boden und lässt das Seil langsam über Kanten gleiten |
| `tautMargin` | 0.12 m | Restspiel im straffen Zustand. Größer = weicherer Übergang, aber schwammiger |
| `baumgarteBeta` | 0.45 | Abbau-Rate von Überdehnung. Höher = straffer, aber sichtbar „zugezogen" |
| `maxBiasSpeed` | 6.0 m/s | Cap gegen harte Korrekturen — niemals hochsetzen, das ist der Anti-Ruckel-Schutz (bei 18 m/s wurde der Bias zum Zugmittel, Defekt #35) |
| `elasticity` | 0.0 | 0 = starr (empfohlen). >0 = Gummiseil, Federanteil |
| `wrapClearance` | 0.14 m | Abstand Seilmittellinie zur Kante ≈ Seildicke. Auch der Anti-Z-Fighting-Abstand |
| `wrapReleaseHold` | 85 ms | Hysterese. Bei Flackern erhöhen, bei „klebriger" Wirkung senken |
| `cornerSlideReach` | 0.8 m | wie nah an der Ecke eine Fortsetzung liegen muss, um als Weitergleiten zu gelten. Größer = frühere Ablösung vom Eckpunkt, aber weitere Koexistenz-Umwege |
| `cornerSlideGain` | 0.02 m | Hysterese der Ecken-Fortsetzung: die neue Route muss um mindestens so viel kürzer sein |
| `topologyHz` | 60 | Rate der teuren Pfad-Prüfung. 30 spart weiter, wird bei schnellen Wraps sichtbar |
| `feedGain` | 1.05 | Seilüberschuss im Flug. >1.1 = sichtbar schlaffes Nachlaufen |
| `pumpReel` | 0.95 m | Amplitude des nullmittelnden Pumpens |
| `swingAirAccel` | 30 | Kontrolle beim Schwingen. Zu hoch killt das Pendel-Gefühl |
| `hook.inherit` | 0.42 | Trägheit: Anteil der Spielergeschwindigkeit auf den Haken |

---

## 17. Ehrliche Grenzen

1. **Konvexe AABB-Hüllkörper.** Der Prototyp arbeitet auf achsenparallelen Boxen. Für
   Rotationskörper: Ray/Segment in den Lokalraum transformieren (OBB) — die Solver-Logik
   bleibt identisch. Für Freiform-Meshes: Kanten-Graph vorbaken oder den Fallback-Kontakt
   (Flächennormale) nutzen, der bereits eingebaut ist.
2. **Greedy mit Lookahead 1, nicht global optimal.** Der Pfad ist lokal optimal und liegt im
   Test 1.5 % über dem analytischen Optimum. Pathologische Fälle (Labyrinth aus vielen
   Körpern zwischen Spieler und Anker) können suboptimal bleiben. Exakte Alternative:
   Sichtgraph über alle Hinderniskanten + Dijkstra/A\*, oder Flächen-Entfaltung für Boxen.
   Beides ist als Austausch hinter `_findContactFor` einsetzbar, ohne dass sich an den
   Schichten 2 und 3 etwas ändert.
3. **Keine Selbstkollision / keine echten Windungen.** „Umwickeln" heißt hier: mehrere
   Umlenkkontakte (getestet bis 3 pro Körper, 6 gesamt). Eine Spirale um einen Mast ist
   damit nicht modelliert — für Parkour-Traversal aber auch nicht nötig.
4. **Seilbruch** ist vorbereitet (`breakTension`), aber standardmäßig aus: ein reißendes Seil
   bestraft Spieler für die Physik des Systems, statt sie zu belohnen.
5. **Kein Drehimpuls um die Seilachse.** Der Spieler ist ein Massenpunkt ohne Rotations-
   kopplung; Seil-Twist ist rein visuell (Verdrillung im Ribbon-Shader).

---

## 18. Portierung auf eine Engine

Die drei Schichten sind engine-unabhängig und lassen sich 1:1 übertragen:

| Schicht | Unity | Unreal | Godot |
|---|---|---|---|
| Pfad-Solver | `Physics.Raycast` (+ `queriesIgnoreTriggers`), Kanten aus `BoxCollider` | `LineTraceSingleByChannel` mit eigenem Collision-Channel für das Seil | `PhysicsDirectSpaceState3D.intersect_ray` |
| Constraint | **nicht** `ConfigurableJoint`/`SpringJoint` (die sind zweiseitig und positionsbasiert). Stattdessen `CharacterController.Move`-Pfad beibehalten und die Velocity-Korrektur selbst anwenden — also genau `constrainPlayer()` | `FConstraintInstance` ebenfalls ungeeignet; besser direkt auf `CharacterMovementComponent::Velocity` arbeiten | `CharacterBody3D.velocity` direkt |
| Darstellung | Verlet-Kette mit harten Pins als `LineRenderer`/eigenes Mesh | `SplineComponent` + eigene Ribbon-Geometrie | `ImmediateMesh` |

**Der wichtigste Portierungshinweis:** Fast jede Engine bringt ein „Rope" oder „Joint" mit,
das genau die in Kapitel 2 beschriebenen Probleme hat. Die Versuchung ist groß, es zu
verwenden. Die einseitige Velocity-Constraint ist ~40 Zeilen Code und der einzige Teil, der
das Spielgefühl wirklich trägt — den sollte man selbst besitzen.

---

## 19. Dateistruktur

```
grapple/
├── index.html              fertiges Spiel, 245 KB, keine Abhängigkeiten (reines WebGL2)
├── README.md               Start, Steuerung, Szenarios
├── doc/ARCHITEKTUR.md      dieses Dokument
├── doc/architektur.svg     Schichten-Diagramm
├── src/
│   ├── 00_math.js          Vec3 / Quat / Mat4 (column-major)
│   ├── 01_world.js         AABB-Welt, Raycast, Sweep, Kapsel-Kollision, dynamische Körper
│   ├── 02_rope.js          ★ Kern: Pfad-Solver, Budget, Constraint, physikalische Seilkette
│   ├── 03_player.js        Parkour-Controller + ballistischer Haken
│   ├── 04_render.js        WebGL2-Renderer (instanziiert, Ribbon, Partikel)
│   ├── 05_fx.js            Partikel + WebAudio-Synth (Last-gesteuert)
│   ├── 06_level.js         Referenz-Level, jede Zone testet eine Seil-Eigenschaft
│   └── 07_game.js          Loop, Input, Viewmodel, HUD, Tuning-Panel
└── tools/
    ├── build.py            konkateniert src/ → index.html
    ├── test_sim.js         165 physikalische Assertions (headless)
    ├── test_browser.js     Renderer/Loop-Smoke-Test gegen DOM+GL-Stub
    ├── check_panel.js      Panel-Regler gegen ihre echten Default-Werte
    └── bench.js            Micro-Benchmarks
```

Das Level ist bewusst als Testparcours gebaut: Treppenturm (Basis-Parkour), Dachroute mit
Pylon über der Schlucht (Schwingen), **Wrap-Wand** mit Ankerblock dahinter (Umlenkung über
eine Kante mit Gleitkontakt), **Säulen-Wrap** (vertikaler Gleitkontakt), kinematische
Hebebühne + Pendel-Block + freie Kisten + schwerer Container (bewegliche Objekte und
Rückwirkung), Wallrun-Wand, Hochhaus (weiter Schwung), Mast (langer Schwung).

---

## 20. Was die Test-Suite tatsächlich gefunden hat

Ein Entwurf ist nur so viel wert wie seine Überprüfung. Die folgenden Defekte sind **nicht**
theoretisch begründet, sondern von `test_sim.js` / `test_browser.js` / `check_panel.js` / den
End-to-End-Szenarios gefunden und behoben worden. Sie stehen hier, weil sie Muster zeigen, die
bei jedem Seilsystem auftreten — und weil sie belegen, dass die Architektur tragfähig ist,
nachdem sie getroffen wurde:

| # | Defekt | Symptom | Ursache / Fix |
|---|---|---|---|
| 46 | **Formkurve zog im Flug zum alten Anker** | Seil lief vom fliegenden Haken in zwei geraden Linien zum Boden — „das Seil teleportiert sich mittig an den Boden" | Die analytische Zielkurve interpolierte im Flug (`path = null`) zwischen Hand und **`this.anchor`** — dem *vorigen* Anker (bei Spielstart: der Ursprung am Boden). Gemessen: Ketten-Node 5.3 m neben der Fluglinie bei y = −3.7 m. Mit der Formkurve entfernt: die Kette pinnt ihre Enden auf Hand und **Haken**, der alte Anker wird im Flug nirgends gelesen (Test 10j-b) |
| 47 | **Durchhang-Deckel machte die Seillänge unsichtbar** | „Ein Seil hat keine Länge mehr, es hängt nicht auf dem Boden" — bei 14.5 m Spiel waren nur 4.0 von 17.75 m sichtbar, tiefster Punkt 0.96 m in der Luft | `d = min(0.42·S, √(3Se/8))` deckelte den Durchhang auf 42 % der Spannweite; großer Seilüberschuss war nicht darstellbar. Fix: physikalische Kette, Länge = Budget als harter Constraint. Gemessen danach: 17.72 m sichtbare Kurve, tiefster Node liegt auf dem Boden (y = 0.07 m = Node-Radius) |
| 48 | **Handoff + Reparatur snappten Kontakte** | Kontakt-Teleporte bis 0.82 m an Kanten anderer Boxen (1.2 m Reichweite); Seil löste sich von der rechten Seite und lief links herum | `_cornerHandoff` setzte Kontakte an andere Kanten um; die `_findBestEdge`-„Reparatur" tat dasselbe bei blockiertem Zulauf — global kürzeste statt stetige Route. Beides entfernt: **Kontakte wechseln nie ihre Kante.** Ecken-Fortsetzung ist jetzt `_cornerSlide` — INSERT eines benachbarten Kontakts (≤ 0.8 m an der Ecke, Route strikt kürzer, Zulauf/Ablauf/Koexistenz frei), der alte löst per Hysterese. Gemessen: max. Wanderung 0.18 m/Schritt, 0 Sprünge, 0 Seitenwechsel |
| 49 | **Überrelaxation riss die Kette auf** | bis zu 6 m Lücken zwischen Nachbar-Nodes beim Entfalten und bei Budget-Sprüngen | SOR (ω = 1.6) verstärkte *große* Constraint-Fehler — Nodes schossen über den Nachbarn hinaus und schaukelten sich auf. Fix: ω nur bei `|Fehler| < Ruhelänge`, sonst exakt 100 % Korrektur |
| 50 | **Push-out klemmte Punkte unter den Boden** | Render-Punkte bei y = −0.105 m — unter dem Boden an der Wandfuß-Kante | Der Tief-im-Inneren-Zweig von `collideSphere` schob über die kürzeste Achse heraus: an einer konkaven Ecke (Wand steht auf Boden) in die Nachbarbox hinein, die schob zurück — Oszillation. Fix: Flächen-Kandidaten in Distanzreihenfolge, erster Kandidat, der in keiner anderen Box liegt (2 Margin-Stufen, Fallback kürzeste Fläche) |
| 51 | **Gerade-Initialisierung war route-zufällig + gerade Verbindungen durch konvexe Kanten** | Seil blieb UNTER der Box hängen statt um die gelöste Kante (42 % Segment-Dehnung an der Unterkante); 0.43 % der Render-Segmente liefen durch Kanten | (a) Neulegen als Gerade Hand→Anker + Herausdrücken überließ die Seitenwahl dem Zufall der Push-out-Richtung; die energetisch günstigere falsche Route war metastabil. Fix: eingehakt wird entlang des Welt-Pfads neugelegt. (b) Zwei benachbarte Render-Samples landen an einer konvexen Kante auf verschiedenen Flächen — beide korrekt, aber die gerade Verbindungslinie zwischen ihnen läuft durch die Kante. Fix: begrenzte Eck-Reparatur (Mittelpunkt in Geometrie ⇒ einen herausgeschobenen Punkt einfügen, 2 Passs × 96). Rate 0.43 % → 0.023 %, max. Tiefe 9 mm |
| 52 | **Panel-Regler zeigten und erreichten ihre echten Werte nicht** | „Ketten-Iterationen" stand am Anschlag 10, während die Physik mit 14 lief — die erste Berührung verschlechterte die Längentreue (0.8 % → 2.6 % Dehnung) und 14 war nie wieder erreichbar; „Suchkegel (°)" zeigte **0** statt 12; „Luftwiderstand" (Haken) sprang beim Anfassen von 0.0026 auf 0.005 | Dieselbe Klasse wie #45, nur auf der Anzeige-Seite: (a) Slider-Bereich [1, 10] kleiner als der Default 14 — der Browser klemmt den Regler, die Zahl daneben zeigte trotzdem „14"; (b) die Winkelzeile rechnete beim *Schreiben* Grad → Radiant, beim *Anzeigen* nicht zurück; (c) Schrittmaß 0.005 passte nicht zum Default 0.0026 — der Browser rundet einen Reglerwert auf sein Raster. Fix: Bereich 1..24, Schritt 0.0002, Einheit als 6. Spalte der Panel-Spec (wirkt symmetrisch auf Anzeige **und** Schreiben), Anzeigegenauigkeit aus dem Schrittmaß abgeleitet statt hartkodiert. `tools/check_panel.js` prüft alle 28 Regler auf genau diese drei Bedingungen |
| 53 | **Seil wirkte schlaff bei Vollspannung + Knick im Ego-Bild** | Trotz `tension=1.0` und `slack=0.05 m` hing die gerenderte Kette 1.4–1.9 m unter dem gelösten Pfad (45 m Spannweite); im Ego-Bild knickte der Seil-Anfang um 6.5–11°, in Third-Person nicht | (a) Die Kette pinnt an der HAND, Länge und Form autorisierte aber der BRUSTpunkt: bei gestrecktem Arm liegt die Hand ~0.6–0.7 m näher am Anker — dieser Offset hing zwischen den Pins als unsichtbarer Seilüberschuss (Ketenar-Verstärkung: 0.6 m Überschuss an 15 m ≈ 1.3 m Durchhang). (b) Das erste Kettensegment sprang von der Hand zum Brustpunkt (der Knick). (c) Gauss-Seidel trifft die Ketenar-Toleranz in 14 Durchläufen prinzipiell nicht (6 cm Restüberschuss an 45 m ⇒ 1 m Durchhang). Fix: Pin-Polylinie (Hand → Wrap-Kontakte → Anker) als Längen- und Form-Autorität der Kette, pin-konsistente Länge, Straff-Projektion auf die Polylinie bei Spiel ≈ 0 (die exakte Lösung des straffen Seils IST der kürzeste freie Pfad), geschwindigkeitserhaltend. Gemessen danach: 0.13–0.31 m Abweichung an 45 m, Knick 1.0–1.4° (Test 13a) |
| 54 | **Seil hob den laufenden Spieler aus** | Rückwärtslaufen am straffen, steilen Seil: y 10.9 → 17.3 m, Bodenkontakt verloren nach 0.3 s — „unsichtbare Schubskraft" statt Mechanik | Die einseitige Constraint wirkte am Boden mit der vollen Seilnormalen: die Einseitigkeits-Korrektur lenkte das Weglaufen in die Pendel-Tangente (nach oben) um, der Baumgarte-Bias zog zusätzlich entlang des Seils — der Boden kam in der Formulierung nicht vor. Fix: am Boden wird die Constraint-Normale auf die Bodenebene projiziert (Seil hält horizontal, Vertikalkomponente trägt der Boden); Bias ebenso; NUR bewusstes Einrollen (Rate < 0 bei steilem Seil) hebt als Winde. Gemessen danach: Höhengewinn 0.00 m, 0 airborne-Substeps (Test 13b) |
| 55 | **Slide endete nie + Haltungswechsel ließ Kapsel schweben** | Slide lief 6 s+ bei v = 0 und blieb geduckt; ein frisch ausgelöster Slide starb nach 0.01 s; „Boden wie Eis, Rutschen ohne Zeitlimit" | (a) Die Aufsteh-Probe zählte aufliegenden Bodenkontakt als Durchdringung (Pad +0.02 bei Abstand == radius) → Aufstehen schlug immer fehl. (b) Die Probe testete die Stehhaltung am geduckten Zentrum statt um den Fußpunkt → die stehende Kapsel „durchdrang" den Boden um die Einzugshöhe. (c) Das Crouch-Schrumpfen hob die Füße für einen Substep (grounded = false) → der Slide starb am eigenen `!grounded`. Fix: Pad −0.03 (nur echte Überlappung > 3 cm blockt), Probe UND Aufstehen um den Fußpunkt, Haltungswechsel dreht um die Füße (Pos-Ausgleich). Gemessen danach: Slide 1.45 s / 8.2 m, danach hh = 0.50; Lauf-Stopp 0.33 s / 0.9 m ab 9.8 m/s (Test 13c) |
| 56 | **Kein Halt am Umlenkpunkt („geschmierter Gummibär")** | Umkreisen der Wrap-Wand: nach 0.5 s schlug +15.5 m freies Spiel in einem Substep zu, Widerstand null, Seil „rutscht immer über die Kante" | Drei Ursachen zusammen: (a) Der greedy-Solver setzte einen Wrap-Kontakt 12 m neben die echte Kante (ans Kantenende geklemmt), und das Setzen **fror** das Budget auf diesem Irrpfad ein (28 m statt 12.5 m); korrigierte sich die Topologie, blieb die Differenz als Spiel stehen. (b) Löste sich ein Wrap, wurde die gespeicherte Länge schlagartig frei — nichts rollte sie nach. (c) Capstan-Dämpfung 0.55/(s·rad) ≈ 1.4/s war gegenüber groundAccel 92 wirkungslos (Gleichgewicht ~64 m/s). Fix: Direktlinien-Abstands-Wächter (ein Kontakt > 9 m neben der Direktlinie prev→next ist keine Umlenkung dieser Verbindung; gemessen: echte Wicklungen ≤ 6 m, Irrtum 12 m), Setze-Lock darf sich bei Topologie-Korrektur nach unten neu locken (der Ratchet-Schutz gilt der Handbewegung, nicht dem Solver-Irrtum), 1.0-s-Nachrollfenster nach Release, Capstan 1.6. Gemessen danach: Orbit 2.9–3.0 m/s statt 6.7–9.5, nach Release wieder straff in 0.26 s (Tests 13d, 10e) |
| 57 | **Panels schwebten + Knopfleiste statt gedockter Falt-Panels** | Telemetrie/Steuerung/Parameter schwebten 14 px vor den Kanten, ausgeblendete Panels waren nur über die Leiste unten rechts zurückholbar; Spawn-Leiste unten ohne Aktiv-Markierung | Das Bedienmodell war keines: Panels müssen an ihrer Bildschirmkante andocken und sich so falten, dass der Titelbalken sichtbar bleibt (Klick auf den Balken = ein/aus). Fix: Dock-Mechanik (`dock-bl/-tl/-tr`, `collapsed` = Translation in die Kante, Titelbalken klickbar), Spawn-Leiste oben mittig zwischen Steuerung und Parametern mit `.on`-Markierung des aktiven Spots, uibar ersatzlos entfernt. Regression: Browser-Smoke, Panel-Abschnitt |
| 58 | **Solver verwarf aufliegende Kontakte — Umweg, Schlaffschlaufe, Zickzack-Knick** | Nutzervideo (Orbit um die dunkle Säule, Anker auf dem grünen Block): Frame 5 s schlaffe V-Schlaufe zwischen Wicklung und Anker, Frame 8 s harter Knick scheinbar in der Luft, Frame 9 s Zickzack direkt unter dem Anker. Gemessen (`tools/probe_orbit.js`): Budget beim Setzen 16.25 m statt 13.3 m, Wicklung auf der **Säulendecke** (y=10.1) 4 m neben der echten Kante; im Orbit bis zu **10.3 m Umweg** (live 15.1–15.4 m vs. frisch konvergiert 4.9–6.2 m) bei ~1.2 m Spiel; danach Flächen-Fallback-Kontakt (edgeIdx=-1) an der Blockflanke; Ketten-Knicke 72–126° | Eine Ursache, drei Bilder: `_findBestEdge` und `_segBlocked` prüften An-/Ablauf mit `segmentAvoidsBox(..., pad=+0.035)` — auch wenn der Strecken-Endpunkt **auf derselben Box** lag (Anker auf der Deckfläche, Nachbarkontakt). Ein Seil, das von der Kante auf der Fläche zum Anker **aufliegt**, galt damit als „blockiert": der physikalisch richtige Kontakt (Oberkante des Blocks) wurde verworfen, die Greedy wich auf die nächstbeste Kante (Säulendecke) oder den Flächen-Fallback aus; das Setzen fror das zu lange Budget ein (V-Schlaufe). Zweite Baustelle: das Nachrollfenster (tidy) sprang nur bei **sinkender Wrap-Zahl** an — eine Routen-Selbstkorrektur mit gleicher Wrap-Zahl ließ altes Budget stehen. Fix: **Ruhe-Toleranz** — Graze-Test mit pad=−0.05, wenn der Endpunkt auf der Box liegt (Testvolumen schrumpft: Aufliegen frei, >5 cm Eintauchen bleibt blockiert; konvexe Boxen ⇒ Aufliegen ist sicher); tidy rollt auch nach, wenn `required` stärker fällt als die Handbewegung + 0.5 m erklärt (Akku-Paare, Reset bei steigendem required). Gemessen danach: Orbit eine Runde d=0.00, Wicklung auf der Block-Oberkante, kein edgeIdx=-1, alle Ketten-Knicke ≤0.16 m an Geometrie, überschüssiges Spiel 0.01 m. Dieselbe Wurzel zeigte sich an der Wrap-Wand: vorher 27 m Umweg ums Wandende statt 11.6 m über die Oberkante. Regression: Tests 13d (4) + 14 (4), Messprobe `probe_orbit.js` |
| 1 | View-Matrix transponiert | ganze Welt gespiegelt | `m4viewFromQuat` schrieb `R` statt `Rᵀ` in die Rotationsspalten |
| 2 | **Tiefe Penetration ohne Auflösung** | Spieler bleibt in dünner Wand stecken und wird hindurchgedrückt, wenn starker Seilzug ihn hineinpresst | `closestPoint(segment, box)` liefert keine Normale, sobald die Kapselachse *in* der Box liegt → zusätzlicher Min-Achsen-Pushout |
| 3 | Kontakt-"Reparatur" zerstörte Mehrfach-Wicklung | Seil nahm den 22.6-m-Weg ums Wandende statt 18.1 m über die Wand | Ein Kontakt, dessen *Ablauf* in dieselbe Box wieder eintritt, wurde als „falsche Kante" interpretiert und ausgetauscht — dabei fehlte nur der Folgekontakt. Jetzt wird zwischen Zulauf- und Ablauf-Blockade unterschieden |
| 4 | Zierleisten degenerieren das Wrapping | Kontaktpunkt findet keinen Platz, Solver fällt auf Oberflächen-Fallback zurück | 3-cm-Trim über einem Block ⇒ `pointFree` schlägt fehl. Fix: `ropeSolid`-Layer-Flag **plus** Nachbar-Box-Suche („äußerste Geometrie gewinnt") |
| 5 | Temp-Puffer-Aliasing in Rekursion | Lookahead lieferte den Punkt des inneren Aufrufs | `_findBestEdge` ruft sich über `_findContactFor` rekursiv auf und teilte sich `_cpShort` → lokale Puffer in den seltenen Solver-Pfaden |
| 6 | Seilausgabe = Distanz statt Bogenlänge | Seil war im Flug straff gespannt, lief **nicht** lose hinterher | `L = ∫|v_Haken|dt` statt `L = |Hand−Haken|`; der Überschuss folgt jetzt aus der Wurfparabel |
| 7 | **Anfangsbudget zu klein** | Haken wurde im ersten Substep zurückgerissen und tauchte sofort ab | Abstand Brust→sichtbare Hand ≈ 0.5 m, Budget startete bei 0.55 m ⇒ `dHand ≥ budget` war sofort wahr. Fix: Startbudget = Abstand + 0.45 m, und die Zugbedingung ist jetzt `>` statt `≥` |
| 8 | **Setzen durfte das Budget erhöhen** | Seil zahlte sich selbst Gratis-Länge aus, Constraint wirkungslos, Spieler hing 2 m zu weit draußen | `budget = required + margin` wurde auch nach *oben* gesnappt. Einziehen ja, Auszahlen nie |
| 9 | Sprung-Puffer überlebte ins Attached | frisch verankertes Seil löste sich im selben Frame wieder | `jumpBuf` wird beim Übergang in den Seil-Zustand verworfen |
| 10 | **Pump-Vorzeichen invertiert** | Amplitude schrumpfte statt zu wachsen, Budget driftete auf 46 m | Reel-Pumping muss am Totpunkt *einziehen*, nicht auslassen. Zusätzlich: Modulation statt Integration ⇒ nullmittelnd, Drift 0.000 m |
| 11 | `topologyHz` → `NaN` | Topologie-Prüfung lief nie, Wraps eingefroren | Teil-Parameterobjekte ohne Default ⇒ `NaN <= 0` ist `false`. Defensive Defaults |
| 12 | Mausrad-Rollen wirkungslos | 0.017 m pro Raste | diskrete 0.9 m pro Raste + kontinuierlich über Q/E |
| 14 | **Blicksteuerung nur bei Pointer-Lock** | Spiel in der In-App-Vorschau nicht bedienbar: man konnte sich nicht umsehen | `frame()` wertete `input.mouseX` nur bei `this.locked` aus. In einem Sandbox-iframe ohne `allow-pointer-lock` bleibt `locked` aber immer `false`. Fix: eigener Blick-Modus, der sich bei der ersten Mausbewegung selbst aktiviert, das Delta aus `clientX/Y` errechnet (`movementX/Y` sind ohne Sperre nicht überall gesetzt) und die Empfindlichkeit anpasst. Zusätzlich Drag-Look. Der DOM-Stub im Test kann inzwischen Events dispatchen und prüft genau das |
| 36b | **Keine Plausibilitätsschranke für den Umweg** | Kontakte an weggeschwungenen beweglichen Körpern blieben liegen und spannten das Seil über 40 m | Eine Umlenkung um eine Box kann nie wesentlich mehr Seil kosten als die Ausdehnung der Box. Kostet ein Kontakt mehr als `Diagonale·1.35 + 6·Clearance`, ist er kein gültiger Kontakt und wird ohne Hysterese verworfen |
| 33 | **Rate-Limit auf die Pfadlänge war kontraproduktiv** | Überdehnung stieg von 0.07 m auf 7.35 m | Dieselbe Größe steuert auch das Setzen des Budgets. Eine verzögerte Länge erzeugt ein zu kurzes Budget und damit **größere** Überdehnung als der Sprung, den sie dämpfen sollte. Entfernt; gegen Rucke wirkt der gedeckelte Baumgarte-Bias |
| 32 | **Catmull-Rom schneidet Umlenkecken ab** | Seil lief sichtbar durch die Kante, um die es gewickelt war | Die Spline-Unterteilung rundet genau dort, wo die Geometrie sitzt. Korrektur liegt jetzt in `buildRenderCurve()`: jeder Stützpunkt wird aus fester Geometrie geschoben, und Segmente, die trotzdem noch etwas queren, werden am Trefferpunkt geknickt |
| 31 | **Ketten-Kollision bei straffem Seil übersprungen** | Seil zog durch Wände, sobald die Pfadführung stark war | Begründung war „hart geführte Nodes liegen ja auf dem freien Pfad" — das gilt nur, solange der Solver recht hat. Kollision ist jetzt die **harte Garantie**, der Pfad nur die Soll-Form |
| 30 | **Sprung-Detach an zwei Stellen** | Leertaste beendete jeden Schwung — auch nach dem ersten Fix | Der erste Fix entfernte das Lösen nur im Seil-Zweig des Controllers. Es saß zusätzlich im **Boden**-Zweig und in der Aktionsabfrage der Spielebene. Alle drei entfernt; `R`/LMB-loslassen sind die einzigen Wege zum Lösen |
| 29 | **Strafing invertiert** | A und D vertauscht | `rightH = [fwd.z, 0, −fwd.x]` — korrekt ist `right = cross(forward, up) = [−fwd.z, 0, fwd.x]`. Getestet bei yaw 0°/90°/180° in Welt- **und** Kamerakoordinaten |
| 28 | **Bodenreibung hatte eine Totzone** | man rutschte endlos mit ~0.6 m/s weiter — „alles wie Eis" | `drop = max(0, speed − 0.6)·fr·dt` wirkt unter 0.6 m/s gar nicht. Coulomb-Anteil `control = max(speed, 1.4)` ergänzt: aus 9.8 m/s → Stand nach **0.32 s**, Bremsweg 0.94 m. Zusätzlich dezenter quadratischer Luftwiderstand und **Capstan-Reibung** an Umlenkkontakten (das Seil glitt vorher reibungsfrei um Ecken) |
| 27 | **Schlaufe am Ankerpunkt** | Seil lief vom Anker erst als Bogen nach unten und wieder hoch | Nodes jenseits der Pfadlänge bekamen `guide = 0` und hingen frei — da sie aber am **Anker** festgenagelt sind, entstand dort genau diese Schlaufe. Ersatz: alle Nodes liegen auf dem Pfad, der Seilüberschuss wird als **Durchhang über die Spannweiten** verteilt (Kettenlinien-Näherung `d = √(3Le/8)`, geformt als `sin(πu)`, skaliert mit dem Horizontalanteil des Segments). Endgültig behoben erst durch das Pin-Modell (Kap. 8.2): ohne Guide gibt es auch keine „freien" Nodes mehr, die am Anker hängen könnten |
| 26 | **Ketten-CCD an der falschen Stelle** | Seil-Nodes wurden auf den Boden genagelt, Durchhang 10.7 m statt 0.4 m | Der Sweeptest lief *innerhalb* der Constraint-Schleife gegen ein bereits veraltetes `prev` und maß die Verschiebung der Pfadführung als Bewegung. Korrekt: **einmal direkt nach der Integration**, vor den Constraints |
| 25 | **Steuerung: einrasten statt halten, Sprung löste** | Seil blieb nach dem Loslassen verankert; Springen beendete jeden Schwung | `LMB halten = eingehakt, loslassen = einholen`. Sprung löst nicht mehr (weder im Controller noch in der Aktionsabfrage). Rechte Taste ist ausschließlich Drag-Look |
| 42 | **Kette als Gerade initialisiert** | im allerersten Frame lief das Seil bis zu 0.8 m durch das Hindernis | `vlerp(pos[i], hand, farPin, …)` — also genau die Gerade, die durch das Objekt führt, für das es einen Umlenkkontakt gibt. Jetzt wird entlang des Welt-Pfads initialisiert. Zusätzlich wird die Topologie direkt nach dem Verankern einmal bis zur Konvergenz getrieben (`converge()`) |
| 43 | **Kontakt klebte für immer am Kantenende** | Seil blieb um die Endecke einer Box geschlungen, die der Spieler längst passiert hatte — Pfadlänge wuchs mit dem Abstand (8.8 m bei 6.9 m korrekter Route, steigend) | `edgeTouchPoint` begrenzt `t` auf die Kante, aber nichts führte den Kontakt darüber hinaus weiter. Fix: `_cornerHandoff` (Kap. 6.7) — am Kantenende wird an eine dort weiterlaufende Kante übergeben (Nachbarkante derselben Box oder Kante einer nahen anderen Box), strikt kürzer + gültig + nahe der Ecke. Ohne Fortsetzung greift die normale lokale Freigabe: das Seil rutscht über das Ende und löst sich. Tests 10i-a/b/c. — Der Mechanismus wurde später ersatzlos entfernt und durch `_cornerSlide` abgelöst (Insert statt Umsetzung, siehe #48) |
| 44 | **Übergabe an Kanten, die Folgekontakte brauchen** | bei größerer `cornerZone` stieg der Pfad-Überschuss um das Fünffache (2.22 → 12.97 m·Schritte), Kontakt band früh an vertikale Eckkanten | Die Kandidatenprüfung erlaubte Ablauf-Blockade durch die neue Box selbst („Folgekontakt kommt") — damit vergleicht die Gewinn-Bilanz eine 2-Segment-Route, die in Wahrheit erst mit einem weiteren Kontakt gültig und dann *länger* ist. Fix: Ablauf muss bei der Übergabe **strikt frei** sein; der Zweikontakt-Fall bleibt vollständig dem Insert+Release-Pfad überlassen. — Die Regel „Ablauf strikt frei" lebt in `_cornerSlide` weiter; der Handoff selbst ist entfernt (#48) |
| 45 | **Tote Parameter, toter Code, tote UI** | Panel-Slider „Constraint-Iterationen" und „Luftwiderstand Kette" ohne jede Wirkung; `_buildShape` doppelt definiert; `_buildNodeArcs`/`_applyPins` nie aufgerufen; `_globalRelease`-Bedingungsrest | Überreste der Modellwechsel (Verlet-Kette → analytische Ein-Kurven-Form). Entfernt: `chainIterations`, `chainDrag`, `collideEvery`, `pinOffsets`, `visualStretch`, `rebuildHz`, `wrapReleaseTol`; beide toten Methoden; das Duplikat; die Bedingung `!this._globalRelease &&` (Variable existierte seit dem Kap.-6.5-Fix nicht mehr). Panel zeigt stattdessen die wirklich wirksamen Form-Parameter (`shapeStiff`, `shapeDamp`, `shapeMaxOffset`). — Mit der physikalischen Kette (#47) wurden die Form-Parameter wieder entfernt; `chainIterations`/`chainDrag` leben als echte Ketten-Parameter wieder |
| 41 | **Setz-Phase verfolgte den Spieler** | Budget ratterte herunter, danach war das Seil Dutzende Meter zu kurz | `target = required + margin` wurde jeden Substep neu berechnet. Läuft der Spieler während des Einziehens auf den Anker zu, rollt das Budget immer weiter ab — schwingt er danach weg, fehlt die Länge. **Gemessen: 41.6 m Überdehnung bei 8.1 m Budget.** Ziel wird jetzt einmal festgelegt; danach darf nur noch *verlängert* werden (Verlängern reißt nie, Verkürzen schon) |
| 40 | **`attachAt` setzte den Setz-Zustand nicht zurück** | Budget wurde auf **0.00 m** abgerollt, Spieler hing an einem Seil, das es nicht gab | `_settledOnce` blieb vom Vorzyklus auf `true`, `_settleTarget` auf `0` ⇒ die Setz-Phase rollte sofort auf null. Ein `assert s != o` auf Dateiebene hatte das vorher verdeckt, weil andere Ersetzungen derselben Datei gegriffen hatten |
| 39 | **Globale Freigabe + Neu-Einfädeln** | Seil sprang bei sichtbarem Anker komplett durch das Objekt; beim seitlichen Wandern wechselte es von der linken auf die rechte Seite des Blocks | Zwei Regeln, die „kürzer/sichtbar" mit „erreichbar" verwechselten. Ein gefangenes Seil bleibt gefangen, bis es über eine Kante abrutscht; die Freigabe ist eine **lokale** Bedingung (Strecke zum Nachbarkontakt frei). Beide Regeln entfernt, Fall als Test 10h festgeschrieben |
| 38 | **Freigabe verlangte eine Längenersparnis unter 5 cm** | Kontakte blieben kleben, häuften sich bis 4 an, Pfad 24.05 m bei 13.37 m Luftlinie | `unnecessary` war `direktFrei && (wrapLen − directLen) < wrapReleaseTol`. Eine echte Umlenkung spart aber nie weniger als 5 cm, also wurde nie freigegeben — Kontakte häuften sich bis 4 an. Die Bedingung ist ersatzlos gestrichen; gegen Flackern schützt ausschließlich die Hysterese-Zeit |
| 37 | **Freigabe blendete den Kontakt durch das Objekt** | Seil sprang von der gewickelten Seite quer durch den Block auf die Direktverbindung | Beim Loslassen wurde der Kontaktpunkt über 85 ms Richtung Luftlinie interpoliert — und die Luftlinie führt definitionsgemäß *durch* das Objekt. Zusätzlich war in dieser Zeit das Einfügen neuer Kontakte gesperrt. Fix: Kontakt bleibt immer exakt auf der Kante und verschwindet dann; weich ist der Übergang trotzdem, weil die Kette dynamisch ist und das Freigeben den Pfad immer *verkürzt* (die Constraint zieht also nie) |
| 36 | **`endTol` als fester Abstand** | Seil lief flach auf den Anker zu, trat 39 cm vor dem Ende in dessen Block ein ⇒ Direktverbindung galt als blockiert ⇒ alle Kontakte blieben | Eine Abstands-Toleranz hängt vom Anflugwinkel ab. Korrekt ist das **Austritts**-Kriterium: verlässt die Strecke die Box wieder, ist es ein echter Schnitt; liegt der Endpunkt in ihr, ist es der Anker selbst |
| 35 | **Baumgarte-Bias als Zugmittel missbraucht** | 1.8 m Überdehnung beim Fangen einer neuen Kante, harter Ruck | `maxBiasSpeed` war 18 m/s. Der Bias ist aber eine **Restfehler-Korrektur**, kein Zugmittel — was das Seil hält, ist das Entfernen der Radialkomponente. Cap auf 6 m/s, und Kontakte werden nur noch **einer pro Topologie-Update** aufgenommen statt drei: die Welt-Pfadlänge wächst über mehrere Frames statt als Sprung. Überdehnung **1.804 m → 0.078 m** |
| 34 | **Anker-Box global übersprungen** | Seil schnitt die Oberkante des Ankerblocks, ohne dass ein Kontakt entstand | `skip2: boxB` befreite die Anker-Box vollständig von der Prüfung. Korrekt ist `endBox` mit **absoluter** Toleranz von 0.20 m: ein Eintritt ganz am Ende ist legitim (der Anker liegt auf der Fläche), einer mitten in der Strecke nicht. Der frühere längenproportionale Wert (`len·0.12`) erlaubte bei 22 m Seil ein Eintauchen von 2.7 m |
| 33 | **Segmente zwischen zwei Kontakten derselben Box ungeprüft** | Solver wählte eine Kante *unterhalb* der Oberkante, Seil lief quer durch den Block | `boxA === boxB` ⇒ Graze-Test komplett übersprungen, mit der Begründung „das Seil läuft entlang der Oberfläche". Stimmt nur, wenn es das tatsächlich tut. Jetzt wird immer geprüft, mit `startBox`/`endBox`-Toleranz statt globalem Skip |
| 32 | **Graze-Test mit prozentualen Stichproben** | Eintauchen in eine Box wurde bei kurzen Segmenten komplett übersehen | `t = 0.2 … 0.8` sind bei 1.7 m Länge Proben ab 0.34 m Tiefe — die kritische Kante lag davor. Jetzt Stichproben im **Absolutabstand** (≤ 0.30 m Raster, 0.12 m Rand ausgenommen) |
| 31b | **`collideSphere` ignorierte `ropeSolid`** | Seil zitterte um Zierleisten, die der Pfad korrekt ignorierte | Solver und Kollision müssen dieselbe Geometrie-Menge sehen |
| 31c | **`rayAABB` invertierte die Richtung pro Box** | ~4500 Divisionen pro Topologie-Update | Inversion gehört einmal pro Strahl berechnet. Pfad-Solver 194 → 125 µs |
| 24 | **Box-Viewmodel als „IK" verkauft** | Arme hässlich, falsch proportioniert, beide starr aufs Seil gerichtet, verdeckten das Testobjekt | Der 2-Bone-Solver selbst war korrekt (Knochenlängen konstant, Dreiecksungleichung erfüllt, in 9 Blickrichtungen gültig) — aber daran hingen unbeschriftete Boxen ohne Tapering, ohne Schulterblatt und ohne Handgelenk, und beide Arme zeigten zum Anker, was anatomisch Unsinn ist. **Komplett entfernt** statt weiter poliert. Ein tragfähiges Viewmodel braucht ein geriggtes Mesh mit Clips und IK-Retargeting; das wird hier nicht mit Platzhaltern simuliert. Das Seil tritt jetzt an einem festen, stabilen Punkt rechts/unten vor der Kamera aus |
| 23 | **Bodenbewegung mit eingehaktem Seil unterbunden** | man stand am Boden fest, sobald das Seil hielt | `if (this.grounded && !attached)` — die Boden-Verzweigung war an `!attached` geknüpft. Das Seil ist aber eine *zusätzliche Constraint*, kein anderer Bewegungszustand. Jetzt gilt Bodenbewegung immer; die Constraint nimmt nur die Radialkomponente |
| 22 | **Haken durfte nicht in jede Richtung fliegen** | Schuss wurde um-geaimt, Böden/Rückseiten gesperrt | `solveBallisticDrag` lenkte den Schuss auf einen per Kegel gesuchten Punkt um, zusätzlich filterten `n[1] < -0.45` und `minNormalDot` Flächen. Beides widerspricht dem Zielbild: **der Haken fliegt exakt in Blickrichtung**, `aimAssist` ist jetzt default `0` und `minNormalDot = -1` |
| 21 | **Baumgarte-Bias akkumulierte** | große Überdehnung konvergierte nie, Spieler wurde hin- und hergeschossen | Bias wurde zur Normalgeschwindigkeit *addiert* (`v -= n·bias`) statt sie auf einen Zielwert zu *setzen*. Korrekt: `v_n → budgetRate − bias`, gedeckelt auf `maxBiasSpeed`. Der `budgetRate`-Term sorgt zusätzlich dafür, dass beim Einziehen nie schneller gezogen wird, als tatsächlich Seil aufgerollt wird |
| 20 | **Viewmodel ohne IK, Hand achsenparallel** | Arme zeigten in die falsche Richtung, „Hand-Klötze" drehten beim Umschauen seltsam | Schulter/Ellenbogen/Hand waren starre Offsets, die Hand-Box war ein `pushBoxC` ohne Rotation. Ersetzt durch analytische **2-Bone-IK** (Kosinussatz + Pol-Vektor für die Gelenkebene), Hand und Werfer werden entlang der Unterarmrichtung orientiert. Die Pose wird **vor** dem Seil-Rendering berechnet, damit das Seil exakt an der sichtbaren IK-Hand ansetzt |
| 19 | **Pointer-Lock als unavailable vorweggenommen** | eigener Blick-Fallback wurde ungefragt aufgedrängt | `setTimeout`-Probe schaltete nach 220 ms automatisch einen Ersatzmodus. Jetzt: Pointer-Lock wird angefordert und nur dann als gescheitert gemeldet, wenn der Browser `pointerlockerror` wirft bzw. das Promise ablehnt. Fallback ist **rechte Taste halten + ziehen** |
| 18 | **View-Matrix: Rotation und Translation inkonsistent** | **Die Kamera rotierte nicht um sich selbst, sondern um einen Punkt vor sich — echtes Third-Person-Orbit-Verhalten** | `m4viewFromQuat` baute die Rotation als `Rᵀ`, die Translation aber als `−(R·p)` statt `−(Rᵀ·p)`. Mit der Kamera im Ursprung hebt sich der Fehler teilweise auf, deshalb fiel er in frühen Tests nicht auf; sobald die Kamera irgendwo in der Welt steht, wandert ein Punkt auf der Blickachse bei jeder Drehung aus der Bildmitte. **Diagnose:** ein Punkt `camPos + forward·30` muss für jede Position/jeden Winkel NDC `(0,0)` liefern — Abweichung vorher `3.9·10⁻¹`, danach `1.2·10⁻⁶` über 5 Kamerapositionen × 37 Yaw × 15 Pitch. Steht jetzt als dauerhafter Regressionstest in `test_sim.js` (Abschnitt 0) |
| 15 | **Viewmodel in der Spiel-FOV projiziert** | Arme/Hände nicht sichtbar | Viewmodel wurde mit ~96–110° FOV gerendert und lag teils hinter der Kameraebene (`fwd·−0.06`) → NDC-Werte von 4 bis −7, alles außerhalb des Frustums. Fix: eigene enge Viewmodel-Projektion (55°), Near 0.04, alle Punkte mit positivem Kameraabstand |
| 16 | **Geometrische Ribbon-Verdrillung** | Seil sah aus wie ein in sich geknicktes, verdrehtes Blatt Papier / „Fliege" | Der Flachstreifen wurde pro Bogenlänge um 26 rad um die Tangente gedreht. Bei flacher Sicht faltet sich so ein Strip auf sich selbst zurück (Bowties), und bei nahezu paralleler Tangente flippt die Seitenachse. Fix: Streifen ist reines Kamera-Billboard + stabilisierte Seitenachse; die Geflecht-Optik kommt ausschließlich aus dem Fragment-Shader |
| 17 | **Ankersuche fand bei Blick nach unten nichts** | Haken schlug direkt vor den Füßen in den Boden und prallte zurück | Suche lief nur in einem 11°-Kegel und erlaubte Treffer ab 0.35 m. Fix: zweistufige Suche (12° → 34°, weiterhin gegen die Blickrichtung bewertet) plus `minAnchorDist = 3.2 m` |
| 13 | **GLSL-Swizzle außerhalb des Vektors** | Renderer baute nicht, Seil unsichtbar | `vUVW` ist `vec3`, gelesen wurde `.w` statt `.z`. Der WebGL-Stub im Test meldet Shader-Fehler prinzipbedingt nicht — deshalb enthält `test_browser.js` inzwischen einen statischen GLSL-Linter (Swizzle-Bereich + Varying-Typabgleich), der genau diesen Fehler reproduzierbar fängt |

Viele davon sind genau die Klasse von Fehlern, die ein Seilsystem *unspielbar*
machen, ohne dass eine Exception fliegt: die Simulation läuft, die Zahlen sehen plausibel aus,
aber das Seil hält nicht. Sie wären im normalen Spieltest erst nach Stunden aufgefallen.

### End-to-End-Szenarien (echter Controller, echte Eingaben)

Zusätzlich zu den Unit-Assertions werden komplette Spielzüge headless durchgespielt:

| Szenario | Ergebnis |
|---|---|
| Schlucht: anlaufen, abspringen, im Flug feuern, schwingen | landet auf dem gegenüberliegenden Dach, max. Überdehnung **0.17 m**, 1 Umlenkung |
| Wrap-Wand: verankern, dann seitlich weglaufen | **315** Substeps mit Umlenkkontakt, max. Überdehnung **0.064 m**, 21 m zurückgelegt, 0 dauerhafte Pfadblockaden |
| Säulen-Wrap: verankern, nach Osten laufen | **761** Substeps mit Kontakt, max. Überdehnung **0.006 m**, Abstand zum Anker 7.94 m bei Budget 7.88 m |
| 30 s Chaos über alle 10 Szenarios | keine NaN, max. Überdehnung **0.088 m** |

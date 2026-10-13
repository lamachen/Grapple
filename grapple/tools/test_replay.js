#!/usr/bin/env node
/* test_replay.js — Regressionstest des Replay-Harness:
   R1 dieselbe Aufnahme zweimal abgespielt ⇒ identischer Fingerabdruck
      (Determinismus über DOM/GL-Stub-Grenzen hinweg),
   R2 Fingerabdruck gleich dem in der Fixture gespeicherten
      (jede Physik-Änderung, die Trajektorien verschiebt, bricht hier),
   R3 harte Grenzen: kein NaN, Solver-Polylinie nie tiefer als 1 m in Geometrie.
   Neue Aufnahmen: im Spiel F9 (oder game.toggleRecording()), Export über
   game.exportRecording(); Fixture-Update bewusst manuell mit
   replay.js --write-fingerprint quittieren.                              */
'use strict';
const fs = require('fs'), path = require('path');
const { replayOnce } = require('./replay.js');
let failed = 0;
const ok = (c, name, detail) => {
  console.log(` ${c ? '✔' : '✘'} ${name}${detail ? '   ·  ' + detail : ''}`);
  if (!c) failed++;
};
const file = path.join(__dirname, 'fixtures', 'demo_orbit.json');
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = replayOnce(rec);
const b = replayOnce(rec);
ok(a.fingerprint === b.fingerprint && !a.nan && !b.nan, 'R1: Replay ist deterministisch',
   `${a.fingerprint} == ${b.fingerprint} über ${a.frames} Frames`);
ok(a.fingerprint === rec.fingerprint, 'R2: Fingerabdruck entspricht der gespeicherten Fixture',
   `gespeichert ${rec.fingerprint}`);
ok(a.maxPen < 1.0 && b.maxPen < 1.0, 'R3: keine tiefe Geometrie-Penetration im Replay',
   `max. Eindringtiefe ${Math.max(a.maxPen, b.maxPen).toFixed(3)} m`);
console.log(failed ? '\n✘ Replay-Regression verletzt.' : '\n✔ Replay-Regression sauber.');
process.exit(failed ? 1 : 0);

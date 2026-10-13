#!/usr/bin/env node
/* make_fixture.js — erzeugt tools/fixtures/demo_orbit.json: eine synthetische
   Aufnahme (Säulen-Wrap: feuern, einhängen, orbit-artiges Laufen mit Blick-
   drehung, lösen), die als Replay-Regressionstest dient. Der Fingerprint wird
   anschließend mit replay.js --write-fingerprint eingetragen.              */
'use strict';
const fs = require('fs'), path = require('path');
const { freshEnv } = require('./replay.js');
const { game } = freshEnv();
const spot = game.level.spots.findIndex(x => x.name === 'Säulen-Wrap');
if (spot < 0) { console.error('Spot nicht gefunden'); process.exit(1); }
game.teleport(spot);
game.setFreeLook(true);
for (let i = 0; i < 30; i++) game.frame(1/60);
game.toggleRecording();
const push = (over, n) => { for (let i = 0; i < n; i++) {
  const inp = game.input;
  inp.forward = !!(over && over.f); inp.firePressed = !!(over && over.fp && i === 0);
  inp.releasePressed = !!(over && over.rp && i === 0);
  inp.mouseX = (over && over.mx) || 0; inp.jumpHeld = true;
  game.frame(1/60);
} };
push(null, 30);
push({ fp: 1 }, 1);  push(null, 90);
push({ f: 1, mx: 6 }, 420);
push({ rp: 1 }, 1);  push(null, 90);
game.toggleRecording();
const rec = game.lastRec;
if (!rec || !rec.frames.length) { console.error('Aufnahme leer'); process.exit(1); }
const out = path.join(__dirname, 'fixtures', 'demo_orbit.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rec));
console.log('Fixture geschrieben:', out, rec.frames.length, 'Frames');

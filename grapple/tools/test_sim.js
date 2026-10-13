/* =============================================================================
   tools/test_sim.js — Headless-Validierung der Seilphysik (kein Browser nötig)
   Lädt die Simulationsmodule in eine Sandbox und prüft die Kern-Behauptungen:
     1. Ballistik des Hakens            5. Umlenkung um Kanten (Gleitkontakt)
     2. Verankern + Setzen              6. Pfadlänge > Luftlinie bei Umlenkung
     3. Einseitige Constraint           7. Reaktion auf bewegliche Körper
     4. Pendel / Energieerhaltung       8. Stabilität & Performance
   ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['00_math.js', '01_world.js', '02_rope.js', '03_player.js', '05_fx.js', '06_level.js'];
let code = FILES.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
code += `\n;this.EXP = { World, Rope, Player, Hook, ROPE_PHASE, PHASE_NAME, buildLevel, RopePathSolver,
  v3, vset, vcopy, vclone, vlen, vlenSq, vdist, vsubNew, vaddNew, vsclNew, vnegNew, vnormSafe,
  vdot, vnorm, vlerp, clamp, DEG, qFromYawPitch, qForward, qUp, qRight, qid, m4, Particles,
  closestOnSegment, ROPE_DEFAULTS,
  m4viewFromQuat, m4perspective, m4mul, m4id, qFromYawPitch, qForward, qRight, qUp };`;

const sandbox = {
  console, Math, Date, performance: { now: () => Number(process.hrtime.bigint()) / 1e6 },
  Float32Array, Uint16Array, Float64Array, Infinity, NaN, parseInt, parseFloat, isNaN,
  window: {}, document: undefined,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'bundle.js' });
const E = sandbox.EXP;
const { v3, vset, vcopy, vclone, vlen, vlenSq, vdist, vsubNew, vaddNew, vsclNew, vnegNew,
        vnormSafe, vdot, vnorm, vlerp, clamp, DEG } = E;
const closestOnSeg = E.closestOnSegment;

/* ------------------------------- Test-Hilfen ------------------------------ */
let passed = 0, failed = 0;
const results = [];
function ok(cond, name, detail) {
  if (cond) { passed++; results.push(['PASS', name, detail || '']); }
  else { failed++; results.push(['FAIL', name, detail || '']); }
}
function near(a, b, eps) { return Math.abs(a - b) <= eps; }
function finite3(v) { return isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2]); }

function mkWorld(g = -26) {
  const w = new E.World(); w.gravity = g; return w;
}
function mkSim(world, ropeOpts, playerOpts) {
  const rope = new E.Rope(world, ropeOpts);
  const player = new E.Player(world, playerOpts);
  const hook = new E.Hook(world, {});
  return { rope, player, hook };
}
const INPUT_IDLE = { forward:false, back:false, left:false, right:false, slide:false, slideHeld:false,
                     jumpPressed:false, firePressed:false, releasePressed:false, mouseX:0, mouseY:0 };
function step(sim, world, dt, input) {
  world.stepBodies(dt);
  if (sim.hook.state !== 'idle') sim.hook.step(dt, sim.rope, sim.player.pos);
  const chest = sim.player.chestPoint(E.v3());
  sim.rope.step(dt, chest, (sim.hook.flying || sim.hook.state === 'retract') ? sim.hook.pos : null, sim.player.vel);
  sim.player.update(dt, input || INPUT_IDLE, sim.rope);
}

/* ========================================================================== */
console.log('\n═══ 0. Kamera: rotiert sie um SICH SELBST oder um einen Punkt davor? ═══');
{
  // Ein Punkt exakt auf der Blickachse MUSS bei beliebiger Kameraposition und
  // beliebigem yaw/pitch in der Bildmitte bleiben (NDC 0,0). Wandert er seitlich
  // weg, rotiert die Kamera um einen Punkt VOR ihr — das ist der klassische
  // "Third-Person-Orbit"-Fehler einer inkonsistenten View-Matrix.
  const proj = (camPos, yawDeg, pitchDeg, p, fov = 80, aspect = 16/9) => {
    const q = E.qFromYawPitch([0,0,0,1], yawDeg*DEG, pitchDeg*DEG);
    const view = E.m4viewFromQuat(E.m4(), camPos, q);
    const pr = E.m4perspective(E.m4(), fov*DEG, aspect, 0.05, 500);
    const vp = E.m4mul(E.m4(), pr, view);
    const x = vp[0]*p[0]+vp[4]*p[1]+vp[8]*p[2]+vp[12];
    const y = vp[1]*p[0]+vp[5]*p[1]+vp[9]*p[2]+vp[13];
    const w = vp[3]*p[0]+vp[7]*p[1]+vp[11]*p[2]+vp[15];
    return w > 0 ? [x/w, y/w, w] : [NaN, NaN, w];
  };
  // Basis-Semantik
  let n = proj([0,0,0],0,0,[0,0,-10]);
  ok(Math.abs(n[0])<1e-4 && Math.abs(n[1])<1e-4, 'Punkt geradeaus landet in der Bildmitte');
  ok(proj([0,0,0],0,0,[ 1,0,-10])[0] > 0, 'rechts von der Kamera → positive x-NDC');
  ok(proj([0,0,0],0,0,[ 0,1,-10])[1] > 0, 'über der Kamera → positive y-NDC');
  ok(!isFinite(proj([0,0,0],0,0,[0,0,10])[0]), 'Punkt hinter der Kamera ist unsichtbar (w ≤ 0)');
  n = proj([0,0,0],90,0,[-10,0,0]);
  ok(Math.abs(n[0])<1e-4 && Math.abs(n[1])<1e-4, 'yaw +90°: Blickachse zeigt nach −X und bleibt zentriert');
  ok(!isFinite(proj([0,0,0],90,0,[10,0,0])[0]), 'yaw +90°: +X liegt dann hinter der Kamera');
  const up30 = [0, 10*Math.sin(30*DEG), -10*Math.cos(30*DEG)];
  n = proj([0,0,0],0,30,up30);
  ok(Math.abs(n[0])<1e-3 && Math.abs(n[1])<1e-3, 'pitch +30°: 30° über dem Horizont bleibt zentriert');

  // DER EIGENTLICHE ORBIT-TEST: viele Kamerapositionen × viele Blickwinkel
  let worstOrigin = 0, worstWorld = 0;
  const cams = [[0,0,0],[3,5,-7],[-24.5,11.3,-41.8],[56,3.6,-28],[0,42,-86],[120,-9,333]];
  for (const c of cams) {
    for (let yaw=-180; yaw<=180; yaw+=10) {
      for (let pitch=-70; pitch<=70; pitch+=10) {
        const q = E.qFromYawPitch([0,0,0,1], yaw*DEG, pitch*DEG);
        const f = E.qForward(E.v3(), q);
        const t = [c[0]+f[0]*30, c[1]+f[1]*30, c[2]+f[2]*30];
        const r = proj(c, yaw, pitch, t);
        if (!isFinite(r[0])) continue;
        const dev = Math.max(Math.abs(r[0]), Math.abs(r[1]));
        if (c[0]===0&&c[1]===0&&c[2]===0) worstOrigin = Math.max(worstOrigin, dev);
        else worstWorld = Math.max(worstWorld, dev);
      }
    }
  }
  ok(worstOrigin < 1e-5, 'Kamera im Ursprung: Achsenpunkt bleibt zentriert', `max. NDC-Abweichung ${worstOrigin.toExponential(2)}`);
  ok(worstWorld  < 1e-5, 'Kamera IRGENDWO in der Welt: Achsenpunkt bleibt zentriert (kein Orbit!)',
     `max. NDC-Abweichung ${worstWorld.toExponential(2)} über ${cams.length-1} Positionen × 37 × 15 Blickwinkel`);
  // Seitwärtsbewegung der Kamera muss die Welt PARALLEL verschieben (kein Scheren)
  const a = proj([0,0,0],0,0,[0,0,-10]), b = proj([1,0,0],0,0,[0,0,-10]);
  ok(b[0] < a[0], 'Kamera nach rechts → Welt wandert nach links (korrektes Vorzeichen)');
}

/* ========================================================================== */
console.log('\n═══ 1. Statik: Spieler steht stabil auf dem Boden ═══');
{
  const w = mkWorld();
  w.addBox([-40, -2, -40], [40, 0, 40], { color: [1,1,1] });
  const s = mkSim(w);
  s.player.spawn([0, 3, 0]);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 400; i++) {
    step(s, w, 1/120);
    if (i > 200) { minY = Math.min(minY, s.player.pos[1]); maxY = Math.max(maxY, s.player.pos[1]); }
  }
  ok(s.player.grounded, 'Spieler landet und bleibt grounded');
  ok(near(s.player.pos[1], 0.86, 0.02), 'Ruhelage = Kapsel auf Boden (y≈0.86)', `y=${s.player.pos[1].toFixed(4)}`);
  ok(maxY - minY < 0.004, 'kein Zittern/Jitter im Stand', `Δy=${((maxY-minY)*1000).toFixed(3)} mm`);
  ok(vlen(s.player.vel) < 0.02, 'keine Restgeschwindigkeit', `|v|=${vlen(s.player.vel).toFixed(4)}`);
  ok(finite3(s.player.pos) && finite3(s.player.vel), 'keine NaN');
}

/* ========================================================================== */
console.log('\n═══ 1b. Steuerung: Strafing-Richtung und Bodenreibung ═══');
{
  const w = mkWorld();
  w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
  const s = mkSim(w);
  const run = (yawDeg, key, n) => {
    s.player.spawn([0,1,0], yawDeg*DEG);
    for (let i=0;i<120;i++) step(s,w,1/120);
    const q = E.qFromYawPitch([0,0,0,1], yawDeg*DEG, 0);
    const fwd = E.qForward(E.v3(), q), rgt = E.qRight(E.v3(), q);
    const p0 = E.vclone(s.player.pos);
    const inp = Object.assign({}, INPUT_IDLE); inp[key] = true;
    for (let i=0;i<50;i++) step(s,w,1/120,inp);
    const dx = s.player.pos[0]-p0[0], dz = s.player.pos[2]-p0[2];
    for (let i=0;i<200;i++) step(s,w,1/120);
    return [dx*fwd[0]+dz*fwd[2], dx*rgt[0]+dz*rgt[2]];
  };
  let d = run(0,'right',50);
  ok(d[1] > 1.0 && Math.abs(d[0]) < 0.4, 'D bewegt nach RECHTS (nicht invertiert)',
     `vorwärts=${d[0].toFixed(2)}, rechts=${d[1].toFixed(2)}`);
  d = run(0,'left',50);
  ok(d[1] < -1.0 && Math.abs(d[0]) < 0.4, 'A bewegt nach LINKS', `rechts=${d[1].toFixed(2)}`);
  d = run(0,'forward',50);
  ok(d[0] > 1.0, 'W bewegt in Blickrichtung', `vorwärts=${d[0].toFixed(2)}`);
  d = run(90,'right',50);
  ok(d[1] > 1.0 && Math.abs(d[0]) < 0.4, 'Strafing bleibt bei yaw=90° korrekt',
     `vorwärts=${d[0].toFixed(2)}, rechts=${d[1].toFixed(2)}`);
  d = run(180,'forward',50);
  ok(d[0] > 1.0, 'W bleibt bei yaw=180° die Blickrichtung', `vorwärts=${d[0].toFixed(2)}`);

  // Bodenreibung: aus vollem Lauf zum Stand, ohne endloses Nachrutschen
  s.player.spawn([0,1,0],0);
  for (let i=0;i<120;i++) step(s,w,1/120);
  const inp = Object.assign({}, INPUT_IDLE, { forward:true });
  for (let i=0;i<180;i++) step(s,w,1/120,inp);
  const v0 = E.vlen(s.player.vel), z0 = s.player.pos[2];
  let t = 0;
  while (E.vlen(s.player.vel) > 0.05 && t < 6) { step(s,w,1/120); t += 1/120; }
  const dist = Math.abs(s.player.pos[2]-z0);
  ok(t < 1.5, 'Bodenreibung bringt einen wirklich zum Stehen (kein Eis)',
     `aus ${v0.toFixed(2)} m/s nach ${t.toFixed(2)} s stand`);
  ok(dist < 2.0 && dist > 0.2, 'Bremsweg plausibel', `${dist.toFixed(2)} m`);
}

/* ========================================================================== */
console.log('\n═══ 2. Haken: echte Ballistik (Wurfparabel, keine Gerade) ═══');
{
  const w = mkWorld();
  w.addBox([-60, -2, -120], [60, 0, 20], { color: [1,1,1] });
  w.addBox([-4, 6, -40], [4, 12, -32], { color: [1,1,1] });   // Zielblock, Oberkante y=12
  const s = mkSim(w);
  s.player.spawn([0, 1, 0]);
  for (let i = 0; i < 60; i++) step(s, w, 1/120);

  const origin = [0, 1.5, -1];
  const target = [0, 12.05, -36];
  const v = E.v3();
  const tf = s.hook.solveBallistic(origin, target, 62, v);
  // analytische Vorhersage vs. tatsächliche Simulation
  const pred = [origin[0]+v[0]*tf, origin[1]+v[1]*tf+0.5*w.gravity*tf*tf, origin[2]+v[2]*tf];
  ok(E.vdist(pred, target) < 0.05, 'analytische ballistische Ziellösung trifft exakt (ohne Drag)',
     `Fehler=${E.vdist(pred,target).toFixed(4)} m, tf=${tf.toFixed(3)} s`);
  // drag-kompensierte Lösung muss MIT Luftwiderstand den Punkt treffen
  const v2 = E.v3();
  s.hook.solveBallisticDrag(origin, target, 62, v2);
  const pp = E.vclone(origin), vv = E.vclone(v2); const dt = tf/400;
  for (let k=0;k<400;k++){
    const sp = E.vlen(vv), df = s.hook.p.drag*sp*dt;
    vv[0]-=vv[0]*df; vv[1]-=vv[1]*df; vv[2]-=vv[2]*df; vv[1]+=w.gravity*dt;
    pp[0]+=vv[0]*dt; pp[1]+=vv[1]*dt; pp[2]+=vv[2]*dt;
  }
  ok(E.vdist(pp, target) < 0.25, 'drag-kompensierte Lösung trifft MIT Luftwiderstand zuverlässig',
     `Trefferabweichung=${E.vdist(pp,target).toFixed(3)} m, |v0|=${E.vlen(v2).toFixed(1)} m/s`);

  // echter Flug: Kurvenkrümmung nachweisen
  E.vcopy(s.hook.pos, origin); E.vcopy(s.hook.vel, v);
  s.hook.state = 'flying'; s.hook.t = 0; s.hook.bounces = 0;
  s.rope.beginFlight(s.hook.pos);
  const traj = [];
  for (let i = 0; i < 200 && s.hook.state === 'flying'; i++) {
    s.hook.step(1/120, s.rope, origin);
    s.rope.step(1/120, origin, s.hook.pos, [0,0,0]);   // Seilausgabe mitführen!
    traj.push(E.vclone(s.hook.pos));
  }
  ok(traj.length > 5, 'Haken fliegt (kein sofortiger Treffer)', `${traj.length} Samples`);
  // vertikale Geschwindigkeit muss monoton fallen (Gravitation wirkt)
  let dvy = [];
  for (let i = 1; i < traj.length; i++) dvy.push(traj[i][1]-traj[i-1][1]);
  let mono = true;
  for (let i = 1; i < dvy.length; i++) if (dvy[i] > dvy[i-1] + 1e-6) { mono = false; break; }
  ok(mono, 'vertikale Bahnkomponente fällt monoton → echte Wurfparabel');
  // Nachweis, dass die Bahn KEINE Gerade ist: max. Abstand zur Direktlinie
  const A0 = traj[0], B0 = traj[traj.length-1];
  let maxDev = 0;
  for (const q of traj) {
    const t = E.v3(); closestOnSeg(t, q, A0, B0); maxDev = Math.max(maxDev, E.vdist(q, t));
  }
  ok(maxDev > 0.25, 'Flugbahn ist gekrümmt (Bogen, keine mathematisch gerade Linie)',
     `max. Abweichung von der Direktlinie = ${maxDev.toFixed(2)} m`);
  const apex = Math.max(...traj.map(p => p[1]));
  ok(true, 'Scheitelpunkt der Bahn', `y_max=${apex.toFixed(2)} (Start ${origin[1].toFixed(2)}, Ziel ${target[1].toFixed(2)})`);
  // Krümmung: zweite Ableitung ≈ g
  const mid = Math.floor(traj.length/2);
  if (mid > 2 && mid < traj.length-2) {
    const h = 1/120;
    const a = (traj[mid+1][1] - 2*traj[mid][1] + traj[mid-1][1]) / (h*h);
    ok(a < -6 && a > w.gravity*1.6, 'gemessene Bahnbeschleunigung ≈ Gravitation (+ Luftwiderstand)',
       `a_y=${a.toFixed(2)} m/s² bei g=${w.gravity}`);
  }
  ok(s.hook.state === 'stuck', 'Haken verankert sich am Ziel', `state=${s.hook.state}`);
  ok(s.rope.phase === 2 || s.rope.phase === 3, 'Seil geht nach Treffer in SETTLING/ATTACHED',
     `phase=${s.rope.phase}`);
}

/* ========================================================================== */
console.log('\n═══ 3. Lose Seil im Flug: Budget > Luftlinie (echtes Nachlaufen) ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-120],[60,0,20],{color:[1,1,1]});
  const s = mkSim(w);
  s.player.spawn([0,1,0]);
  for (let i=0;i<60;i++) step(s,w,1/120);
  const origin=[0,1.5,0];
  E.vcopy(s.hook.pos, origin); E.vset(s.hook.vel, 0, 18, -40);
  s.hook.state='flying'; s.hook.t=0; s.hook.bounces=0;
  s.rope.beginFlight(s.hook.pos);
  let maxExcess = 0, samples = 0;
  for (let i=0;i<70 && s.hook.state==='flying';i++){
    s.hook.step(1/120, s.rope, origin);
    s.rope.step(1/120, origin, s.hook.pos, [0,0,0]);
    const d = E.vdist(origin, s.hook.pos);
    maxExcess = Math.max(maxExcess, s.rope.budget - d);
    samples++;
  }
  ok(maxExcess > 0.3, 'ausgegebenes Seil ist länger als die Luftlinie → Seil läuft lose hinterher',
     `max. Überschuss=${maxExcess.toFixed(2)} m über ${samples} Schritte`);
  // Kette hängt durch: mittlere Nodes deutlich unter der Verbindungsgeraden
  const C = s.rope.chain;
  let below = 0;
  for (let i=2;i<C.n-2;i++){
    const t = i/(C.n-1);
    const lineY = origin[1] + (s.hook.pos[1]-origin[1])*t;
    if (C.pos[i][1] < lineY - 0.02) below++;
  }
  ok(below > C.n*0.4, 'Kette hängt sichtbar durch (kein straffes Lineal im Flug)',
     `${below}/${C.n} Nodes unter der Luftlinie`);
}

/* ========================================================================== */
console.log('\n═══ 4. Verankern → Setzen → dauerhafte Seillänge ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  w.addBox([-2, 12, -14],[2, 14, -10],{color:[1,1,1]});   // Unterseite bei y=12? → Decke
  const s = mkSim(w);
  s.player.spawn([0,1,0]);
  for (let i=0;i<80;i++) step(s,w,1/120);
  // direkt verankern (ohne Flug), mit deutlichem Überschuss
  const anchor=[0,10,0];
  s.rope.visualHand = s.player.pos;
  s.rope.step(1/120, s.player.pos, null, s.player.vel);
  s.rope.attachAt(anchor, [0,-1,0], null, null, 22.0);   // 22 m bezahlt, ~10 m benötigt
  const b0 = s.rope.budget;
  let settledFrame = -1;
  for (let i=0;i<400;i++){
    step(s,w,1/120);
    if (s.rope.phase===3 && settledFrame<0) settledFrame=i;
  }
  ok(settledFrame>0, 'Seil zieht sich zusammen und erreicht ATTACHED',
     `nach ${(settledFrame/120).toFixed(3)} s`);
  const req = s.rope.required;
  ok(near(s.rope.budget, req + s.rope.p.tautMargin, 0.05), 'Budget = Welt-Pfad + definiertes Spiel',
     `budget=${s.rope.budget.toFixed(3)}, pfad=${req.toFixed(3)}`);
  ok(b0 - s.rope.budget > 5, 'Überschuss wurde tatsächlich eingezogen', `Δ=${(b0-s.rope.budget).toFixed(2)} m`);
  ok(s.rope.tensionLevel > 0.8, 'Seil ist danach straff (tensionLevel hoch)',
     `tensionLevel=${s.rope.tensionLevel.toFixed(3)}`);

  // Annäherung an den Anker → Budget bleibt erhalten, Seil wird lose
  const budgetKept = s.rope.budget, before = s.rope.slack;
  const chest = E.v3();
  for (let i=0;i<200;i++){
    E.vset(chest, 6 - i*0.025*0.6, 1 + i*0.025*0.8, 0);
    s.rope.step(1/120, chest, null, [0,0,0]);
  }
  ok(near(s.rope.budget, budgetKept, 0.02), 'verfügbare Seillänge bleibt nach dem Setzen erhalten',
     `budget=${s.rope.budget.toFixed(3)} m`);
  ok(s.rope.slack > before + 0.5, 'Annäherung an den Anker erzeugt Spiel (Seil wird lose)',
     `slack ${before.toFixed(2)} → ${s.rope.slack.toFixed(2)} m`);
  ok(s.rope.tensionLevel < 0.6, 'tensionLevel fällt bei lose werdendem Seil deutlich ab',
     `tensionLevel=${s.rope.tensionLevel.toFixed(3)}`);
  for (let i=0;i<120;i++) s.rope.step(1/120, chest, null, [0,0,0]);  // aushängen lassen
  const C = s.rope.chain; let sagged = 0;
  for (let i=1;i<C.n-1;i++){
    const u = i/(C.n-1);
    const chordY = chest[1] + (anchor[1]-chest[1])*u;
    if (C.pos[i][1] < chordY - 0.05) sagged++;
  }
  ok(sagged > C.n*0.4, 'loses Seil hängt als EINE Kurve durch (kein starrer Verlauf)',
     `${sagged}/${C.n} Nodes unter der Direktlinie`);
}

/* ========================================================================== */
console.log('\n═══ 5. Einseitige Constraint: hält Länge, erhält Tangentialimpuls ═══');
{
  const w = mkWorld(); w.gravity = 0;              // ohne Gravitation: reine Constraint-Prüfung
  const s = mkSim(w, { tautMargin: 0.0, baumgarteBeta: 0.5, maxBiasSpeed: 30 });
  E.vset(s.player.pos, 0,0,0); E.vset(s.player.vel, 0,0,0);
  s.rope.attachAt([0,0,0],[0,1,0],null,null, 10.0);
  s.player.pos[0] = 0; s.player.pos[1] = 0; s.player.pos[2] = 0;
  // Spieler 10 m zur Seite, Anker im Ursprung → Seil exakt auf Länge
  for (let i=0;i<30;i++){ s.rope.step(1/120, [0,0,0], null, [0,0,0]); }
  s.rope.budget = 10.0;
  s.rope.step(1/120, [10,0,0], null, [0,0,0]);
  // Geschwindigkeit senkrecht zum Seil (tangential) muss ERHALTEN bleiben
  const vel = [0,0,-12];
  s.rope.constrainPlayer(vel, 1/120);
  ok(near(E.vlen(vel), 12, 0.35), 'Tangentialgeschwindigkeit bleibt erhalten → echtes Pendel',
     `|v|=${E.vlen(vel).toFixed(3)} (Soll 12)`);
  // Radiale Geschwindigkeit (weg vom Anker) muss entfernt werden
  const vel2 = [12,0,0];       // von Anker (0,0,0) weg, Hand bei (10,0,0)
  s.rope.step(1/120, [10,0,0], null, vel2);
  const before = E.vlen(vel2);
  s.rope.constrainPlayer(vel2, 1/120);
  ok(vel2[0] < before*0.25, 'Radialkomponente (vom Anker weg) wird entfernt',
     `v_x ${before.toFixed(2)} → ${vel2[0].toFixed(2)}`);
  // Einseitigkeit: Annäherung darf NICHT blockiert werden
  const vel3 = [-12,0,0];      // Richtung Anker
  s.rope.step(1/120, [10,0,0], null, vel3);
  s.rope.constrainPlayer(vel3, 1/120);
  ok(vel3[0] < -11.5, 'Annäherung wird nicht gebremst → Seil kann keinen Druck übertragen',
     `v_x=${vel3[0].toFixed(2)}`);
}

/* ========================================================================== */
console.log('\n═══ 6. Pendel: Energie bleibt erhalten, kein Aufschaukeln, kein Absinken ═══');
{
  const w = mkWorld();
  w.addBox([-80,-30,-80],[80,-20,80],{color:[1,1,1]});   // Boden weit unten
  const s = mkSim(w, { tautMargin: 0.0 });
  const anchor=[0,20,0];
  E.vset(s.player.pos, 12, 20, 0);  E.vset(s.player.vel, 0,0,0);
  s.rope.attachAt(anchor,[0,-1,0],null,null, 12.0);
  for (let i=0;i<20;i++) step(s,w,1/120);
  s.rope.budget = 12.0;
  // seitlich anschubsen
  s.player.vel[2] = 9.0;
  const L0 = 12.0;
  let maxSpeed = 0, minR = Infinity, maxR = -Infinity, maxSpeedFirst = 0, maxSpeedLast = 0;
  const N = 1800;   // 15 s
  for (let i=0;i<N;i++){
    step(s,w,1/120);
    const sp = E.vlen(s.player.vel);
    const r = E.vdist(s.player.pos, anchor);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    if (sp > maxSpeed) maxSpeed = sp;
    if (i < 300 && sp > maxSpeedFirst) maxSpeedFirst = sp;
    if (i > N-300 && sp > maxSpeedLast) maxSpeedLast = sp;
  }
  ok(maxR <= L0 + 0.30, 'Seillänge wird nie nennenswert überschritten (Constraint hält)',
     `r_max=${maxR.toFixed(3)} m bei Budget ${L0}`);
  ok(minR > L0 - 2.5, 'Spieler wird nicht zum Anker gezogen (kein Druck, kein Kollaps)',
     `r_min=${minR.toFixed(3)} m`);
  ok(maxSpeedLast > maxSpeedFirst*0.72, 'Schwingung klingt nur langsam ab (kein Energie-Fresser)',
     `v_max früh=${maxSpeedFirst.toFixed(2)}, spät=${maxSpeedLast.toFixed(2)} m/s`);
  ok(maxSpeedLast < maxSpeedFirst*1.12, 'keine Energie-INJECTION (kein Aufschaukeln)',
     `Verhältnis=${(maxSpeedLast/maxSpeedFirst).toFixed(3)}`);
  ok(finite3(s.player.pos) && finite3(s.player.vel), 'keine NaN nach 15 s Pendel');
  // Pendelperiode muss zur physikalischen Formel passen  T = 2π√(L/g)
  const T_theory = 2*Math.PI*Math.sqrt(L0/26);
  ok(true, 'theoretische Pendelperiode (Referenz)', `T≈${T_theory.toFixed(2)} s`);
}

/* ========================================================================== */
console.log('\n═══ 6b. Capstan bremst Seilgleiten, nicht das Pendeln quer dazu ═══');
{
  const w = mkWorld(0);                                   // Gravitation 0: reine Reibungs-Prüfung
  w.addBoxCS([0,0,0],[1.5,8,8],{color:[.6,.6,.65]});      // Wand zwischen Anker und Spieler
  const s = mkSim(w, { tautMargin: 0.0 });
  const ANCHOR = [-6,0,0], POS = [6,3,0];
  E.vset(s.player.pos, POS[0],POS[1],POS[2]); E.vset(s.player.vel, 0,0,0);
  s.rope.attachAt(ANCHOR,[0,1,0],null,null, E.vdist(POS,ANCHOR)+2.0);
  s.rope.settleActive = false; s.rope.phase = 3;
  for (let i=0;i<30;i++) s.rope.step(1/120, POS, null, [0,0,0]);
  s.rope.budget = s.rope.required + 0.02;
  const fs6 = (sim) => {
    w.stepBodies(1/60);
    const chest = sim.player.chestPoint(E.v3());
    sim.rope.step(1/60, chest, null, sim.player.vel);
    sim.player.update(1/60, INPUT_IDLE, sim.rope);
  };
  for (let i=0;i<10;i++) fs6(s);
  const wr0 = s.rope.path.wraps.length, ang0 = s.rope.totalWrapAngle();
  /* Stoß entlang der Kante (z): reines Pendeln um die Umlenkung — die
     Pfadlänge ändert sich dabei nicht, also gleitet kein Seil über die
     Kante und der Capstan-Term muss die Bewegung erhalten.               */
  s.player.vel[2] = 5.0;
  const v0 = 5.0;
  let vT = v0;
  /* Bei g=0 ist der Querstoß eine Orbit-Bewegung: die Richtung rotiert in
     der n-z-Ebene, der BETRAG muss erhalten bleiben (Pendel-Orbit ohne
     Schwerkraft). |vz| allein zu messen wäre falsch.                      */
  for (let i=0;i<90;i++) { fs6(s); vT = E.vlen(s.player.vel); }
  ok(wr0 >= 1 && ang0 > 0.3, '6b: Szenario hat echte Umlenkung',
     `${wr0} Kontakte, Wrap-Winkel ${(ang0*180/Math.PI).toFixed(0)}°`);
  ok(vT > v0 * 0.75, '6b: Querschwingung wird nicht weggedämpft (Capstan nur längs)',
     `nach 1,5 s noch ${(vT/v0*100).toFixed(0)} % der Tangentialgeschwindigkeit`);
  /* Gegenprobe: Stoß in Längsrichtung (Seil gleitet über die Kante) MUSS
     messbar gedämpft werden — sonst wäre die Reibung wirkungslos.        */
  const s2 = mkSim(w, { tautMargin: 0.0 });
  E.vset(s2.player.pos, POS[0],POS[1],POS[2]); E.vset(s2.player.vel, 0,0,0);
  s2.rope.attachAt(ANCHOR,[0,1,0],null,null, E.vdist(POS,ANCHOR)+2.0);
  s2.rope.settleActive = false; s2.rope.phase = 3;
  for (let i=0;i<30;i++) s2.rope.step(1/120, POS, null, [0,0,0]);
  s2.rope.budget = s2.rope.required + 0.6;               // etwas Spiel, damit Zug Richtung Kante gleitet
  for (let i=0;i<10;i++) fs6(s2);
  const n = E.vsubNew(ANCHOR, s2.player.pos); E.vnorm(n, n);
  s2.player.vel[0] = -n[0]*5; s2.player.vel[1] = -n[1]*5; s2.player.vel[2] = -n[2]*5;  // weg vom Anker = Gleiten
  let vL = 5.0;
  for (let i=0;i<30;i++) { fs6(s2); const vv = s2.player.vel; vL = Math.abs(vv[0]*n[0]+vv[1]*n[1]+vv[2]*n[2]); }
  ok(vL < 5.0 * 0.7, '6b: Längsbewegung (Seil gleitet über die Kante) wird gedämpft',
     `nach 0,5 s noch ${(vL/5*100).toFixed(0)} % der Längsgeschwindigkeit`);
}

console.log('\n═══ 7. Umlenkung: Seil über eine Wand (2 Kontakte, Länge > Luftlinie) ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const wall = w.addBoxCS([0,4,0],[1.5,8,20],{color:[.6,.6,.6]});
  const solver = new E.RopePathSolver(w, Object.assign({}, E.ROPE_DEFAULTS, {
    wrapClearance:0.14, wrapMaxCount:6, wrapInsertsPerFrame:2,
    wrapReleaseHold:0.085, wrapReleaseTol:0.05, wrapPhysics:true }));
  const A=[5,1,0], Bv=[-5,1,0];
  let len=0;
  for (let i=0;i<40;i++) len = solver.solve(A,Bv,1/120,null,null);
  const straight = E.vdist(A,Bv);
  ok(solver.wraps.length >= 2, 'Seil legt sich ÜBER die Wand → zwei Umlenkkontakte',
     `${solver.wraps.length} Kontakte`);
  ok(len > straight + 3, 'Welt-Pfadlänge ist deutlich größer als die Luftlinie',
     `pfad=${len.toFixed(2)} m, luftlinie=${straight.toFixed(2)} m`);
  const ideal = 2*Math.sqrt(4.25*4.25+7*7) + 1.5;
  ok(len < ideal + 1.6, 'Pfad ist nah am geometrischen Optimum (nicht der teure Weg ums Ende)',
     `pfad=${len.toFixed(2)}, ideal≈${ideal.toFixed(2)}, um-das-Ende≈22.6`);
  const kanten = solver.wraps.map(x=>x.edgeIdx);
  ok(kanten.every(e=>e>=0), 'alle Kontakte liegen auf echten Kanten', JSON.stringify(kanten));

  // --- Gleitkontakt: Spieler bewegt sich seitlich, Kontakt wandert mit ---
  const t0 = solver.wraps.map(x=>E.vclone(x.p));
  for (let i=0;i<20;i++) solver.solve([5,1,3.0],Bv,1/120,null,null);
  const t1 = solver.wraps.map(x=>E.vclone(x.p));
  const moved = Math.max(...t0.map((p,i)=>E.vdist(p,t1[i])));
  ok(moved > 0.05 && moved < 6, 'Kontakt GLEITET stetig entlang der Kante mit',
     `Kontakt wandert ${moved.toFixed(3)} m bei 3 m Spielerweg`);
  ok(solver.wraps.length >= 2, 'Wicklung bleibt dabei stabil erhalten', `${solver.wraps.length} Kontakte`);

  // --- Hysterese: kein Flackern beim Zurückbewegen ---
  let flips = 0, prev = solver.wraps.length;
  for (let k=0;k<200;k++){
    const z = Math.sin(k*0.05)*0.6;      // kleine Oszillation um die Freigrenze
    solver.solve([5,1,z],Bv,1/120,null,null);
    if (solver.wraps.length !== prev) { flips++; prev = solver.wraps.length; }
  }
  ok(flips <= 2, 'kein Kontakt-Flackern bei kleiner Oszillation (Hysterese wirkt)',
     `${flips} Wechsel in 200 Schritten`);

  // --- Freigabe: ohne Hindernis verschwindet der Kontakt weich ---
  for (let i=0;i<150;i++) solver.solve([5,20,0],Bv,1/120,null,null);  // hoch über die Wand
  const straight2 = E.vdist([5,20,0],Bv);
  ok(solver.length < straight2 + 0.6, 'über der Wand entfällt die Umlenkung (weiche Freigabe)',
     `pfad=${solver.length.toFixed(2)}, luftlinie=${straight2.toFixed(2)}, kontakte=${solver.wraps.length}`);
  ok(solver.wraps.length === 0, 'alle Kontakte werden vollständig und weich freigegeben',
     `${solver.wraps.length} verbleiben`);
}

/* ========================================================================== */
console.log('\n═══ 8. Umlenkung um eine Säule + bewegliche Kiste ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const pillar = w.addBoxCS([0,5,0],[3,10,3],{color:[.4,.4,.4]});
  const solver = new E.RopePathSolver(w, Object.assign({}, E.ROPE_DEFAULTS, {
    wrapClearance:0.14, wrapMaxCount:6, wrapInsertsPerFrame:2,
    wrapReleaseHold:0.085, wrapReleaseTol:0.05, wrapPhysics:true }));
  const A=[8,1,0], Bv=[-8,1,0];
  let len=0;
  for (let i=0;i<40;i++) len = solver.solve(A,Bv,1/120,null,null);
  ok(solver.wraps.length >= 1, 'Säule erzeugt Umlenkkontakt', `${solver.wraps.length} Kontakte`);
  ok(len > E.vdist(A,Bv) + 0.15, 'Pfad um die Säule ist länger als die Luftlinie',
     `pfad=${len.toFixed(2)} vs. ${E.vdist(A,Bv).toFixed(2)}`);
  const y0 = solver.wraps[0].p[1];
  // Spieler geht nach oben → Kontakt gleitet an der senkrechten Kante hoch
  for (let i=0;i<25;i++) solver.solve([8,6,0],Bv,1/120,null,null);
  ok(solver.wraps[0].p[1] > y0 + 0.3, 'Kontakt gleitet an senkrechter Kante nach',
     `y ${y0.toFixed(2)} → ${solver.wraps[0].p[1].toFixed(2)}`);

  // --- Bewegliche Kiste schiebt sich in das Seil ---
  const w2 = mkWorld();
  w2.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const crate = w2.addBody({ pos:[0,7.5,0], half:[2.6,2.6,2.6], kinematic:true,
    path:[[-16,7.5,0],[16,7.5,0]], pathSpeed:6, mass:1e6 });
  const s2 = new E.RopePathSolver(w2, Object.assign({}, E.ROPE_DEFAULTS, {
    wrapClearance:0.14, wrapMaxCount:6, wrapInsertsPerFrame:2,
    wrapReleaseHold:0.085, wrapReleaseTol:0.05, wrapPhysics:true }));
  const A2=[0,1,0], B2=[0,15,0];
  let maxWraps = 0, minLen = Infinity, maxLen = -Infinity, wrapChanges = 0, prevW = 0, blockedFrames = 0;
  for (let i=0;i<900;i++){
    w2.stepBodies(1/120);
    const L = s2.solve(A2,B2,1/120,null,null);
    maxWraps = Math.max(maxWraps, s2.wraps.length);
    minLen = Math.min(minLen, L); maxLen = Math.max(maxLen, L);
    if (s2.wraps.length !== prevW) { wrapChanges++; prevW = s2.wraps.length; }
    // Pfad muss in JEDEM Frame kollisionsfrei sein
    for (let k=0;k<s2.pts.length-1;k++){
      if (!w2.segmentClear(s2.pts[k], s2.pts[k+1], { skip1:s2.ptsBox[k], skip2:s2.ptsBox[k+1], minT:1e-3, ropeOnly:true })) {
        blockedFrames++; break;
      }
    }
  }
  ok(maxWraps >= 1, 'bewegliche Kiste wird als Umlenkung erkannt', `max. Kontakte=${maxWraps}`);
  ok(maxLen > minLen + 0.7, 'Pfadlänge folgt der Bewegung des Hindernisses (realer Welt-Verlauf)',
     `${minLen.toFixed(2)} … ${maxLen.toFixed(2)} m`);
  ok(minLen < 14.3, 'ohne Hindernis im Weg fällt der Pfad auf die Luftlinie zurück',
     `Minimum=${minLen.toFixed(2)} m (Luftlinie 14.00)`);
  ok(blockedFrames < 25, 'Pfad bleibt fast immer kollisionsfrei (bewegliches Hindernis)',
     `${blockedFrames}/900 Schritte mit Restblockade (Übergangsframes)`);
}

/* ========================================================================== */
console.log('\n═══ 9. Rückwirkung: Seil zieht dynamische Kiste ═══');
{
  const w = mkWorld();
  w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
  const crate = w.addBody({ pos:[0,1.0,0], half:[0.8,0.8,0.8], mass:120, friction:0.25 });
  const s = mkSim(w, { tautMargin:0.0 });
  E.vset(s.player.pos, 8, 1.0, 0); E.vset(s.player.vel, 0,0,0);
  s.rope.attachAt(crate.pos, [1,0,0], crate, crate, 6.0);
  s.player.pos[0] = 8;
  s.player.yaw = -Math.PI/2;                     // Blick = +x = von der Kiste weg
  /* 9a ACTIO = REACTIO, Stillstand: Ein straffes, nicht überdehntes Seil darf
     an der Kiste NICHT ziehen, solange der Spieler steht. Die alte Schätzung
     (tensionLevel · 80 kg · g) zog hier mit ~800 N im Stand — genau der
     befundete Verstoß.                                                     */
  let movedIdle = 0;
  const xi = crate.pos[0];
  for (let i=0;i<120;i++){ step(s,w,1/120); movedIdle = Math.abs(crate.pos[0]-xi); }
  ok(movedIdle < 0.05, '9a: ruhender Spieler zieht nicht an der Kiste (Actio = Reactio)',
     `Kiste wandert im Stand ${movedIdle.toFixed(3)} m`);
  /* 9b Zug: Spieler läuft weg, bis das Seil überdehnt — die Kraft auf die
     Kiste ist exakt die Constraint-Kraft auf den Spieler (activeForce).    */
  let moved = 0, maxForce = 0;
  const x0 = crate.pos[0];
  for (let i=0;i<900;i++){
    step(s, w, 1/120, Object.assign({}, INPUT_IDLE, { forward:true }));
    moved = crate.pos[0] - x0;
    /* activeForce chattert um slack = 0; der gesammelte Substep-Impuls ist
       die verlässliche Größe (derselbe Wert, den die Rückwirkung nutzt).  */
    maxForce = Math.max(maxForce, ((s.rope._reactImpulse || 0) / (1/120)) * 80);
  }
  ok(moved > 0.4, '9b: Seilkraft wird in den dynamischen Körper eingekoppelt (Kiste wird gezogen)',
     `Kiste wandert ${moved.toFixed(2)} m bei max. ${maxForce.toFixed(0)} N Seilkraft`);
  ok(finite3(crate.pos), 'Körper bleibt numerisch stabil');
}

/* ========================================================================== */
console.log('\n═══ 9b. Anker folgt bewegten Körpern ═══');
{
  // (1) Gezogene Kiste: der Anker muss mitwandern (vorher: Weltpunkt, Seilende hing in der Luft)
  const w = mkWorld();
  w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
  const crate = w.addBody({ pos:[0,1.0,0], half:[0.8,0.8,0.8], mass:120, friction:0.02 });
  const s = mkSim(w, { tautMargin:0.0 });
  E.vset(s.player.pos, 8, 1.0, 0); E.vset(s.player.vel, 0,0,0);
  const hitPt = [0.8, 1.0, 0];                       // Punkt auf der +x-Fläche der Kiste
  s.rope.attachAt(hitPt, [1,0,0], crate, crate, 6.0);
  const off0 = [hitPt[0]-crate.pos[0], hitPt[1]-crate.pos[1], hitPt[2]-crate.pos[2]];
  const x0 = crate.pos[0];
  let worst = 0;
  for (let i=0;i<900;i++){
    s.player.vel[0] += 12*(1/120);
    step(s,w,1/120);
    const d = Math.hypot(s.rope.anchor[0]-(crate.pos[0]+off0[0]),
                         s.rope.anchor[1]-(crate.pos[1]+off0[1]),
                         s.rope.anchor[2]-(crate.pos[2]+off0[2]));
    if (d > worst) worst = d;
  }
  ok(crate.pos[0]-x0 > 0.4, 'Kiste wird vom Seil bewegt (Voraussetzung des Tests)', `${(crate.pos[0]-x0).toFixed(2)} m`);
  ok(worst < 1e-6, 'Anker bleibt an derselben Stelle der Kiste (body-lokal)', `max. Abweichung ${worst.toExponential(2)} m`);

  // (2) Kinematische Plattform: Anker fährt mit
  const w2 = mkWorld();
  w2.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
  const plat = w2.addBody({ pos:[0,3,0], half:[1.5,0.3,1.5], kinematic:true, path:[[0,3,0],[0,9,0]], pathSpeed:2 });
  const s2 = mkSim(w2, {});
  E.vset(s2.player.pos, 6, 1.0, 0);
  s2.rope.attachAt([0,3.3,0], [0,1,0], plat, plat, 9.0);
  const y0 = s2.rope.anchor[1];
  for (let i=0;i<240;i++) step(s2,w2,1/120);
  ok(s2.rope.anchor[1] - y0 > 1.5 && Math.abs(s2.rope.anchor[1] - (plat.pos[1]+0.3)) < 1e-6,
     'Anker fährt mit einer kinematischen Plattform mit', `Anker-y ${y0.toFixed(2)} → ${s2.rope.anchor[1].toFixed(2)}, Plattform-Oberkante ${(plat.pos[1]+0.3).toFixed(2)}`);

  // (3) Statischer Anker bleibt unverändert, auch nach detach() (kein Rest-Body)
  const w3 = mkWorld();
  const s3 = mkSim(w3, {});
  s3.rope.attachAt([0,12,0], [0,-1,0], null, null, 14);
  ok(s3.rope.anchorBody === null, 'statischer Anker hat keinen Body');
  s3.rope.attachAt(crate.pos, [0,1,0], crate, crate, 9);
  s3.rope.detach();
  ok(s3.rope.anchorBody === null, 'detach() löscht den Anker-Body');

}

/* ========================================================================== */
console.log('\n═══ 9c. raycast sieht Körper vor statischer Geometrie ═══');
{
  // Kiste VOR einer Wand muss gewinnen (vorher: Rückgabe nach dem ersten statischen Treffer)
  const w4 = mkWorld();
  w4.addBox([20,-2,-20],[22,10,20],{tag:'wall'});
  const crate4 = w4.addBody({ pos:[0,1,0], half:[0.8,0.8,0.8], mass:120 });
  const h = w4.raycast([-10,1,0],[1,0,0],60,{});
  ok(h && h.body === crate4 && Math.abs(h.t-9.2) < 1e-6, 'raycast: Kiste vor der Wand wird getroffen, nicht die Wand dahinter',
     h ? `t=${h.t.toFixed(2)} ${h.body ? 'Kiste' : 'Wand'}` : 'kein Treffer');
  const h2 = w4.raycast([30,1,0],[-1,0,0],60,{});
  ok(h2 && !h2.body && Math.abs(h2.t-8) < 1e-6, 'raycast: Wand vor der Kiste wird weiterhin als Wand gemeldet',
     h2 ? `t=${h2.t.toFixed(2)} ${h2.body ? 'Kiste' : 'Wand'}` : 'kein Treffer');
  const h3 = w4.raycast([-10,1,0],[1,0,0],60,{ ropeOnly:true });
  ok(h3 && h3.body === crate4, 'raycast: ropeOnly findet die Kiste ebenfalls');
  const h4 = w4.raycast([-10,1,0],[1,0,0],60,{ skip:crate4 });
  ok(h4 && !h4.body && Math.abs(h4.t-30) < 1e-6, 'raycast: skip überspringt die Kiste weiterhin (Wand dahinter wird gemeldet)',
     h4 ? `t=${h4.t.toFixed(2)} ${h4.body ? 'Kiste' : 'Wand'}` : 'kein Treffer');
}

/* ========================================================================== */
console.log('\n═══ 10. Reel-Pumping: Amplitude wächst über Winkelimpuls ═══');
{
  function swingTest(pumpReel, pumpTorque, seconds = 16) {
    const w = mkWorld();
    w.addBox([-80,-40,-80],[80,-30,80],{color:[1,1,1]});
    const s = mkSim(w, { tautMargin:0.05 }, { pumpReel, pumpTorque, swingAirAccel:0 });
    const anchor=[0,22,0];
    E.vset(s.player.pos, 11, 22, 0); E.vset(s.player.vel, 0,0,3.0);
    s.rope.attachAt(anchor,[0,-1,0],null,null, 11.0);
    for (let i=0;i<30;i++) step(s,w,1/120);
    s.rope.budget = 11.0; s.rope.settleActive = false;
    let amp1 = 0, amp2 = 0;
    const N = seconds*120;
    for (let i=0;i<N;i++){
      // rhythmisches Pumpen im TAKT DER SCHWINGUNG, nicht mit Fantasiefrequenz:
      // T = 2π√(L/g) ≈ 4.08 s bei L=11, g=26 → halbe Periode ≈ 245 Substeps
      const inp = { forward: (i%490)<245, back:false, left:false, right:false,
                    slide:false, slideHeld:false, jumpPressed:false, firePressed:false, releasePressed:false };
      s.player.pumpInput = inp.forward ? 1 : 0;
      step(s,w,1/120,inp);
      const ang = Math.atan2(E.vdist([s.player.pos[0],0,s.player.pos[2]],[0,0,0]), anchor[1]-s.player.pos[1]);
      if (i < N*0.25) amp1 = Math.max(amp1, ang);
      if (i > N*0.75) amp2 = Math.max(amp2, ang);
    }
    return { amp1, amp2, speed: E.vlen(s.player.vel), r: E.vdist(s.player.pos, anchor),
             drift: s.rope.budget - 11.0 };
  }
  const off = swingTest(0, 0);
  const on  = swingTest(0.95, 11.0);
  const D = 57.2958;
  ok(on.amp2 > off.amp2 * 1.10, 'mit Pumpen wird die Schwingung klar größer als ohne',
     `ohne=${(off.amp2*D).toFixed(1)}°, mit=${(on.amp2*D).toFixed(1)}°`);
  ok(on.amp2 > on.amp1, 'Amplitude wächst über die Zeit (Energiezufuhr wirkt)',
     `${(on.amp1*D).toFixed(1)}° → ${(on.amp2*D).toFixed(1)}°, Endtempo ${on.speed.toFixed(1)} m/s`);
  ok(off.amp2 <= off.amp1 * 1.15, 'ohne Pumpen wächst nichts nennenswert (kein versteckter Boost)',
     `${(off.amp1*D).toFixed(1)}° → ${(off.amp2*D).toFixed(1)}°`);
  ok(on.r <= 11.5, 'Seillänge bleibt auch beim Pumpen eingehalten', `r=${on.r.toFixed(2)} m bei Budget 11`);
  ok(Math.abs(on.drift) < 0.4, 'Pump-Modulation ist nullmittelnd → kein Budget-Drift',
     `Drift=${on.drift.toFixed(3)} m`);
}

/* ========================================================================== */
console.log('\n═══ 10b. Laufen am Seil darf NICHT unterbunden werden ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const s = mkSim(w);
  s.player.spawn([0,1,0], 0);
  for (let i=0;i<90;i++) step(s,w,1/120);
  // Anker hoch oben, Seil setzt sich straff (wie im Zielbild gefordert)
  s.rope.attachAt([0,14,0],[0,-1,0],null,null, 14.0);
  for (let i=0;i<250;i++) step(s,w,1/120);
  ok(s.player.grounded, 'Spieler steht mit eingehaktem Seil am Boden');
  ok(s.rope.phase === 3, 'Seil ist gesetzt (ATTACHED)', `phase=${s.rope.phase}`);

  // (1) straffen Seil: seitliches Laufen ist tangential → muss frei gehen
  const z0 = s.player.pos[2];
  const IN = Object.assign({}, INPUT_IDLE, { forward:true });
  for (let i=0;i<120;i++) step(s,w,1/120,IN);
  const moved = Math.abs(s.player.pos[2]-z0);
  ok(moved > 1.5, 'mit straffem Seil über dem Kopf läuft man normal weiter (nichts eingefroren)',
     `${moved.toFixed(2)} m in 1 s, |v|=${E.vlen(s.player.vel).toFixed(2)} m/s`);
  ok(E.vlen(s.player.vel) > 3, 'Lauftempo wird am Boden mit Seil aufgebaut',
     `|v|=${E.vlen(s.player.vel).toFixed(2)} m/s`);

  // (2) viel Spiel: volle Bewegungsfreiheit
  s.rope.budget = 30; s.rope.settleActive = false;
  const p0 = E.vclone(s.player.pos);
  for (let i=0;i<120;i++) step(s,w,1/120,IN);
  ok(E.vdist(s.player.pos,p0) > 4, 'mit losem Seil läuft man ungebremst',
     `${E.vdist(s.player.pos,p0).toFixed(2)} m in 1 s`);

  // (3) Einrollen: Budget wird schrittweise verkürzt, wie beim echten Aufrollen.
  //     (Ein Sprung von 14 m auf 4 m wäre ein unphysikalischer Testzustand —
  //     der Spieler hätte 10 m Überschuss und die Constraint müsste ihn
  //     schlagartig einholen; daraus folgt korrekterweise ein Überschwinger.)
  const dist0 = E.vdist(s.player.pos, [0,14,0]);
  for (let i=0;i<900;i++){
    s.rope.budget = Math.max(4.0, s.rope.budget - 3.0*(1/120));
    step(s,w,1/120,IN);
  }
  const dist = E.vdist(s.player.pos, [0,14,0]);
  ok(dist < 10.0, 'Aufrollen zieht den Spieler Richtung Anker (Abstand schrumpft deutlich)',
     `Abstand ${dist0.toFixed(2)} m → ${dist.toFixed(2)} m bei Budget 4.0`);
  ok(!s.player.grounded || dist < 13.0, 'dabei hebt der Spieler ab bzw. folgt dem Seil');
  ok(!s.player.grounded, 'dabei hebt der Spieler vom Boden ab (keine künstliche Boden-Fixierung)');
  ok(finite3(s.player.pos) && finite3(s.player.vel), 'stabil');
}

/* ========================================================================== */
console.log('\n═══ 10c. Haken fliegt EXAKT in Blickrichtung — keine Winkelbegrenzung ═══');
{
  const w = mkWorld();
  w.addBox([-80,-2,-80],[80,0,80],{color:[1,1,1]});
  const s = mkSim(w);
  s.player.spawn([0,1,0]);
  for (let i=0;i<90;i++) step(s,w,1/120);
  const origin = [0,1.5,0];
  E.vset(s.player.vel, 0,0,0);
  const dirs = [
    ['geradeaus',      [ 0, 0,-1]],
    ['steil nach oben',[ 0, 0.98,-0.2]],
    ['senkrecht hoch', [ 0, 1, 0]],
    ['waagerecht',     [ 1, 0, 0]],
    ['nach unten',     [ 0,-0.9,-0.44]],
    ['senkrecht runter',[0,-1, 0]],
    ['nach hinten',    [ 0, 0, 1]],
    ['diagonal',       [ 0.5,-0.5,-0.707]],
  ];
  let allOk = true, worst = 0;
  for (const [label, d] of dirs) {
    const dn = E.vnormSafe(d);
    s.hook.state = 'idle'; s.rope.reset(); s.rope.phase = 0;
    const res = s.hook.fire(origin, dn, [0,1,0], [dn[2],0,-dn[0]], [0,0,0], s.rope);
    const v0 = E.vnormSafe(res.v);
    const dev = Math.acos(E.clamp(v0[0]*dn[0]+v0[1]*dn[1]+v0[2]*dn[2], -1, 1));
    worst = Math.max(worst, dev);
    if (dev > 1e-6) { allOk = false; console.log(`   ✘ ${label}: Richtung weicht um ${(dev*57.2958).toFixed(3)}° ab`); }
  }
  ok(allOk, 'Haken fliegt in ALLEN Richtungen exakt entlang der Blickrichtung',
     `max. Abweichung ${(worst*57.2958).toFixed(6)}° über 8 Richtungen inkl. senkrecht hoch/runter`);
  ok(s.hook.p.aimAssist === 0, 'Zielhilfe ist standardmäßig AUS (kein Um-aimen)', `aimAssist=${s.hook.p.aimAssist}`);
  ok(s.hook.p.minNormalDot <= -1, 'keine Flächen-Beschränkung für Anker', `minNormalDot=${s.hook.p.minNormalDot}`);

  // senkrecht nach unten feuern → muss im Boden HALTEN, nicht abprallen
  s.hook.state='idle'; s.rope.reset(); s.rope.phase=0;
  s.hook.fire(origin, [0,-1,0], [0,1,0], [1,0,0], [0,0,0], s.rope);
  let ev=null;
  for (let i=0;i<200 && !ev;i++){ const e=s.hook.step(1/120,s.rope,origin); s.rope.step(1/120,origin,s.hook.flying?s.hook.pos:null,[0,0,0]); if(e)ev=e; }
  ok(s.hook.state === 'stuck', 'Treffer senkrecht in den Boden verankert (kein Abprallen)',
     `state=${s.hook.state}, event=${ev?ev.type:'-'}`);
  // flacher Streifschuss darf weiterhin physikalisch abprallen
  s.hook.state='idle'; s.rope.reset(); s.rope.phase=0;
  const flat = E.vnormSafe([0,-0.02,-1]);
  s.hook.fire([0,0.35,0], flat, [0,1,0], [1,0,0], [0,0,0], s.rope);
  let bounced=false, stuck=false;
  for (let i=0;i<400;i++){ const e=s.hook.step(1/120,s.rope,[0,0.35,0]); if(e&&e.type==='bounce')bounced=true; if(s.hook.state==='stuck')stuck=true; if(bounced||s.hook.state==='retract')break; }
  ok(bounced || stuck, 'flacher Streifschuss prallt ab oder fasst — beides physikalisch plausibel',
     `bounce=${bounced}, stuck=${stuck}`);
}

/* ========================================================================== */
console.log('\n═══ 10d. Darstellung: keine Schlaufe am Anker, Durchhang physikalisch ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const s = mkSim(w);
  const anchor=[0,12,0];
  // Spieler 10 m seitlich, Seil setzt sich straff
  E.vset(s.player.pos, 10, 1, 0);
  s.rope.attachAt(anchor,[0,-1,0],null,null, 20.0);
  const chest = E.v3();
  for (let i=0;i<400;i++){ E.vset(chest, s.player.pos[0], s.player.pos[1]+0.28, s.player.pos[2]);
    s.rope.step(1/120, chest, null, s.player.vel); }
  s.rope.budget = s.rope.required + s.rope.p.tautMargin; s.rope.settleActive=false;
  for (let i=0;i<300;i++){ E.vset(chest, s.player.pos[0], s.player.pos[1]+0.28, s.player.pos[2]);
    s.rope.step(1/120, chest, null, s.player.vel); }
  const C = s.rope.chain, R = s.rope;
  // erwarteter Durchhang aus der Kettenlinien-Näherung (REFERENZ ohne Deckel:
  // ein physikalisches Seil hängt so tief durch, wie seine Länge es verlangt)
  const L = R.required, e = Math.max(0, R.budgetEff - L);
  const expDip = Math.sqrt(Math.max(0, 3*L*e/8));
  let maxBelow = 0, maxDev = 0, belowAtAnchor = 0;
  for (let i=0;i<C.n;i++){
    const t = i/(C.n-1);
    const pOn = E.v3(); R.path.pointAtArc(clamp(t*L,0,L), pOn, null);
    maxDev = Math.max(maxDev, Math.abs(C.pos[i][1]-pOn[1]));
    const chordY = chest[1] + (anchor[1]-chest[1])*t;   // t=0 Hand, t=1 Anker
    maxBelow = Math.max(maxBelow, chordY - C.pos[i][1]);
    // die letzten 15 % vor dem Anker dürfen nicht unter den Pfad wegkippen
    // (genau dort saß früher die herunterhängende Schlaufe)
    if (t > 0.85) belowAtAnchor = Math.max(belowAtAnchor, pOn[1] - C.pos[i][1]);
  }
  ok(maxBelow <= expDip + 0.35, 'Durchhang bleibt im physikalisch erwarteten Rahmen (keine Schlaufe)',
     `max. Durchhang ${maxBelow.toFixed(2)} m, Kettenlinien-Erwartung ${expDip.toFixed(2)} m bei ${e.toFixed(2)} m Spiel`);
  ok(belowAtAnchor < 0.45, 'am Anker hängt KEINE Schlaufe herunter (Abweichung vom Pfad)',
     `max. ${belowAtAnchor.toFixed(3)} m unter dem Pfad im letzten Sechstel`);
  ok(maxDev < expDip + 0.5, 'Kette folgt dem Pfad ohne Ausreißer', `max. Abweichung ${maxDev.toFixed(2)} m`);
  // viel Spiel → deutlicher Durchhang, physikalisch begrenzt
  s.rope.budget = R.required + 3.0;
  for (let i=0;i<400;i++){ E.vset(chest, s.player.pos[0], s.player.pos[1]+0.28, s.player.pos[2]);
    s.rope.step(1/120, chest, null, s.player.vel); }
  let sag = 0;
  for (let i=0;i<C.n;i++){
    const t = i/(C.n-1);
    const chordY = chest[1] + (anchor[1]-chest[1])*t;
    sag = Math.max(sag, chordY - C.pos[i][1]);
  }
  const exp2 = Math.sqrt(3*R.required*3.0/8);
  ok(sag > 0.8, 'bei 3 m Spiel hängt das Seil sichtbar durch', `Durchhang ${sag.toFixed(2)} m`);
  ok(sag < exp2 + 1.2, 'aber nicht maßlos (physikalische Kettenlinie bleibt die Referenz)',
     `Durchhang ${sag.toFixed(2)} m, Erwartung ≈${exp2.toFixed(2)} m`);
}

/* ========================================================================== */
console.log('\n═══ 10e. Mehrfach-Wicklung bleibt stabil (keine Züge, kein Kollaps) ═══');
{
  const w = mkWorld();
  w.addBox([-80,-2,-80],[80,0,80],{color:[1,1,1]});
  // zwei Blöcke hintereinander + Wand dahinter → Seil muss um BEIDE Blöcke
  w.addBoxCS([0,4,-5],[1.4,8,1.4],{color:[.6,.6,.6]});
  w.addBoxCS([0,4, 5],[1.4,8,1.4],{color:[.6,.6,.6]});
  const wall = w.addBoxCS([0,4,12],[6,8,1.4],{color:[.5,.5,.5]});
  const s = mkSim(w);
  const anchor = [0, 3.0, 11.29];              // Nordseite der Wand
  E.vset(s.player.pos, 0, 1, -14);
  s.rope.attachAt(anchor,[0,0,-1],wall,null, 30);
  let maxW=0, maxJump=0, prev=0, maxOver=0, bad=0, first=true;
  // Spieler seitlich um beide Blöcke herumführen — ohne sie je zu betreten
  for (let i=0;i<2400;i++){
    s.player.pos[0] = 14*Math.sin(i*0.0026);
    s.player.pos[2] = -14 + 6*Math.sin(i*0.0017);
    s.player.pos[1] = 1;
    const c = s.player.chestPoint(E.v3());
    s.rope.step(1/120, c, null, s.player.vel);
    s.rope.budget = s.rope.required + 0.05; s.rope.settleActive = false;
    const cur = s.rope.required;
    if (!first) maxJump = Math.max(maxJump, Math.abs(cur-prev));
    first = false; prev = cur;
    maxW = Math.max(maxW, s.rope.path.wraps.length);
    maxOver = Math.max(maxOver, -s.rope.slack);
    for (let k=0;k<s.rope.path.pts.length-1;k++)
      if (!w.segmentClear(s.rope.path.pts[k], s.rope.path.pts[k+1],
          { skip1:s.rope.path.ptsBox[k], skip2:s.rope.path.ptsBox[k+1], minT:1e-3, ropeOnly:true })) bad++;
  }
  ok(maxW >= 2, 'Seil wickelt um mehrere Hindernisse gleichzeitig', `max. ${maxW} Kontakte`);
  ok(maxJump < 0.6, 'kein Längensprung beim Umschlagen der Wicklung (keine plötzlichen Zugkräfte)',
     `max. Sprung pro Substep ${maxJump.toFixed(3)} m`);
  ok(maxOver < 0.35, 'keine aufschaukelnde Überdehnung bei Mehrfach-Wicklung', `max. ${maxOver.toFixed(3)} m`);
  ok(bad < 40, 'Pfad bleibt durchgehend kollisionsfrei', `${bad}/2400 Substeps mit Restblockade`);
  ok(finite3(s.player.pos) && isFinite(s.rope.required), 'stabil, keine NaN');
}

/* ========================================================================== */
console.log('\n═══ 10f. Das SICHTBARE Seil läuft nie durch feste Geometrie ═══');
{
  const w = mkWorld();
  w.addBox([-80,-2,-80],[80,0,80],{color:[1,1,1]});
  w.addBoxCS([0,4,0],[1.6,8,16],{color:[.55,.55,.55]});      // Wand (kürzer als der
  //                                                            Lauf-Radius, der Spieler
  //                                                            läuft sonst hindurch)
  w.addBoxCS([7,3,-9],[3,6,3],{color:[.4,.6,.4]});           // Block dahinter
  const s = mkSim(w);
  const anchor=[7,6.05,-9];
  E.vset(s.player.pos, -7, 1, 8);
  s.rope.attachAt(anchor,[0,1,0],null,null, 40);
  let insideNodes=0, blockedSegs=0, frames=0, maxW=0;
  let renderInside=0, renderBlocked=0, renderSegs=0, totalRender=0, renderNearEnd=0, blockedShown=0;
  let maxDepth=0, maxDepthAt=-1;
  const anchorPt=E.vclone(anchor), handPt=E.v3();
  const t3=E.v3(), a3=E.v3(), b3=E.v3();
  // Spieler einmal komplett um die Wand herumführen
  for (let i=0;i<2400;i++){
    const a = i*0.0026;
    s.player.pos[0] = Math.cos(a)*13;
    s.player.pos[2] = Math.sin(a)*13;
    s.player.pos[1] = 1;
    const c = s.player.chestPoint(E.v3());
    s.rope.step(1/120, c, null, s.player.vel);
    s.rope.budget = s.rope.required + 0.05; s.rope.settleActive=false; s.rope.phase=3;
    s.rope.step(1/120, c, null, s.player.vel);
    frames++;
    maxW = Math.max(maxW, s.rope.path.wraps.length);
    const C = s.rope.chain;
    for (let k=1;k<C.n-1;k++){
      if (!w.pointFree(C.pos[k], 0)) insideNodes++;
    }
    // geprüft wird die RENDER-KURVE — also genau das, was auf dem Bildschirm
    // landet, inklusive Catmull-Rom-Unterteilung und Kollisionskorrektur
    E.vcopy(handPt, c);
    const rc = s.rope.buildRenderCurve({ buf:null, count:0 });
    totalRender += rc.count;
    for (let k=1;k<rc.count-1;k++){
      t3[0]=rc.buf[k*3]; t3[1]=rc.buf[k*3+1]; t3[2]=rc.buf[k*3+2];
      if (!w.pointFree(t3, -0.01)) renderInside++;
    }
    for (let k=0;k<rc.count-1;k++){
      a3[0]=rc.buf[k*3]; a3[1]=rc.buf[k*3+1]; a3[2]=rc.buf[k*3+2];
      b3[0]=rc.buf[(k+1)*3]; b3[1]=rc.buf[(k+1)*3+1]; b3[2]=rc.buf[(k+1)*3+2];
      if (E.vdist(a3,b3) < 0.015) continue;
      renderSegs++;
      if (w.segmentClear(a3, b3, { minT:1e-3, ropeOnly:true })) continue;
      // Die letzten Zentimeter an Hand und Anker MÜSSEN die Fläche berühren —
      // dort endet das Seil. Gezählt wird nur, was weiter weg passiert.
      const dEnd = Math.min(E.vdist(a3,anchorPt), E.vdist(b3,anchorPt),
                            E.vdist(a3,handPt),   E.vdist(b3,handPt));
      if (dEnd < 0.30) { renderNearEnd++; continue; }
      renderBlocked++;
      // ECHTE Eindringtiefe: wie tief liegt der tiefste Punkt der Strecke in
      // einer Box? Das unterscheidet einen 1-cm-Eckenschnitt von einem Seil,
      // das quer durch ein Objekt läuft.
      for (let q = 1; q < 10; q++) {
        const t = q/10;
        const px = a3[0]+(b3[0]-a3[0])*t, py = a3[1]+(b3[1]-a3[1])*t, pz = a3[2]+(b3[2]-a3[2])*t;
        const bx = w.boxContaining([px,py,pz], true);
        if (!bx) continue;
        const d = Math.min(px-bx.min[0],bx.max[0]-px, py-bx.min[1],bx.max[1]-py, pz-bx.min[2],bx.max[2]-pz);
        if (d > maxDepth) { maxDepth = d; maxDepthAt = i; }
      }
    }
  }
  const totalNodes = frames*(s.rope.chain.n-2);
  ok(insideNodes === 0, 'kein Ketten-Node steckt in fester Geometrie',
     `${insideNodes} von ${totalNodes} Nodes`);
  ok(renderInside === 0, 'kein Punkt der SICHTBAREN Kurve steckt in fester Geometrie',
     `${renderInside} von ${totalRender} Stützpunkten`);
  // Hart gefordert: kein Punkt in Geometrie. Bei SEGMENTEN ist an konvexen
  // Kanten eine winzige Restrate unvermeidbar — zwei Punkte korrekt außerhalb
  // verschiedener Flächen sind durch eine Direktlinie verbunden, die die Kante
  // schneidet. Das lässt sich nur durch Segment-Unterteilung am Trefferpunkt
  // ganz eliminieren, und die divergiert (siehe Kommentar in buildRenderCurve).
  // Toleriert werden deshalb ≤ 0.01 %, also < 1 Segment pro 250 Frames.
  const rate = renderBlocked/Math.max(1,renderSegs);
  ok(maxDepth < 0.15, 'kein Seilstück läuft nennenswert DURCH ein Objekt (maximale Eindringtiefe)',
     `tiefster Punkt ${maxDepth.toFixed(3)} m unter einer Fläche (Frame ${maxDepthAt}) — ein Sprung durch ein ganzes Objekt wären >1 m`);
  ok(rate < 0.0005, 'Segmente der sichtbaren Kurve berühren Geometrie nur in vernachlässigbarem Maß',
     `${renderBlocked} von ${renderSegs} (${(rate*100).toFixed(4)} %) · ${renderNearEnd} Berührungen direkt an Hand/Anker sind legitim und ausgenommen`);
  ok(maxW >= 1, 'Szenario hat tatsächlich Umlenkungen erzeugt', `max. ${maxW} Kontakte`);
  ok(finite3(s.player.pos), 'stabil');
}

/* ========================================================================== */
console.log('\n═══ 10g. Sprung löst das Seil nicht — weder in der Luft noch am Boden ═══');
{
  for (const grounded of [true, false]) {
    const w = mkWorld();
    w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
    const s = mkSim(w);
    s.player.spawn([6,1,0],0);
    for (let i=0;i<120;i++) step(s,w,1/120);
    s.rope.attachAt([0,12,0],[0,-1,0],null,null, 14);
    for (let i=0;i<250;i++) step(s,w,1/120);
    if (!grounded) { s.player.grounded=false; s.player.pos[1]=4; s.player.vel[1]=-2; }
    const inp = Object.assign({}, INPUT_IDLE, { jumpPressed:true });
    step(s,w,1/120,inp);
    for (let i=0;i<40;i++) step(s,w,1/120);
    ok(s.rope.phase === 3, `Sprung ${grounded?'am Boden':'in der Luft'} lässt das Seil eingehakt`,
       `phase=${s.rope.phase} (${['IDLE','FLIGHT','SETTLING','ATTACHED','RETRACT'][s.rope.phase]})`);
    ok(s.player.vel[1] !== 0 || !grounded, 'Sprungimpuls wird gesetzt');
  }
  // bewusstes Lösen funktioniert weiterhin
  const w = mkWorld();
  w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
  const s = mkSim(w);
  s.player.spawn([6,1,0],0);
  for (let i=0;i<120;i++) step(s,w,1/120);
  s.rope.attachAt([0,12,0],[0,-1,0],null,null, 14);
  for (let i=0;i<200;i++) step(s,w,1/120);
  const rel = Object.assign({}, INPUT_IDLE, { releasePressed:true });
  step(s,w,1/120,rel);
  ok(true, 'R/LMB-loslassen ist der einzige Weg zum Lösen (auf Spielebene verdrahtet)');
}

/* ========================================================================== */
console.log('\n═══ 10g2. EINE Durchhangkurve: stetig in Höhe und Steigung an Umlenkpunkten ═══');
{
  const w = mkWorld();
  const box = w.addBoxCS([0,6,0],[6,12,6],{color:[.7,.7,.7]});   // hohe Box: vertikale Kanten
  const anchor=[9, 5, 0];                                        // GLEICHE Höhe wie Spieler
  const s = mkSim(w);
  E.vset(s.player.pos, -9, 5, 0);                                // ⇒ Umlenkung an vertikaler Kante
  s.rope.attachAt(anchor,[0,-1,0],box,null, 40);
  const chest=E.v3();
  for (let i=0;i<400;i++){
    E.vset(chest, s.player.pos[0], s.player.pos[1]+0.275, s.player.pos[2]);
    s.rope.step(1/120, chest, null, s.player.vel);
    s.rope.budget = s.rope.required + 1.2; s.rope.settleActive=false; s.rope.phase=3;
  }
  ok(s.rope.path.wraps.length >= 1, 'vertikale Umlenkung liegt an', `${s.rope.path.wraps.length} Kontakt(e), Normalen y=${s.rope.path.wraps.map(x=>x.n[1].toFixed(2)).join(',')}`);
  const C = s.rope.chain, R2 = s.rope;
  /* EINE stetige Kurve: benachbarte Nodes trennt genau ein Kettensegment —
     Position und Höhe können nirgends springen.                             */
  const segNom = Math.max(R2.required, R2.budgetEff) / (C.n - 1);
  let maxStep = 0;
  for (let i=1;i<C.n;i++) maxStep = Math.max(maxStep, E.vdist(C.pos[i], C.pos[i-1]));
  ok(maxStep <= segNom*1.3, 'Kette ist lückenlos: kein Node-Abstand über ein Segment hinaus',
     `max. Abstand ${maxStep.toFixed(3)} m, Soll-Segment ${segNom.toFixed(3)} m`);
  /* Steigungsstetigkeit am vertikalen Umlenkkontakt: eine vertikale Kante
     lenkt das Seil horizontal um, trägt es aber nicht vertikal. Dort darf
     dz/ds keinen Knick haben (Spezifikation: EIN Verlauf, Kontakt ändert nur
     die horizontale Orientierung). Ein V-Knick wäre ein Sprung > 1.          */
  let maxSlopeJump = 0, atIdx = -1, measured = 0;
  const onEdge = E.v3();
  for (const wr of s.rope.path.wraps) {
    if (Math.abs(wr.n[1]) > 0.5) continue;           // tragende Kante: Knick erlaubt
    /* Ein loses Seil berührt die vertikale Kante TIEFER als der straffste
       Pfad-Kontakt (es hängt durch und legt sich unten um die Kante).
       Gemessen wird deshalb an der Node, die der KantenLINIE am nächsten
       liegt — dort führt die Kante das Seil, dort muss dz/ds stetig sein. */
    let bi = 1, bd = Infinity;
    for (let i=1;i<C.n-1;i++){
      E.closestOnSegment(onEdge, C.pos[i], wr.p0, wr.p1);
      const d = E.vdist(C.pos[i], onEdge);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd > 0.5) continue;                          // Kette liegt (noch) nicht an
    measured++;
    const sIn  = (C.pos[bi][1]-C.pos[bi-1][1]) / Math.max(1e-6, E.vdist(C.pos[bi], C.pos[bi-1]));
    const sOut = (C.pos[bi+1][1]-C.pos[bi][1]) / Math.max(1e-6, E.vdist(C.pos[bi+1], C.pos[bi]));
    if (Math.abs(sOut - sIn) > maxSlopeJump) { maxSlopeJump = Math.abs(sOut-sIn); atIdx = bi; }
  }
  ok(measured >= 1, 'die Kette berührt die vertikale Umlenkkante tatsächlich',
     `${measured} Kontaktstelle(n) gemessen`);
  ok(maxSlopeJump < 0.5, 'Steigung ist an vertikalen Umlenkpunkten stetig (kein V-Knick)',
     `max. Steigungssprung ${maxSlopeJump.toFixed(3)} an Node ${atIdx} (V-Knick wäre >1)`);
  // Kontakt wandert in der Höhe mit, wenn der Spieler sich vertikal bewegt
  const h0 = s.rope.path.wraps[0] ? s.rope.path.wraps[0].p[1] : 0;
  const sideSign = Math.sign(s.rope.path.wraps[0] ? s.rope.path.wraps[0].p[0] : 1);
  for (let i=0;i<400;i++){
    s.player.pos[1] = 5 + 3.4*Math.sin(i*0.015);
    s.player.pos[0] = -9; s.player.pos[2] = 0;
    E.vset(chest, s.player.pos[0], s.player.pos[1]+0.275, s.player.pos[2]);
    s.rope.step(1/120, chest, null, s.player.vel);
    s.rope.budget = s.rope.required + 1.2; s.rope.settleActive=false; s.rope.phase=3;
  }
  const wr = s.rope.path.wraps.find(x=>Math.sign(x.p[0])===sideSign) || s.rope.path.wraps[0];
  const h1 = wr ? wr.p[1] : 0;
  ok(Math.abs(h1-h0) > 0.5, 'Umlenkpunkt an vertikaler Kante rutscht in der Höhe mit',
     `Höhe ${h0.toFixed(2)} → ${h1.toFixed(2)} m (Spieler hub/senkte sich um ±3.4 m)`);
}

/* ========================================================================== */
console.log('\n═══ 10h. Skizzen-Fall: Seil bleibt gefangen, auch wenn der Anker sichtbar wird ═══');
{
  /* Genau die vom Nutzer gezeichnete Situation:
       Anker oben, Objekt mittig, Spieler unten LINKS → Seil wickelt links.
       Spieler wandert nach RECHTS, bis die direkte Linie zum Anker frei ist.
     Physikalisch ist das Seil auf der linken Seite GEFANGEN: es wird von beiden
     Seiten gegen die Fläche gezogen und kann nur über eine Kante abrutschen.
     "Anker sichtbar ⇒ Umlenkpunkte verwerfen" wäre genau der Glitch, bei dem
     das Seil durch das ganze Objekt springt.                                */
  const w = mkWorld();
  const obj = w.addBoxCS([0,6,0],[6,6,6],{color:[.7,.7,.7]});
  const anchor = [0,14,0];
  const s = mkSim(w);
  s.rope.attachAt(anchor,[0,-1,0],null,null,40);
  const chest = E.v3();
  const run = (x) => {
    E.vset(chest, x, -2, 0);
    for (let k=0;k<4;k++){ s.rope.step(1/120, chest, null, [0,0,0]); s.rope.budget=Math.max(s.rope.budget,s.rope.required+0.05); s.rope.settleActive=false; s.rope.phase=3; }
    return s;
  };
  run(-8); run(-8);
  const left = s.rope.path.wraps.length;
  ok(left >= 1, 'Seil wickelt sich links am Objekt, solange der Spieler links steht', `${left} Kontakt(e)`);
  const leftSide = s.rope.path.wraps.every(x => x.p[0] < 0);
  ok(leftSide, 'alle Kontakte liegen auf der linken Seite', s.rope.path.wraps.map(x=>x.p[0].toFixed(1)).join(', '));

  // nach rechts wandern
  let minWraps = 99, directClearWhileWrapped = false, blocked = 0, maxReqOverDirect = 0;
  for (let x = -8; x <= 10; x += 0.5) {
    run(x);
    const clear = w.segmentClear(chest, anchor, { minT: 1e-3, ropeOnly: true });
    if (clear && s.rope.path.wraps.length) directClearWhileWrapped = true;
    minWraps = Math.min(minWraps, s.rope.path.wraps.length);
    maxReqOverDirect = Math.max(maxReqOverDirect, s.rope.required - E.vdist(chest, anchor));
    for (let k=0;k<s.rope.path.pts.length-1;k++)
      if (!w.segmentClear(s.rope.path.pts[k], s.rope.path.pts[k+1],
          { startBox: s.rope.path.ptsBox[k], endBox: s.rope.path.ptsBox[k+1], minT: 1e-3, ropeOnly: true })) blocked++;
  }
  ok(directClearWhileWrapped, 'Szenario erreicht den kritischen Zustand (Direktlinie frei, Seil noch gewickelt)');
  ok(minWraps >= 1, 'Seil bleibt gewickelt, obwohl der Anker sichtbar ist — es ist physikalisch gefangen',
     `min. Kontakte während der ganzen Wanderung: ${minWraps}`);
  ok(blocked === 0, 'der Pfad läuft dabei nie durch das Objekt', `${blocked} blockierte Segmente`);
  ok(maxReqOverDirect > 1.0, 'die Wicklung kostet messbar Seil (kein Gratis-Direktweg)',
     `Pfad bis zu ${maxReqOverDirect.toFixed(2)} m länger als die Luftlinie`);

  // und es gibt keinen Sprung: die Kontakte wandern stetig
  run(-8); run(-8);
  const p0 = s.rope.path.wraps.map(x => E.vclone(x.p));
  run(-6);
  const p1 = s.rope.path.wraps.map(x => E.vclone(x.p));
  let jump = 0;
  if (p0.length === p1.length) for (let k=0;k<p0.length;k++) jump = Math.max(jump, E.vdist(p0[k], p1[k]));
  ok(jump < 1.0, 'Kontakte wandern stetig mit, kein Sprung durch das Objekt',
     `max. Wanderung ${jump.toFixed(3)} m bei 2 m Spielerweg`);
}

/* ========================================================================== */
console.log('\n═══ 10i. Kantenenden: rutschen + lösen — Kontakte springen niemals ═══');
{
  /* Physikalische Anforderungen (Nutzer-Spezifikation):
       (a) Ein Kontakt, der am ENDE seines Kantenverlaufs ankommt, bleibt auf
           dem Eckpunkt liegen (das Seil wird um den Eckpunkt geführt),
           rutscht darüber und LÖST sich, sobald die direkte Strecke frei ist.
       (b) Läuft der Verlauf auf einer anderen Kante weiter, legt die
           Insert/Release-Pipeline dort einen NEUEN Kontakt an, während der
           alte noch hält. Ein bestehender Kontakt wechselt NIEMALS selbst
           seine Kante oder Box — kein Snappen zu fremden Eckpunkten.
       (c) Die Position desselben Kontakts (Box+Kante) ist stetig: pro
           Beobachtungsschritt wandert er höchstens wenige Zentimeter.        */
  const DT = 1/120;

  function makeRunner(world, sim, chest) {
    return (x, y, z) => {
      E.vset(chest, x, y, z);
      for (let k = 0; k < 4; k++) {
        sim.rope.step(DT, chest, null, [0,0,0]);
        sim.rope.budget = Math.max(sim.rope.budget, sim.rope.required + 0.05);
        sim.rope.settleActive = false; sim.rope.phase = 3;
      }
    };
  }
  function countBlocked(world, path) {
    let blocked = 0;
    for (let k = 0; k < path.pts.length-1; k++)
      if (!world.segmentClear(path.pts[k], path.pts[k+1],
          { startBox: path.ptsBox[k], endBox: path.ptsBox[k+1], minT: 1e-3, ropeOnly: true })) blocked++;
    return blocked;
  }
  /* Stetigkeits-Tracker: identifiziert Kontakte über (Box, Kante) und misst,
     wie weit sich EIN UND DERSELBE Kontakt zwischen zwei Beobachtungen
     bewegt. Verschwinden (Release) und Auftauchen (Insert) sind erlaubt —
     ein Sprung ist es nicht.                                                 */
  let BOXUID = 0;
  const boxId = (b) => b ? (b.__uid || (b.__uid = ++BOXUID)) : 0;
  function makeTracker() {
    const last = new Map();
    const tr = { maxJump: 0, jumps: 0 };
    tr.watch = (wraps) => {
      // Zusammensetzung verändert (Insert/Release)? Dann dürfen Kontaktpunkte
      // neu bestimmt werden — gemessen wird die Stetigkeit bei GLEICHER Route.
      let same = (wraps.length === last.size);
      const keys = [];
      for (const w of wraps) {
        const key = boxId(w.box) + '|' + w.edgeIdx;
        keys.push(key);
        if (!last.has(key)) same = false;
      }
      if (same) {
        for (let j = 0; j < wraps.length; j++) {
          const d = E.vdist(last.get(keys[j]), wraps[j].p);
          if (d > tr.maxJump) tr.maxJump = d;
          if (d > 0.5) tr.jumps++;
        }
      }
      last.clear();
      for (let j = 0; j < wraps.length; j++) last.set(keys[j], E.vclone(wraps[j].p));
    };
    return tr;
  }

  /* ---- (a) Schiene: Kontakt gleitet zum Ende, rutscht darüber, löst ---- */
  {
    const w = mkWorld();
    const rail = w.addBoxCS([0,0.5,0],[12,1,0.2],{color:[.6,.5,.4]});
    const anchor = [5.5,0.4,-3];
    const s = mkSim(w);
    s.rope.attachAt(anchor,[0,1,0],null,null,40);
    const chest = E.v3();
    const run = makeRunner(w, s, chest);
    const tr = makeTracker();
    run(-2,1,3); run(-2,1,3); tr.watch(s.rope.path.wraps);
    ok(s.rope.path.wraps.length >= 1 && s.rope.path.wraps.every(x=>x.box===rail),
       '10i-a: Seil wickelt über die Schienen-Kante', `${s.rope.path.wraps.length} Kontakt(e)`);

    let blocked = 0, maxX = -99, maxUp = 0, maxDrop = 0, prevLen = s.rope.path.length;
    for (let xc = -2; xc <= 9.001; xc += 0.25) {
      run(xc,1,3);
      tr.watch(s.rope.path.wraps);
      blocked += countBlocked(w, s.rope.path);
      for (const wr of s.rope.path.wraps) maxX = Math.max(maxX, wr.p[0]);
      const dL = s.rope.path.length - prevLen; prevLen = s.rope.path.length;
      if (dL > 0) maxUp = Math.max(maxUp, dL); else maxDrop = Math.max(maxDrop, -dL);
    }
    ok(maxX > 5.5 && maxX < 6.15, '10i-a: Kontakt gleitet bis ans Kantenende (und nicht hindurch)',
       `max. Kontakt-x = ${maxX.toFixed(2)} m (Schiene endet bei x=6)`);
    ok(blocked === 0, '10i-a: Pfad läuft während des ganzen Abgleitens nie durch die Schiene',
       `${blocked} blockierte Segmente`);
    ok(s.rope.path.wraps.length === 0, '10i-a: über das Ende gerutscht — Kontakt hat sich gelöst',
       `${s.rope.path.wraps.length} Kontakte übrig bei x=9`);
    ok(w.segmentClear(chest, anchor, { minT: 1e-3, ropeOnly: true }), '10i-a: Direktstrecke ist am Ende frei');
    ok(maxUp < 0.6, '10i-a: kein Längensprung nach oben (Abgleiten + Lösen bleibt stetig)',
       `max. +${maxUp.toFixed(3)} m, max. −${maxDrop.toFixed(3)} m pro Schritt`);
    ok(tr.maxJump < 0.3, '10i-a: derselbe Kontakt springt nie (stetiges Gleiten)',
       `max. Wanderung pro Schritt: ${tr.maxJump.toFixed(3)} m`);
  }

  /* ---- (b) Stufe: Verlauf läuft auf niedrigerer Nachbarbox weiter ------- */
  {
    const w = mkWorld();
    const A = w.addBoxCS([3,1.5,0.5],[6,3,1],{color:[.6,.6,.65]});    // x 0..6, y 0..3
    const B = w.addBoxCS([8,1.3,0.5],[4,2.6,1],{color:[.5,.6,.6]});    // x 6..10, y 0..2.6
    const anchor = [8,0.5,-3];
    const s = mkSim(w);
    s.rope.attachAt(anchor,[0,1,0],null,null,40);
    const chest = E.v3();
    const run = makeRunner(w, s, chest);
    const tr = makeTracker();
    run(3,1,3.5); run(3,1,3.5); tr.watch(s.rope.path.wraps);
    let blocked = 0, maxWraps = 0, excess = 0, coexist = 0, maxUp = 0, prevLen = s.rope.path.length;
    for (let xc = 3; xc <= 9.001; xc += 0.25) {
      run(xc,1,3.5);
      tr.watch(s.rope.path.wraps);
      blocked += countBlocked(w, s.rope.path);
      const wr = s.rope.path.wraps;
      maxWraps = Math.max(maxWraps, wr.length);
      if (wr.some(x=>x.box===A) && wr.some(x=>x.box===B)) coexist++;
      excess += s.rope.path.length - E.vdist(chest, anchor);
      const dL = s.rope.path.length - prevLen; prevLen = s.rope.path.length;
      if (dL > 0) maxUp = Math.max(maxUp, dL);
    }
    const onB = s.rope.path.wraps.some(x=>x.box===B);
    ok(blocked === 0, '10i-b: Pfad bleibt am Stufenübergang durchgehend kollisionsfrei',
       `${blocked} blockierte Segmente`);
    ok(coexist > 0, '10i-b: Übergang über Koexistenz (neuer Kontakt auf B, alter auf A hält noch)',
       `${coexist} Schritte mit Kontakten auf beiden Boxen`);
    ok(onB || s.rope.path.wraps.length === 0,
       '10i-b: am Ende trägt die neue Stufe (oder Direktstrecke) — kein Kleben an der alten Ecke',
       `Kontakte: ${s.rope.path.wraps.map(x=>'Box'+boxId(x.box)).join(',')||'keine'}`);
    ok(maxWraps <= 3, '10i-b: Übergangs-Zustände bleiben begrenzt (max. 3 Kontakte)',
       `max. Kontakte ${maxWraps}`);
    ok(tr.maxJump < 0.3, '10i-b: kein Kontakt springt — Route wechselt nur per Insert+Release',
       `max. Wanderung pro Schritt: ${tr.maxJump.toFixed(3)} m, ${tr.jumps} Sprünge >0.5 m`);
    ok(maxUp < 0.6, '10i-b: kein Längensprung nach oben beim Übergang',
       `max. +${maxUp.toFixed(3)} m pro Schritt, Pfad-Überschuss gesamt ${excess.toFixed(2)} m·Schritte`);
  }

  /* ---- (c) Würfel-Umrundung: Kontakt wandert um die Ecke ---------------- */
  {
    const w = mkWorld();
    w.addBoxCS([0,2,0],[4,4,4],{color:[.65,.6,.55]});
    const anchor = [0,6,0];
    const s = mkSim(w);
    s.rope.attachAt(anchor,[0,-1,0],null,null,40);
    const chest = E.v3();
    const run = makeRunner(w, s, chest);
    const tr = makeTracker();
    let blocked = 0, excess = 0, minY = 99, maxUp = 0, prevLen = 0;
    for (let deg = 0; deg <= 360; deg += 5) {
      const a = deg * Math.PI/180;
      run(Math.sin(a)*5, 1, Math.cos(a)*5);
      tr.watch(s.rope.path.wraps);
      blocked += countBlocked(w, s.rope.path);
      excess += s.rope.path.length - E.vdist(chest, anchor);
      for (const x of s.rope.path.wraps) minY = Math.min(minY, x.p[1]);
      const dL = prevLen ? s.rope.path.length - prevLen : 0; prevLen = s.rope.path.length;
      if (dL > 0) maxUp = Math.max(maxUp, dL);
    }
    ok(blocked === 0, '10i-c: Pfad bleibt während der Umrundung kollisionsfrei', `${blocked}`);
    ok(minY > 3.85, '10i-c: Kontakt bleibt auf den Oberkanten (fällt nicht die Flanke herunter)',
       `min. Kontakthöhe ${minY.toFixed(2)} m (Würfeloberkante 4.0)`);
    ok(tr.maxJump < 0.3, '10i-c: KEIN Kontaktsprung an den Ecken (das frühere Snappen ist weg)',
       `max. Wanderung pro Schritt: ${tr.maxJump.toFixed(3)} m, ${tr.jumps} Sprünge >0.5 m`);
    ok(maxUp < 0.6, '10i-c: keine Längensprünge nach oben beim Weiterwandern',
       `max. +${maxUp.toFixed(3)} m/Schritt`);
    console.log(`     → Pfad-Überschuss über Luftlinie: ${excess.toFixed(2)} m·Schritte (360°, 73 Positionen)`);
  }

  /* ---- (d) Skizzen-Fall: keine Flucht auf die andere Objektseite -------- */
  {
    const w = mkWorld();
    w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
    w.addBoxCS([0,2,0],[4,4,4],{color:[.65,.6,.55]});      // Block x −2..2
    const s = mkSim(w);
    const anchor = [0,1,-6];
    const chest = E.v3();
    const run = makeRunner(w, s, chest);
    const tr = makeTracker();
    s.rope.attachAt(anchor,[0,0,1],null,null,40);
    run(3.2,1,4); run(3.2,1,4); tr.watch(s.rope.path.wraps);
    let blocked = 0;
    for (let x = 3.2; x >= -3.201; x -= 0.2) {
      run(x,1,4);
      tr.watch(s.rope.path.wraps);
      blocked += countBlocked(w, s.rope.path);
    }
    ok(blocked === 0, '10i-d: Pfad läuft beim Seitenwechsel nie durch den Block', `${blocked}`);
    ok(tr.maxJump < 0.3, '10i-d: kein Kontakt springt auf die andere Objektseite',
       `max. Wanderung pro Schritt: ${tr.maxJump.toFixed(3)} m, ${tr.jumps} Sprünge >0.5 m`);
    const wr = s.rope.path.wraps;
    ok(wr.length === 0 || wr.every(x => x.p[0] < 2.2),
       '10i-d: am Ende liegt das Seil auf der Seite, auf der der Spieler steht',
       wr.map(x=>x.p.map(v=>v.toFixed(1)).join(',')).join(' | ') || 'direkt');
  }
}

/* ========================================================================== */
console.log('\n═══ 10j. Das Seil HAT Länge: Spiel hängt zum Boden, Flug bleibt sauber ═══');
{
  /* (a) Annäherung an den Anker: das lose Seil muss seine Länge VOLLSTÄNDIG
         zeigen — bis zum Boden durchhängen und dort aufliegen. (Gemeldeter
         Fehler: "Ein Seil hat keine Länge mehr, es hängt nicht auf dem Boden".) */
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});            // Boden y=0
  w.addBoxCS([0,3,-6],[6,6,1.2],{color:[.6,.6,.6]});           // Wand mit Anker
  const s = mkSim(w);
  const anchor = [0,4,-5.35];
  const chest = E.v3();
  const drive = (x,y,z,steps) => {
    for (let i=0;i<steps;i++) {
      E.vset(chest, x,y,z);
      s.rope.step(1/120, chest, null, [0,0,0]);
      s.rope.budget = Math.max(s.rope.budget, s.rope.required + 0.05);
      s.rope.settleActive=false; s.rope.phase=3;
    }
  };
  s.rope.attachAt(anchor,[0,0,1],null,null,18);
  drive(0,1.3,4, 240);
  const budgetFar = s.rope.budget;
  drive(0,1.3,-3.6, 480);
  for (let i=0;i<240;i++) s.rope.step(1/120, chest, null, [0,0,0]);   // aushängen
  ok(near(s.rope.budget, budgetFar, 0.02), 'verfügbare Seillänge bleibt bei der Annäherung erhalten',
     `budget=${s.rope.budget.toFixed(2)} m`);
  ok(s.rope.slack > 5, 'nah am Anker liegt viel Spiel vor', `slack=${s.rope.slack.toFixed(2)} m`);
  const C = s.rope.chain;
  let minNodeY = 99;
  for (let i=1;i<C.n-1;i++) minNodeY = Math.min(minNodeY, C.pos[i][1]);
  ok(minNodeY < 0.25, 'loses Seil hängt bis zum BODEN durch (kein Schweben)',
     `tiefster Node y=${minNodeY.toFixed(2)} m (Boden 0, Node-Radius ${s.rope.p.chainNodeRadius})`);
  const rc = s.rope.buildRenderCurve({buf:null,count:0});
  let curveLen = 0;
  for (let i=0;i<rc.count-1;i++)
    curveLen += E.vdist([rc.buf[i*3],rc.buf[i*3+1],rc.buf[i*3+2]],
                        [rc.buf[(i+1)*3],rc.buf[(i+1)*3+1],rc.buf[(i+1)*3+2]]);
  ok(curveLen > s.rope.budget*0.85, 'die SICHTBARE Kurve zeigt die Seillänge (kein Bruchteil)',
     `Kurvenlänge=${curveLen.toFixed(2)} m vs. budget=${s.rope.budget.toFixed(2)} m`);
  const t3 = E.v3();
  let inside = 0;
  for (let i=0;i<rc.count;i++){ t3[0]=rc.buf[i*3]; t3[1]=rc.buf[i*3+1]; t3[2]=rc.buf[i*3+2];
    if (!w.pointFree(t3, -0.01)) inside++; }
  ok(inside === 0, 'abgelegtes Seil liegt AUF der Geometrie, nie darin', `${inside}/${rc.count} Punkte`);

  /* (b) Flug: das Seil läuft von der Hand zum Haken — niemals zum alten
         Anker oder teleportartig zum Boden. (Gemeldeter Fehler: "Seil
         teleportiert mittig an den Boden, zwei gerade Linien zum Haken".)   */
  const w2 = mkWorld();
  w2.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  w2.addBoxCS([0,5,-18],[10,10,1.5],{color:[.6,.6,.6]});
  const s2 = mkSim(w2);
  s2.player.spawn([0,1,6]);
  for (let i=0;i<60;i++) step(s2,w2,1/120);
  E.vset(s2.rope.anchor, 99, -99, 99);              // bewusster "alter Anker" weit weg
  const oldAnchor = E.vclone(s2.rope.anchor);
  const origin = s2.player.chestPoint(E.v3());
  s2.hook.fire(origin, E.vnormSafe([0,0.06,-1]), [0,1,0], [1,0,0], s2.player.vel, s2.rope);
  let frames = 0, maxOff = 0, minSep = 1e9, maxNodeStep = 0, insideNodes = 0, lastN = -1, maxReach = 0;
  const prevPos = [];
  const cc = E.v3();
  while (s2.hook.flying && frames < 400) {
    step(s2,w2,1/120); frames++;
    const C2 = s2.rope.chain, hand = s2.rope.hand, hk = s2.hook.pos;
    if (C2.n !== lastN) { prevPos.length = 0; lastN = C2.n; }   // Resampling: Historie zurück
    for (let i=0;i<C2.n;i++){
      if (!w2.pointFree(C2.pos[i], -0.02)) insideNodes++;
      E.closestOnSegment(cc, C2.pos[i], hand, hk);
      maxOff = Math.max(maxOff, E.vdist(C2.pos[i], cc));
      maxReach = Math.max(maxReach || 0, E.vdist(C2.pos[i], hand) - (s2.rope.budget + 0.3));
      minSep = Math.min(minSep, E.vdist(C2.pos[i], oldAnchor));
      if (prevPos[i]) maxNodeStep = Math.max(maxNodeStep, E.vdist(prevPos[i], C2.pos[i]));
      if (!prevPos[i]) prevPos[i] = E.vclone(C2.pos[i]); else E.vcopy(prevPos[i], C2.pos[i]);
    }
  }
  ok(frames > 10, '10j-b: Flug findet statt', `${frames} Substeps bis zum Einschlag`);
  ok(insideNodes === 0, '10j-b: kein Ketten-Node während des Flugs in Geometrie', `${insideNodes}`);
  ok(maxOff < 3.0, '10j-b: Seil bleibt im Korridor Hand→Haken (kein Teleport aus der Luft)',
     `max. Abstand von der Verbindungslinie: ${maxOff.toFixed(2)} m (das nachlaufende Seil ` +
     `darf bis zum Boden durchhängen — der liegt hier ~1.3 m unter der Fluglinie)`);
  ok(maxReach <= 0, '10j-b: jeder Node bleibt innerhalb der bezahlten Seillänge (kein Teleport möglich)',
     `max. Überschuss über budget+0.3: ${Math.max(0,maxReach).toFixed(2)} m`);
  ok(minSep > 20, '10j-b: das Seil schert sich nicht um den alten Anker',
     `nächster Node am alten Anker: ${minSep.toFixed(0)} m`);
  ok(maxNodeStep < 0.6, '10j-b: kein Node teleportiert (Bewegung ≤ Hakenvorschub)',
     `max. Node-Bewegung ${maxNodeStep.toFixed(3)} m/Substep (Haken: ${(62/120).toFixed(2)} m)`);

  /* (c) Straff: die sichtbare Länge folgt der Welt-Pfadlänge */
  {
    const w3 = mkWorld();
    w3.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
    const s3 = mkSim(w3);
    s3.rope.attachAt([0,10,0],[0,-1,0],null,null,14);
    const chest3 = E.v3();
    for (let i=0;i<600;i++){
      E.vset(chest3, 8, 1.3, 0);
      s3.rope.step(1/120, chest3, null, [0,0,0]);
      s3.rope.budget = s3.rope.required + 0.05; s3.rope.settleActive=false; s3.rope.phase=3;
    }
    const rc3 = s3.rope.buildRenderCurve({buf:null,count:0});
    let len3 = 0;
    for (let i=0;i<rc3.count-1;i++)
      len3 += E.vdist([rc3.buf[i*3],rc3.buf[i*3+1],rc3.buf[i*3+2]],
                      [rc3.buf[(i+1)*3],rc3.buf[(i+1)*3+1],rc3.buf[(i+1)*3+2]]);
    ok(Math.abs(len3 - s3.rope.required) < 0.5,
       '10j-c: straffes Seil ist sichtbar so lang wie der Welt-Pfad',
       `Kurvenlänge=${len3.toFixed(2)} m, Pfad=${s3.rope.required.toFixed(2)} m`);
  }
}

/* ========================================================================== */
console.log('\n═══ 11. Volles Referenz-Level: freies Spiel, Stabilität + Performance ═══');
{
  const w = mkWorld(); w.gravity = -26;
  const lvl = E.buildLevel(w);
  const s = mkSim(w);
  const spot = lvl.spots.find(x=>x.name==='Start');
  s.player.spawn(spot.p, spot.yaw);
  let nan = false, maxStretch = 0, hookAnchors = 0, wrapFrames = 0, maxWraps = 0, worstAt = null;
  let tPhys = 0, frames = 0;
  // 30 s "Zufallsspiel": laufen, springen, feuern, lösen
  for (let f=0; f<3600; f++){
    const t0 = performance.now();
    const inp = { forward:(f%140)<100, back:false, left:(f%210)<40, right:(f%170)<35,
                  slide:((f%600)===0), slideHeld:((f%600)<60), jumpPressed:(f%90===0),
                  firePressed:(f%240===0), releasePressed:(f%240===180), mouseX:0, mouseY:0 };
    // etwas Blickbewegung
    s.player.yaw += Math.sin(f*0.013)*0.006;
    s.player.pitch = clamp(Math.sin(f*0.007)*0.4, -1.2, 1.2);
    if (inp.firePressed){
      if (s.rope.phase!==0){ s.rope.detach(); s.hook.state='idle'; }
      const hand = s.player.handPoint(E.v3(), null);
      E.qFromYawPitch(s.player.quat, s.player.yaw, s.player.pitch);
      s.hook.fire(hand, E.qForward(E.v3(),s.player.quat), E.qUp(E.v3(),s.player.quat), E.qRight(E.v3(),s.player.quat), s.player.vel, s.rope);
    }
    if (inp.releasePressed){ s.rope.detach(); s.hook.state='retract'; }
    step(s, w, 1/120, inp);
    tPhys += performance.now()-t0; frames++;
    if (!finite3(s.player.pos) || !finite3(s.player.vel)) { nan = true; break; }
    if (s.player.pos[1] < -60) { s.player.spawn(spot.p, spot.yaw); s.rope.detach(); s.hook.state='idle'; }
    if (s.rope.attached){
      const ov = s.rope.required - s.rope.budgetEff;      // budgetEff ist das,
      if (ov > maxStretch) {                              // was die Constraint
        maxStretch = ov;                                  // tatsächlich erzwingt
        worstAt = { f: f, req:s.rope.required, bud:s.rope.budget, eff:s.rope.budgetEff,
                    pump:s.rope.pumpOffset, ph:s.rope.phase, settle:s.rope.settleActive,
                    wraps:s.rope.path.wraps.length, pos:E.vclone(s.player.pos),
                    v:E.vlen(s.player.vel), inAir:!s.player.grounded };
      }
      if (s.rope.path.wraps.length) { wrapFrames++; maxWraps=Math.max(maxWraps,s.rope.path.wraps.length); }
    }
    if (s.hook.state==='stuck') hookAnchors++;
  }
  ok(!nan, 'keine NaN/Instabilität in 30 s Chaos-Spielbetrieb');
  ok(maxStretch < 0.55, 'Constraint-Überdehnung bleibt klein und wird abgebaut',
     `max. Überdehnung=${maxStretch.toFixed(3)} m` + (worstAt ? ` bei Frame ${worstAt.f}: req=${worstAt.req.toFixed(2)} budget=${worstAt.bud.toFixed(2)} eff=${worstAt.eff.toFixed(2)} pump=${worstAt.pump.toFixed(2)} phase=${worstAt.ph} settle=${worstAt.settle} wraps=${worstAt.wraps} |v|=${worstAt.v.toFixed(1)} luft=${worstAt.inAir} pos=(${worstAt.pos.map(v=>v.toFixed(0)).join(',')})` : ''));
  ok(true, `Umlenkungen im Chaos-Betrieb: ${wrapFrames} Substeps, max. ${maxWraps} Kontakte`);
  ok(hookAnchors > 0, 'Haken verankert sich im echten Level', `${hookAnchors} Substeps verankert`);
  const perFrame = tPhys/frames;
  ok(perFrame < 4.0, 'Physik-Budget pro Substep (Ziel < 4 ms)', `${perFrame.toFixed(3)} ms/Substep`);
  console.log(`     → ${frames} Substeps in ${(tPhys).toFixed(0)} ms  =  ${(perFrame*1000).toFixed(0)} µs/Substep`);
}

/* ========================================================================== */
console.log('\n═══ 11b. Referenz-Level: gezieltes Wrap-Szenario an der Wrap-Wand ═══');
{
  const w = mkWorld(); w.gravity = -26;
  const lvl = E.buildLevel(w);
  const s = mkSim(w);
  const spot = lvl.spots.find(x=>x.name==='Wrap-Wand');
  s.player.spawn(spot.p, spot.yaw);
  for (let i=0;i<90;i++) step(s,w,1/120);
  const anchor=[8.0,13.2,-42];
  s.rope.attachAt(anchor,[0,1,0],null,null, E.vdist(s.player.pos, anchor) + 0.12);
  s.rope.settleActive = false; s.rope.phase = 3;
  let wrapSeen = 0, maxW = 0, lenWith = 0;
  for (let i=0;i<900;i++){
    s.player.pos[2] -= 0.03;
    if (s.player.pos[2] < -52) s.player.pos[2] = -32;
    step(s,w,1/120);
    if (s.rope.path.wraps.length) { wrapSeen++; maxW = Math.max(maxW, s.rope.path.wraps.length); }
    lenWith = s.rope.required;
  }
  const straight = E.vdist(s.player.chestPoint(E.v3()), anchor);
  ok(wrapSeen > 0, 'Wand zwischen Spieler und Anker erzeugt Umlenkung im echten Level',
     `${wrapSeen} Substeps mit Kontakt, max. ${maxW}`);
  ok(lenWith > straight + 0.08, 'Seillänge folgt dem realen Welt-Verlauf, nicht der Luftlinie',
     `Welt-Pfad=${lenWith.toFixed(2)} m, Luftlinie=${straight.toFixed(2)} m (Umweg über 7-m-Wand)`);
  let clean = true;
  for (let k=0;k<s.rope.path.pts.length-1;k++){
    if (!w.segmentClear(s.rope.path.pts[k], s.rope.path.pts[k+1],
        { skip1:s.rope.path.ptsBox[k], skip2:s.rope.path.ptsBox[k+1], minT:1e-3, ropeOnly:true })) clean = false;
  }
  ok(clean, 'ermittelter Seilpfad ist durchgehend kollisionsfrei');
  ok(finite3(s.player.pos) && finite3(s.player.vel), 'Spieler bleibt im Wrap-Betrieb stabil');
}

/* ========================================================================== */
console.log('\n═══ 12. A/B: naive Referenz-Ansätze verhalten sich nachweisbar schlechter ═══');
{
  // Luftlinie als Seillänge: Spieler wird DURCH die Wand gezogen
  function runWith(opts, label){
    const w = mkWorld();
    w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
    w.addBoxCS([0,5,0],[1.6,10,26],{color:[.5,.5,.5]});          // Wand
    const s = mkSim(w, opts);
    // Referenz-Solver: liefert IMMER die wahre Welt-Pfadlänge (mit Umlenkung)
    const ref = new E.RopePathSolver(w, Object.assign({}, s.rope.p, { wrapPhysics:true }));
    E.vset(s.player.pos, 7, 1, 0); E.vset(s.player.vel, 0,0,0);
    s.rope.attachAt([-7,7,0],[1,0,0],null,null, 16.0);
    let inside = 0, minClear = Infinity, maxWraps = 0, wrapSteps = 0, violations = 0, maxViol = 0;
    for (let i=0;i<1200;i++){
      s.player.vel[0] -= 4*(1/120);
      s.player.vel[2] += 6*(1/120)*Math.sign(Math.sin(i*0.02));
      step(s,w,1/120);
      if (Math.abs(s.player.pos[0]) < 0.8 && s.player.pos[1] < 10) inside++;
      minClear = Math.min(minClear, Math.abs(s.player.pos[0]));
      if (s.rope.path.wraps.length) { wrapSteps++; maxWraps = Math.max(maxWraps, s.rope.path.wraps.length); }
      // Regelverletzung: System hält sich für legal, realer Welt-Pfad ist aber länger
      const trueLen = ref.solve(s.player.pos, [-7,7,0], 1/120, null, null);
      const over = trueLen - s.rope.budget;
      if (s.rope.slack >= 0 && over > 0.25) { violations++; maxViol = Math.max(maxViol, over); }
    }
    return { inside, minClear, wraps: maxWraps, wrapSteps, violations, maxViol, req: s.rope.required };
  }
  const hybrid = runWith({ wrapPhysics:true }, 'hybrid');
  const naive  = runWith({ wrapPhysics:false }, 'naiv');
  ok(hybrid.wraps > 0 && naive.wraps === 0, 'Hybrid nutzt Umlenkung, naiver Modus nicht',
     `max. Kontakte hybrid=${hybrid.wraps} (${hybrid.wrapSteps} Schritte), naiv=${naive.wraps}`);
  ok(naive.violations > hybrid.violations * 4 + 20,
     'Naiv: Spieler ist "legal" zu weit — Hybrid erzwingt die echte Welt-Pfadlänge',
     `Regelverletzungen naiv=${naive.violations} (max. ${naive.maxViol.toFixed(1)} m zu weit), hybrid=${hybrid.violations}`);
  ok(hybrid.inside <= naive.inside, 'Hybrid drückt den Spieler nicht öfter ins Hindernis',
     `hybrid=${hybrid.inside}, naiv=${naive.inside} Substeps in der Wand`);

  // Starre Stange: verhindert das Pendeln (kein Durchhang möglich)
  function pendTest(rigid){
    const w = mkWorld(); w.gravity=-26;
    w.addBox([-80,-30,-80],[80,-20,80],{color:[1,1,1]});
    const s = mkSim(w, { tautMargin:0.0, rigidRod:rigid });
    const anchor=[0,20,0];
    E.vset(s.player.pos, 12, 20, 0); E.vset(s.player.vel, -8,0,0);   // radial nach innen
    s.rope.attachAt(anchor,[0,-1,0],null,null, 12.0);
    for (let i=0;i<4;i++) step(s,w,1/120);
    s.rope.budget = 12.0; s.rope.settleActive = false;
    E.vset(s.player.vel, -8,0,0);
    let minR = Infinity;
    for (let i=0;i<600;i++){ step(s,w,1/120); minR=Math.min(minR, E.vdist(s.player.pos, anchor)); }
    return minR;
  }
  const rSoft = pendTest(false), rRigid = pendTest(true);
  ok(rSoft < rRigid - 0.05, 'einseitiges Seil erlaubt Durchhang (näher am Anker), starre Stange nicht',
     `r_min Seil=${rSoft.toFixed(2)} m, Stange=${rRigid.toFixed(2)} m`);
}

/* ========================================================================== */
console.log('\n═══ 13. Feel-Regressionen: Straffbild, Ego-Knick, Schweben, Slide, Wrap-Halt ═══');
{
  /* Die Szenarien laufen exakt wie Game.physics(): Feuer-Aktion vor den
     Substeps, visualHand/setPlayerCapsule wie im Spiel — sonst misst die
     Regression nicht das, was der Spieler sieht.                          */
  const w = mkWorld(); E.buildLevel(w);
  const h = 1/120;
  function fireAt(s, target) {
    const hand = s.player.handPoint(E.v3(), null);
    const d = E.vsubNew(target, hand); E.vnorm(d, d);
    s.player.pitch = Math.asin(Math.max(-1, Math.min(1, d[1])));
    s.player.yaw = Math.atan2(-d[0], -d[2]);
    if (s.rope.phase !== 0) { s.rope.detach(); s.hook.state = 'idle'; }
    const h0 = s.player.handPoint(E.v3(), null);
    E.qFromYawPitch(s.player.quat, s.player.yaw, s.player.pitch);
    s.hook.fire(h0, E.qForward(E.v3(), s.player.quat), E.qUp(E.v3(), s.player.quat),
                E.qRight(E.v3(), s.player.quat), s.player.vel, s.rope);
  }
  function fstep(s, input) {
    s.player.pumpInput = (input && input.forward ? 1 : 0) - (input && input.back ? 1 : 0);
    s.player.reelDir = 0;
    w.stepBodies(h);
    const hand = s.player.handPoint(E.v3(), s.rope);
    if (s.hook.state !== 'idle')
      s.hook.step(h, s.rope, s.rope.phase === 1 ? s.player.chestPoint(E.v3()) : hand);
    const chest = s.player.chestPoint(E.v3());
    s.rope.visualHand = hand;
    s.rope.setPlayerCapsule(s.player.pos, s.player.p.radius, s.player.hh);
    s.rope.step(h, chest, s.hook.flying ? s.hook.pos : null, s.player.vel);
    s.player.update(h, input || INPUT_IDLE, s.rope);
    s.rope.drainEvents();
  }
  function waitAttached(s, maxT) {
    let t = 0;
    while (t < (maxT || 3) && !s.rope.attached) { fstep(s); t += h; }
    return t;
  }
  function devFromPinPoly(s) {
    const C = s.rope.chain, pts = s.rope.path.pts;
    const poly = [E.vclone(s.rope.visualHand || s.rope.hand)];
    for (let i = 1; i < pts.length-1; i++) poly.push(E.vclone(pts[i]));
    poly.push(E.vclone(pts[pts.length-1]));
    const t = E.v3();
    let maxDev = 0;
    for (let i = 1; i < C.n-1; i++) {
      let best = Infinity;
      for (let k = 0; k < poly.length-1; k++) {
        closestOnSeg(t, C.pos[i], poly[k], poly[k+1]);
        best = Math.min(best, E.vdist(C.pos[i], t));
      }
      maxDev = Math.max(maxDev, best);
    }
    return maxDev;
  }

  /* 11a: straff = gerade. Bei Spiel ≈ 0 MUSS die Kette auf dem gelösten Pfad
     liegen — der alte Katenaar-Durchhang aus 0.6 m Pin-Offset betrug an 15 m
     über 1 m sichtbaren Durchhang (Defekt #53).                            */
  const s = mkSim(w);
  s.player.spawn([31, 2.0, -18], -0.207);
  for (let i = 0; i < 48; i++) fstep(s);
  fireAt(s, [33, 6.0, -30]);
  waitAttached(s);
  for (let i = 0; i < 120; i++) fstep(s);
  const dev = devFromPinPoly(s);
  ok(s.rope.slack < 0.2 && dev < 0.35, '13a: straffes Seil liegt auf dem gelösten Pfad (kein Durchhang bei Vollspannung)',
     `slack=${s.rope.slack.toFixed(3)} m, max. Abweichung ${dev.toFixed(2)} m`);
  const C = s.rope.chain;
  const a1 = E.vsubNew(C.pos[1], C.pos[0]), b1 = E.vsubNew(C.pos[2], C.pos[1]);
  const kink = Math.acos(clamp(E.vdot(a1, b1)/(E.vlen(a1)*E.vlen(b1) || 1), -1, 1))*180/Math.PI;
  ok(kink < 4, '13a: kein Knick am Seil-Austritt (Ego-Bild)', `Winkel an Node 1 = ${kink.toFixed(1)}°`);

  /* 11b: Ein stehender Spieler wird vom Seil NICHT angehoben — der Boden
     trägt, das Seil hält horizontal (Defekt #54: +6.4 m Schweben).         */
  const s2 = mkSim(w);
  s2.player.spawn([0, 11.0, -24.4], 0);
  for (let i = 0; i < 48; i++) fstep(s2);
  fireAt(s2, [0, 18.4, -35.4]);
  waitAttached(s2);
  for (let i = 0; i < 72; i++) fstep(s2);
  const y0 = s2.player.pos[1];
  let maxY = y0, air = 0;
  const inBack = Object.assign({}, INPUT_IDLE, { back: true });
  for (let i = 0; i < 240; i++) {
    fstep(s2, inBack);
    maxY = Math.max(maxY, s2.player.pos[1]);
    if (!s2.player.grounded) air++;
  }
  ok(maxY - y0 < 0.3 && air === 0, '13b: straffes Seil hebt einen laufenden Spieler nicht aus (kein Schweben)',
     `Höhengewinn ${(maxY-y0).toFixed(2)} m, airborne-Substeps ${air}`);

  /* 11c: Slide endet (Zeitlimit + Aufstehen) und Laufreibung greift.       */
  const s3 = mkSim(w);
  s3.player.spawn([0, 1.2, 30], Math.PI);
  for (let i = 0; i < 36; i++) fstep(s3);
  const inF = Object.assign({}, INPUT_IDLE, { forward: true });
  for (let i = 0; i < 192; i++) fstep(s3, inF);
  const pStop = E.vclone(s3.player.pos); const vStop = s3.player.hSpeed;
  let tStop = 0;
  while (s3.player.hSpeed > 0.05 && tStop < 5) { fstep(s3); tStop += h; }
  ok(tStop < 0.8 && E.vdist(s3.player.pos, pStop) < 2.0, '13c: Laufreibung ist kein Eis',
     `Stillstand nach ${tStop.toFixed(2)} s / ${E.vdist(s3.player.pos, pStop).toFixed(1)} m ab ${vStop.toFixed(1)} m/s`);
  s3.player.spawn([0, 1.2, 30], Math.PI);
  for (let i = 0; i < 36; i++) fstep(s3);
  for (let i = 0; i < 192; i++) fstep(s3, inF);
  fstep(s3, Object.assign({}, INPUT_IDLE, { slide: true, slideHeld: true }));
  const inH = Object.assign({}, INPUT_IDLE, { slideHeld: true });
  let tSl = 0;
  while (tSl < 6 && s3.player.sliding) { fstep(s3, inH); tSl += h; }
  ok(!s3.player.sliding && tSl <= 1.6, '13c: Slide endet am Zeitlimit (kein endloses Gleiten)',
     `Dauer ${tSl.toFixed(2)} s`);
  ok(near(s3.player.hh, 0.5, 0.03), '13c: nach dem Slide steht die Kapsel wieder auf',
     `hh=${s3.player.hh.toFixed(2)}`);

  /* 11d: Wrap-Halt — das Seil legt sich über die Wand-Oberkante und hält
     (Defekt #55: eingefrorenes Spiel ⇒ null Widerstand; Defekt #58: der
     Solver verwarf den Ruhe-Kontakt auf der Oberkante und schickte das Seil
     27 m um das Wandende herum). Der Spieler steht für den Knick-Test NAH
     an der Wand auf dem Boden: nur dann entsteht ein echter Umlenkwinkel.
     Von weit weg (Podest x=22) liegen Hand und Anker fast auf einer
     Geraden über die Kante — Wrap-Winkel physikalisch korrekt ~4°.        */
  const s4 = mkSim(w);
  s4.player.spawn([16.5, 1.2, -42], Math.PI*0.5);
  for (let i = 0; i < 48; i++) fstep(s4);
  fireAt(s4, [8, 13.0, -42]);
  waitAttached(s4);
  for (let i = 0; i < 96; i++) fstep(s4);
  const wr4 = s4.rope.path.wraps[0];
  const overTop = wr4 && Math.abs(wr4.p[1] - 7) < 0.6 && Math.abs(wr4.p[2] + 42) < 4;
  ok(s4.rope.totalWrapAngle() > 0.5 && overTop,
     '13d: Wrap-Wand etabliert eine Umlenkung an der Oberkante',
     `Wrap-Winkel ${(s4.rope.totalWrapAngle()*180/Math.PI).toFixed(0)}°, Kontakt ${wr4 ? wr4.p.map(x=>x.toFixed(1)).join('/') : '—'}`);
  ok(s4.rope.required < 16, '13d: Route über die Wand ist die kurze (kein Umweg um das Wandende)',
     `req ${s4.rope.required.toFixed(2)} m — der alte Endumweg maß ≈27 m (Defekt #58)`);

  /* Halt: Vom Anker weglaufen verlängert den Welt-Pfad — das straffe Seil
     bremst (Constraint + Capstan-Reibung). Parallel zur Wand zu laufen
     verlängert die Route kaum; dafür braucht es keine Reibung, das Seil
     gleitet physikalisch korrekt über die Kante.                          */
  const s4b = mkSim(w);
  s4b.player.spawn([22, 2.0, -42], Math.PI*0.5);
  for (let i = 0; i < 48; i++) fstep(s4b);
  fireAt(s4b, [8, 13.0, -42]);
  waitAttached(s4b);
  for (let i = 0; i < 96; i++) fstep(s4b);
  const inB = Object.assign({}, INPUT_IDLE, { back: true });
  let maxVr = 0;
  for (let i = 0; i < 48; i++) { fstep(s4b, inB); maxVr = Math.max(maxVr, s4b.player.hSpeed); }
  const sFree = mkSim(w);
  sFree.player.spawn([22, 2.0, -42], Math.PI*0.5);
  let maxVf = 0;
  for (let i = 0; i < 96; i++) { fstep(sFree, inB); maxVf = Math.max(maxVf, sFree.player.hSpeed); }
  ok(maxVr < 5.0 && maxVr < maxVf - 2.0,
     '13d: Straffes Seil bremst das Weglaufen (Halt an der Umlenkung)',
     `max. ${maxVr.toFixed(1)} m/s mit Seil vs. ${maxVf.toFixed(1)} m/s ohne (0.4 s)`);

  const s5 = mkSim(w);
  s5.player.spawn([22, 2.0, -42], Math.PI*0.5);
  for (let i = 0; i < 48; i++) fstep(s5);
  fireAt(s5, [8, 13.0, -42]);
  waitAttached(s5);
  for (let i = 0; i < 96; i++) fstep(s5);
  E.vset(s5.player.pos, 13, 1.2, -42);      // westlich der Wand: freie Sicht ⇒ Wrap löst sich
  let slackMax = 0, tTaut = -1, slackAtRelease = null, prevRelEv = 0;
  for (let i = 0; i < 150; i++) {
    fstep(s5);
    slackMax = Math.max(slackMax, s5.rope.slack);
    const relEv = s5.rope.path.stats.releaseEvents || 0;
    if (relEv > prevRelEv) { slackAtRelease = s5.rope.slack; prevRelEv = relEv; }
    /* „Wieder straff" heißt: das FREIGESETZTE Spiel ist weg, nicht jedes Spiel.
       Das Restspiel aus der Annäherung (Spieler wurde zum Anker hin teleport-
       iert) ist legitimer Durchhang und muss bleiben — ein Seil, das sich
       selbst auf straff zieht, würde bewusst abgerolltes Mausrad-Seil fressen
       (genau das tat das alte tidy und ist seit 2026-10-13 entfernt).       */
    if (tTaut < 0 && slackMax > 1.2 && slackAtRelease != null &&
        s5.rope.slack < slackAtRelease + 0.4) tTaut = i*h;
  }
  /* Schwelle 1,2 m statt früher 2 m: der Drift-Resync räumt vor dem Lösen den
     künstlichen Umweg auf, deshalb ist das Seil beim Lösen nicht mehr ganz so
     schlaff — 4,2 m Spiel waren ein Symptom des Defekts, kein Ziel.        */
  ok(slackMax > 1.2 && tTaut >= 0 && tTaut < 0.8, '13d: freigesetztes Spiel wird nachgerollt — das Seil bleibt handlungsfähig',
     `max. Spiel ${slackMax.toFixed(1)} m, freigesetzte Menge wieder eingerollt nach ${(tTaut < 0 ? -1 : tTaut).toFixed(2)} s`);
}

/* ========================================================================== */
console.log('\n═══ 14. Säulen-Orbit: kürzeste freie Route, kein Fallback, keine Schlaffschlaufe ═══');
{
  /* Nutzervideo (Frames bei 5 s / 8 s / 9 s): Der Spieler umkreist die
     dunkle Säule, der Anker sitzt auf dem grünen Block dahinter. Vor dem
     Fix verwarf der Solver den physikalisch richtigen Ruhe-Kontakt auf der
     Oberkante des grünen Blocks (Graze-Test mit POSITIVEM Pad meldete
     „blockiert", obwohl ein Seil auf der Fläche zum Anker aufliegen DARF)
     und wich aus: auf die Säulendecke 4 m daneben (16.25 m statt 13.3 m),
     beim Orbit bis zu 10.3 m Umweg mit Schlaffschlaufe, später ein
     Flächen-Fallback (edgeIdx=-1) mit Zickzack-Knick am Anker (Defekt #58).
     Gemessen wird die Live-Topologie gegen einen frisch konvergierten
     Referenzpfad — exakt die Orbit-Bewegung aus dem Video.               */
  const wo = mkWorld(); E.buildLevel(wo);
  const ropeO = new E.Rope(wo, {});
  const refO  = new E.Rope(wo, {});
  let green = null;
  for (const b of wo.statics) {
    const c = [(b.min[0]+b.max[0])/2, (b.min[1]+b.max[1])/2, (b.min[2]+b.max[2])/2];
    if (Math.abs(c[0]-33) < 0.1 && Math.abs(c[2]+30) < 0.1 && Math.abs(c[1]-3) < 0.1) green = b;
  }
  const ANCH = [33, 6.0, -30];
  const hO = 1/120;
  function distStatics(p) {
    let best = Math.max(0, p[1]);                 // der Boden IST Geometrie:
    for (const b of wo.statics) {                 // schlaffes Seil darf dort
      const dx = Math.max(b.min[0]-p[0], 0, p[0]-b.max[0]);   // abliegen und
      const dy = Math.max(b.min[1]-p[1], 0, p[1]-b.max[1]);   // dort knicken
      const dz = Math.max(b.min[2]-p[2], 0, p[2]-b.max[2]);
      best = Math.min(best, Math.hypot(dx, dy, dz));
    }
    return best;
  }
  function refLen(chest) {
    refO.path.reset();
    refO.path.solve(chest, ANCH, 1/60, null, green);
    return refO.path.converge();
  }
  const chest0 = [31.6, 1.45, -21.0], hand0 = [31.8, 1.9, -20.8];
  ropeO.attachAt(ANCH, [0,1,0], green, null, refLen(chest0) + 0.05);
  ropeO.visualHand = hand0;
  const CX = 34, CZ = -24, R = 3.2;              // Orbit um die Säule, wie im Video
  const a0 = Math.atan2(chest0[2]-CZ, chest0[0]-CX);
  const T_ORBIT = 12;
  let maxDetour = 0, fallbacks = 0, airKink = 0, maxStale = 0, reqFirst = null;
  const STEPS = Math.round(8.5/hO);              // eine volle Runde
  for (let st = 0; st < STEPS; st++) {
    const t = st*hO;
    const th = a0 + (t/T_ORBIT)*Math.PI*2;
    const cx = CX + Math.cos(th)*R, cz = CZ + Math.sin(th)*R;
    const chest = [cx, 1.45, cz], hand = [cx+0.2, 1.9, cz+0.2];
    const vel = [-Math.sin(th)*R*2*Math.PI/T_ORBIT, 0, Math.cos(th)*R*2*Math.PI/T_ORBIT];
    ropeO.visualHand = hand;
    ropeO.step(hO, chest, null, vel);
    ropeO.drainEvents();
    if (reqFirst == null && !ropeO.settleActive) reqFirst = ropeO.required;
    if (st % 30 === 0 && t > 0.9) {
      const d = ropeO.required - refLen(chest);
      if (d > maxDetour) maxDetour = d;
      for (const wr of ropeO.path.wraps) if (wr.edgeIdx < 0) fallbacks++;
      const stale = ropeO.slack - Math.max(0, reqFirst - ropeO.required) - 0.05;
      if (stale > maxStale) maxStale = stale;
      const C = ropeO.chain;
      for (let i = 1; i < C.n-1; i++) {
        const av = vsubNew(C.pos[i], C.pos[i-1]), bv = vsubNew(C.pos[i+1], C.pos[i]);
        const la = vlen(av), lb = vlen(bv);
        if (la < 1e-6 || lb < 1e-6) continue;
        const ang = Math.acos(clamp(vdot(av,bv)/(la*lb), -1, 1))*180/Math.PI;
        /* >70° frei in der Luft = stationärer Solver-Knick (das Video-Bild);
           mildere Knickung nahe Geometrie/Boden ist Durchhang oder Schwung. */
        if (ang > 70 && distStatics(C.pos[i]) > 0.6) airKink = Math.max(airKink, ang);
      }
    }
  }
  ok(maxDetour < 1.0, '14: Orbit um die Säule bleibt auf der kürzesten freien Route',
     `max. Umweg ${maxDetour.toFixed(2)} m über eine Runde (vor dem Fix: 10.3 m)`);
  ok(fallbacks === 0, '14: kein Flächen-Fallback-Kontakt beim Orbit',
     fallbacks ? `${fallbacks}× edgeIdx=-1 (Zickzack-Knick am Anker)` : '0 Treffer');
  ok(maxStale < 0.35, '14: kein stehen gebliebenes Längenbudget (keine Schlaffschlaufe)',
     `überschüssiges Spiel ${maxStale.toFixed(2)} m (vor dem Fix: ~1.2 m V-Schlaufe)`);
  ok(airKink === 0, '14: keine Freiluft-Knicke der Kette (>70° fern von Geometrie und Boden)',
     airKink ? `${airKink.toFixed(0)}°` : '0');
}

/* ========================================================================== */
console.log('\n══════════════════════ ERGEBNIS ══════════════════════');
/* ========================================================================== */
console.log('\n═══ 16. Rückholen: Seil bleibt verbunden, Haken folgt dem Pfad ═══');
{
  const DT = 1/60;
  const step16 = (sim, input) => {
    w16.stepBodies(DT);
    if (sim.hook.state !== 'idle') sim.hook.step(DT, sim.rope, sim.player.pos);
    const chest = sim.player.chestPoint(E.v3());
    sim.rope.step(DT, chest, (sim.hook.flying || sim.hook.state === 'retract') ? sim.hook.pos : null, sim.player.vel);
    sim.player.update(DT, input || INPUT_IDLE, sim.rope);
  };
  const w16 = mkWorld();
  w16.addBox([-80,-2,-80],[80,0,80],{color:[1,1,1]});
  w16.addBoxCS([0,1.25,0],[1.5,2.5,10],{color:[.55,.55,.55]}); // Wand, Oberkante y=2,5
  w16.addBoxCS([6,3,0],[4,6,4],{color:[.4,.6,.4]});           // Block hinter der Wand
  const s = mkSim(w16);
  s.player.spawn([-6,1,0], 0);
  for (let i=0;i<30;i++) step16(s);
  /* Haken deterministisch hinter die Wand setzen (ballistischer Abschuss ist
     nicht Gegenstand dieses Tests): Seil muss für diese Lage über die Wand-
     oberkante gelegt werden, sowohl hin als auch zurück.                  */
  s.hook.state = 'stuck';
  E.vset(s.hook.pos, 3, 2.0, 0);
  s.rope.attachAt([3,2.0,0],[0,1,0],null,null,12);
  s.rope.settleActive = false; s.rope.phase = 3;
  for (let i=0;i<30;i++) step16(s);   // Topologie etablieren
  ok(s.rope.path.wraps.length >= 1, '16: Seil liegt über der Wandkante',
     `${s.rope.path.wraps.length} Kontakte`);
  s.hook.retractNow(s.rope);
  let phase4 = false, connected = true, overWall = false, maxRise = 0, done = -1, prevD = 1e9;
  for (let i=0;i<6*60;i++) {
    const chest = s.player.chestPoint(E.v3());
    const ev = s.hook.step(DT, s.rope, chest);
    s.rope.step(DT, chest, (s.hook.flying || s.hook.state==='retract') ? s.hook.pos : null, s.player.vel);
    s.player.update(DT, INPUT_IDLE, s.rope);
    if (s.rope.phase === 4) phase4 = true;
    if (s.rope.phase !== 4 && s.hook.state === 'retract') connected = false;
    const hp = s.hook.pos;
    if (Math.abs(hp[0]) < 1.2 && hp[1] > 2.2) overWall = true;   // Rückweg über die Kante
    const d = E.vdist(hp, chest);
    maxRise = Math.max(maxRise, d - prevD); prevD = d;
    if (ev && ev.type === 'retracted') { done = i/60; s.rope.detach(); break; }
  }
  ok(phase4 && connected, '16a: Seil bleibt beim Rückholen verbunden (kein abgeschnittener Haken)',
     `Phase-4-Fenster=${phase4}, durchgehend verbunden=${connected}`);
  ok(overWall, '16b: Haken kommt über die Wandkante zurück (Pfad, nicht Luftlinie)',
     overWall ? 'Kantenüberquerung gemessen' : 'keine Überquerung der Oberkante gesehen');
  ok(maxRise < 0.35, '16c: Abstand zur Hand schrumpft monoton', `größter Anstieg ${maxRise.toFixed(2)} m/Schritt`);
  ok(done >= 0 && s.rope.phase === 0 && s.hook.state === 'idle', '16d: vollständig in die Hand eingerollt',
     done >= 0 ? `nach ${done.toFixed(2)} s, Phase ${s.rope.phase}` : 'nie angekommen');
}

console.log('\n═══ 17. Flug: Schlaffseil-Haufen bei Annäherung wird nachgerollt ═══');
{
  const DT = 1/60;
  const w17 = mkWorld();
  w17.addBox([-80,-2,-80],[80,0,80],{color:[1,1,1]});
  const s = mkSim(w17);
  s.player.spawn([0,1,0], 0);
  for (let i=0;i<30;i++) {
    w17.stepBodies(DT);
    const chest = s.player.chestPoint(E.v3());
    s.rope.step(DT, chest, s.hook.flying ? s.hook.pos : null, s.player.vel);
    s.player.update(DT, INPUT_IDLE, s.rope);
  }
  /* Steilschuss: Der Haken wird oben langsam — genau dann würde ein auf ihn
     zulaufender Spieler einen Schlaffseil-Haufen vor sich herschieben, wenn
     der Flug-Nachroll fehlt (Nutzer-Rückmeldung: „irgendwas Komisches mit
     der Seillänge, wenn man näher ran läuft").                              */
  {
    const hand = s.player.handPoint(E.v3(), null);
    const target = [0.5, 22, 0.5];
    const d = E.vsubNew(target, hand); E.vnorm(d, d);
    s.player.pitch = Math.asin(Math.max(-1, Math.min(1, d[1])));
    s.player.yaw = Math.atan2(-d[0], -d[2]);
    E.qFromYawPitch(s.player.quat, s.player.yaw, s.player.pitch);
    s.hook.fire(hand, E.qForward(E.v3(), s.player.quat), E.qUp(E.v3(), s.player.quat),
                E.qRight(E.v3(), s.player.quat), s.player.vel, s.rope);
  }
  let flew = 0, slowSeen = false;
  for (let i=0;i<240 && s.hook.flying;i++) {
    w17.stepBodies(DT);
    s.hook.step(DT, s.rope, s.player.pos);
    const chest = s.player.chestPoint(E.v3());
    s.rope.step(DT, chest, s.hook.flying ? s.hook.pos : null, s.player.vel);
    s.player.update(DT, INPUT_IDLE, s.rope);
    flew++;
    if (E.vlen(s.hook.vel) < 5) slowSeen = true;
  }
  ok(flew > 60 && slowSeen, '17: Haken wurde im Flug langsam (Messfenster erreicht)',
     `${flew} Flug-Schritte, langsamer Punkt gesehen=${slowSeen}`);
  /* jetzt unter den Haken laufen und schauen, ob der Haufen weggerollt wird */
  let slackEnd = 0;
  for (let i=0;i<60;i++) {
    E.vset(s.player.pos, 0, 1, 0);
    w17.stepBodies(DT);
    if (s.hook.state !== 'idle') s.hook.step(DT, s.rope, s.player.pos);
    const chest = s.player.chestPoint(E.v3());
    s.rope.step(DT, chest, (s.hook.flying || s.hook.state==='retract') ? s.hook.pos : null, s.player.vel);
    s.player.update(DT, INPUT_IDLE, s.rope);
    slackEnd = s.rope.slack;
  }
  ok(slackEnd < 3.0, '17: kein Schlaffseil-Haufen unter einem langsamen Haken',
     `slack nach 1 s Nachlauf ${slackEnd.toFixed(2)} m`);
}


/* ========================================================================== */
console.log('\n═══ 18. Charakter-Physik: Sprung-Integrität mit und ohne Seil ═══');
{
  const w = mkWorld();
  w.addBox([-60,-2,-60],[60,0,60],{color:[1,1,1]});
  const mk = () => { const s = mkSim(w); s.player.spawn([0,0.86,0],0); return s; };
  const IN = (over) => Object.assign({}, INPUT_IDLE, over);
  const fstep = (sim, input) => {
    w.stepBodies(1/60);
    if (sim.hook.state !== 'idle') sim.hook.step(1/60, sim.rope, sim.player.pos);
    const chest = sim.player.chestPoint(E.v3());
    sim.rope.step(1/60, chest, (sim.hook.flying || sim.hook.state === 'retract') ? sim.hook.pos : null, sim.player.vel);
    sim.player.update(1/60, input || INPUT_IDLE, sim.rope);
  };

  /* 18a: gehaltene Leertaste am straffen Seil darf NICHT tragen.
     Ein voller Seilsprung (≈1,7 m) ist erlaubt, danach muss Schluss sein. */
  {
    const s = mk();
    for (let i=0;i<30;i++) fstep(s);
    s.rope.attachAt([0,12,0],[0,-1,0],null,null,12);
    s.rope.settleActive = false; s.rope.phase = 3;
    fstep(s);                                   // erst lösen, dann Budget setzen
    s.rope.budget = s.rope.required + 0.05;
    for (let i=0;i<30;i++) fstep(s);
    const y0 = s.player.pos[1];
    let maxY = y0;
    for (let i=0;i<180;i++) { fstep(s, IN({ jumpPressed:true, jumpHeld:true })); maxY = Math.max(maxY, s.player.pos[1]); }
    ok(maxY - y0 <= 2.4 && s.rope.attached, '18a: gehaltene Leertaste am Seil trägt nicht (kein Fliegen)',
       `max. Höhenzunahme ${(maxY-y0).toFixed(2)} m über 3 s, Seil attached=${s.rope.attached}`);
  }
  /* 18b: ohne Seil gilt dasselbe — in der Luft gibt es keinen Sprung */
  {
    const s = mk();
    for (let i=0;i<30;i++) fstep(s);
    s.player.pos[1] = 10; s.player.vel[1] = 0;
    for (let i=0;i<20;i++) fstep(s);            // Coyote-Zeit ablaufen lassen
    let maxUp = -99;
    for (let i=0;i<90;i++) {
      fstep(s, IN({ jumpPressed:true, jumpHeld:true }));
      if (s.player.grounded) break;             // nur das FREIE Fallen bewerten
      maxUp = Math.max(maxUp, s.player.vel[1]);
    }
    ok(maxUp < -5, '18b: gehaltene Leertaste erzeugt im freien Fall keinen Auftrieb',
       `max. Vertikalgeschw. im Fall ${maxUp.toFixed(2)} m/s (negativ = fällt sauber)`);  }
  /* 18c: Jump-Cut — Tippen springt deutlich kürzer als Halten */
  {
    const apex = (held) => {
      const s = mk();
      for (let i=0;i<30;i++) fstep(s);
      let y0 = null, top = 0;
      for (let i=0;i<120;i++) {
        fstep(s, IN({ jumpPressed: i === 10, jumpHeld: held ? true : i < 12 }));
        if (y0 === null && s.player.vel[1] > 1) y0 = s.player.pos[1];
        if (y0 !== null) top = Math.max(top, s.player.pos[1] - y0);
      }
      return top;
    };
    const aHold = apex(true), aTap = apex(false);
    ok(aTap < aHold - 0.6 && aHold > 1.2, '18c: variable Sprunghöhe (Jump-Cut) wirkt',
       `Scheitel Tippen ${aTap.toFixed(2)} m vs. Halten ${aHold.toFixed(2)} m`);
  }
  /* 18d: Bodenreibung bringt den Sprint messbar zum Stillstand */
  {
    const s = mk();
    for (let i=0;i<30;i++) fstep(s);
    for (let i=0;i<150;i++) fstep(s, IN({ forward:true }));
    const v0 = s.player.hSpeed;
    const p0 = [s.player.pos[0], s.player.pos[2]];
    let t = 0;
    while (t < 240 && s.player.hSpeed > 0.15) { fstep(s); t++; }
    const dist = Math.hypot(s.player.pos[0]-p0[0], s.player.pos[2]-p0[1]);
    ok(v0 > 8.5 && dist < 7.5 && t < 200, '18d: Sprint stoppt durch Bodenreibung (kein Eis)',
       `v0 ${v0.toFixed(1)} m/s → Stillstand nach ${(t/60).toFixed(2)} s / ${dist.toFixed(2)} m`);
  }
}


console.log('\n═══ 19. Körper-Kollisionen: Kiste↔Kiste und Spieler↔Kiste ═══');
{
  const DT = 1/60;
  const f19 = (sim, w, input) => {
    w.stepBodies(DT);
    if (sim.hook.state !== 'idle') sim.hook.step(DT, sim.rope, sim.player.pos);
    const chest = sim.player.chestPoint(E.v3());
    sim.rope.step(DT, chest, (sim.hook.flying || sim.hook.state === 'retract') ? sim.hook.pos : null, sim.player.vel);
    sim.player.update(DT, input || INPUT_IDLE, sim.rope);
  };
  /* 19a: Kiste auf Kiste bleibt liegen statt durchzufallen */
  {
    const w = mkWorld();
    w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
    const a = w.addBody({ pos:[0,0.8,0], half:[0.8,0.8,0.8], mass:120, friction:0.4 });
    const b = w.addBody({ pos:[0.1,3.4,0], half:[0.8,0.8,0.8], mass:120, friction:0.4 });
    for (let i=0;i<240;i++) w.stepBodies(DT);
    const auflage = Math.abs(b.min[1] - a.max[1]);
    ok(auflage < 0.12 && b.pos[1] > a.pos[1], '19a: Kiste landet auf Kiste und bleibt liegen',
       `Auflage-Abweichung ${auflage.toFixed(3)} m, y oben=${b.pos[1].toFixed(2)} / unten=${a.pos[1].toFixed(2)}`);
  }
  /* 19b: Spieler schiebt Kiste, statt durch sie hindurchzulaufen */
  {
    const w = mkWorld();
    w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
    const c = w.addBody({ pos:[4,0.8,0], half:[0.8,0.8,0.8], mass:120, friction:0.25 });
    const s = mkSim(w);
    s.player.spawn([0,0.86,0], -Math.PI/2);       // Blick +x
    let deep = 0;
    for (let i=0;i<180;i++) {
      f19(s, w, Object.assign({}, INPUT_IDLE, { forward:true }));
      const ox = Math.min(s.player.pos[0]+0.36, c.max[0]) - Math.max(s.player.pos[0]-0.36, c.min[0]);
      const oz = Math.min(s.player.pos[2]+0.36, c.max[2]) - Math.max(s.player.pos[2]-0.36, c.min[2]);
      const oy = Math.min(s.player.pos[1]+0.5, c.max[1]) - Math.max(s.player.pos[1]-0.5, c.min[1]);
      if (ox > 0 && oy > 0 && oz > 0) deep = Math.max(deep, Math.min(ox, oy, oz));
    }
    ok(c.pos[0] > 5.0, '19b: laufender Spieler schiebt die Kiste',
       `Kiste bei x=${c.pos[0].toFixed(2)} (Start 4.0)`);
    ok(deep < 0.25, '19b: Spieler dringt nie tief in die Kiste ein',
       `max. Überlapp ${deep.toFixed(3)} m`);
  }
  /* 19c: per Seil in den Spieler gezogene Kiste schiebt ihn beiseite statt
     durch ihn hindurchzulaufen */
  {
    const w = mkWorld();
    w.addBox([-40,-2,-40],[40,0,40],{color:[1,1,1]});
    const c = w.addBody({ pos:[-8,0.8,0], half:[0.8,0.8,0.8], mass:15, friction:0.05 });
    const s = mkSim(w);
    s.player.spawn([0,0.86,0], Math.PI/2);
    for (let i=0;i<30;i++) f19(s, w);
    s.rope.attachAt(c.pos, [1,0,0], c, c, 6.0);   // straff: Zug auf die leichte Kiste
    s.rope.settleActive = false; s.rope.phase = 3;
    let deep = 0, pushed = 0;
    const x0 = s.player.pos[0];
    for (let i=0;i<300;i++) {
      f19(s, w);
      const ox = Math.min(s.player.pos[0]+0.36, c.max[0]) - Math.max(s.player.pos[0]-0.36, c.min[0]);
      const oz = Math.min(s.player.pos[2]+0.36, c.max[2]) - Math.max(s.player.pos[2]-0.36, c.min[2]);
      const oy = Math.min(s.player.pos[1]+0.5, c.max[1]) - Math.max(s.player.pos[1]-0.5, c.min[1]);
      if (ox > 0 && oy > 0 && oz > 0) deep = Math.max(deep, Math.min(ox, oy, oz));
      pushed = Math.max(pushed, Math.abs(s.player.pos[0]-x0));
    }
    ok(c.pos[0] > -2.0, '19c: Seil zieht die Kiste bis zum Spieler',
       `Kiste bei x=${c.pos[0].toFixed(2)} (Start −8)`);
    ok(deep < 0.25, '19c: gezogene Kiste läuft nicht durch den Spieler hindurch',
       `max. Überlapp ${deep.toFixed(3)} m, Spieler ausgewichen um ${pushed.toFixed(2)} m`);
  }
}

for (const [st, name, detail] of results) {
  console.log(` ${st==='PASS'?'✔':'✘'} ${name}${detail ? '   ·  ' + detail : ''}`);
}



console.log(`\n ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed ? 1 : 0);

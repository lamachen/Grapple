const fs=require('fs'),path=require('path'),vm=require('vm');
const SRC=path.join(__dirname,'..','src');
let code=['00_math.js','01_world.js','02_rope.js','03_player.js','05_fx.js','06_level.js'].map(f=>fs.readFileSync(path.join(SRC,f),'utf8')).join('\n');
code+='\n;this.EXP={World,Rope,Player,Hook,buildLevel,v3,vset,vcopy,vlen,vdist};';
const sb={console,Math,Date,performance:{now:()=>Number(process.hrtime.bigint())/1e6},Float32Array,Uint16Array,window:{}};
sb.globalThis=sb;vm.createContext(sb);vm.runInContext(code,sb);
const E=sb.EXP, T=()=>Number(process.hrtime.bigint())/1e6;

function bench(label, boxes, fn, iters){
  fn(); // warmup
  const t0=T(); for(let i=0;i<iters;i++) fn(); const dt=T()-t0;
  console.log(`${label.padEnd(46)} ${(dt/iters*1000).toFixed(1).padStart(7)} µs/Aufruf`);
  return dt/iters;
}

// --- A: kompletter Physik-Substep im Referenzlevel, OHNE Seil
{
  const w=new E.World(); w.gravity=-26; E.buildLevel(w);
  const rope=new E.Rope(w,{}); const pl=new E.Player(w,{});
  pl.spawn([0,1,12],0);
  const IN={forward:true,back:0,left:0,right:0,slide:0,slideHeld:0,jumpPressed:0,firePressed:0,releasePressed:0};
  bench('A  Substep: Körper+Spieler (49 Boxen, kein Seil)',0,()=>{
    w.stepBodies(1/120); const c=pl.chestPoint(E.v3()); rope.step(1/120,c,null,pl.vel); pl.update(1/120,IN,rope);
  },4000);
  console.log(`     → ${w.statics.length} statische Boxen, ${w.bodies.length} dynamische Körper`);
}
// --- B: Seil straff, gerade (kein Wrap)
{
  const w=new E.World(); w.gravity=-26; E.buildLevel(w);
  const rope=new E.Rope(w,{}); const pl=new E.Player(w,{});
  pl.spawn([0,11,-18],0);
  rope.attachAt([0,23.2,-28.5],[0,-1,0],null,null,14);
  rope.settleActive=false; rope.phase=3;
  const IN={forward:true,back:0,left:0,right:0,slide:0,slideHeld:0,jumpPressed:0,firePressed:0,releasePressed:0};
  let rc=0;
  bench('B  Substep: Seil straff, freie Sicht (0 Kontakte)',0,()=>{
    w.stats.raycasts=0;
    w.stepBodies(1/120); const c=pl.chestPoint(E.v3()); rope.step(1/120,c,null,pl.vel); pl.update(1/120,IN,rope);
    rc=w.stats.raycasts;
  },4000);
  console.log(`     → Raycasts pro Substep: ${rc}`);
}
// --- C: Seil mit 2 Umlenkkontakten (Wand) — der teure Fall
{
  const w=new E.World(); w.gravity=-26; E.buildLevel(w);
  const rope=new E.Rope(w,{}); const pl=new E.Player(w,{});
  pl.spawn([22,2,-42],Math.PI*0.5);
  rope.attachAt([8,13.17,-42],[0,1,0],null,null,20);
  rope.settleActive=false; rope.phase=3;
  const IN={forward:0,back:0,left:0,right:0,slide:0,slideHeld:0,jumpPressed:0,firePressed:0,releasePressed:0};
  let rc=0,wr=0;
  bench('C  Substep: Seil um Wand+Block (2 Kontakte)',0,()=>{
    w.stats.raycasts=0;
    pl.pos[2]-=0.004;
    w.stepBodies(1/120); const c=pl.chestPoint(E.v3()); rope.step(1/120,c,null,pl.vel); pl.update(1/120,IN,rope);
    rc=w.stats.raycasts; wr=rope.path.wraps.length;
  },4000);
  console.log(`     → Raycasts pro Substep: ${rc}, Kontakte: ${wr}`);
}
// --- D: nur der Pfad-Solver isoliert
{
  const w=new E.World(); w.gravity=-26; E.buildLevel(w);
  const rope=new E.Rope(w,{});
  const A=[22,2,-42],B=[8,13.17,-42];
  for(let i=0;i<40;i++) rope.path.solve(A,B,1/120,null,null);
  let et=0,st=0;
  bench('D  nur Pfad-Solver (2 Kontakte, eingeschwungen)',0,()=>{
    rope.path.stats.edgeTests=0; rope.path.stats.segTests=0;
    rope.path.solve(A,B,1/120,null,null); et=rope.path.stats.edgeTests; st=rope.path.stats.segTests;
  },6000);
  console.log(`     → Kanten-Tests: ${et}, Segment-Tests: ${st} pro Solve`);
}
// --- E: Visualisierungskette isoliert (physikalisches Verlet-Seil)
{
  const w=new E.World(); w.gravity=-26; E.buildLevel(w);
  const rope=new E.Rope(w,{});
  rope.attachAt([0,20,0],[0,-1,0],null,null,20); rope.settleActive=false; rope.phase=3;
  for(let i=0;i<60;i++) rope.step(1/120,[10,1,0],null,[0,0,0]);
  bench(`E  nur Seilkette (physikalisch, ${rope.chain.n} Nodes)`,0,()=>{ rope._stepChain(1/120,null,[3,0,4]); },6000);
  rope.p.chainSpacing=0.15;   // hohe Auflösung: mehr Nodes
  for(let i=0;i<60;i++) rope.step(1/120,[10,1,0],null,[0,0,0]);
  bench(`E2 dito, fein aufgelöst (${rope.chain.n} Nodes)`,0,()=>{ rope._stepChain(1/120,null,[3,0,4]); },6000);
}
// --- F: Würfel-Umrundung (Kontakt gleitet permanent, Weitergleiten an Ecken aktiv)
{
  const w=new E.World(); w.gravity=-26;
  w.addBoxCS([0,2,0],[4,4,4],{});
  const rope=new E.Rope(w,{});
  rope.attachAt([0,6,0],[0,-1,0],null,null,40); rope.settleActive=false; rope.phase=3;
  const chest=E.v3(); let deg=0, sl=0;
  for(let i=0;i<60;i++){ E.vset(chest,Math.sin(i*0.05)*5,1,Math.cos(i*0.05)*5); rope.step(1/120,chest,null,[0,0,0]); rope.budget=Math.max(rope.budget,rope.required+0.05); }
  bench('F  Umrundung: Kontakt gleitet + Weitergleiten an Ecken',0,()=>{
    deg+=0.7; const a=deg*Math.PI/180;
    E.vset(chest,Math.sin(a)*5,1,Math.cos(a)*5);
    rope.step(1/120,chest,null,[0,0,0]);
    rope.budget=Math.max(rope.budget,rope.required+0.05);
    sl=rope.path.stats.slides||0;
  },6000);
  console.log(`     → ${sl} Kanten-Fortsetzungen während des Benchmarks, Kontakte: ${rope.path.wraps.length}`);
}

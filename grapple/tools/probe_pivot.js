'use strict';
/* probe_pivot.js — A/B-Messung beider Solver-Modi auf den vier test_wrap-Orbits
   (blockiert %, größter Längensprung, größter Umweg, Freisetzungen, Sweeps).
     node tools/probe_pivot.js --mode=legacy
     node tools/probe_pivot.js --mode=pivot
   pivot ist WIP auf Branch feature/pivot-solver (Schalter wrapSolver). */
const fs=require('fs'),path=require('path'),vm=require('vm');
const SRC = require('path').join(__dirname, '..', 'src');
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || '--mode=legacy').split('=')[1];
const FILES=['00_math.js','01_world.js','02_rope.js','03_player.js','05_fx.js','06_level.js'];
let code=FILES.map(f=>fs.readFileSync(path.join(SRC,f),'utf8')).join('\n');
code+='\n;this.X={World,buildLevel,RopePathSolver,ROPE_DEFAULTS,vdist};';
const sb={console,Math,Date,JSON,performance:{now:()=>0},Float32Array,Uint16Array,Float64Array,Infinity,NaN,parseInt,parseFloat,isNaN,window:{},document:undefined};
sb.globalThis=sb; vm.createContext(sb); vm.runInContext(code,sb);
const X=sb.X;
const world=new X.World(); X.buildLevel(world);
const boxes=world.statics.filter(b=>b.ropeSolid!==false);
const ANCHOR=[33,4.5,-27.5];
const anchorBox=boxes.find(b=>ANCHOR.every((v,k)=>v>=b.min[k]-1e-3&&v<=b.max[k]+1e-3));
function segHit(a,b,box,sh){sh=(sh===undefined)?0.03:sh;let t0=0,t1=1;
 for(let k=0;k<3;k++){const mn=box.min[k]+sh,mx=box.max[k]-sh,d=b[k]-a[k];
  if(Math.abs(d)<1e-12){if(a[k]<=mn||a[k]>=mx)return false;}
  else{let ta=(mn-a[k])/d,tb=(mx-a[k])/d;if(ta>tb){const x=ta;ta=tb;tb=x;}t0=Math.max(t0,ta);t1=Math.min(t1,tb);if(t0>=t1)return false;}}
 return true;}
const polyBlocked=pts=>{for(let i=0;i<pts.length-1;i++)for(const b of boxes)if(segHit(pts[i],pts[i+1],b))return true;return false;};
const RUNS=[['enger Orbit',9.8,3.2,12],['enger Orbit schnell',20,3.2,12],['weiter Orbit',9.8,4.5,12],['weiter Orbit schnell',20,4.5,12]];
const hz=120,dt=1/hz;
const out=[];
for(const [name,V,R,T] of RUNS){
  const P=Object.assign({},X.ROPE_DEFAULTS,{wrapSolver:MODE});
  const S=new X.RopePathSolver(world,P);
  const CX=34,CZ=-24;
  const hand=t=>{const a=-t*V/R;return[CX+R*Math.sin(a),2.2+Math.sin(t)*1.5,CZ+R*Math.cos(a)];};
  let A=hand(0);
  S.solve(A,ANCHOR,dt,null,anchorBox); S.converge();
  let valid=0,blocked=0,maxJump=0,maxDetour=0,releases=0,relWithJump=0;
  const ref=new X.RopePathSolver(world,Object.assign({},X.ROPE_DEFAULTS));
  let prevLen=S.length, prevWraps=S.wraps.length;
  const N=Math.round(T*hz);
  for(let i=1;i<=N;i++){
    const t=i*dt; A=hand(t);
    S.solve(A,ANCHOR,dt,null,anchorBox);
    valid++;
    if(polyBlocked(S.pts))blocked++;
    const jump=Math.abs(S.length-prevLen);
    if(jump>maxJump)maxJump=jump;
    ref.wraps.length=0; ref.solve(A,ANCHOR,dt,null,anchorBox); ref.converge();
    maxDetour=Math.max(maxDetour,S.length-ref.length);
    if(S.wraps.length<prevWraps){releases++; if(jump>0.5)relWithJump++;}
    prevLen=S.length; prevWraps=S.wraps.length;
  }
  out.push({name,blockedPct:+(blocked/valid*100).toFixed(1),maxJump:+maxJump.toFixed(2),maxDetour:+maxDetour.toFixed(2),releases,relWithJump,pivotInserts:S.stats.pivotInserts||0,inserts:S.stats.inserts});
}
console.log(JSON.stringify({MODE,out},null,1));

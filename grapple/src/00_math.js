/* =============================================================================
   00_math.js — Minimal-Mathematik (Vec3 / Quat / Mat4) für den Grapple-Prototyp
   Keine externen Abhängigkeiten. Vektoren sind [x,y,z]-Arrays, Mat4 sind
   Float32Array(16) in COLUMN-MAJOR (WebGL-Konvention).
   ========================================================================== */
'use strict';

/* ---------------------------------- Utils --------------------------------- */
const clamp  = (v, a, b) => v < a ? a : (v > b ? b : v);
const clamp01= (v) => v < 0 ? 0 : (v > 1 ? 1 : v);
const lerp   = (a, b, t) => a + (b - a) * t;
const sign   = (v) => v < 0 ? -1 : 1;
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
/** Frame-rate-unabhängiges exponentielles Dämpfen ("critically damped feel"). */
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
/** Winkel-preservendes Interpolieren auf einen Zielwert mit max. Rate. */
function moveTowards(a, b, maxDelta) {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + sign(d) * maxDelta;
}
/** Kürzester Winkelunterschied (rad) im Bereich (-PI, PI]. */
function wrapAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* ----------------------------------- Vec3 ---------------------------------- */
const v3   = (x = 0, y = 0, z = 0) => [x, y, z];
const vset = (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; };
const vcopy= (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; };
const vclone = (a) => [a[0], a[1], a[2]];

const vadd = (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; };
const vsub = (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; };
const vmul = (o, a, b) => { o[0] = a[0] * b[0]; o[1] = a[1] * b[1]; o[2] = a[2] * b[2]; return o; };
const vscl = (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; };
/** out = a + b*s   (das Arbeitspferd jeder Physik-Schleife) */
const vmad = (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; };

const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (o, a, b) => {
  const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
  o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx;
  return o;
};
const vlenSq = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
const vlen   = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const vdistSq= (a, b) => { const x = a[0]-b[0], y = a[1]-b[1], z = a[2]-b[2]; return x*x+y*y+z*z; };
const vdist  = (a, b) => Math.sqrt(vdistSq(a, b));

/** Normalisiert in-place; gibt die Länge VOR der Normalisierung zurück (0 => unverändert). */
function vnorm(o, a) {
  const x = a[0], y = a[1], z = a[2];
  const l = Math.sqrt(x * x + y * y + z * z);
  if (l > 1e-9) { const il = 1 / l; o[0] = x * il; o[1] = y * il; o[2] = z * il; }
  else { o[0] = 0; o[1] = 0; o[2] = 0; }
  return l;
}
/** Normalisierte Kopie mit Fallback-Richtung, falls Eingabe ~0. */
function vnormSafe(a, fx = 0, fy = 1, fz = 0) {
  const l = vlen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [fx, fy, fz];
}
const vlerp = (o, a, b, t) => { o[0] = a[0] + (b[0]-a[0])*t; o[1] = a[1] + (b[1]-a[1])*t; o[2] = a[2] + (b[2]-a[2])*t; return o; };
const vneg  = (o, a) => { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; return o; };
const vnegNew = (a) => [-a[0], -a[1], -a[2]];
const vaddNew = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const vsubNew = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const vsclNew = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const vmadNew = (a, b, s) => [a[0]+b[0]*s, a[1]+b[1]*s, a[2]+b[2]*s];
/** Entfernt die Komponente entlang n (Einheitsvektor): Projektion auf die Ebene. */
const vslide = (o, v, n) => { const d = vdot(v, n); o[0] = v[0]-n[0]*d; o[1] = v[1]-n[1]*d; o[2] = v[2]-n[2]*d; return o; };
const vreflect = (o, v, n, rest = 1) => { const d = vdot(v, n); o[0] = v[0]-(1+rest)*n[0]*d; o[1] = v[1]-(1+rest)*n[1]*d; o[2] = v[2]-(1+rest)*n[2]*d; return o; };
/** Componentwise min/max — praktisch für AABBs. */
const vmin = (o, a, b) => { o[0]=Math.min(a[0],b[0]); o[1]=Math.min(a[1],b[1]); o[2]=Math.min(a[2],b[2]); return o; };
const vmax = (o, a, b) => { o[0]=Math.max(a[0],b[0]); o[1]=Math.max(a[1],b[1]); o[2]=Math.max(a[2],b[2]); return o; };

/* ---------------------------------- Quat ---------------------------------- */
/* Layout: [x, y, z, w] */
const qid = () => [0, 0, 0, 1];
function qset(o, x, y, z, w) { o[0]=x; o[1]=y; o[2]=z; o[3]=w; return o; }
function qcopy(o, a) { o[0]=a[0]; o[1]=a[1]; o[2]=a[2]; o[3]=a[3]; return o; }
function qmul(o, a, b) {
  const ax=a[0], ay=a[1], az=a[2], aw=a[3];
  const bx=b[0], by=b[1], bz=b[2], bw=b[3];
  o[0] = ax*bw + aw*bx + ay*bz - az*by;
  o[1] = ay*bw + aw*by + az*bx - ax*bz;
  o[2] = az*bw + aw*bz + ax*by - ay*bx;
  o[3] = aw*bw - ax*bx - ay*by - az*bz;
  return o;
}
function qnorm(o, a) {
  let l = Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]+a[3]*a[3]);
  if (l > 1e-9) { l = 1/l; o[0]=a[0]*l; o[1]=a[1]*l; o[2]=a[2]*l; o[3]=a[3]*l; }
  else { o[0]=0; o[1]=0; o[2]=0; o[3]=1; }
  return o;
}
/** Rotation um lokale Achse (x=pitch, y=yaw, z=roll), delta in Radiant. */
function qRotateLocal(o, q, ax, ay, az, angle) {
  const h = angle * 0.5, s = Math.sin(h);
  const dq = [ax*s, ay*s, az*s, Math.cos(h)];
  return qnorm(o, qmul(TMPQ_A, q, dq));
}
const TMPQ_A = [0,0,0,1], TMPQ_B = [0,0,0,1];
/** Vektor mit Quaternion rotieren. */
function qrot(o, q, v) {
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const vx=v[0], vy=v[1], vz=v[2];
  // t = 2 * cross(q.xyz, v)
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  o[0] = vx + w*tx + (y*tz - z*ty);
  o[1] = vy + w*ty + (z*tx - x*tz);
  o[2] = vz + w*tz + (x*ty - y*tx);
  return o;
}
/** Inverse Rotation (conjugate, da Einheitsquaternion). */
function qrotInv(o, q, v) {
  const x=-q[0], y=-q[1], z=-q[2], w=q[3];
  const vx=v[0], vy=v[1], vz=v[2];
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  o[0] = vx + w*tx + (y*tz - z*ty);
  o[1] = vy + w*ty + (z*tx - x*tz);
  o[2] = vz + w*tz + (x*ty - y*tx);
  return o;
}
/** Quaternion aus Yaw/Pitch (FPS-Kamera, YXZ-Reihenfolge). */
function qFromYawPitch(o, yaw, pitch) {
  const cy = Math.cos(yaw*0.5), sy = Math.sin(yaw*0.5);
  const cp = Math.cos(pitch*0.5), sp = Math.sin(pitch*0.5);
  // q = qy(yaw) * qx(pitch)   →  pitch > 0 = Blick nach oben
  o[0] = cy*sp;      // x
  o[1] = sy*cp;      // y
  o[2] = -sy*sp;     // z
  o[3] = cy*cp;      // w
  return o;
}
function qToMat4(o, q) {
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, yx=y*x2, yy=y*y2, zx=z*x2, zy=z*y2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  o[0]=1-yy-zz; o[1]=yx+wz;   o[2]=zx-wy;   o[3]=0;
  o[4]=yx-wz;   o[5]=1-xx-zz; o[6]=zy+wx;   o[7]=0;
  o[8]=zx+wy;   o[9]=zy-wx;   o[10]=1-xx-yy;o[11]=0;
  o[12]=0; o[13]=0; o[14]=0; o[15]=1;
  return o;
}

/* ---------------------------------- Mat4 ---------------------------------- */
const m4 = () => new Float32Array(16);
function m4id(o) {
  o[0]=1;o[1]=0;o[2]=0;o[3]=0; o[4]=0;o[5]=1;o[6]=0;o[7]=0;
  o[8]=0;o[9]=0;o[10]=1;o[11]=0; o[12]=0;o[13]=0;o[14]=0;o[15]=1;
  return o;
}
function m4mul(o, a, b) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  for (let i = 0; i < 4; i++) {
    const b0=b[i*4], b1=b[i*4+1], b2=b[i*4+2], b3=b[i*4+3];
    o[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
    o[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
    o[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
    o[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
  }
  return o;
}
function m4perspective(o, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  o[0]=f/aspect;o[1]=0;o[2]=0;o[3]=0;
  o[4]=0;o[5]=f;o[6]=0;o[7]=0;
  o[8]=0;o[9]=0;o[11]=-1;
  o[12]=0;o[13]=0;o[15]=0;
  const nf = 1/(near-far);
  o[10]=(far+near)*nf; o[14]=2*far*near*nf;
  return o;
}
/** View-Matrix direkt aus Position + Quaternion (vermeidet invert()). */
function m4viewFromQuat(o, pos, q) {
  // R^T | -R^T * pos
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, yx=y*x2, yy=y*y2, zx=z*x2, zy=z*y2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  const r00=1-yy-zz, r01=yx-wz, r02=zx+wy;
  const r10=yx+wz,   r11=1-xx-zz, r12=zy-wx;
  const r20=zx-wy,   r21=zy+wx,   r22=1-xx-yy;
  // V = R^T | -R^T*p   (column-major: o[j*4+i] = V[i][j] = R[j][i])
  o[0]=r00;o[1]=r01;o[2]=r02;o[3]=0;
  o[4]=r10;o[5]=r11;o[6]=r12;o[7]=0;
  o[8]=r20;o[9]=r21;o[10]=r22;o[11]=0;
  // Translation = -(R^T * pos). Die ZEILEN von R^T sind right/up/back, also
  // müssen hier die SPALTEN von R verwendet werden (r00,r10,r20 = right).
  // Vorher standen hier die Zeilen von R — zusammen mit der (ebenfalls
  // transponierten) Rotation hat sich das teilweise weggehoben, und bei einer
  // Kamera im Ursprung fiel es gar nicht auf. Sobald die Kamera aber irgendwo
  // in der Welt steht, rotiert sie nicht mehr um sich selbst, sondern um einen
  // Punkt VOR ihr → genau das orbitartige Bild.
  o[12]=-(r00*pos[0]+r10*pos[1]+r20*pos[2]);
  o[13]=-(r01*pos[0]+r11*pos[1]+r21*pos[2]);
  o[14]=-(r02*pos[0]+r12*pos[1]+r22*pos[2]);
  o[15]=1;
  return o;
}
/** TRS aus Position, Quaternion und einheitlichem/achweisen Scale. */
function m4fromTRS(o, p, q, sx, sy, sz) {
  const x=q[0], y=q[1], z=q[2], w=q[3];
  const x2=x+x, y2=y+y, z2=z+z;
  const xx=x*x2, yx=y*x2, yy=y*y2, zx=z*x2, zy=z*y2, zz=z*z2;
  const wx=w*x2, wy=w*y2, wz=w*z2;
  o[0]=(1-yy-zz)*sx; o[1]=(yx+wz)*sx;   o[2]=(zx-wy)*sx;   o[3]=0;
  o[4]=(yx-wz)*sy;   o[5]=(1-xx-zz)*sy; o[6]=(zy+wx)*sy;   o[7]=0;
  o[8]=(zx+wy)*sz;   o[9]=(zy-wx)*sz;   o[10]=(1-xx-yy)*sz;o[11]=0;
  o[12]=p[0]; o[13]=p[1]; o[14]=p[2]; o[15]=1;
  return o;
}
/** Blickrichtung (vorwärts = -Z) aus Quaternion. */
const qForward = (o, q) => qrot(o, q, FWD_VEC);
const qRight   = (o, q) => qrot(o, q, RIGHT_VEC);
const qUp      = (o, q) => qrot(o, q, UP_VEC);
const FWD_VEC = [0,0,-1], RIGHT_VEC = [1,0,0], UP_VEC = [0,1,0];

/** Projekt-Punkt auf die Strecke AB; gibt t (unbegrenzt) zurück und schreibt den Punkt. */
function closestOnSegment(out, p, a, b) {
  const abx=b[0]-a[0], aby=b[1]-a[1], abz=b[2]-a[2];
  const l2 = abx*abx+aby*aby+abz*abz;
  let t = l2 > 1e-12 ? ((p[0]-a[0])*abx + (p[1]-a[1])*aby + (p[2]-a[2])*abz) / l2 : 0;
  t = clamp(t, 0, 1);
  out[0]=a[0]+abx*t; out[1]=a[1]+aby*t; out[2]=a[2]+abz*t;
  return t;
}
/** Unbegrenzte Gerade: gibt t zurück (kann <0 oder >1 sein). */
function closestOnLine(out, p, a, b) {
  const abx=b[0]-a[0], aby=b[1]-a[1], abz=b[2]-a[2];
  const l2 = abx*abx+aby*aby+abz*abz;
  const t = l2 > 1e-12 ? ((p[0]-a[0])*abx + (p[1]-a[1])*aby + (p[2]-a[2])*abz) / l2 : 0;
  out[0]=a[0]+abx*t; out[1]=a[1]+aby*t; out[2]=a[2]+abz*t;
  return t;
}

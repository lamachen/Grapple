/* =============================================================================
   04_render.js — Kompakter WebGL2-Renderer (keine externen Abhängigkeiten)
   Instanzierte Boxen, prozedurale Panelfugen, Himmel/Fog, Seil-Ribbon mit
   zylindrischem Shading (sieht rund aus, obwohl es ein Flachstreifen ist),
   Punkt-Sprites für Partikel, Debug-Linien, Viewmodel-Pass.
   ========================================================================== */
'use strict';

/* --------------------------------- Shader --------------------------------- */
const VS_BOX = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 iR0;
layout(location=3) in vec4 iR1;
layout(location=4) in vec4 iR2;
layout(location=5) in vec4 iR3;
layout(location=6) in vec4 iColor;
uniform mat4 uVP;
uniform vec3 uCam;
out vec3 vWorld; out vec3 vNormal; out vec4 vColor; out float vDist;
void main(){
  mat4 M = mat4(iR0,iR1,iR2,iR3);
  vec4 wp = M * vec4(aPos,1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(M) * aNormal);
  vColor = iColor;
  vDist = distance(wp.xyz, uCam);
  gl_Position = uVP * wp;
}`;

const FS_BOX = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec4 vColor; in float vDist;
uniform vec3 uLightDir, uSunColor, uSkyColor, uGroundColor, uFogColor, uCam;
uniform float uFogDensity, uPanel, uTime;
out vec4 frag;
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCam - vWorld);
  float ndl = max(dot(N, uLightDir), 0.0);
  vec3 amb = mix(uGroundColor, uSkyColor, N.y*0.5+0.5);
  float panel = 1.0;
  if (uPanel > 0.5) {
    vec3 aN = abs(N);
    vec2 uv = (aN.y > aN.x && aN.y > aN.z) ? vWorld.xz : (aN.x > aN.z ? vWorld.zy : vWorld.xy);
    vec2 g = abs(fract(uv * 0.5) - 0.5);
    float line = smoothstep(0.455, 0.5, max(g.x, g.y));
    vec2 g2 = abs(fract(uv * 0.125) - 0.5);
    float line2 = smoothstep(0.485, 0.5, max(g2.x, g2.y));
    panel = 1.0 - line*0.13 - line2*0.16;
  }
  // Höhen-AO: etwas dunkler Richtung Boden → Objekte "sitzen" im Level
  float ao = clamp(0.55 + 0.45 * smoothstep(-1.0, 7.0, vWorld.y), 0.0, 1.0);
  vec3 col = vColor.rgb * (amb*0.92*ao + uSunColor*ndl*1.02) * panel;
  vec3 H = normalize(uLightDir + V);
  col += uSunColor * pow(max(dot(N,H),0.0), 46.0) * 0.20 * vColor.a;
  float f = 1.0 - exp(-pow(vDist*uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(f,0.0,1.0));
  frag = vec4(col, 1.0);
}`;

const VS_SKY = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec3 uFwd, uRight, uUp;
uniform float uTanHalf, uAspect;
out vec3 vDir;
void main(){
  vDir = normalize(uFwd + uRight*(aPos.x*uTanHalf*uAspect) + uUp*(aPos.y*uTanHalf));
  gl_Position = vec4(aPos, 0.9999, 1.0);
}`;

const FS_SKY = `#version 300 es
precision highp float;
in vec3 vDir;
uniform vec3 uZenith, uHorizon, uSunColor, uLightDir;
out vec4 frag;
void main(){
  float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.85));
  float sun = pow(max(dot(normalize(vDir), normalize(uLightDir)), 0.0), 220.0);
  float glow = pow(max(dot(normalize(vDir), normalize(uLightDir)), 0.0), 8.0);
  col += uSunColor * (sun*2.2 + glow*0.14);
  frag = vec4(col, 1.0);
}`;

const VS_LINE = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uVP;
out vec4 vColor;
void main(){ vColor = aColor; gl_Position = uVP * vec4(aPos,1.0); }`;
const FS_LINE = `#version 300 es
precision highp float; in vec4 vColor; out vec4 frag;
void main(){ frag = vColor; }`;

const VS_ROPE = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aUVW;   // .x = Bogenlaenge, .y = quer (0..1), .z = Spannung 0..1
uniform mat4 uVP;
uniform vec3 uCam;
out vec3 vUVW; out float vDist;
void main(){
  vUVW = aUVW; vDist = distance(aPos, uCam);
  gl_Position = uVP * vec4(aPos,1.0);
}`;
const FS_ROPE = `#version 300 es
precision highp float;
in vec3 vUVW; in float vDist;
uniform vec3 uLightDir, uFogColor, uColA, uColB, uCam;
uniform float uFogDensity, uTime;
out vec4 frag;
void main(){
  // zylindrisches Shading: der Flachstreifen wirkt wie ein rundes Seil
  float t = vUVW.y * 2.0 - 1.0;
  float cyl = sqrt(max(0.0, 1.0 - t*t));
  vec3 base = mix(uColA, uColB, clamp(vUVW.z, 0.0, 1.0));
  // Faser-Twist (prozedural, scrollt mit der Bogenlänge)
  float twist = sin((vUVW.x*30.0 + t*1.9) * 3.14159) * 0.5 + 0.5;
  base *= 0.86 + twist*0.20;
  vec3 N = normalize(vec3(t, cyl, 0.18*t));
  float ndl = max(dot(N, normalize(uLightDir)), 0.0);
  vec3 col = base * (0.48 + 0.86*ndl*cyl + 0.16) + vec3(1.0,0.96,0.9) * pow(ndl, 26.0) * 0.30;
  // Spannung glüht leicht mit (Feedback, ohne die Physik zu verfälschen)
  col += vec3(1.0,0.55,0.25) * pow(clamp(vUVW.z,0.0,1.0), 3.0) * 0.22;
  float f = 1.0 - exp(-pow(vDist*uFogDensity*1.6, 2.0));
  col = mix(col, uFogColor, clamp(f,0.0,1.0));
  frag = vec4(col, 1.0);
}`;

const VS_PART = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
layout(location=2) in float aSize;
uniform mat4 uVP;
out vec4 vColor;
void main(){ vColor = aColor; gl_Position = uVP * vec4(aPos,1.0);
  gl_PointSize = aSize / max(0.35, gl_Position.w) * 46.0; }`;
const FS_PART = `#version 300 es
precision highp float; in vec4 vColor; out vec4 frag;
void main(){
  vec2 d = gl_PointCoord*2.0-1.0;
  float a = 1.0 - dot(d,d);
  if (a <= 0.0) discard;
  frag = vec4(vColor.rgb, vColor.a * a*a);
}`;

/* -------------------------------- Renderer -------------------------------- */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/,'')] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false };
    const gl = canvas.getContext('webgl2', opts);
    if (!gl) throw new Error('WebGL2 nicht verfügbar');
    this.gl = gl;
    this.maxInstances = 4096;
    this._initBox(); this._initSky(); this._initLine(); this._initRope(); this._initPart();
    this.viewProj = m4(); this.view = m4(); this.proj = m4();
    this.camPos = v3(); this.camQuat = qid();
    this.camFwd = v3(0,0,-1); this.camRight = v3(1,0,0); this.camUp = v3(0,1,0);
    this.tanHalf = Math.tan(45*DEG); this.aspect = 1.6;
    this.time = 0;
    this.lightDir = vnormSafe([0.42, 0.82, 0.36]);
    this.theme = {
      zenith: [0.30, 0.52, 0.86], horizon: [0.78, 0.86, 0.95],
      sun: [1.00, 0.95, 0.86], ground: [0.24, 0.25, 0.28], fog: [0.76, 0.84, 0.93],
      fogDensity: 0.0075,
    };
    this._instanceCount = 0;
    this._lineCount = 0;
    this._partCount = 0;
    this.triboxCount = 0;
  }

  /* ------------------------------ Geometrie ------------------------------ */
  _initBox() {
    const gl = this.gl;
    // Würfel mit flächenweisen Normalen
    const P = [], N = [], I = [];
    const faces = [
      [[ 1,0,0], [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]],
      [[-1,0,0], [[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]]],
      [[0, 1,0], [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]]],
      [[0,-1,0], [[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]]],
      [[0,0, 1], [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
      [[0,0,-1], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
    ];
    for (let f = 0; f < 6; f++) {
      const n = faces[f][0], v = faces[f][1];
      for (let k = 0; k < 4; k++) { P.push(v[k][0]*0.5, v[k][1]*0.5, v[k][2]*0.5); N.push(n[0],n[1],n[2]); }
      const b = f*4; I.push(b,b+1,b+2, b,b+2,b+3);
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(P), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(N), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(I), gl.STATIC_DRAW);

    // Instanzdaten: 4x vec4 Matrix + vec4 Farbe = 20 Floats
    const stride = 20*4;
    this.instData = new Float32Array(this.maxInstances*20);
    const ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);
    for (let r = 0; r < 4; r++) {
      gl.enableVertexAttribArray(2+r);
      gl.vertexAttribPointer(2+r, 4, gl.FLOAT, false, stride, r*16);
      gl.vertexAttribDivisor(2+r, 1);
    }
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, stride, 64);
    gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
    this.boxVAO = vao; this.boxIBuf = ibuf; this.boxIndexCount = I.length;
    this.boxProg = program(gl, VS_BOX, FS_BOX);
  }

  _initSky() {
    const gl = this.gl;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
    this.skyVAO = vao; this.skyProg = program(gl, VS_SKY, FS_SKY);
  }

  _initLine() {
    const gl = this.gl;
    this.maxLineVerts = 20000;
    this.lineData = new Float32Array(this.maxLineVerts*7);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,28,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.FLOAT,false,28,12);
    gl.bindVertexArray(null);
    this.lineVAO = vao; this.lineBuf = b; this.lineProg = program(gl, VS_LINE, FS_LINE);
  }

  _initRope() {
    const gl = this.gl;
    this.maxRopeVerts = 2048;
    this.ropeData = new Float32Array(this.maxRopeVerts*6);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, this.ropeData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
    gl.bindVertexArray(null);
    this.ropeVAO = vao; this.ropeBuf = b; this.ropeProg = program(gl, VS_ROPE, FS_ROPE);
  }

  _initPart() {
    const gl = this.gl;
    this.maxParts = 2048;
    this.partData = new Float32Array(this.maxParts*8);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, this.partData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.FLOAT,false,32,12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,1,gl.FLOAT,false,32,28);
    gl.bindVertexArray(null);
    this.partVAO = vao; this.partBuf = b; this.partProg = program(gl, VS_PART, FS_PART);
  }

  /* -------------------------------- Kamera ------------------------------- */
  resize() {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(c.clientWidth * dpr)), h = Math.max(2, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.width = w; this.height = h; this.dpr = dpr;
    this.cssWidth = c.clientWidth; this.cssHeight = c.clientHeight;
    this.aspect = w/h;
  }
  /** Projektion Welt → CSS-Pixel (für HUD-Marker). null wenn hinter der Kamera. */
  project(p, out2) {
    const v = this.viewProj;
    const x = v[0]*p[0]+v[4]*p[1]+v[8]*p[2]+v[12];
    const y = v[1]*p[0]+v[5]*p[1]+v[9]*p[2]+v[13];
    const w = v[3]*p[0]+v[7]*p[1]+v[11]*p[2]+v[15];
    if (w <= 1e-4) return null;
    out2[0] = ((x/w)*0.5+0.5) * this.cssWidth;
    out2[1] = (1-((y/w)*0.5+0.5)) * this.cssHeight;
    return out2;
  }

  /** Kamera direkt aus Position + Blickrichtung (für Orbit-/Spektator-Modus). */
  setCameraRaw(pos, fwd, upHint, fovDeg) {
    vcopy(this.camPos, pos);
    const f = vnormSafe(fwd, 0,0,-1);
    const r = vnormSafe(vcross(_V_A, f, upHint || [0,1,0]), 1,0,0);
    const u = vcross(_V_B, r, f);
    vcopy(this.camFwd, f); vcopy(this.camRight, r); vcopy(this.camUp, u);
    this.fovDeg = fovDeg;
    this.tanHalf = Math.tan(fovDeg*DEG*0.5);
    m4perspective(this.proj, fovDeg*DEG, this.aspect, 0.045, 620);
    const V = this.view;
    V[0]=r[0]; V[1]=u[0]; V[2]=-f[0]; V[3]=0;
    V[4]=r[1]; V[5]=u[1]; V[6]=-f[1]; V[7]=0;
    V[8]=r[2]; V[9]=u[2]; V[10]=-f[2]; V[11]=0;
    V[12]=-vdot(r,pos); V[13]=-vdot(u,pos); V[14]=vdot(f,pos); V[15]=1;
    m4mul(this.viewProj, this.proj, this.view);
  }

  setCamera(pos, quat, fovDeg) {
    this.fovDeg = fovDeg;
    vcopy(this.camPos, pos); qcopy(this.camQuat, quat);
    qForward(this.camFwd, quat); qRight(this.camRight, quat); qUp(this.camUp, quat);
    const fov = fovDeg*DEG;
    this.tanHalf = Math.tan(fov*0.5);
    m4perspective(this.proj, fov, this.aspect, 0.045, 620);
    m4viewFromQuat(this.view, pos, quat);
    m4mul(this.viewProj, this.proj, this.view);
  }

  /* ------------------------------ Instanzen ------------------------------ */
  pushBox(mat, r, g, b, spec = 0.4) {
    if (this._instanceCount >= this.maxInstances) return;
    const d = this.instData, o = this._instanceCount*20;
    d[o]=mat[0]; d[o+1]=mat[1]; d[o+2]=mat[2]; d[o+3]=mat[3];
    d[o+4]=mat[4]; d[o+5]=mat[5]; d[o+6]=mat[6]; d[o+7]=mat[7];
    d[o+8]=mat[8]; d[o+9]=mat[9]; d[o+10]=mat[10]; d[o+11]=mat[11];
    d[o+12]=mat[12]; d[o+13]=mat[13]; d[o+14]=mat[14]; d[o+15]=mat[15];
    d[o+16]=r; d[o+17]=g; d[o+18]=b; d[o+19]=spec;
    this._instanceCount++;
    this.triboxCount += 12;
  }
  /** Achsenausgerichtete Box aus min/max (der Normalfall im Level). */
  pushAABB(b, col, spec) {
    const m = _M4TMP;
    const sx = b.max[0]-b.min[0], sy = b.max[1]-b.min[1], sz = b.max[2]-b.min[2];
    m4fromTRS(m, [(b.min[0]+b.max[0])*0.5, (b.min[1]+b.max[1])*0.5, (b.min[2]+b.max[2])*0.5], QID, sx, sy, sz);
    this.pushBox(m, col[0], col[1], col[2], spec != null ? spec : 0.4);
  }
  pushBoxC(center, size, col, spec, quat) {
    const m = _M4TMP;
    m4fromTRS(m, center, quat || QID, size[0], size[1], size[2]);
    this.pushBox(m, col[0], col[1], col[2], spec != null ? spec : 0.4);
  }

  /* -------------------------------- Linien ------------------------------- */
  line(a, b, col) {
    if (this._lineCount + 2 > this.maxLineVerts) return;
    const d = this.lineData; let o = this._lineCount*7;
    d[o]=a[0];d[o+1]=a[1];d[o+2]=a[2];d[o+3]=col[0];d[o+4]=col[1];d[o+5]=col[2];d[o+6]=col.length>3?col[3]:1;
    o += 7;
    d[o]=b[0];d[o+1]=b[1];d[o+2]=b[2];d[o+3]=col[0];d[o+4]=col[1];d[o+5]=col[2];d[o+6]=col.length>3?col[3]:1;
    this._lineCount += 2;
  }
  polyline(pts, count, col, stride = 3) {
    for (let i = 0; i < count-1; i++) {
      const a = [pts[i*stride], pts[i*stride+1], pts[i*stride+2]];
      const b = [pts[(i+1)*stride], pts[(i+1)*stride+1], pts[(i+1)*stride+2]];
      this.line(a, b, col);
    }
  }

  /* ------------------------------- Partikel ------------------------------ */
  particle(p, col, size) {
    if (this._partCount >= this.maxParts) return;
    const d = this.partData, o = this._partCount*8;
    d[o]=p[0];d[o+1]=p[1];d[o+2]=p[2];d[o+3]=col[0];d[o+4]=col[1];d[o+5]=col[2];d[o+6]=col[3];d[o+7]=size;
    this._partCount++;
  }

  /* --------------------------------- Seil -------------------------------- */
  /**
   * Ribbon aus einer Kurve. `tensionAt(i)` liefert 0..1 für die Färbung.
   * Der Streifen wird kameraseitig aufgespannt und zusätzlich um die
   * Tangente verdrillt → sieht aus wie ein geschlagenes Seil.
   */
  rope(curveBuf, count, widthFn, tensionFn) {
    const gl = this.gl;
    const d = this.ropeData;
    let vi = 0;
    const cam = this.camPos;
    const side = _V_A, tan = _V_B, toCam = _V_C;
    const n = count;
    this._ropeVerts = 0;
    if (this._lastSide) vset(this._lastSide, 0,0,0);
    for (let i = 0; i < n; i++) {
      const px = curveBuf[i*3], py = curveBuf[i*3+1], pz = curveBuf[i*3+2];
      const i0 = Math.max(0, i-1), i1 = Math.min(n-1, i+1);
      tan[0]=curveBuf[i1*3]-curveBuf[i0*3]; tan[1]=curveBuf[i1*3+1]-curveBuf[i0*3+1]; tan[2]=curveBuf[i1*3+2]-curveBuf[i0*3+2];
      if (vnorm(tan, tan) < 1e-6) vset(tan, 0,1,0);
      toCam[0]=cam[0]-px; toCam[1]=cam[1]-py; toCam[2]=cam[2]-pz;
      if (vnorm(toCam, toCam) < 1e-6) vset(toCam, 0,0,1);
      vcross(side, tan, toCam);
      if (vnorm(side, side) < 1e-5) { vcross(side, tan, this.camUp); vnorm(side, side); }
      const u = n > 1 ? i/(n-1) : 0;
      const w = widthFn(u, i) * 0.5;
      const tens = tensionFn(u, i);
      /* KEINE geometrische Verdrillung. Ein Flachstreifen, den man um die
         eigene Tangente dreht, faltet sich bei flacher Sicht auf sich selbst
         zurück → Bowties, Knicke, "verdrehte Vertices". Der Streifen bleibt
         deshalb immer ein reines Kamera-Billboard; die geflochtene Optik kommt
         aus dem Fragment-Shader (prozeduraler Faser-Twist + zylindrisches
         Shading). Das ist stabil aus JEDEM Blickwinkel.                     */
      if (this._lastSide) {
        // Seitenvorzeichen stabilisieren: flippt `side` wegen fast paralleler
        // Tangente, würde das Ribbon in sich umschlagen.
        const dotPrev = side[0]*this._lastSide[0] + side[1]*this._lastSide[1] + side[2]*this._lastSide[2];
        if (dotPrev < 0) { side[0]=-side[0]; side[1]=-side[1]; side[2]=-side[2]; }
      }
      if (!this._lastSide) this._lastSide = v3();
      vcopy(this._lastSide, side);
      const ox = side[0]*w, oy = side[1]*w, oz = side[2]*w;
      if (vi + 2 > this.maxRopeVerts) break;
      let o = vi*6;
      d[o]=px-ox; d[o+1]=py-oy; d[o+2]=pz-oz; d[o+3]=u; d[o+4]=0; d[o+5]=tens; vi++;
      o = vi*6;
      d[o]=px+ox; d[o+1]=py+oy; d[o+2]=pz+oz; d[o+3]=u; d[o+4]=1; d[o+5]=tens; vi++;
    }
    this._ropeVerts = vi;
  }

  /* -------------------------------- Frame -------------------------------- */
  begin() {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.clearColor(0.7,0.8,0.9,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this._instanceCount = 0; this._lineCount = 0; this._partCount = 0; this._ropeVerts = 0;
    this.triboxCount = 0;
    this.time += 1/60;
  }

  drawSky() {
    const gl = this.gl, p = this.skyProg;
    gl.useProgram(p.p); gl.bindVertexArray(this.skyVAO);
    gl.depthMask(false); gl.disable(gl.DEPTH_TEST);
    gl.uniform3fv(p.u.uFwd, this.camFwd); gl.uniform3fv(p.u.uRight, this.camRight); gl.uniform3fv(p.u.uUp, this.camUp);
    gl.uniform1f(p.u.uTanHalf, this.tanHalf); gl.uniform1f(p.u.uAspect, this.aspect);
    const t = this.theme;
    gl.uniform3fv(p.u.uZenith, t.zenith); gl.uniform3fv(p.u.uHorizon, t.horizon);
    gl.uniform3fv(p.u.uSunColor, t.sun); gl.uniform3fv(p.u.uLightDir, this.lightDir);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }

  flushBoxes(panel = true, vp = null) {
    if (this._instanceCount === 0) return;
    const gl = this.gl, p = this.boxProg;
    gl.bindVertexArray(this.boxVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxIBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instData, 0, this._instanceCount*20);
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uVP, false, vp || this.viewProj);
    gl.uniform3fv(p.u.uCam, this.camPos);
    gl.uniform3fv(p.u.uLightDir, this.lightDir);
    const t = this.theme;
    gl.uniform3fv(p.u.uSunColor, t.sun); gl.uniform3fv(p.u.uSkyColor, t.zenith);
    gl.uniform3fv(p.u.uGroundColor, t.ground); gl.uniform3fv(p.u.uFogColor, t.fog);
    gl.uniform1f(p.u.uFogDensity, t.fogDensity);
    gl.uniform1f(p.u.uPanel, panel ? 1 : 0);
    gl.uniform1f(p.u.uTime, this.time);
    gl.drawElementsInstanced(gl.TRIANGLES, this.boxIndexCount, gl.UNSIGNED_SHORT, 0, this._instanceCount);
    this._instanceCount = 0;
    gl.bindVertexArray(null);
  }

  flushLines(vp = null) {
    if (this._lineCount === 0) return;
    const gl = this.gl, p = this.lineProg;
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData, 0, this._lineCount*7);
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uVP, false, vp || this.viewProj);
    gl.drawArrays(gl.LINES, 0, this._lineCount);
    gl.bindVertexArray(null);
    this._lineCount = 0;
  }

  flushRope(vp = null) {
    if (this._ropeVerts < 4) return;
    const gl = this.gl, p = this.ropeProg;
    gl.bindVertexArray(this.ropeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ropeBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ropeData, 0, this._ropeVerts*6);
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uVP, false, vp || this.viewProj);
    gl.uniform3fv(p.u.uCam, this.camPos);
    gl.uniform3fv(p.u.uLightDir, this.lightDir);
    const t = this.theme;
    gl.uniform3fv(p.u.uFogColor, t.fog);
    gl.uniform1f(p.u.uFogDensity, t.fogDensity);
    gl.uniform3fv(p.u.uColA, this.ropeColA || [0.30,0.29,0.31]);
    gl.uniform3fv(p.u.uColB, this.ropeColB || [0.92,0.90,0.86]);
    gl.uniform1f(p.u.uTime, this.time);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, this._ropeVerts);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    this._ropeVerts = 0;
  }

  flushParticles(vp = null) {
    if (this._partCount === 0) return;
    const gl = this.gl, p = this.partProg;
    gl.bindVertexArray(this.partVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.partData, 0, this._partCount*8);
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uVP, false, vp || this.viewProj);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.POINTS, 0, this._partCount);
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    this._partCount = 0;
  }
}

const _M4TMP = m4();
const QID = qid();
const _V_A = v3(), _V_B = v3(), _V_C = v3();

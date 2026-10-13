/* Headless-DOM/GL-Stub, gemeinsam genutzt von test_browser.js und replay.js.
   Keine Spiellogik, nur gerade genug Oberfläche, um Game headless zu fahren. */
'use strict';
const shaderErrors = {};
let glCalls = 0, drawCalls = 0;
const stats = { get glCalls(){return glCalls;}, get drawCalls(){return drawCalls;} };
/* ------------------------------- GL-Stub ---------------------------------- */
function makeGL() {
  const consts = {};
  const names = ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','ACTIVE_UNIFORMS',
    'ARRAY_BUFFER','ELEMENT_ARRAY_BUFFER','STATIC_DRAW','DYNAMIC_DRAW','FLOAT','UNSIGNED_SHORT',
    'TRIANGLES','LINES','POINTS','TRIANGLE_STRIP','DEPTH_TEST','CULL_FACE','BACK','LEQUAL',
    'COLOR_BUFFER_BIT','DEPTH_BUFFER_BIT','BLEND','SRC_ALPHA','ONE_MINUS_SRC_ALPHA'];
  names.forEach((n, i) => consts[n] = 0x1000 + i);
  const target = {
    ...consts,
    canvas: { width: 1280, height: 720 },
    createShader: () => ({ __src: '', __err: '' }),
    shaderSource: (sh, src) => { sh.__src = src; },
    compileShader: (sh) => { sh.__err = shaderErrors[sh.__src] || ''; },
    getShaderParameter: (sh) => !sh.__err,
    getShaderInfoLog: (sh) => sh.__err || '',
    createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: (p, w) => (w === consts.ACTIVE_UNIFORMS ? 0 : true),
    getProgramInfoLog: () => '', getActiveUniform: () => ({ name: 'u' }),
    getUniformLocation: () => ({}),
    createVertexArray: () => ({}), bindVertexArray: () => {},
    createBuffer: () => ({}), bindBuffer: () => {}, bufferData: () => {}, bufferSubData: () => {},
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
    useProgram: () => {}, viewport: () => {}, enable: () => {}, disable: () => {},
    clear: () => {}, clearColor: () => {}, depthFunc: () => {}, cullFace: () => {},
    depthMask: () => {}, blendFunc: () => {},
    uniform1f: () => {}, uniform3fv: () => {}, uniformMatrix4fv: () => {},
    drawElementsInstanced: () => { drawCalls++; }, drawArrays: () => { drawCalls++; },
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return (...a) => { glCalls++; };
    },
  });
}

/* ------------------------------- DOM-Stub --------------------------------- */
/* Mit echtem Event-Dispatch: nur so lässt sich die Blicksteuerung prüfen —
   genau der Teil, der im Sandbox-iframe der In-App-Vorschau kritisch ist.    */
function addEventSupport(obj) {
  obj._h = {};
  obj.addEventListener = function (t, fn) { (this._h[t] = this._h[t] || []).push(fn); };
  obj.removeEventListener = function (t, fn) {
    if (!this._h[t]) return;
    this._h[t] = this._h[t].filter(f => f !== fn);
  };
  obj.dispatch = function (type, ev) {
    const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {},
                              button: 0, clientX: 0, clientY: 0 }, ev || {});
    (this._h[type] || []).slice().forEach(fn => fn(e));
    return e;
  };
  obj.listenerCount = function (t) { return (this._h[t] || []).length; };
  return obj;
}
function makeEl(id) {
  const el = addEventSupport({
    id, style: new Proxy({}, { get: (t,k) => t[k] || '', set: (t,k,v) => { t[k]=v; return true; } }),
    dataset: {}, textContent: '', innerHTML: '', value: '0', checked: true, title: '',
    // echte classList — sonst lassen sich Sichtbarkeits-Umschalter nicht testen
    classList: {
      _s: new Set(),
      toggle(c, force) { const on = (force === undefined) ? !this._s.has(c) : !!force;
        if (on) this._s.add(c); else this._s.delete(c); return on; },
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) { return this['_q' + sel] || (this['_q' + sel] = makeEl('q' + sel)); },
    querySelectorAll: () => [],
    dataset2: null,
    getContext: () => gl, clientWidth: 1280, clientHeight: 720, width: 1280, height: 720,
    requestPointerLock: () => { throw new Error('pointer lock im Sandbox-iframe nicht erlaubt'); },
    getBoundingClientRect: () => ({ left:0, top:0, width:1280, height:720, right:1280, bottom:720 }),
  });
  return el;
}
const gl = makeGL();
const els = {};
const document = addEventSupport({
  getElementById: (id) => (els[id] || (els[id] = makeEl(id))),
  createElement: (t) => makeEl('created-' + t),
  pointerLockElement: null,
});
document.body = makeEl('body');
let rafQueue = [];
const window = addEventSupport({
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  AudioContext: null, webkitAudioContext: null,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
});


module.exports = { makeGL, makeEl, addEventSupport, document, window, rafQueue, gl, stats, shaderErrors };

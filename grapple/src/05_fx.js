/* =============================================================================
   05_fx.js — Partikel + minimaler WebAudio-Synth (Seil-Akustik folgt der Physik)
   ========================================================================== */
'use strict';

class Particles {
  constructor(max = 1400) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max*3);
    this.v = new Float32Array(max*3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.col = new Float32Array(max*4);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
  }
  spawn(pos, vel, life, size, col, grav = 1, drag = 1.4) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p[i*3]=pos[0]; this.p[i*3+1]=pos[1]; this.p[i*3+2]=pos[2];
    this.v[i*3]=vel[0]; this.v[i*3+1]=vel[1]; this.v[i*3+2]=vel[2];
    this.life[i]=life; this.maxLife[i]=life; this.size[i]=size;
    this.col[i*4]=col[0]; this.col[i*4+1]=col[1]; this.col[i*4+2]=col[2]; this.col[i*4+3]=col[3];
    this.grav[i]=grav; this.drag[i]=drag;
  }
  burst(pos, normal, count, opts = {}) {
    const speed = opts.speed || 4, spread = opts.spread || 1.0;
    const col = opts.color || [0.85,0.84,0.80,0.9];
    const life = opts.life || 0.6, size = opts.size || 0.16;
    for (let i = 0; i < count; i++) {
      const d = vnormSafe([normal[0]+rnd(-spread,spread), normal[1]+rnd(-spread,spread), normal[2]+rnd(-spread,spread)]);
      const s = speed * (0.35 + Math.random()*0.9);
      this.spawn(pos, [d[0]*s, d[1]*s + (opts.up||0), d[2]*s], life*(0.6+Math.random()*0.8), size*(0.6+Math.random()*0.9), col, opts.grav != null ? opts.grav : 1, opts.drag != null ? opts.drag : 1.6);
    }
  }
  step(dt, gravity) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // mit dem letzten tauschen (Reihenfolge egal)
        const l = --this.n;
        if (l !== i) {
          for (let k=0;k<3;k++){ this.p[i*3+k]=this.p[l*3+k]; this.v[i*3+k]=this.v[l*3+k]; }
          this.life[i]=this.life[l]; this.maxLife[i]=this.maxLife[l]; this.size[i]=this.size[l];
          for (let k=0;k<4;k++) this.col[i*4+k]=this.col[l*4+k];
          this.grav[i]=this.grav[l]; this.drag[i]=this.drag[l];
        }
        i--; continue;
      }
      const dg = Math.exp(-this.drag[i]*dt);
      this.v[i*3]  *= dg; this.v[i*3+1] = this.v[i*3+1]*dg + gravity*this.grav[i]*dt; this.v[i*3+2] *= dg;
      this.p[i*3] += this.v[i*3]*dt; this.p[i*3+1] += this.v[i*3+1]*dt; this.p[i*3+2] += this.v[i*3+2]*dt;
    }
  }
  render(r) {
    const c = [0,0,0,0];
    for (let i = 0; i < this.n; i++) {
      const f = clamp01(this.life[i]/this.maxLife[i]);
      c[0]=this.col[i*4]; c[1]=this.col[i*4+1]; c[2]=this.col[i*4+2]; c[3]=this.col[i*4+3]*f*f;
      r.particle([this.p[i*3], this.p[i*3+1], this.p[i*3+2]], c, this.size[i]*(0.4+f*0.9));
    }
  }
}
const rnd = (a, b) => a + Math.random()*(b-a);

/* -------------------------------------------------------------------------- */
/*  Minimal-Synth: alle Geräusche werden aus Seil-Zustandsgrößen gespeist,     */
/*  dadurch klingt das System kohärent und nicht wie angeklebte Samples.       */
/* -------------------------------------------------------------------------- */
class RopeAudio {
  constructor() { this.ok = false; this.enabled = true; }
  init() {
    if (this.ok || !this.enabled) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = 0.55; this.master.connect(c.destination);
      // Rauschbuffer
      const len = c.sampleRate * 1.2;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random()*2-1;
      // Dauer-Lastkanal: gefiltertes Rauschen + Sägezahn, Gain folgt der Seilkraft
      this.creakGain = c.createGain(); this.creakGain.gain.value = 0;
      this.creakFilter = c.createBiquadFilter(); this.creakFilter.type = 'bandpass';
      this.creakFilter.frequency.value = 620; this.creakFilter.Q.value = 5.5;
      this.creakSrc = c.createBufferSource(); this.creakSrc.buffer = this.noise; this.creakSrc.loop = true;
      this.creakSrc.connect(this.creakFilter); this.creakFilter.connect(this.creakGain); this.creakGain.connect(this.master);
      this.creakSrc.start();
      this.creakOsc = c.createOscillator(); this.creakOsc.type = 'sawtooth'; this.creakOsc.frequency.value = 74;
      this.creakOscGain = c.createGain(); this.creakOscGain.gain.value = 0;
      this.creakOsc.connect(this.creakOscGain); this.creakOscGain.connect(this.master);
      this.creakOsc.start();
      this.ok = true;
    } catch (e) { this.ok = false; }
  }
  resume() { if (this.ok && this.ctx.state === 'suspended') this.ctx.resume(); }
  /** Last aus Seilkraft + Relativgeschwindigkeit → Tonhöhe & Lautstärke */
  update(rope, playerVel) {
    if (!this.ok || !this.enabled) return;
    const t = rope.tensionLevel * (rope.slack <= 0 ? 1 : 0.15);
    const load = clamp(t * (0.4 + clamp(vlen(playerVel)/34, 0, 1.2)), 0, 1.4);
    const now = this.ctx.currentTime;
    this.creakGain.gain.setTargetAtTime(load*0.10, now, 0.06);
    this.creakOscGain.gain.setTargetAtTime(load*0.035, now, 0.08);
    this.creakFilter.frequency.setTargetAtTime(430 + load*760, now, 0.1);
    this.creakOsc.frequency.setTargetAtTime(58 + load*92, now, 0.12);
  }
  _env(node, t0, a, d, peak) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0+a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0+a+d);
    node.connect(g); g.connect(this.master);
    return g;
  }
  noiseHit(dur, freq, q, peak, type = 'bandpass') {
    if (!this.ok || !this.enabled) return;
    const c = this.ctx, t0 = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f);
    this._env(f, t0, 0.004, dur, peak);
    s.start(t0); s.stop(t0 + dur + 0.1);
  }
  tone(freq, dur, peak, type = 'sine', glide = 0) {
    if (!this.ok || !this.enabled) return;
    const c = this.ctx, t0 = c.currentTime;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq+glide), t0+dur);
    this._env(o, t0, 0.006, dur, peak);
    o.start(t0); o.stop(t0+dur+0.1);
  }
  fire()    { this.noiseHit(0.30, 1500, 0.9, 0.30, 'highpass'); this.tone(220, 0.16, 0.10, 'triangle', -120); }
  anchor(s) { this.noiseHit(0.13, 320, 2.2, 0.42*s+0.18); this.tone(140+40*s, 0.22, 0.20, 'square', -60); this.tone(880, 0.10, 0.06*s, 'sine'); }
  bounce()  { this.noiseHit(0.07, 2400, 3.0, 0.16); }
  taut()    { this.tone(520, 0.10, 0.09, 'triangle', 220); this.noiseHit(0.09, 900, 4.0, 0.13); }
  retract() { this.noiseHit(0.24, 780, 1.4, 0.16); }
  land(s)   { this.noiseHit(0.16, 130, 1.0, 0.10+0.30*s, 'lowpass'); this.tone(62, 0.22, 0.14*s, 'sine', -22); }
  jump()    { this.noiseHit(0.06, 620, 1.2, 0.06); }
  reel(dir) { this.noiseHit(0.05, 1900, 2.4, 0.05); }
}

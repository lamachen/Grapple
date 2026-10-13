'use strict';
/* tools/ref_edgecross.js — Referenz-Implementierung von edgeCross2D mit Residual-Prüfung.

   Unabhängig, langsam, aber korrekt: ein Treffer wird nur akzeptiert, wenn
   P(s,t) wirklich gleich q ist. Das ist der Maßstab, an dem die schnelle
   Fassung in src/02_rope.js gemessen wird (work/test_edgecross.js).

   Herleitung, mit der 2D-Determinante p×r := p_u·r_v − p_v·r_u:
     P(s,t) = a + t·e + s·(f + t·g) = q,   w := q − a
     (*)    t·e + s·(f + t·g) = w
     E = e×w, F = e×f, G = e×g, H = w×f, K = g×w
     (*) × e           ⇒  s·(F + t·G) = E + t·G    ⇒  s = (E+tG)/(F+tG)
     (*) × (f + t·g)   ⇒  G·t² + (F + K − H)·t + H = 0
                          (Translation, G = 0:  t = −H/(F + K − H))
   Numerische Kontrolle (work/test_edgecross.js):
     Translation Mitte  E 5, F 10, G 0, H 5, K 0        → t 0,500  s 0,500
     Schwenk um b       E 10, F 20, G −20, H 4, K 4     → t 0,200  s 0,625
     Orbit-Fall         E 37,39, F −1,854, G 1,854,
                        H 0,581, K 0,581                → t 0,854  s 0,0078
*/
function refCross(au, av, bu, bv, a2u, a2v, b2u, b2v, qu, qv, out) {
  const eu = bu - au, ev = bv - av;
  const fu = a2u - au, fv = a2v - av;
  const gu = (b2u - bu) - fu, gv = (b2v - bv) - fv;
  const wu = qu - au, wv = qv - av;
  const E = eu * wv - ev * wu;      // e × w
  const F = eu * fv - ev * fu;      // e × f
  const G = eu * gv - ev * gu;      // e × g
  const H = fu * wv - fv * wu;      // f × w
  const K = gu * wv - gv * wu;      // g × w
  const B = 2 * F + K;
  const scale = Math.max(1, Math.abs(G), Math.abs(B), Math.abs(H));
  const cands = [];
  if (Math.abs(G) < 1e-12 * scale) {
    if (Math.abs(B) > 1e-12 * scale) cands.push(-H / B);
  } else {
    const disc = B * B - 4 * G * H;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      cands.push((-B - sq) / (2 * G), (-B + sq) / (2 * G));
    }
  }
  for (const tc of cands) {
    if (tc < -1e-9 || tc > 1 + 1e-9) continue;
    const t = Math.min(1, Math.max(0, tc));
    const den = F + t * G;
    if (Math.abs(den) < 1e-12 * scale) continue;
    const sc = (E + t * G) / den;
    if (sc < -1e-9 || sc > 1 + 1e-9) continue;
    const s = Math.min(1, Math.max(0, sc));
    const mt = 1 - t, ms = 1 - s;
    const pu = ms * (mt * au + t * bu) + s * (mt * a2u + t * b2u);
    const pv = ms * (mt * av + t * bv) + s * (mt * a2v + t * b2v);
    const tol = 1e-6 * Math.max(1, Math.abs(qu), Math.abs(qv));
    if (Math.abs(pu - qu) > tol || Math.abs(pv - qv) > tol) continue;   // Residual
    if (out) { out.s = s; out.t = t; out.u = pu; out.v = pv; }
    return true;
  }
  return false;
}
module.exports = { refCross };

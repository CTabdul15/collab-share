// Collab Share 2D physics: rigid bodies (circles + convex polygons), gravity, collisions with
// friction and bounce, revolute/weld joints with motors, springs and ropes. Side view, y points down.
// Units: 1 board unit = 1 cm. Shared by the host's simulation (Node) and the Sandbox (browser).
(function (root) {
  'use strict';

  const GRAVITY = 980; // cm/s²
  const SUBSTEPS = 6, ITERATIONS = 10;
  const SLOP = 0.5, BAUMGARTE = 0.2, SLEEP_V = 6, SLEEP_W = 0.08, SLEEP_TIME = 0.6;

  const v = (x, y) => ({ x, y });
  const add = (a, b) => v(a.x + b.x, a.y + b.y), sub = (a, b) => v(a.x - b.x, a.y - b.y), mul = (a, s) => v(a.x * s, a.y * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y, cross = (a, b) => a.x * b.y - a.y * b.x;
  const crossSV = (s, a) => v(-s * a.y, s * a.x); // ω × r
  const len = (a) => Math.hypot(a.x, a.y);
  const rot = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return v(p.x * c - p.y * s, p.x * s + p.y * c); };

  /** Materials: density g/cm² (2D), bounce, friction. */
  const MATERIALS = {
    steel: { density: 7.8, rest: 0.04, fric: 0.45 },
    aluminium: { density: 2.7, rest: 0.08, fric: 0.4 },
    wood: { density: 0.7, rest: 0.2, fric: 0.6 },
    rubber: { density: 1.1, rest: 0.82, fric: 0.95 },
    foam: { density: 0.15, rest: 0.55, fric: 0.8 },
    lead: { density: 11.3, rest: 0.01, fric: 0.5 },
    ground: { density: 0, rest: 0, fric: 0.7 },
    ice: { density: 0.9, rest: 0.1, fric: 0.03 },
  };

  class Body {
    constructor(o) {
      this.id = o.id;
      this.shape = o.shape; // { type: 'circle', r } | { type: 'poly', verts: [{x,y}] (local, around the center) }
      this.x = o.x; this.y = o.y; this.a = o.a || 0;
      this.vx = 0; this.vy = 0; this.w = 0;
      this.kind = o.kind || 'dynamic'; // dynamic | static | kinematic
      const m = MATERIALS[o.material] || MATERIALS.steel;
      this.rest = o.rest ?? m.rest; this.fric = o.fric ?? m.fric;
      this.surface = 0; // conveyor surface speed (cm/s along the body's x axis)
      this.fx = 0; this.fy = 0; this.torque = 0;
      this.asleep = false; this.still = 0;
      this.tag = o.tag || '';
      this.magnetic = o.magnetic ?? (o.material === 'steel' || o.material === 'lead');
      this.contactImpulse = 0; // sum of normal impulses this tick (force sensors)
      this.setMass(this.kind === 'dynamic' ? (o.density ?? m.density) : 0);
      this.updateWorld();
    }
    setMass(density) {
      if (!density) { this.invM = 0; this.invI = 0; this.mass = 0; return; }
      let area, inertia;
      if (this.shape.type === 'circle') {
        const r = this.shape.r; area = Math.PI * r * r; inertia = 0.5 * area * r * r;
      } else {
        area = 0; inertia = 0;
        const p = this.shape.verts;
        for (let i = 0; i < p.length; i++) {
          const a = p[i], b = p[(i + 1) % p.length], c = cross(a, b);
          area += c / 2;
          inertia += (c * (dot(a, a) + dot(a, b) + dot(b, b))) / 12;
        }
        area = Math.abs(area); inertia = Math.abs(inertia);
      }
      const mass = (area * density) / 1000; // kg
      this.mass = mass; this.invM = 1 / mass; this.invI = 1 / ((inertia * density) / 1000);
    }
    updateWorld() {
      if (this.shape.type === 'poly') {
        const c = Math.cos(this.a), s = Math.sin(this.a);
        this.wv = this.shape.verts.map((p) => v(this.x + p.x * c - p.y * s, this.y + p.x * s + p.y * c));
        this.wn = this.wv.map((p, i) => { const q = this.wv[(i + 1) % this.wv.length], e = sub(q, p), l = len(e) || 1; return v(e.y / l, -e.x / l); });
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of this.wv) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
        this.box = { x1, y1, x2, y2 };
      } else {
        const r = this.shape.r;
        this.box = { x1: this.x - r, y1: this.y - r, x2: this.x + r, y2: this.y + r };
      }
    }
    wake() { this.asleep = false; this.still = 0; }
    velAt(r) { return add(v(this.vx, this.vy), crossSV(this.w, r)); }
    applyImpulse(P, r) {
      if (!this.invM) return;
      this.vx += P.x * this.invM; this.vy += P.y * this.invM; this.w += this.invI * cross(r, P);
    }
    /** World point → local point. */
    toLocal(p) { return rot(sub(p, v(this.x, this.y)), -this.a); }
    toWorld(p) { return add(v(this.x, this.y), rot(p, this.a)); }
    contains(p) {
      if (this.shape.type === 'circle') return Math.hypot(p.x - this.x, p.y - this.y) <= this.shape.r;
      for (let i = 0; i < this.wv.length; i++) if (dot(sub(p, this.wv[i]), this.wn[i]) > 0) return false;
      return true;
    }
  }

  // ------------------------------------------------------------------ collision detection
  function polyProject(verts, n) { let mn = Infinity, mx = -Infinity; for (const p of verts) { const d = dot(p, n); mn = Math.min(mn, d); mx = Math.max(mx, d); } return [mn, mx]; }

  /** Contacts between two bodies: [{ p, n (from A to B), depth }] or []. */
  function collide(A, B) {
    if (A.box.x2 < B.box.x1 || B.box.x2 < A.box.x1 || A.box.y2 < B.box.y1 || B.box.y2 < A.box.y1) return [];
    const ta = A.shape.type, tb = B.shape.type;
    if (ta === 'circle' && tb === 'circle') {
      const d = v(B.x - A.x, B.y - A.y), dist = len(d), r = A.shape.r + B.shape.r;
      if (dist >= r) return [];
      const n = dist > 1e-6 ? mul(d, 1 / dist) : v(0, -1);
      return [{ p: add(v(A.x, A.y), mul(n, A.shape.r)), n, depth: r - dist }];
    }
    if (ta === 'poly' && tb === 'circle') return polyCircle(A, B, false);
    if (ta === 'circle' && tb === 'poly') return polyCircle(B, A, true);
    return polyPoly(A, B);
  }
  function polyCircle(P, C, flip) {
    const c = v(C.x, C.y), r = C.shape.r;
    let best = -Infinity, bi = 0;
    for (let i = 0; i < P.wv.length; i++) { const s = dot(sub(c, P.wv[i]), P.wn[i]); if (s > r) return []; if (s > best) { best = s; bi = i; } }
    const a = P.wv[bi], b = P.wv[(bi + 1) % P.wv.length];
    let n, point, depth;
    if (best < 1e-9) { n = P.wn[bi]; depth = r - best; point = sub(c, mul(n, r)); }
    else {
      const e = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(c, a), e) / dot(e, e))), q = add(a, mul(e, t));
      const d = sub(c, q), dist = len(d);
      if (dist > r) return [];
      n = dist > 1e-6 ? mul(d, 1 / dist) : P.wn[bi]; depth = r - dist; point = q;
    }
    return [{ p: point, n: flip ? mul(n, -1) : n, depth }];
  }
  function polyPoly(A, B) {
    const axis = (X, Y) => {
      let best = -Infinity, bi = -1;
      for (let i = 0; i < X.wv.length; i++) {
        const n = X.wn[i]; let mn = Infinity;
        for (const p of Y.wv) mn = Math.min(mn, dot(sub(p, X.wv[i]), n));
        if (mn > best) { best = mn; bi = i; }
      }
      return { sep: best, i: bi };
    };
    const ea = axis(A, B); if (ea.sep > 0) return [];
    const eb = axis(B, A); if (eb.sep > 0) return [];
    let ref, inc, ri, flip;
    if (eb.sep > ea.sep + 0.05) { ref = B; inc = A; ri = eb.i; flip = true; } else { ref = A; inc = B; ri = ea.i; flip = false; }
    const n = ref.wn[ri];
    // incident edge: most anti-parallel to n
    let ii = 0, mn = Infinity;
    for (let i = 0; i < inc.wn.length; i++) { const d = dot(inc.wn[i], n); if (d < mn) { mn = d; ii = i; } }
    let pts = [inc.wv[ii], inc.wv[(ii + 1) % inc.wv.length]];
    const r1 = ref.wv[ri], r2 = ref.wv[(ri + 1) % ref.wv.length], t = sub(r2, r1), tl = len(t) || 1, tu = mul(t, 1 / tl);
    const clip = (pts, nrm, off) => {
      const out = [], d0 = dot(nrm, pts[0]) - off, d1 = dot(nrm, pts[1]) - off;
      if (d0 <= 0) out.push(pts[0]); if (d1 <= 0) out.push(pts[1]);
      if (d0 * d1 < 0) out.push(add(pts[0], mul(sub(pts[1], pts[0]), d0 / (d0 - d1))));
      return out;
    };
    pts = clip(pts, mul(tu, -1), -dot(tu, r1)); if (pts.length < 2) return pts.length ? fin(pts) : [];
    pts = clip(pts, tu, dot(tu, r2));
    function fin(ps) {
      const out = [];
      for (const p of ps) { const sep = dot(sub(p, r1), n); if (sep <= 0) out.push({ p, n: flip ? mul(n, -1) : n, depth: -sep }); }
      return out;
    }
    return fin(pts);
  }

  // ------------------------------------------------------------------ world
  class World {
    constructor() {
      this.bodies = new Map(); this.joints = []; this.springs = []; this.forces = [];
      this.gravity = GRAVITY; this.contacts = [];
    }
    add(b) { this.bodies.set(b.id, b); return b; }
    /** Bodies at a world point, topmost (last added) first. */
    bodiesAt(p, filter) { return [...this.bodies.values()].reverse().filter((b) => b.contains(p) && (!filter || filter(b))); }

    step(dt) {
      const h = dt / SUBSTEPS;
      for (const b of this.bodies.values()) b.contactImpulse = 0;
      for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
      // sleeping
      for (const b of this.bodies.values()) {
        if (b.kind !== 'dynamic') continue;
        if (Math.hypot(b.vx, b.vy) < SLEEP_V && Math.abs(b.w) < SLEEP_W && !b.pushed) { b.still += dt; if (b.still > SLEEP_TIME) { b.asleep = true; b.vx = b.vy = b.w = 0; } }
        else b.wake();
        b.pushed = false;
      }
    }
    substep(h) {
      const bodies = [...this.bodies.values()];
      // external forces: gravity, user forces (thrusters, magnets, nozzles), springs
      for (const f of this.forces) f(h);
      for (const sp of this.springs) sp.apply();
      for (const b of bodies) {
        if (b.kind !== 'dynamic' || b.asleep) { b.fx = b.fy = b.torque = 0; continue; }
        b.vy += this.gravity * h;
        b.vx += b.fx * b.invM * h; b.vy += b.fy * b.invM * h; b.w += b.torque * b.invI * h;
        if (b.fx || b.fy || b.torque) b.pushed = true;
        b.vx *= 0.99995; b.vy *= 0.99995; b.w *= 0.9997; // a little air drag
        b.fx = b.fy = b.torque = 0; // forces are added again each substep
      }
      // contacts
      const contacts = [];
      for (let i = 0; i < bodies.length; i++) {
        const A = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const B = bodies[j];
          if (A.kind !== 'dynamic' && B.kind !== 'dynamic') continue;
          if ((A.asleep || A.kind !== 'dynamic') && (B.asleep || B.kind !== 'dynamic')) continue;
          if (this.ignore && this.ignore(A, B)) continue;
          for (const c of collide(A, B)) {
            c.A = A; c.B = B; c.rA = sub(c.p, v(A.x, A.y)); c.rB = sub(c.p, v(B.x, B.y));
            const t = v(-c.n.y, c.n.x);
            const kn = A.invM + B.invM + A.invI * cross(c.rA, c.n) ** 2 + B.invI * cross(c.rB, c.n) ** 2;
            const kt = A.invM + B.invM + A.invI * cross(c.rA, t) ** 2 + B.invI * cross(c.rB, t) ** 2;
            c.mn = kn > 0 ? 1 / kn : 0; c.mt = kt > 0 ? 1 / kt : 0; c.t = t;
            const rv = sub(B.velAt(c.rB), A.velAt(c.rA)), vn = dot(rv, c.n);
            const e = Math.max(A.rest, B.rest);
            c.bounce = vn < -120 && e > 0.05 ? -e * vn : 0;
            // push overlapping bodies apart gently (never together with a bounce, so no energy is added)
            c.bias = c.bounce ? 0 : Math.min(25, (BAUMGARTE / h) * Math.max(0, c.depth - SLOP));
            c.fric = Math.sqrt(A.fric * B.fric);
            c.surf = (B.surface ? dot(rot(v(1, 0), B.a), t) * B.surface : 0) - (A.surface ? dot(rot(v(1, 0), A.a), t) * A.surface : 0);
            c.Pn = 0; c.Pt = 0;
            if (A.asleep) A.wake(); if (B.asleep) B.wake();
            contacts.push(c);
          }
        }
      }
      this.contacts = contacts;
      for (const j of this.joints) j.pre(h);
      for (let it = 0; it < ITERATIONS; it++) {
        for (const j of this.joints) j.solve(h);
        for (const c of contacts) {
          const { A, B, n, t } = c;
          let rv = sub(B.velAt(c.rB), A.velAt(c.rA));
          // normal
          const vn = dot(rv, n);
          let dPn = c.mn * (-vn + c.bias + c.bounce);
          const Pn0 = c.Pn; c.Pn = Math.max(0, Pn0 + dPn); dPn = c.Pn - Pn0;
          const P = mul(n, dPn); A.applyImpulse(mul(P, -1), c.rA); B.applyImpulse(P, c.rB);
          // friction (with conveyor surface speed)
          rv = sub(B.velAt(c.rB), A.velAt(c.rA));
          const vt = dot(rv, t) + c.surf;
          let dPt = -c.mt * vt;
          const maxF = c.fric * c.Pn, Pt0 = c.Pt;
          c.Pt = Math.max(-maxF, Math.min(maxF, Pt0 + dPt)); dPt = c.Pt - Pt0;
          const T = mul(t, dPt); A.applyImpulse(mul(T, -1), c.rA); B.applyImpulse(T, c.rB);
        }
      }
      for (const c of contacts) { c.A.contactImpulse += c.Pn; c.B.contactImpulse += c.Pn; }
      // integrate positions
      for (const b of bodies) {
        if (b.kind === 'static' || b.asleep) continue;
        b.x += b.vx * h; b.y += b.vy * h; b.a += b.w * h;
        b.updateWorld();
      }
    }
  }

  // ------------------------------------------------------------------ joints
  /** Pin joint: anchor points on A and B (B = null means the world) stay together; optional motor. */
  class Revolute {
    constructor(A, B, worldPoint) {
      this.A = A; this.B = B;
      this.la = A.toLocal(worldPoint);
      this.lb = B ? B.toLocal(worldPoint) : worldPoint;
      this.refAngle = (B ? B.a : 0) - A.a;
      this.motor = false; this.speed = 0; this.maxTorque = 0; this.Pm = 0;
      this.target = null; // servo: target angle (relative), rad
    }
    pre(h) {
      const A = this.A, B = this.B;
      this.rA = rot(this.la, A.a); this.rB = B ? rot(this.lb, B.a) : v(0, 0);
      const pA = add(v(A.x, A.y), this.rA), pB = B ? add(v(B.x, B.y), this.rB) : this.lb;
      this.err = sub(pB, pA);
      this.bias = mul(this.err, 0.2 / h);
      const iA = A.invI, iB = B ? B.invI : 0, mA = A.invM, mB = B ? B.invM : 0;
      const k11 = mA + mB + iA * this.rA.y ** 2 + iB * this.rB.y ** 2, k12 = -iA * this.rA.x * this.rA.y - iB * this.rB.x * this.rB.y, k22 = mA + mB + iA * this.rA.x ** 2 + iB * this.rB.x ** 2;
      const det = k11 * k22 - k12 * k12;
      this.K = det ? { a: k22 / det, b: -k12 / det, d: k11 / det } : { a: 0, b: 0, d: 0 };
      this.mAng = iA + iB > 0 ? 1 / (iA + iB) : 0;
      if (this.motor || this.target !== null) { if (A.asleep) A.wake(); if (B && B.asleep) B.wake(); }
      this.h = h; this.Pm = 0; // the motor limit applies per step
    }
    solve(h) {
      const A = this.A, B = this.B;
      // motor / servo on the relative angular speed
      if ((this.motor || this.target !== null) && this.mAng) {
        let goal = this.speed;
        if (this.target !== null) { const rel = (B ? B.a : 0) - A.a - this.refAngle; goal = Math.max(-6, Math.min(6, (this.target - rel) * 8)); }
        const wrel = (B ? B.w : 0) - A.w;
        let dP = this.mAng * (goal - wrel);
        const max = this.maxTorque * h, P0 = this.Pm;
        this.Pm = Math.max(-max, Math.min(max, P0 + dP)); dP = this.Pm - P0;
        A.w -= A.invI * dP; if (B) B.w += B.invI * dP;
      }
      const vA = A.velAt(this.rA), vB = B ? B.velAt(this.rB) : v(0, 0);
      const cdot = add(sub(vB, vA), this.bias);
      const P = v(-(this.K.a * cdot.x + this.K.b * cdot.y), -(this.K.b * cdot.x + this.K.d * cdot.y));
      A.applyImpulse(mul(P, -1), this.rA); if (B) B.applyImpulse(P, this.rB);
    }
  }
  /** Weld: a pin joint that also keeps the angle. */
  class Weld extends Revolute {
    solve(h) {
      const A = this.A, B = this.B;
      if (this.mAng) {
        const rel = (B ? B.a : 0) - A.a - this.refAngle, wrel = (B ? B.w : 0) - A.w;
        const dP = -this.mAng * (wrel + (0.25 / h) * rel);
        A.w -= A.invI * dP; if (B) B.w += B.invI * dP;
      }
      super.solve(h);
    }
  }
  /** Spring / rope between two anchor points (bodies or world). */
  class Spring {
    constructor(A, pa, B, pb, o) {
      this.A = A; this.B = B;
      this.la = A ? A.toLocal(pa) : pa; this.lb = B ? B.toLocal(pb) : pb;
      this.rest = o.rest; this.k = o.k; this.damp = o.damp; this.rope = !!o.rope;
    }
    ends() {
      const pa = this.A ? this.A.toWorld(this.la) : this.la, pb = this.B ? this.B.toWorld(this.lb) : this.lb;
      return [pa, pb];
    }
    apply() {
      const [pa, pb] = this.ends(), d = sub(pb, pa), L = len(d);
      if (L < 1e-6) return;
      if (this.rope && L <= this.rest) return;
      const n = mul(d, 1 / L);
      const rA = this.A ? sub(pa, v(this.A.x, this.A.y)) : v(0, 0), rB = this.B ? sub(pb, v(this.B.x, this.B.y)) : v(0, 0);
      const vrel = dot(sub(this.B ? this.B.velAt(rB) : v(0, 0), this.A ? this.A.velAt(rA) : v(0, 0)), n);
      const F = this.k * (L - this.rest) + this.damp * vrel;
      const f = mul(n, F);
      if (this.A && this.A.invM) { this.A.fx += f.x; this.A.fy += f.y; this.A.torque += cross(rA, f); this.A.wake(); }
      if (this.B && this.B.invM) { this.B.fx -= f.x; this.B.fy -= f.y; this.B.torque -= cross(rB, f); this.B.wake(); }
    }
  }

  // ------------------------------------------------------------------ shape helpers
  const boxVerts = (w, h) => [v(-w / 2, -h / 2), v(w / 2, -h / 2), v(w / 2, h / 2), v(-w / 2, h / 2)];
  const rampVerts = (w, h) => [v(-w / 2, h / 2), v(w / 2, -h / 2), v(w / 2, h / 2)].map((p) => sub(p, v(w / 6, h / 6))); // centroid at 0
  function segmentHitsBody(a, b, body) {
    const L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(2, Math.ceil(L / 4));
    for (let i = 0; i <= n; i++) if (body.contains(v(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n))) return true;
    return false;
  }

  const api = { World, Body, Revolute, Weld, Spring, MATERIALS, GRAVITY, boxVerts, rampVerts, segmentHitsBody, collide, rot, v };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollabPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

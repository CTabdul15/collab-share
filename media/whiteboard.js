// Collab Share blueprint whiteboard. Runs in a VS Code webview; the extension syncs the shapes.
// Shapes are plain objects keyed by id. Blueprint nodes (logic gates, math functions like Clamp)
// are connected with wires and evaluated live on every client.
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const editBox = document.getElementById('edit');
  const FONT = '"Cascadia Mono", Consolas, monospace';

  // ------------------------------------------------------------------ state
  let dpr = window.devicePixelRatio || 1;
  let shapes = [];                // sorted for drawing
  const byId = new Map();
  let me = { id: -1, name: 'me', color: '#fff' };
  let readOnly = false;
  let view = { x: -60, y: -110, z: 1 };
  let tool = 'select';
  const style = { color: '#ffffff', w: 2, dash: false, fill: false };
  let snap = false;
  let placing = null;             // node kind waiting to be placed
  let selection = new Set();
  let drag = null;                // current pointer interaction
  let spaceDown = false;
  let hoverPin = null;
  let mouseWorld = { x: 0, y: 0 };
  const pointers = new Map();
  let lastPtr = 0;
  const history = [], future = [];
  let clipboard = [];
  let values = new Map(), inputsOf = new Map();

  const uid = () => me.id + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const GRID = 20; // one square of the blueprint grid
  const snapV = (v) => (snap ? Math.round(v / GRID) * GRID : v);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ circuits (simulated on the host, see circuit.js)
  const CC = window.CollabCircuit;
  const { def, pinPos, truthy } = CC;
  let sim = { v: new Map(), i: new Map(), s: new Map() };
  function evaluate() {
    values = sim.v;
    inputsOf = sim.i;
  }
  const memOf = (id) => sim.s.get(id) || {};
  let editingId = null; // shape whose text is being typed (its canvas text is hidden meanwhile)
  const fmt = (v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(Math.round(v * 1000) / 1000));

  // ------------------------------------------------------------------ geometry
  const toWorld = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.z + view.x, y: (e.clientY - r.top) / view.z + view.y };
  };
  const toScreen = (x, y) => ({ x: (x - view.x) * view.z, y: (y - view.y) * view.z });
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
    let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function wirePoints(w) {
    const A = byId.get(w.a.n), B = byId.get(w.b.n);
    if (!A || !B) return null;
    const moving = poseNow.has(A.id) || poseNow.has(B.id); // cables to moving parts: a loose curve
    return { a: pinPos(A, 'out', w.a.p), b: pinPos(B, 'in', w.b.p), ba: moving ? null : worldBox(A), bb: moving ? null : worldBox(B), skip: [A.id, B.id], moving };
  }
  // ------------------------------------------------------------------ physics poses (from the host's simulation, 20 per second, smoothed)
  let posePrev = new Map(), poseCur = new Map(), poseT = 0, poseNow = new Map(), springEnds = new Map();
  function updatePoses() {
    const k = Math.max(0, Math.min(1, (performance.now() - poseT) / 50));
    poseNow = new Map();
    for (const [id, q] of poseCur) {
      const p = posePrev.get(id) || q;
      let da = q[2] - p[2]; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      poseNow.set(id, { x: p[0] + (q[0] - p[0]) * k, y: p[1] + (q[1] - p[1]) * k, a: p[2] + da * k });
    }
  }
  CC.setPoseProvider((n) => poseNow.get(n.id) || null);
  // Wire style: curved or square (right angles with rounded corners). A per-person view setting.
  let wireStyle = 'curve';
  try { wireStyle = localStorage.getItem('collab.wireStyle') || 'curve'; } catch { /* ignore */ }
  let routeCache = new Map(), routeVersion = 0, routeCacheVersion = -1;
  function wirePath(a, b, ba, bb, skip) {
    if (!ba && !bb && skip) return bezier(a, b); // to or from a moving part
    if (routeCacheVersion !== routeVersion) { routeCache = new Map(); routeCacheVersion = routeVersion; }
    const key = [wireStyle, a.x, a.y, a.dx, a.dy, b.x, b.y, b.dx, b.dy, skip && skip.join()].join('|');
    let r = routeCache.get(key);
    if (!r) {
      r = elbow(a, b, ba, bb, skip); // both styles go around modules; the curved style rounds the bends
      if (wireStyle !== 'square') r = smoothRoute(r, 34);
      if (routeCache.size < 5000) routeCache.set(key, r);
    }
    return r;
  }
  /** Boxes of all modules, to steer square wires around them. */
  function obstacles(skip) {
    const out = [];
    for (const n of shapes) if (n.type === 'node' && !(skip && skip.includes(n.id))) out.push(worldBox(n));
    return out;
  }
  /** How many modules a right-angle path runs through. */
  function crossings(pts, boxes) {
    let hits = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
      for (const b of boxes) if (x2 > b.x1 - 3 && x1 < b.x2 + 3 && y2 > b.y1 - 3 && y1 < b.y2 + 3) hits++;
    }
    return hits;
  }
  /**
   * Route between two pins that leaves/enters each pin in its own direction and goes around every
   * module (including the two it connects): tries straight, L, Z and detour shapes through free
   * lanes next to the modules and keeps the one with the fewest crossings, then the shortest.
   */
  function elbow(a, b, ba, bb, skip) {
    const S = 18;
    const adx = a.dx ?? 1, ady = a.dy ?? 0, bdx = b.dx ?? -1, bdy = b.dy ?? 0;
    const A = { x: a.x, y: a.y }, B = { x: b.x, y: b.y };
    const a1 = { x: a.x + adx * S, y: a.y + ady * S }, b1 = { x: b.x + bdx * S, y: b.y + bdy * S };
    const others = ba && bb ? obstacles(skip) : [];
    const own = [ba, bb].filter(Boolean);
    const all = others.concat(own);
    // straight across (pins facing each other on one line)
    if (Math.abs(a.y - b.y) < 1.5 && Math.abs(ady) < 0.5 && Math.abs(bdy) < 0.5 && adx * (b.x - a.x) > 4 && adx === -bdx && crossings([A, B], others) === 0) return [A, B];
    if (Math.abs(a.x - b.x) < 1.5 && Math.abs(adx) < 0.5 && Math.abs(bdx) < 0.5 && ady * (b.y - a.y) > 4 && ady === -bdy && crossings([A, B], others) === 0) return [A, B];
    // lanes: next to the modules near the two pins, plus the stubs and the middle
    const rx1 = Math.min(a1.x, b1.x) - 160, rx2 = Math.max(a1.x, b1.x) + 160, ry1 = Math.min(a1.y, b1.y) - 160, ry2 = Math.max(a1.y, b1.y) + 160;
    const near = all.filter((q) => q.x2 > rx1 && q.x1 < rx2 && q.y2 > ry1 && q.y1 < ry2);
    const uniq = (arr) => [...new Set(arr.map((v) => Math.round(v)))];
    const xs = uniq([a1.x, b1.x, (a1.x + b1.x) / 2, ...near.flatMap((q) => [q.x1 - 16, q.x2 + 16])]);
    const ys = uniq([a1.y, b1.y, (a1.y + b1.y) / 2, ...near.flatMap((q) => [q.y1 - 16, q.y2 + 16])]);
    const len = (pts) => pts.reduce((s, p, i) => (i ? s + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0);
    let best = null;
    const tryPath = (mid) => {
      const inner = [a1, ...mid, b1];
      const score = crossings(inner, all) * 10000 + len(inner) + mid.length * 12;
      if (!best || score < best.score) best = { score, inner };
    };
    tryPath([{ x: b1.x, y: a1.y }]);
    tryPath([{ x: a1.x, y: b1.y }]);
    for (const mx of xs) tryPath([{ x: mx, y: a1.y }, { x: mx, y: b1.y }]);
    for (const my of ys) tryPath([{ x: a1.x, y: my }, { x: b1.x, y: my }]);
    if (best.score >= 10000) {
      // detours with four turns, through lanes close to the start and the end
      const closest = (arr, v) => arr.slice().sort((p, q) => Math.abs(p - v) - Math.abs(q - v)).slice(0, 10);
      const xa = closest(xs, a1.x), xb = closest(xs, b1.x), ya = closest(ys, a1.y), yb = closest(ys, b1.y);
      for (const mx1 of xa) for (const my of ys) for (const mx2 of xb) tryPath([{ x: mx1, y: a1.y }, { x: mx1, y: my }, { x: mx2, y: my }, { x: mx2, y: b1.y }]);
      for (const my1 of ya) for (const mx of xs) for (const my2 of yb) tryPath([{ x: a1.x, y: my1 }, { x: mx, y: my1 }, { x: mx, y: my2 }, { x: b1.x, y: my2 }]);
    }
    const pts = [A, ...best.inner, B];
    // drop repeated and in-line points
    const out = [];
    for (const p of pts) {
      if (out.length && Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) < 0.5) continue;
      if (out.length >= 2) {
        const q = out[out.length - 1], r = out[out.length - 2];
        if ((Math.abs(r.x - q.x) < 0.5 && Math.abs(q.x - p.x) < 0.5) || (Math.abs(r.y - q.y) < 0.5 && Math.abs(q.y - p.y) < 0.5)) out.pop();
      }
      out.push(p);
    }
    return out;
  }
  /** The same route with smooth bends (for the curved wire style): corners become sampled arcs. */
  function smoothRoute(pts, r) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i - 1], n = pts[i + 1];
      const d1 = Math.hypot(p.x - q.x, p.y - q.y), d2 = Math.hypot(n.x - p.x, n.y - p.y);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      const s = { x: p.x + ((q.x - p.x) * rr) / d1, y: p.y + ((q.y - p.y) * rr) / d1 }, e = { x: p.x + ((n.x - p.x) * rr) / d2, y: p.y + ((n.y - p.y) * rr) / d2 };
      for (let k = 0; k <= 8; k++) { const t = k / 8, u = 1 - t; out.push({ x: u * u * s.x + 2 * u * t * p.x + t * t * e.x, y: u * u * s.y + 2 * u * t * p.y + t * t * e.y }); }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  /** Polyline with rounded corners. */
  function roundedPoly(c, pts, r) {
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i - 1], n = pts[i + 1];
      const rr = Math.min(r, Math.hypot(p.x - q.x, p.y - q.y) / 2, Math.hypot(n.x - p.x, n.y - p.y) / 2);
      c.arcTo(p.x, p.y, n.x, n.y, rr);
    }
    c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  /** Points of a square-style line/arrow shape. */
  const elbowLine = (s) => { const mx = (s.x1 + s.x2) / 2; return [{ x: s.x1, y: s.y1 }, { x: mx, y: s.y1 }, { x: mx, y: s.y2 }, { x: s.x2, y: s.y2 }]; };
  function bezier(a, b, steps = 24) {
    const k = Math.max(36, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
    const c1 = { x: a.x + (a.dx ?? 1) * k, y: a.y + (a.dy ?? 0) * k };
    const c2 = { x: b.x + (b.dx ?? -1) * k, y: b.y + (b.dy ?? 0) * k };
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      });
    }
    return pts;
  }
  function textLines(s) { return String(s.text ?? '').split('\n'); }
  function measureText(s) {
    ctx.save(); ctx.font = s.size + 'px ' + FONT;
    const w = Math.max(10, ...textLines(s).map((l) => ctx.measureText(l).width));
    ctx.restore();
    return w;
  }
  function bbox(s) {
    switch (s.type) {
      case 'pen': {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (let i = 0; i < s.pts.length; i += 2) { a = Math.min(a, s.pts[i]); b = Math.min(b, s.pts[i + 1]); c = Math.max(c, s.pts[i]); d = Math.max(d, s.pts[i + 1]); }
        return { x1: a, y1: b, x2: c, y2: d };
      }
      case 'text': return { x1: s.x, y1: s.y, x2: s.x + measureText(s), y2: s.y + textLines(s).length * s.size * 1.25 };
      case 'note': return { x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y + s.h };
      case 'node': { const d = def(s.kind) ? CC.sizeOf(s) : { w: 60, h: 40 }; return { x1: s.x, y1: s.y, x2: s.x + d.w, y2: s.y + d.h }; }
      case 'wire': {
        const p = wirePoints(s);
        if (!p) return { x1: 0, y1: 0, x2: 0, y2: 0 };
        return { x1: Math.min(p.a.x, p.b.x), y1: Math.min(p.a.y, p.b.y), x2: Math.max(p.a.x, p.b.x), y2: Math.max(p.a.y, p.b.y) };
      }
      default: return { x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2), x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) };
    }
  }
  // Rotation: shapes keep their unrotated geometry plus `rot` (degrees) around their centre.
  const rad = (s) => ((s.rot || 0) * Math.PI) / 180;
  function center(s) { const b = bbox(s); return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 }; }
  function rotPt(p, c, a) {
    const cos = Math.cos(a), sin = Math.sin(a);
    return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos };
  }
  /** A point in the shape's own (unrotated) coordinates. */
  function local(s, p) { return s.rot && s.type !== 'wire' ? rotPt(p, center(s), -rad(s)) : p; }
  /** Bounding box on the board, including rotation. */
  function worldBox(s) {
    const b = bbox(s);
    if (!s.rot || s.type === 'wire') return b;
    const c = center(s);
    const pts = [[b.x1, b.y1], [b.x2, b.y1], [b.x1, b.y2], [b.x2, b.y2]].map(([x, y]) => rotPt({ x, y }, c, rad(s)));
    return { x1: Math.min(...pts.map((q) => q.x)), y1: Math.min(...pts.map((q) => q.y)), x2: Math.max(...pts.map((q) => q.x)), y2: Math.max(...pts.map((q) => q.y)) };
  }
  const normDeg = (d) => ((Math.round(d) % 360) + 360) % 360;
  /** Draws in a shape's rotated frame. */
  function inFrame(c, s, fn) {
    if (!s.rot || s.type === 'wire') { fn(); return; }
    const o = center(s);
    c.save(); c.translate(o.x, o.y); c.rotate(rad(s)); c.translate(-o.x, -o.y);
    fn();
    c.restore();
  }

  /** A pen stroke that ends near where it started (a closed outline you can fill). */
  function penClosed(s) {
    const p = s.pts, n = p.length;
    if (n < 8) return false;
    const b = bbox(s), size = Math.max(b.x2 - b.x1, b.y2 - b.y1);
    return Math.hypot(p[0] - p[n - 2], p[1] - p[n - 1]) <= Math.max(14, size * 0.18);
  }
  function inPolygon(pts, q) {
    let inside = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if ((yi > q.y) !== (yj > q.y) && q.x < ((xj - xi) * (q.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** Is the point inside the area of a shape (not just on its outline)? */
  function insideArea(s, p) {
    const q = local(s, p), b = bbox(s);
    const inBox = q.x >= b.x1 && q.x <= b.x2 && q.y >= b.y1 && q.y <= b.y2;
    switch (s.type) {
      case 'rect': case 'note': case 'text': case 'node': return inBox;
      case 'ellipse': { const rx = Math.max(1, (b.x2 - b.x1) / 2), ry = Math.max(1, (b.y2 - b.y1) / 2); return Math.hypot((q.x - (b.x1 + rx)) / rx, (q.y - (b.y1 + ry)) / ry) <= 1; }
      case 'diamond': { const rx = Math.max(1, (b.x2 - b.x1) / 2), ry = Math.max(1, (b.y2 - b.y1) / 2); return Math.abs(q.x - (b.x1 + rx)) / rx + Math.abs(q.y - (b.y1 + ry)) / ry <= 1; }
      case 'pen': return penClosed(s) && inPolygon(s.pts, q);
      default: return false;
    }
  }
  /** Fill bucket: fills the top shape under the point with the current color (Shift: remove the fill). */
  function bucketAt(p, remove) {
    let target = null;
    for (let i = shapes.length - 1; i >= 0 && !target; i--) if (shapes[i].type === 'node' && insideArea(shapes[i], p)) target = shapes[i];
    for (let i = shapes.length - 1; i >= 0 && !target; i--) if (shapes[i].type !== 'node' && insideArea(shapes[i], p)) target = shapes[i];
    if (!target) {
      notice = { text: 'Click inside a shape to fill it (rectangle, ellipse, diamond, closed pen drawing, note…)', x: p.x, y: p.y, until: Date.now() + 2200 };
      setTimeout(redraw, 2300); redraw();
      return;
    }
    const s = clone(target);
    if (['rect', 'ellipse', 'diamond', 'pen'].includes(s.type)) {
      if (remove) { s.fill = false; delete s.fillColor; delete s.fillAlpha; }
      else { s.fill = true; s.fillColor = style.color; s.fillAlpha = 1; }
    } else if (s.type === 'note') s.color = remove ? '#ffd166' : style.color === '#ffffff' ? '#ffd166' : style.color;
    else if (s.type === 'text') s.color = remove ? '#ffffff' : style.color;
    else if (s.type === 'node') { if (remove) delete s.color; else s.color = style.color; }
    commit([s]);
  }

  function hit(s, p) {
    p = local(s, p);
    const tol = 6 / view.z + (s.w || 2) / 2;
    switch (s.type) {
      case 'pen':
        if (s.fill && penClosed(s) && inPolygon(s.pts, p)) return true;
        for (let i = 2; i < s.pts.length; i += 2) if (segDist(p.x, p.y, s.pts[i - 2], s.pts[i - 1], s.pts[i], s.pts[i + 1]) < tol) return true;
        return s.pts.length === 2 && Math.hypot(p.x - s.pts[0], p.y - s.pts[1]) < tol;
      case 'line': case 'arrow': case 'dim':
        if (s.elbow && s.type !== 'dim') { const q = elbowLine(s); for (let i = 1; i < q.length; i++) if (segDist(p.x, p.y, q[i - 1].x, q[i - 1].y, q[i].x, q[i].y) < tol) return true; return false; }
        return segDist(p.x, p.y, s.x1, s.y1, s.x2, s.y2) < tol;
      case 'wire': {
        const w = wirePoints(s);
        if (!w) return false;
        const pts = wirePath(w.a, w.b, w.ba, w.bb, w.skip);
        for (let i = 1; i < pts.length; i++) if (segDist(p.x, p.y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) < 6 / view.z + 2) return true;
        return false;
      }
      case 'rect': case 'ellipse': case 'diamond': {
        const b = bbox(s);
        if (s.fill && p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2) return true;
        if (s.type === 'rect') {
          return [[b.x1, b.y1, b.x2, b.y1], [b.x2, b.y1, b.x2, b.y2], [b.x2, b.y2, b.x1, b.y2], [b.x1, b.y2, b.x1, b.y1]]
            .some(([a, c, d, e]) => segDist(p.x, p.y, a, c, d, e) < tol);
        }
        if (s.type === 'diamond') {
          const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
          return [[cx, b.y1, b.x2, cy], [b.x2, cy, cx, b.y2], [cx, b.y2, b.x1, cy], [b.x1, cy, cx, b.y1]]
            .some(([a, c, d, e]) => segDist(p.x, p.y, a, c, d, e) < tol);
        }
        const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, rx = Math.max(1, (b.x2 - b.x1) / 2), ry = Math.max(1, (b.y2 - b.y1) / 2);
        return Math.abs(Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) * Math.min(rx, ry) < tol;
      }
      case 'node': {
        const b = bbox(s), m = Math.min(3, 3 / view.z);
        return p.x >= b.x1 - m && p.x <= b.x2 + m && p.y >= b.y1 - m && p.y <= b.y2 + m;
      }
      default: {
        const b = bbox(s);
        return p.x >= b.x1 - tol && p.x <= b.x2 + tol && p.y >= b.y1 - tol && p.y <= b.y2 + tol;
      }
    }
  }
  function moved(s, dx, dy) {
    const c = clone(s);
    if (c.pts) c.pts = c.pts.map((v, i) => (i % 2 ? v + dy : v + dx));
    if ('x1' in c) { c.x1 += dx; c.x2 += dx; c.y1 += dy; c.y2 += dy; }
    if ('x' in c) { c.x += dx; c.y += dy; }
    return c;
  }
  function scaled(s, b0, b1) {
    const sx = (b1.x2 - b1.x1) / Math.max(1, b0.x2 - b0.x1), sy = (b1.y2 - b1.y1) / Math.max(1, b0.y2 - b0.y1);
    const mx = (x) => b1.x1 + (x - b0.x1) * sx, my = (y) => b1.y1 + (y - b0.y1) * sy;
    const c = clone(s);
    if (c.pts) c.pts = c.pts.map((v, i) => (i % 2 ? my(v) : mx(v)));
    if ('x1' in c) { c.x1 = mx(c.x1); c.x2 = mx(c.x2); c.y1 = my(c.y1); c.y2 = my(c.y2); }
    if (c.type === 'text') { c.x = mx(c.x); c.y = my(c.y); c.size = Math.max(6, c.size * sy); }
    if (c.type === 'note') { c.x = b1.x1; c.y = b1.y1; c.w = Math.max(40, b1.x2 - b1.x1); c.h = Math.max(30, b1.y2 - b1.y1); }
    if (c.type === 'node') { c.x = b1.x1; c.y = b1.y1; c.bw = Math.max(16, Math.round(b1.x2 - b1.x1)); c.bh = Math.max(8, Math.round(b1.y2 - b1.y1)); if ((def(c.kind) || {}).square) c.bw = c.bh = Math.max(c.bw, c.bh); delete c.home; }
    return c;
  }
  const resizable = (s) => s && (s.type === 'node' ? !!(def(s.kind) || {}).resizable : s.type !== 'wire');

  // ------------------------------------------------------------------ changes (synced + undoable)
  /** Applies changes, sends them to everyone, and records them for undo. */
  function commit(set, del = [], record = true, beforeStates) {
    set = set.filter(Boolean);
    const ids = [...new Set([...set.map((s) => s.id), ...del])];
    if (!ids.length || readOnly) return;
    const before = beforeStates && beforeStates.length === ids.length ? beforeStates : ids.map((id) => (byId.has(id) ? clone(byId.get(id)) : null));
    vscode.postMessage({ type: 'batch', set, del });
    // Apply locally right away; the extension echoes the authoritative state.
    for (const id of del) byId.delete(id);
    for (const s of set) byId.set(s.id, s);
    sortShapes();
    if (record) {
      const after = ids.map((id) => (byId.has(id) ? clone(byId.get(id)) : null));
      history.push({ ids, before, after });
      if (history.length > 200) history.shift();
      future.length = 0;
    }
    redraw();
  }
  function restore(ids, states) {
    const set = [], del = [];
    ids.forEach((id, i) => (states[i] ? set.push(states[i]) : del.push(id)));
    commit(set, del, false);
  }
  function undo() { const h = history.pop(); if (h) { restore(h.ids, h.before); future.push(h); } }
  function redo() { const h = future.pop(); if (h) { restore(h.ids, h.after); history.push(h); } }

  /** Deleting nodes also deletes their wires. */
  function withWires(ids) {
    const all = new Set(ids);
    for (const s of shapes) if (s.type === 'wire' && (all.has(s.a.n) || all.has(s.b.n))) all.add(s.id);
    return [...all];
  }
  const maxZ = () => shapes.reduce((m, s) => Math.max(m, s.z ?? s.t ?? 0), 0);
  const minZ = () => shapes.reduce((m, s) => Math.min(m, s.z ?? s.t ?? 0), Infinity);
  function base(type) {
    return { id: uid(), type, color: style.color, w: style.w, dash: style.dash || undefined, fill: style.fill || undefined, by: me.name, t: Date.now(), z: maxZ() + 1 };
  }

  // ------------------------------------------------------------------ drawing
  const BACKGROUNDS = {
    blue: { paper: '#123f7a', glow: 'rgba(40,110,190,.35)' },
    black: { paper: '#0b0d10', glow: 'rgba(70,80,95,.30)' },
    gray: { paper: '#3a4049', glow: 'rgba(140,150,165,.25)' },
    green: { paper: '#0f4a2e', glow: 'rgba(40,160,95,.30)' },
  };
  let boardMeta = null; // board settings shared by everyone (only the host changes them)
  function bgTheme() {
    const bg = (boardMeta && boardMeta.bg) || 'blue';
    if (bg === 'custom' && /^#[0-9a-f]{6}$/i.test(String(boardMeta.bgColor))) {
      const v = parseInt(boardMeta.bgColor.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
      return { paper: boardMeta.bgColor, glow: 'rgba(' + Math.min(255, r + 60) + ',' + Math.min(255, g + 60) + ',' + Math.min(255, b + 60) + ',.30)' };
    }
    return BACKGROUNDS[bg] || BACKGROUNDS.blue;
  }
  function grid(c, w, h, vx, vy, z) {
    const th = bgTheme();
    c.fillStyle = th.paper;
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.8);
    g.addColorStop(0, th.glow); g.addColorStop(1, 'rgba(0,0,0,.25)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const lines = (step, alpha) => {
      const s = step * z;
      if (s < 6) return;
      c.strokeStyle = 'rgba(255,255,255,' + alpha + ')'; c.lineWidth = 1; c.beginPath();
      for (let x = ((-vx * z) % s + s) % s; x < w; x += s) { c.moveTo(Math.round(x) + .5, 0); c.lineTo(Math.round(x) + .5, h); }
      for (let y = ((-vy * z) % s + s) % s; y < h; y += s) { c.moveTo(0, Math.round(y) + .5); c.lineTo(w, Math.round(y) + .5); }
      c.stroke();
    };
    lines(GRID, .07);
    lines(GRID * 5, .16);
  }
  function arrowHeadFilled(c, x1, y1, x2, y2, size) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath(); c.moveTo(x2, y2);
    c.lineTo(x2 - size * Math.cos(a - 0.4), y2 - size * Math.sin(a - 0.4));
    c.lineTo(x2 - size * Math.cos(a + 0.4), y2 - size * Math.sin(a + 0.4));
    c.closePath(); c.fill();
  }
  function arrowHead(c, x1, y1, x2, y2, size) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x2, y2); c.lineTo(x2 - size * Math.cos(a - .45), y2 - size * Math.sin(a - .45));
    c.moveTo(x2, y2); c.lineTo(x2 - size * Math.cos(a + .45), y2 - size * Math.sin(a + .45));
    c.stroke();
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function wrap(c, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const tryLine = line ? line + ' ' + word : word;
        if (c.measureText(tryLine).width > maxW && line) { out.push(line); line = word; } else line = tryLine;
      }
      out.push(line);
    }
    return out;
  }

  function drawShape(c, s) {
    if (s.type === 'node' && (s.kind === 'SPRING' || s.kind === 'ROPE')) { drawSpringPart(c, s); return; }
    const pose = s.type === 'node' ? poseNow.get(s.id) : null;
    if (pose) {
      const sz = CC.sizeOf(s);
      c.save(); c.translate(pose.x, pose.y); c.rotate(pose.a); c.translate(-(s.x + sz.w / 2), -(s.y + sz.h / 2));
      drawShapeInner(c, s); c.restore(); return;
    }
    inFrame(c, s, () => drawShapeInner(c, s));
  }
  function drawShapeInner(c, s) {
    const beingEdited = editingId === s.id;
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = s.w || 2; c.lineCap = 'round'; c.lineJoin = 'round';
    c.setLineDash(s.dash ? [8, 6] : []);
    const fill = () => { if (s.fill) { c.save(); c.globalAlpha = s.fillColor ? (s.fillAlpha ?? 1) : 0.22; c.fillStyle = s.fillColor || s.color; c.fill(); c.restore(); } };
    switch (s.type) {
      case 'pen': {
        const p = s.pts;
        c.beginPath(); c.moveTo(p[0], p[1]);
        if (p.length === 2) c.lineTo(p[0] + .1, p[1] + .1);
        for (let i = 2; i < p.length - 2; i += 2) c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
        if (p.length > 2) c.lineTo(p[p.length - 2], p[p.length - 1]);
        if (s.fill && penClosed(s)) fill();
        c.stroke(); break;
      }
      case 'line': case 'arrow': {
        if (s.elbow) {
          const q = elbowLine(s);
          c.beginPath(); roundedPoly(c, q, 10); c.stroke();
          if (s.type === 'arrow') { c.setLineDash([]); const a = q[q.length - 2], b = q[q.length - 1]; arrowHeadFilled(c, Math.abs(b.x - a.x) > 0.5 ? a.x : b.x - 1, a.y, b.x, b.y, 9 + (s.w || 2) * 1.5); }
          break;
        }
        c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();
        if (s.type === 'arrow') { c.setLineDash([]); arrowHead(c, s.x1, s.y1, s.x2, s.y2, 10 + (s.w || 2) * 2); }
        break;
      }
      case 'rect': { const b = bbox(s); c.beginPath(); c.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1); fill(); c.stroke(); break; }
      case 'diamond': {
        const b = bbox(s), cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
        c.beginPath(); c.moveTo(cx, b.y1); c.lineTo(b.x2, cy); c.lineTo(cx, b.y2); c.lineTo(b.x1, cy); c.closePath(); fill(); c.stroke(); break;
      }
      case 'ellipse': {
        const b = bbox(s);
        c.beginPath(); c.ellipse((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, Math.max(.5, (b.x2 - b.x1) / 2), Math.max(.5, (b.y2 - b.y1) / 2), 0, 0, Math.PI * 2);
        fill(); c.stroke(); break;
      }
      case 'dim': {
        const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1), a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const nx = -Math.sin(a) * 9, ny = Math.cos(a) * 9;
        c.lineWidth = Math.max(1, (s.w || 2) * .6);
        c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2);
        c.moveTo(s.x1 - nx, s.y1 - ny); c.lineTo(s.x1 + nx, s.y1 + ny);
        c.moveTo(s.x2 - nx, s.y2 - ny); c.lineTo(s.x2 + nx, s.y2 + ny); c.stroke();
        c.setLineDash([]); arrowHead(c, s.x1, s.y1, s.x2, s.y2, 9); arrowHead(c, s.x2, s.y2, s.x1, s.y1, 9);
        const label = String(Math.round(len));
        c.save(); c.translate((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2);
        let r = a; if (r > Math.PI / 2 || r < -Math.PI / 2) r += Math.PI;
        c.rotate(r); c.font = '12px ' + FONT; c.textAlign = 'center';
        const tw = c.measureText(label).width + 8;
        c.fillStyle = '#123f7a'; c.fillRect(-tw / 2, -16, tw, 14);
        c.fillStyle = s.color; c.fillText(label, 0, -5); c.restore(); break;
      }
      case 'text':
        c.font = s.size + 'px ' + FONT; c.textBaseline = 'top';
        if (!beingEdited) textLines(s).forEach((l, i) => c.fillText(l, s.x, s.y + i * s.size * 1.25)); break;
      case 'note': {
        c.setLineDash([]);
        c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 8; c.shadowOffsetY = 3;
        c.fillStyle = s.color === '#ffffff' ? '#ffd166' : s.color;
        c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + s.w, s.y); c.lineTo(s.x + s.w, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h); c.lineTo(s.x, s.y + s.h); c.closePath();
        c.fill(); c.restore();
        c.fillStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.moveTo(s.x + s.w, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h); c.closePath(); c.fill();
        c.fillStyle = '#1b2433'; c.font = '13px ' + FONT; c.textBaseline = 'top';
        if (!beingEdited) wrap(c, s.text || '', s.w - 16).slice(0, Math.floor((s.h - 12) / 17)).forEach((l, i) => c.fillText(l, s.x + 8, s.y + 8 + i * 17));
        break;
      }
      case 'wire': drawWire(c, s); break;
      case 'node': drawNode(c, s); break;
    }
    c.setLineDash([]);
  }

  // Signal colors: on = red, off = black, no power yet = gray.
  const ON = '#ff3131', OFF = '#0b0b0b', NOPOWER = '#8b95a3';
  const sigColor = (v) => (v === undefined ? NOPOWER : truthy(v) ? ON : OFF);
  const HYD_ON = '#f5a524', HYD_OFF = '#5a3d0a'; // hydraulic oil: under pressure / standing
  function isHydWire(w) {
    const src = byId.get(w.a.n), d = src && def(src.kind);
    return !!(d && d.outs[w.a.p] && d.outs[w.a.p].hyd);
  }
  function wireColor(w) {
    const out = values.get(w.a.n);
    const v = out ? out[w.a.p] : undefined;
    if (isHydWire(w)) return v === undefined ? NOPOWER : CC.num(v) > 0 ? HYD_ON : HYD_OFF;
    return sigColor(v);
  }
  // ------------------------------------------------------------------ hydraulic hoses
  /** A rubber hose: orange oil glowing while it carries pressure, dark oil without. */
  function drawHose(c, w, pts) {
    const out = values.get(w.a.n), pres = CC.num(out ? out[w.a.p] : 0);
    const line = (color, width) => { c.beginPath(); c.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) c.lineTo(q.x, q.y); c.strokeStyle = color; c.lineWidth = width; c.stroke(); };
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    line('rgba(255,255,255,.22)', 8.5);
    line('#1c2127', 6.5);
    if (pres > 0) { c.shadowColor = 'rgba(245,165,36,.65)'; c.shadowBlur = 8; line(HYD_ON, 4.6); }
    else line(HYD_OFF, 4.2);
    c.restore();
  }

  function drawWire(c, w, a, b) {
    const p = a && b ? { a, b } : wirePoints(w);
    if (!p) return;
    const pts = wirePath(p.a, p.b, p.ba, p.bb, p.skip);
    if (w && isHydWire(w)) { drawHose(c, w, pts); return; }
    const col = w ? wireColor(w) : '#ffffff';
    const path = () => { c.beginPath(); if (wireStyle === 'square') roundedPoly(c, pts, 8); else { c.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) c.lineTo(q.x, q.y); } };
    if (col === OFF || col === HYD_OFF) { path(); c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = col === HYD_OFF ? 6.5 : 4.5; c.stroke(); } // keep dark wires visible on blue
    c.save();
    if (col === ON || col === HYD_ON) { c.shadowColor = col; c.shadowBlur = 8; }
    path(); c.strokeStyle = col; c.lineWidth = col === HYD_ON || col === HYD_OFF ? 4.5 : 2.5; c.stroke();
    c.restore();
  }

  // ------------------------------------------------------------------ sound (instruments, drums, buzzer)
  let audio = null, master = null, muted = false, noiseBuf = null;
  const tones = new Map(), lastPlays = new Map(), noteFlash = new Map();
  const INSTRUMENTS = [
    ['piano', 'Piano'], ['square', 'Square wave'], ['saw', 'Saw lead'], ['pluck', 'Pluck'], ['bell', 'Bell'],
    ['phonk', 'Phonk bell (cowbell)'], ['bass808', '808 Bass'], ['marimba', 'Marimba'], ['organ', 'Organ'],
  ];
  const WAVES = [['square', 'Square'], ['sine', 'Sine'], ['sawtooth', 'Saw'], ['triangle', 'Triangle']];
  const DRUMS = ['Kick', 'Snare', 'Hi-Hat', 'Clap', 'Cowbell'];
  function unlockAudio() {
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        const comp = audio.createDynamicsCompressor();
        master = audio.createGain(); master.gain.value = 0.8;
        master.connect(comp).connect(audio.destination);
      }
      if (audio.state === 'suspended') void audio.resume();
    } catch { /* no audio */ }
    syncSound();
  }
  function syncSound() {
    const b = document.getElementById('sound');
    if (!b) return;
    const off = muted || !audio;
    b.classList.toggle('on', !off);
    b.title = muted ? 'Sound off (click to turn on)' : !audio ? 'Click to turn on sound' : 'Sound on (click to mute)';
    const label = b.querySelector('span');
    if (label) label.textContent = off ? 'Muted' : 'Sound';
  }
  const live = () => audio && audio.state === 'running' && !muted;

  // Building blocks
  function env(g, t, attack, decay, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  function osc(type, hz, t, attack, decay, peak, dest, hzEnd) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(hz, t);
    if (hzEnd) o.frequency.exponentialRampToValueAtTime(hzEnd, t + Math.min(decay, 0.25));
    env(g, t, attack, decay, peak);
    o.connect(g).connect(dest || master);
    o.start(t); o.stop(t + attack + decay + 0.05);
    return o;
  }
  function filter(type, hz, q = 1) { const f = audio.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; f.connect(master); return f; }
  function noise(t, decay, peak, dest) {
    if (!noiseBuf) {
      noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = audio.createBufferSource(), g = audio.createGain();
    s.buffer = noiseBuf; env(g, t, 0.002, decay, peak);
    s.connect(g).connect(dest); s.start(t); s.stop(t + decay + 0.05);
  }
  function drive(amount) {
    const ws = audio.createWaveShaper(), n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / n) * 2 - 1; curve[i] = Math.tanh(x * amount); }
    ws.curve = curve; ws.connect(master);
    return ws;
  }

  /** Plays one note on an instrument. */
  function playInstrument(inst, hz) {
    if (!audio) return;
    const t = audio.currentTime + 0.005;
    switch (inst) {
      case 'square': osc('square', hz, t, 0.005, 0.35, 0.12); break;
      case 'saw': osc('sawtooth', hz, t, 0.01, 0.5, 0.14, filter('lowpass', 2600, 4)); osc('sawtooth', hz * 1.006, t, 0.01, 0.5, 0.1, filter('lowpass', 2600, 4)); break;
      case 'pluck': osc('triangle', hz, t, 0.002, 0.3, 0.3); osc('square', hz * 2, t, 0.002, 0.08, 0.04); break;
      case 'bell': {
        const car = audio.createOscillator(), mod = audio.createOscillator(), mg = audio.createGain(), g = audio.createGain();
        car.frequency.value = hz; mod.frequency.value = hz * 3.5;
        mg.gain.setValueAtTime(hz * 2.2, t); mg.gain.exponentialRampToValueAtTime(1, t + 1.6);
        mod.connect(mg).connect(car.frequency); env(g, t, 0.003, 2.2, 0.22); car.connect(g).connect(master);
        car.start(t); mod.start(t); car.stop(t + 2.3); mod.stop(t + 2.3);
        break;
      }
      case 'phonk': {
        // Memphis/phonk cowbell: two detuned square waves (like the 808 cowbell), band-passed and driven.
        const out = filter('bandpass', Math.max(800, hz * 3), 1.2);
        osc('square', hz * 2, t, 0.002, 0.45, 0.16, out);
        osc('square', hz * 2 * 1.48, t, 0.002, 0.45, 0.12, out);
        osc('square', hz * 2, t, 0.002, 0.12, 0.06, drive(3));
        break;
      }
      case 'bass808': {
        const d = drive(2.2);
        osc('sine', hz / 2, t, 0.004, 1.4, 0.55, d, hz / 2 * 0.98);
        osc('sine', hz * 1.5, t, 0.001, 0.03, 0.3, d, hz / 2);
        break;
      }
      case 'marimba': osc('sine', hz, t, 0.002, 0.45, 0.3); osc('sine', hz * 4, t, 0.002, 0.08, 0.08); break;
      case 'organ': for (const [m, p] of [[1, 0.12], [2, 0.07], [3, 0.05], [4, 0.03]]) osc('sine', hz * m, t, 0.02, 0.6, p); break;
      default: // piano
        osc('triangle', hz, t, 0.004, 1.3, 0.22); osc('sine', hz * 2, t, 0.004, 0.7, 0.09); osc('sine', hz * 3, t, 0.004, 0.35, 0.04);
        noise(t, 0.02, 0.02, filter('highpass', 3000));
    }
  }
  /** Plays one drum of the kit. */
  function playDrum(i) {
    if (!audio) return;
    const t = audio.currentTime + 0.005;
    switch (i) {
      case 0: osc('sine', 150, t, 0.002, 0.45, 0.9, drive(1.5), 42); break; // kick
      case 1: noise(t, 0.18, 0.45, filter('highpass', 1200)); osc('triangle', 190, t, 0.002, 0.1, 0.3); break; // snare
      case 2: noise(t, 0.05, 0.25, filter('highpass', 7500)); break; // hi-hat
      case 3: { const f = filter('bandpass', 1400, 1.5); for (const dt of [0, 0.011, 0.023]) noise(t + dt, dt === 0.023 ? 0.18 : 0.01, 0.5, f); break; } // clap
      case 4: playInstrument('phonk', 280); break; // cowbell
    }
  }

  function updateSound() {
    const on = live();
    const seen = new Set();
    for (const n of shapes) {
      if (n.type !== 'node') continue;
      if (n.kind === 'BUZZER') {
        seen.add(n.id);
        const sounding = on && truthy((inputsOf.get(n.id) || [])[0]);
        const hz = Math.min(4000, Math.max(40, Number(n.value) || 440));
        const wave = WAVES.some(([w]) => w === n.wave) ? n.wave : 'square';
        let tn = tones.get(n.id);
        if (sounding && !tn) {
          const o = audio.createOscillator(), g = audio.createGain();
          o.type = wave; o.frequency.value = hz; g.gain.value = wave === 'sine' || wave === 'triangle' ? 0.12 : 0.05;
          o.connect(g).connect(master); o.start();
          tones.set(n.id, (tn = { o, g }));
        } else if (!sounding && tn) {
          tn.g.gain.setTargetAtTime(0, audio.currentTime, 0.01); tn.o.stop(audio.currentTime + 0.08); tones.delete(n.id);
        } else if (sounding && tn) { tn.o.frequency.value = hz; if (tn.o.type !== wave) tn.o.type = wave; }
      } else if (n.kind === 'NOTE') {
        const plays = (sim.s.get(n.id) || {}).plays || 0;
        const before = lastPlays.get(n.id);
        if (before !== undefined && plays > before) {
          noteFlash.set(n.id, performance.now());
          if (on) playInstrument(n.inst || 'piano', CC.noteHz(n.value));
        }
        lastPlays.set(n.id, plays);
      } else if (n.kind === 'DRUMKIT') {
        const plays = (sim.s.get(n.id) || {}).plays || [];
        const before = lastPlays.get(n.id);
        plays.forEach((p, i) => {
          if (before && p > (before[i] || 0)) {
            noteFlash.set(n.id + ':' + i, performance.now());
            if (on) playDrum(i);
          }
        });
        lastPlays.set(n.id, plays.slice());
      }
    }
    for (const [id, tn] of tones) if (!seen.has(id)) { tn.o.stop(); tones.delete(id); }
  }

  // ------------------------------------------------------------------ module settings panel (instrument, wave, note…)
  const props = document.getElementById('props');
  let propsFor = null;
  function closeProps() { if (props) props.style.display = 'none'; propsFor = null; liveBox = null; }
  const MATERIAL_OPTS = Object.keys(window.CollabPhysics.MATERIALS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]);
  /** Gear settings of the extra parts: [key, label, number range or options, default]. */
  const PART_SETTINGS = {
    BEAM: [['material', 'Material', MATERIAL_OPTS, 'aluminium']], BALL: [['material', 'Material', MATERIAL_OPTS, 'rubber']],
    COUNTERWEIGHT: [['material', 'Material', MATERIAL_OPTS, 'lead']], WHEEL: [['torque', 'Motor torque', [1e5, 2e7], 2e6], ['material', 'Tire', MATERIAL_OPTS, 'rubber']],
    RAMP: [['loose', 'Ramp', [['', 'Fixed'], ['1', 'Loose (can be pushed)']], '']],
    SPRING: [['value', 'Stiffness', [10, 20000], 400]], THRUSTER: [['value', 'Max force (N)', [1, 100000], 400]], MAGNET: [['value', 'Strength', [10, 5000], 600]],
    NEWTON: [['value', 'Over at (N)', [0, 1e6], 100]], PRESSURE_SW: [['value', 'Switch at (bar)', [0, 1000], 50]], RELIEF: [['value', 'Max pressure (bar)', [0, 1000], 60]],
    ACCUMULATOR: [['value', 'Capacity (bar)', [1, 1000], 120]], HYDMOTOR: [['value', 'rpm per bar', [0.1, 1000], 10]], NOZZLE: [['value', 'Jet strength', [0.1, 10], 1]],
    RANDOM: [['value', 'Max number', [1, 1e6], 100]], TON: [['value', 'Delay (s)', [0.05, 3600], 1]], TOF: [['value', 'Delay (s)', [0.05, 3600], 1]],
    PWM: [['value', 'Period (s)', [0.1, 60], 1]], SCHMITT: [['value', 'High level', [-1e6, 1e6], 60], ['low', 'Low level', [-1e6, 1e6], 40]],
    LOWPASS: [['value', 'Time constant (s)', [0.05, 60], 0.5]], RATELIMIT: [['value', 'Rate per second', [0.01, 1e6], 10]],
    PID: [['kp', 'Kp', [-1e4, 1e4], 1], ['ki', 'Ki', [-1e4, 1e4], 0.2], ['kd', 'Kd', [-1e4, 1e4], 0], ['lim', 'Output limit', [0, 1e6], 100]],
    SLIDER: [['max', 'Max', [1, 1e6], 100]], BARGRAPH: [['value', 'Full scale', [0.01, 1e6], 10]], METER: [['value', 'Full scale', [0.01, 1e6], 100]],
    SCOPE: [['value', 'Full screen =', [0.01, 1e6], 10]], BATTERY: [['value', 'Voltage', [0, 1000], 24]],
  };
  const RESETTABLE = new Set(['DETECTOR', 'COUNTER', 'SHIFT', 'REGISTER', 'INTEGRATOR', 'PID', 'SAMPLEHOLD', 'ACCUMULATOR', 'RANDOM', 'LOWPASS', 'RATELIMIT', 'SR', 'DFF', 'TFF', 'JKFF', 'DLATCH', 'TON', 'TOF', 'SCHMITT']);
  const INSPECT = new Set([...Object.keys(PART_SETTINGS), ...RESETTABLE, 'STEEL', 'BEDROCK', 'DISPLAY', 'NOTE', 'BUZZER', 'BUTTON', 'LIMIT', 'PUMP', 'GAUGE', 'FLOW', 'FLOW_1W', 'POT', 'VALVE', 'VALVE_3_2', 'VALVE_5_2', 'VALVE_4_3', 'CYLINDER', 'CYL_DA']);
  let liveBox = null;
  /** Live values in the open inspector (refreshed while drawing). */
  function updateLive() {
    if (!liveBox || !propsFor) return;
    const n = byId.get(propsFor);
    if (!n) { closeProps(); return; }
    const ins = inputsOf.get(n.id) || [], out = values.get(n.id) || [], mem = memOf(n.id);
    const bar = (v) => Math.round(CC.num(v)) + ' bar';
    let lines = [];
    if (CC.def(n.kind).valve) {
      const names = n.kind === 'VALVE_4_3' ? ['14 (P → A)', 'center', '12 (P → B)'] : ['actuated (left box)', 'rest (right box)'];
      lines = ['Position: ' + (names[mem.pos ?? 1] || '–'), 'P ' + bar(ins[0]) + ' · A ' + bar(out[0]) + (out.length > 1 ? ' · B ' + bar(out[1]) : '')];
    } else if (n.kind === 'CYLINDER' || n.kind === 'CYL_DA') {
      lines = ['Stroke ' + Math.round(CC.num(out[1])) + ' %' + (out[0] ? ' (out)' : out[2] ? ' (in)' : ''), 'Force ' + (Math.round(CC.num(out[3]) * 10) / 10) + ' kN' + ((mem.throttle ?? 1) < 1 ? ' · speed ' + Math.round((mem.throttle ?? 1) * 100) + ' %' : ''), 'A ' + bar(ins[0]) + (n.kind === 'CYL_DA' ? ' · B ' + bar(ins[1]) : '')];
    } else if (n.kind === 'PUMP') lines = ['Pressure ' + bar(mem.p || 0), truthy(ins[0]) ? 'Running' : 'Stopped'];
    else if (n.kind === 'GAUGE') lines = ['Pressure ' + bar(ins[0]) + (CC.num(ins[0]) > gaugeRange(n) ? ' (over range!)' : ''), 'Over: ' + (out[0] ? 'on' : 'off')];
    else if (n.kind === 'FLOW_1W') lines = ['Opening ' + Math.round(CC.flowOpening(n, null)) + ' % (' + (n.mode !== 'out' ? 'meter-in: slow rise' : 'meter-out: slow fall') + ')', 'In ' + bar(ins[0]) + ' · Out ' + bar(out[0])];
    else if (n.kind === 'POT') lines = ['Value ' + CC.potValue(n) + '  (range ' + CC.potRange(n).min + ' … ' + CC.potRange(n).max + ')'];
    else if (n.kind === 'FLOW') lines = ['Opening ' + Math.round(CC.flowOpening(n, ins)) + ' %' + (typeof ins[1] === 'number' && ins[1] >= 0 ? ' (from Set)' : ''), 'In ' + bar(ins[0]) + ' · Out ' + bar(out[0])];
    else if (n.kind === 'LIMIT') lines = [out[0] ? 'Pressed (NO on, NC off)' : 'Released (NO off, NC on)'];
    else if (n.kind === 'BUTTON') lines = ['Contact: ' + (out[0] ? 'on' : 'off')];
    else if (n.kind === 'DISPLAY') lines = [String(n.text ?? '') ? (truthy(ins[0]) ? 'On: showing the text' : 'Off: blank') : 'No text: shows the number ' + fmt(ins[0] ?? 0)];
    const text = lines.join('\n');
    if (liveBox.textContent !== text) liveBox.textContent = text;
  }
  function openProps(n) {
    if (!props) return;
    propsFor = n.id;
    props.replaceChildren();
    const row = (label, el) => { const r = document.createElement('label'); const s = document.createElement('span'); s.textContent = label; r.append(s, el); props.append(r); return el; };
    const select = (opts, value) => { const s = document.createElement('select'); for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; o.selected = v === value; s.append(o); } return s; };
    const input = (value, placeholder) => { const i = document.createElement('input'); i.value = value; i.placeholder = placeholder; i.spellcheck = false; return i; };
    const update = (patch, record = true, before) => { const cur = byId.get(n.id); if (cur && !readOnly) commit([{ ...clone(cur), ...patch }], [], record, before ? [before] : undefined); };
    const title = document.createElement('div'); title.className = 'ptitle'; title.textContent = (CAT.HELP[n.kind] || [def(n.kind).title])[0];
    const qh = document.createElement('a'); qh.textContent = ' ?'; qh.title = 'Open the help for this part'; qh.className = 'phelp-link'; qh.onclick = () => { closeProps(); openHelp(n.kind); };
    title.append(qh); props.append(title);
    let test;
    const d0 = def(n.kind);
    if (d0.help && n.kind !== 'NOTE' && n.kind !== 'BUZZER') { const h = document.createElement('div'); h.className = 'phelp'; h.textContent = d0.help; props.append(h); }
    const numberRow = (label, value, fallback, min, max, key) => {
      const el = row(label, input(String(value ?? fallback), String(fallback)));
      let orig = null;
      const parse = () => { const t = String(el.value).trim().replace(',', '.'); const v = Number(t); return t !== '' && Number.isFinite(v) ? v : null; };
      el.onfocus = () => { orig = clone(byId.get(n.id) || n); };
      el.oninput = () => { const v = parse(); if (v !== null && v >= min && v <= max) update({ [key]: v }, false); }; // live
      el.onchange = () => { const v = parse(); if (v !== null) { const c = Math.min(max, Math.max(min, v)); update({ [key]: c }, true, orig); el.value = String(c); orig = clone(byId.get(n.id) || n); } };
      return el;
    };
    if (RESETTABLE.has(n.kind) && !readOnly) {
      const rb = document.createElement('button'); rb.textContent = '↺ Reset (counter / memory)'; rb.style.width = '100%'; rb.style.margin = '2px 0 6px';
      rb.onclick = () => { const cur = byId.get(n.id); if (cur) commit([{ ...clone(cur), resetAt: Date.now() }]); };
      props.append(rb);
    }
    if (PART_SETTINGS[n.kind]) {
      for (const [key, lab, spec, dflt] of PART_SETTINGS[n.kind]) {
        if (Array.isArray(spec[0])) { const sel = row(lab, select(spec, String(n[key] ?? dflt))); sel.onchange = () => update({ [key]: sel.value === '' ? undefined : sel.value }); }
        else numberRow(lab, n[key], dflt, spec[0], spec[1], key);
      }
    }
    if (n.kind === 'STEEL' || n.kind === 'BEDROCK') {
      const sz = CC.sizeOf(n);
      if (n.kind === 'STEEL') { const mat = row('Material', select(MATERIAL_OPTS, n.material || 'steel')); mat.onchange = () => update({ material: mat.value }); }
      numberRow('Width', sz.w, 80, 20, 2000, 'bw');
      numberRow('Height', sz.h, 80, 20, 2000, 'bh');
      if (n.kind === 'STEEL') {
        const piv = row('Rotation point', select([['none', 'None (it slides)'], ['center', 'Center'], ['left', 'Left end'], ['right', 'Right end'], ['top', 'Top end'], ['bottom', 'Bottom end'], ['custom', 'Custom (X / Y %)']], n.pivot || 'none'));
        piv.onchange = () => update({ pivot: piv.value === 'none' ? undefined : piv.value });
        numberRow('Pivot X (%)', n.pivX ?? 50, 50, 0, 100, 'pivX');
        numberRow('Pivot Y (%)', n.pivY ?? 50, 50, 0, 100, 'pivY');
        const fx = row('Movement', select([['free', 'Can be pushed'], ['fixed', 'Fixed in place']], n.fixed ? 'fixed' : 'free'));
        fx.onchange = () => update({ fixed: fx.value === 'fixed' || undefined });
        const rs = document.createElement('button'); rs.textContent = '↺ Reset to where it started'; rs.style.width = '100%'; rs.style.marginTop = '6px';
        rs.disabled = !n.home || readOnly;
        rs.onclick = () => { const cur = byId.get(n.id); if (cur && cur.home) { const c2 = { ...clone(cur), x: cur.home.x, y: cur.home.y, rot: cur.home.rot || undefined, resetAt: Date.now() }; delete c2.home; commit([c2]); closeProps(); } };
        props.append(rs);
      }
    } else if (n.kind === 'DISPLAY') {
      const tx = row('Text', input(String(n.text ?? ''), 'type a text…'));
      tx.maxLength = 120;
      tx.oninput = () => update({ text: tx.value }, false);
      tx.onchange = () => update({ text: tx.value });
    } else if (n.kind === 'BUTTON') {
      const contact = row('Contact', select([['no', 'NO – normally open'], ['nc', 'NC – normally closed']], n.nc ? 'nc' : 'no'));
      const type = row('Type', select([['momentary', 'Momentary (springs back)'], ['latch', 'Latching (push on / push off)']], n.latch ? 'latch' : 'momentary'));
      contact.onchange = () => update({ nc: contact.value === 'nc' });
      type.onchange = () => update({ latch: type.value === 'latch', value: false });
    } else if (n.kind === 'VALVE_3_2') {
      const normal = row('At rest', select([['nc', 'NC – A vented, P blocked'], ['no', 'NO – P → A']], n.no ? 'no' : 'nc'));
      const ret = row('Return', select([['spring', 'Spring return'], ['bistable', 'Bistable (14 / 12, stays)']], n.mode === 'bistable' ? 'bistable' : 'spring'));
      normal.onchange = () => update({ no: normal.value === 'no' });
      ret.onchange = () => update({ mode: ret.value });
    } else if (n.kind === 'VALVE_5_2') {
      const ret = row('Return', select([['spring', 'Spring return (monostable)'], ['bistable', 'Bistable (14 / 12, stays)']], n.mode === 'bistable' ? 'bistable' : 'spring'));
      ret.onchange = () => update({ mode: ret.value });
    } else if (n.kind === 'VALVE_4_3') {
      const center = row('Center', select([['closed', 'Closed – all blocked, holds'], ['float', 'Float – A, B → T'], ['tandem', 'Tandem – P → T, A/B blocked']], n.center || 'closed'));
      center.onchange = () => update({ center: center.value });
    } else if (n.kind === 'PUMP') {
      numberRow('Pressure (bar)', n.value, 100, 1, 1000, 'value');
    } else if (n.kind === 'GAUGE') {
      const range = row('Range (bar)', select(GAUGE_RANGES.map((v) => [String(v), '0 – ' + v + ' bar']), String(gaugeRange(n))));
      range.onchange = () => update({ range: Number(range.value) });
      numberRow('Over at (bar)', n.value, 50, 0, 1000, 'value');
    } else if (n.kind === 'FLOW') {
      numberRow('Opening (%)', n.value, 50, 0, 100, 'value');
    } else if (n.kind === 'FLOW_1W') {
      const dirSel = row('Slows', select([['in', 'Meter-in: pressure rises slowly'], ['out', 'Meter-out: pressure drops slowly']], n.mode !== 'out' ? 'in' : 'out'));
      dirSel.onchange = () => update({ mode: dirSel.value });
      numberRow('Opening (%)', n.value, 50, 0, 100, 'value');
    } else if (n.kind === 'POT') {
      const r = CC.potRange(n);
      numberRow('Value', CC.potValue(n), 5, -1e6, 1e6, 'value');
      numberRow('Min', r.min, 0, -1e6, 1e6, 'min');
      numberRow('Max', r.max, 10, -1e6, 1e6, 'max');
    } else if (n.kind === 'CYLINDER' || n.kind === 'CYL_DA') {
      numberRow('Bore (mm)', n.bore, 40, 5, 400, 'bore');
      numberRow('Rod (mm)', n.rod, Math.round((Number(n.bore) || 40) * 0.4), 2, 398, 'rod');
      numberRow('Load (kN)', n.load, 1, 0, 10000, 'load');
    }
    if (n.kind === 'NOTE') {
      const inst = row('Instrument', select(INSTRUMENTS, n.inst || 'piano'));
      const note = row('Note', input(CC.noteName(n.value), 'e.g. C5, F#4'));
      inst.onchange = () => { update({ inst: inst.value }); unlockAudio(); playInstrument(inst.value, CC.noteHz(byId.get(n.id)?.value)); };
      note.onchange = () => { const v = CC.parseNote(note.value); if (v !== null) { update({ value: Math.min(36, Math.max(-12, v)) }); note.value = CC.noteName(v); } };
      test = () => playInstrument(inst.value, CC.noteHz(CC.parseNote(note.value) ?? n.value));
    } else if (n.kind === 'BUZZER') {
      const wave = row('Wave', select(WAVES, n.wave || 'square'));
      const hz = row('Pitch (Hz)', input(String(n.value ?? 440), '440'));
      wave.onchange = () => update({ wave: wave.value });
      hz.onchange = () => { const v = Number(hz.value); if (Number.isFinite(v)) update({ value: Math.min(4000, Math.max(40, v)) }); };
      test = () => { const t = audio.currentTime; osc(wave.value, Number(hz.value) || 440, t, 0.005, 0.4, wave.value === 'sine' || wave.value === 'triangle' ? 0.2 : 0.08); };
    }
    if (readOnly) props.querySelectorAll('select,input').forEach((e) => (e.disabled = true));
    liveBox = null;
    if (!['NOTE', 'BUZZER'].includes(n.kind)) { liveBox = document.createElement('div'); liveBox.className = 'plive'; props.append(liveBox); updateLive(); }
    const bar = document.createElement('div'); bar.className = 'pbar';
    if (test) {
      const play = document.createElement('button'); play.textContent = '▶ Test sound';
      play.onclick = () => { unlockAudio(); muted = false; syncSound(); if (audio && test) test(); };
      bar.append(play);
    }
    const done = document.createElement('button'); done.textContent = 'Done'; done.onclick = closeProps;
    bar.append(done); props.append(bar);
    const sp = toScreen(n.x + def(n.kind).w + 10, n.y);
    props.style.left = Math.min(innerWidth - 230, Math.max(8, sp.x)) + 'px';
    props.style.top = Math.min(innerHeight - 260, Math.max(60, sp.y)) + 'px';
    props.style.display = 'block';
  }

  if (props) props.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || e.key === 'Enter') { e.target.dispatchEvent(new Event('change')); closeProps(); } });

  // ------------------------------------------------------------------ animation (motors, buzzers, notes)
  const motorAngle = new Map();
  let lastFrame = performance.now();
  function motorSpeed(n) {
    const v = (inputsOf.get(n.id) || [])[0];
    if (!truthy(v)) return 0;
    return typeof v === 'number' ? Math.min(10, Math.max(0.2, Math.abs(v))) * Math.sign(v) : 1;
  }
  function animating() {
    const now = performance.now();
    if (partsAnim) { partsAnim = false; return true; }
    if (poseCur.size && now - poseT < 150) return true;
    for (const n of shapes) {
      if (n.type !== 'node') continue;
      if (n.kind === 'MOTOR' && motorSpeed(n) !== 0) return true;
      if (n.kind === 'DISPLAY' && displayAnimating(n)) return true;
      if (n.kind === 'PUMP' && (memOf(n.id).p || 0) > 0.5) return true;
      if (n.kind === 'BUZZER' && truthy((inputsOf.get(n.id) || [])[0])) return true;
      if (n.kind === 'NOTE' && now - (noteFlash.get(n.id) || 0) < 400) return true;
      if (n.kind === 'DRUMKIT' && [0, 1, 2, 3, 4].some((i) => now - (noteFlash.get(n.id + ':' + i) || 0) < 250)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ module drawing
  function gatePath(c, kind, x, y, w, h) {
    const bodyW = w - 14;
    c.beginPath();
    if (/^N?AND/.test(kind)) {
      c.moveTo(x + 8, y); c.lineTo(x + bodyW / 2, y); c.arc(x + bodyW / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2); c.lineTo(x + 8, y + h); c.closePath();
    } else if (/^(X?N?OR)/.test(kind)) {
      c.moveTo(x + 8, y); c.quadraticCurveTo(x + bodyW * 0.75, y, x + bodyW, y + h / 2);
      c.quadraticCurveTo(x + bodyW * 0.75, y + h, x + 8, y + h); c.quadraticCurveTo(x + 22, y + h / 2, x + 8, y); c.closePath();
    } else {
      c.moveTo(x + 10, y + 2); c.lineTo(x + bodyW, y + h / 2); c.lineTo(x + 10, y + h - 2); c.closePath();
    }
  }
  /** Pin dot: red when on, black when off, hollow gray when nothing is wired. */
  function drawPin(c, p, connected, value, accent, hyd) {
    c.beginPath(); c.arc(p.x, p.y, hyd ? 5.5 : 4.5, 0, Math.PI * 2);
    c.fillStyle = !connected ? '#123f7a' : hyd ? (value === undefined ? NOPOWER : CC.num(value) > 0 ? HYD_ON : HYD_OFF) : sigColor(value); c.fill();
    c.strokeStyle = connected ? (accent || '#ffffff') : NOPOWER; c.lineWidth = 1.5; c.stroke();
  }
  const HEADER = { func: '#3f8f6a', mem: '#7b4fb8', time: '#2a8c9c', in: '#b07d12', out: '#4a6fa5', hyd: '#1769aa' };
  const ICON = { func: 'ƒ', mem: '⧉', time: '⏱', in: '◉', out: '◐', hyd: '≋' };
  const secs = (v) => (Math.round((Number(v) || 0) * 100) / 100) + ' s';

  /** Module card: soft shadow, dark gradient body, glossy colored header with an icon chip. */
  function body(c, n, d, color) {
    const accent = HEADER[d.cat] || HEADER.func;
    c.save();
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 12; c.shadowOffsetY = 4;
    roundRect(c, n.x, n.y, d.w, d.h, 9);
    const bg = c.createLinearGradient(0, n.y, 0, n.y + d.h); bg.addColorStop(0, '#11663f'); bg.addColorStop(1, '#093820');
    c.fillStyle = bg; c.fill();
    c.restore();
    c.save(); roundRect(c, n.x, n.y, d.w, d.h, 9); c.clip();
    const hg = c.createLinearGradient(0, n.y, 0, n.y + 26); hg.addColorStop(0, '#0d5232'); hg.addColorStop(1, '#083620');
    c.fillStyle = hg; c.fillRect(n.x, n.y, d.w, 26);
    c.fillStyle = accent; c.fillRect(n.x, n.y + 23, d.w, 3); // category stripe
    c.strokeStyle = 'rgba(170,240,190,.10)'; c.lineWidth = 1; // copper traces
    for (let k = 0; k < 3; k++) { const yy = n.y + 34 + k * 14; if (yy > n.y + d.h - 6) break; c.beginPath(); c.moveTo(n.x + d.w * 0.35, yy); c.lineTo(n.x + d.w * 0.55, yy); c.lineTo(n.x + d.w * 0.62, yy + 6); c.stroke(); }
    c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(n.x, n.y, d.w, 1.5);
    c.restore();
    roundRect(c, n.x, n.y, d.w, d.h, 9); c.strokeStyle = color === '#ffffff' ? '#c9a227' : color; c.lineWidth = 1.5; c.stroke();
    c.beginPath(); c.moveTo(n.x, n.y + 26); c.lineTo(n.x + d.w, n.y + 26); c.strokeStyle = 'rgba(0,0,0,.35)'; c.stroke();
    // icon chip + title
    const ic = (ICON[d.cat] || '').trim();
    let tx = n.x + 9;
    if (ic) { roundRect(c, n.x + 6, n.y + 5, 16, 16, 4); c.fillStyle = 'rgba(0,0,0,.25)'; c.fill(); c.fillStyle = '#fff'; c.font = '700 11px "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(ic, n.x + 14, n.y + 13.5); tx = n.x + 27; }
    c.fillStyle = '#ffffff'; c.font = '700 12px "Segoe UI", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText(d.title, tx, n.y + 13.5);
    c.lineWidth = 2;
  }
  /** Lighter (amt > 0) or darker (amt < 0) version of a #rrggbb color. */
  function shade(hex, amt) {
    const v = parseInt(hex.slice(1), 16), f = (x) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? x + (255 - x) * amt : x * (1 + amt))));
    return 'rgb(' + f(v >> 16) + ',' + f((v >> 8) & 255) + ',' + f(v & 255) + ')';
  }

  function pinLabels(c, n, d, out) {
    c.font = '11px ' + FONT; c.textBaseline = 'middle';
    d.ins.forEach((pin, i) => {
      const p = pinPos(n, 'in', i, true);
      c.fillStyle = 'rgba(255,255,255,.88)';
      if (pin.at === 'top') { c.textAlign = 'center'; c.font = '600 10px ' + FONT; c.fillText(pin.n, p.x, p.y - 11); c.font = '11px ' + FONT; return; }
      if (pin.at === 'bottom') { c.textAlign = 'center'; c.font = '600 10px ' + FONT; c.fillText(pin.n, p.x, p.y + 12); c.font = '11px ' + FONT; return; }
      c.textAlign = 'left';
      if (pin.clk) {
        c.beginPath(); c.moveTo(p.x, p.y - 5); c.lineTo(p.x + 8, p.y); c.lineTo(p.x, p.y + 5); c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1.2; c.stroke(); c.lineWidth = 2;
        c.fillText(pin.n, p.x + 12, p.y);
      } else c.fillText(pin.n + (pin.dflt === true ? ' (on)' : ''), p.x + 10, p.y);
    });
    d.outs.forEach((pin, i) => {
      const p = pinPos(n, 'out', i, true);
      const v = out[i];
      c.textAlign = 'right';
      c.fillStyle = pin.bool ? (v ? '#ff6b6b' : 'rgba(255,255,255,.6)') : 'rgba(255,255,255,.88)';
      c.font = (pin.bool ? '600 ' : '') + '11px ' + FONT;
      c.fillText(pin.n, p.x - 10, p.y);
      if (!pin.bool && d.cat === 'func') { c.fillStyle = '#ffd166'; c.textAlign = 'left'; c.font = '600 11px ' + FONT; c.fillText('= ' + fmt(v ?? 0), p.x + 9, p.y - 11); }
      c.font = '11px ' + FONT;
    });
  }

  function seg7(c, x, y, w, h, v, on) {
    const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', 10: 'abcefg', 11: 'cdefg', 12: 'adef', 13: 'bcdeg', 14: 'adefg', 15: 'aefg' };
    const lit = on ? SEG[v] || '' : '';
    const t = 6, m = h / 2;
    const segs = {
      a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + m - t / 2, w - 2 * t, t],
      f: [x, y + t, t, m - t * 1.2], b: [x + w - t, y + t, t, m - t * 1.2], e: [x, y + m + t * 0.2, t, m - t * 1.2], c: [x + w - t, y + m + t * 0.2, t, m - t * 1.2],
    };
    for (const [k, r] of Object.entries(segs)) {
      const onSeg = lit.includes(k);
      roundRect(c, r[0], r[1], r[2], r[3], 2);
      if (onSeg) { c.save(); c.shadowColor = '#ff4d4d'; c.shadowBlur = 8; c.fillStyle = '#ff4d4d'; c.fill(); c.restore(); }
      else { c.fillStyle = 'rgba(255,77,77,.1)'; c.fill(); }
    }
  }

  // ------------------------------------------------------------------ fluid power symbols (ISO 1219 style)
  const DIM = 'rgba(255,255,255,.42)', LINE = '#e8eef6', EXHAUST = 'rgba(255,255,255,.7)';
  const pressureColor = (p) => (CC.num(p) > 0 ? HYD_ON : LINE);
  function tag(c, text, x, y, align, col, size) {
    c.fillStyle = col || 'rgba(255,255,255,.8)'; c.font = '600 ' + (size || 10) + 'px ' + FONT;
    c.textAlign = align || 'left'; c.textBaseline = 'middle'; c.fillText(text, x, y);
  }
  function arrowTo(c, x1, y1, x2, y2, col) {
    const a = Math.atan2(y2 - y1, x2 - x1), L = 7;
    c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)); c.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)); c.closePath();
    c.fillStyle = col; c.fill();
  }
  function frame(c, n, d, title) {
    const hyd = d.cat === 'hyd';
    c.save(); roundRect(c, n.x, n.y, d.w, d.h, 6);
    if (hyd) { c.fillStyle = 'rgba(245,190,60,.05)'; c.fill(); }
    c.setLineDash([3, 4]); c.strokeStyle = hyd ? 'rgba(245,190,60,.45)' : 'rgba(255,255,255,.16)'; c.lineWidth = 1; c.stroke(); c.restore();
    if (title) tag(c, title, n.x + 5, n.y + 8, 'left', 'rgba(255,255,255,.62)', 9);
  }
  /** Spring symbol between x1 and x2 around y. */
  function spring(c, x1, x2, y, col) {
    c.beginPath(); c.moveTo(x1, y); const k = 5, step = (x2 - x1) / k;
    for (let i = 0; i < k; i++) c.lineTo(x1 + step * (i + 0.5), y + (i % 2 ? 6 : -6));
    c.lineTo(x2, y); c.strokeStyle = col; c.lineWidth = 1.3; c.stroke();
  }
  /** Solenoid / pilot actuator box; lit when its signal is on. */
  function solenoid(c, x, y, on, label) {
    c.beginPath(); c.rect(x, y - 10, 13, 20);
    c.fillStyle = on ? 'rgba(255,49,49,.45)' : 'rgba(255,255,255,.04)'; c.fill();
    c.strokeStyle = on ? ON : LINE; c.lineWidth = 1.3; c.stroke();
    c.beginPath(); c.moveTo(x, y + 10); c.lineTo(x + 13, y - 10); c.stroke();
    if (label) tag(c, label, x + 6.5, y - 16, 'center', on ? '#ffb3b3' : 'rgba(255,255,255,.65)', 9);
  }
  function exhaustMark(c, x, y, col) {
    // tank / exhaust symbol under an exhaust port
    c.beginPath(); c.moveTo(x - 7, y); c.lineTo(x - 7, y + 6); c.lineTo(x + 7, y + 6); c.lineTo(x + 7, y);
    c.strokeStyle = col; c.lineWidth = 1.3; c.stroke();
  }

  function drawValve(c, n, d, mem, ins, out) {
    const L = CC.VLAYOUT[n.kind], boxes = CC.valveBoxes(n.kind, n), bw = L.bw;
    const pos = Math.max(0, Math.min(boxes.length - 1, mem.pos ?? 1));
    const cx = n.x + d.w / 2, y1 = n.y + CC.BOX_Y1, y2 = n.y + CC.BOX_Y2, ym = (y1 + y2) / 2;
    const left0 = cx - bw / 2 - pos * bw;
    const pP = CC.num(ins[0]);
    const portP = { A: out[0], B: out[1], P: pP };
    const portXY = (bx, name) => (L.top[name] !== undefined ? { x: bx + L.top[name] * bw, y: y1 } : { x: bx + L.bottom[name] * bw, y: y2 });
    frame(c, n, d, d.title + (n.kind === 'VALVE_3_2' ? (n.no ? ' NO' : ' NC') : ''));
    // switching boxes
    boxes.forEach((box, i) => {
      const bx = left0 + i * bw, active = i === pos;
      c.beginPath(); c.rect(bx, y1, bw, y2 - y1);
      c.fillStyle = active ? 'rgba(245,165,36,.12)' : 'rgba(10,28,58,.55)'; c.fill();
      c.strokeStyle = active ? LINE : DIM; c.lineWidth = active ? 1.8 : 1.2; c.stroke();
      for (const [a, b] of box.c || []) {
        const A = portXY(bx, a), Bp = portXY(bx, b);
        const pressurized = active && a === 'P' && pP > 0;
        const exhausting = active && /^[RST]$/.test(b);
        const col = !active ? DIM : pressurized ? HYD_ON : exhausting ? EXHAUST : LINE;
        c.strokeStyle = col; c.lineWidth = pressurized ? 2.6 : 1.4;
        c.beginPath();
        if (Math.abs(A.y - Bp.y) < 1) { // both ports on the same side: U-shaped path
          const my = A.y === y1 ? y1 + 12 : y2 - 12;
          c.moveTo(A.x, A.y); c.lineTo(A.x, my); c.lineTo(Bp.x, my); c.lineTo(Bp.x, Bp.y + (A.y === y1 ? 7 : -7)); c.stroke();
          arrowTo(c, Bp.x, my, Bp.x, Bp.y, col);
        } else {
          const ex = Bp.x - (Bp.x - A.x) * (7 / Math.hypot(Bp.x - A.x, Bp.y - A.y));
          const ey = Bp.y - (Bp.y - A.y) * (7 / Math.hypot(Bp.x - A.x, Bp.y - A.y));
          c.moveTo(A.x, A.y); c.lineTo(ex, ey); c.stroke();
          arrowTo(c, A.x, A.y, Bp.x, Bp.y, col);
        }
      }
      for (const name of box.b || []) { // blocked port: ⊥
        const q = portXY(bx, name), dir = q.y === y1 ? 1 : -1;
        c.strokeStyle = active ? LINE : DIM; c.lineWidth = 1.4;
        c.beginPath(); c.moveTo(q.x, q.y); c.lineTo(q.x, q.y + dir * 8); c.moveTo(q.x - 5, q.y + dir * 8); c.lineTo(q.x + 5, q.y + dir * 8); c.stroke();
      }
    });
    // port lines to the pins (fixed, under the switched-in box) + exhausts
    for (const [name, frac] of Object.entries(L.top)) {
      const x = cx + (frac - 0.5) * bw;
      c.strokeStyle = pressureColor(portP[name]); c.lineWidth = CC.num(portP[name]) > 0 ? 2.6 : 1.4;
      c.beginPath(); c.moveTo(x, y1); c.lineTo(x, n.y); c.stroke();
      tag(c, name, x + 5, n.y + 9, 'left', '#cfe8ff', 10);
    }
    for (const [name, frac] of Object.entries(L.bottom)) {
      const x = cx + (frac - 0.5) * bw;
      if (name === 'P') {
        c.strokeStyle = pressureColor(pP); c.lineWidth = pP > 0 ? 2.6 : 1.4;
        c.beginPath(); c.moveTo(x, y2); c.lineTo(x, n.y + d.h); c.stroke();
      } else {
        c.strokeStyle = EXHAUST; c.lineWidth = 1.3;
        c.beginPath(); c.moveTo(x, y2); c.lineTo(x, y2 + 8); c.stroke();
        exhaustMark(c, x, y2 + 8, EXHAUST);
      }
      tag(c, name, x + 5, n.y + d.h - 8, 'left', '#cfe8ff', 10);
    }
    // actuators: 14 on the left, spring and/or 12 on the right (4/3: springs on both sides)
    const rightEnd = left0 + boxes.length * bw;
    const on14 = n.kind === 'VALVE_4_3' ? CC.num(ins[1]) > 0 || ins[1] === true : truthy(ins[1]);
    const on12 = truthy(ins[2]) || (n.kind === 'VALVE_4_3' && typeof ins[1] === 'number' && ins[1] < 0);
    const spring43 = n.kind === 'VALVE_4_3';
    let lx = left0;
    if (spring43) { spring(c, lx - 14, lx, ym, LINE); lx -= 14; }
    solenoid(c, lx - 14, ym, on14, n.kind === 'VALVE' ? '' : '14');
    c.save(); c.setLineDash([4, 3]); c.strokeStyle = on14 ? ON : DIM; c.lineWidth = 1.2; c.beginPath(); c.moveTo(n.x, ym); c.lineTo(lx - 14, ym); c.stroke(); c.restore();
    let rx = rightEnd;
    const hasSpring = spring43 || n.kind === 'VALVE' || n.mode !== 'bistable';
    if (hasSpring) { spring(c, rx, rx + 14, ym, LINE); rx += 14; }
    if (n.kind !== 'VALVE') {
      solenoid(c, rx + 1, ym, on12, '12');
      c.save(); c.setLineDash([4, 3]); c.strokeStyle = on12 ? ON : DIM; c.lineWidth = 1.2; c.beginPath(); c.moveTo(rx + 14, ym); c.lineTo(n.x + d.w, ym); c.stroke(); c.restore();
    }
    const modeText = n.kind === 'VALVE_4_3' ? 'center: ' + (n.center || 'closed') : n.kind === 'VALVE' ? 'spring return' : n.mode === 'bistable' ? 'bistable' : 'spring return';
    tag(c, modeText, n.x + d.w - 22, n.y + 8, 'right', 'rgba(255,255,255,.5)', 9);
    if (n.kind === 'VALVE') tag(c, 'Open', n.x + 6, ym - 10, 'left', 'rgba(255,255,255,.65)', 9);
  }

  function drawCylinder(c, n, d, mem, ins, out) {
    const g = CC.CYL, dbl = n.kind === 'CYL_DA';
    const x = Math.max(0, Math.min(1, mem.x || 0));
    const bx1 = n.x + g.x1, bx2 = n.x + g.x2, by1 = n.y + g.y1, by2 = n.y + g.y2, ry = n.y + g.rodY;
    const pA = CC.num(ins[0]), pB = dbl ? CC.num(ins[1]) : 0;
    const bore = Math.round(Number(n.bore) || 40);
    frame(c, n, d, '');
    tag(c, 'Ø' + bore + ' · load ' + (Math.round(Number(n.load ?? 1) * 10) / 10) + ' kN', n.x + d.w * 0.4, n.y + d.h - 10, 'center', 'rgba(255,255,255,.6)', 10);
    const PW = 9; // piston width
    const px = bx1 + 4 + x * (bx2 - bx1 - PW - 8); // piston (left face)
    // chambers
    // chambers: oil-colored while under pressure
    c.fillStyle = pA > 0 ? 'rgba(245,165,36,' + Math.min(0.85, 0.3 + pA / 250) + ')' : 'rgba(255,255,255,.05)';
    c.fillRect(bx1, by1, px - bx1, by2 - by1);
    c.fillStyle = pB > 0 ? 'rgba(245,165,36,' + Math.min(0.85, 0.3 + pB / 250) + ')' : 'rgba(255,255,255,.05)';
    c.fillRect(px + PW, by1, bx2 - px - PW, by2 - by1);
    c.beginPath(); c.rect(bx1, by1, bx2 - bx1, by2 - by1); c.strokeStyle = LINE; c.lineWidth = 2.6; c.stroke();
    c.fillStyle = LINE; c.fillRect(bx1 - 4, by1 - 3, 4, by2 - by1 + 6); c.fillRect(bx2, by1 - 3, 4, by2 - by1 + 6); // end caps
    // piston + rod (the rod leaves the module and can press limit switches)
    c.fillStyle = '#c9d3de'; c.fillRect(px, by1 + 1, PW, by2 - by1 - 2);
    if (!dbl) { // return spring: a coil around the rod, between piston and front cap
      const x0 = px + PW, x1 = bx2 - 1, turns = 9;
      c.beginPath(); c.moveTo(x0, by2 - 3);
      for (let k = 1; k <= turns * 2; k++) c.lineTo(x0 + ((x1 - x0) * k) / (turns * 2), k % 2 ? by1 + 3 : by2 - 3);
      c.strokeStyle = 'rgba(230,238,246,.75)'; c.lineWidth = 1.5; c.stroke();
    }
    const tip = bx2 + g.out + x * g.stroke;
    const rg = c.createLinearGradient(0, ry - 6, 0, ry + 6); rg.addColorStop(0, '#f4f7fa'); rg.addColorStop(1, '#8794a3');
    c.fillStyle = rg; c.fillRect(px + PW, ry - 6, tip - px - PW, 12);
    c.fillStyle = x >= 0.999 ? ON : '#d6dde5'; roundRect(c, tip, ry - 13, g.plate, 26, 2); c.fill();
    // ports
    const ports = [['A', d.ins[0], pA]].concat(dbl ? [['B', d.ins[1], pB]] : []);
    for (const [name, pin, p] of ports) {
      const xx = n.x + d.w * pin.f;
      c.strokeStyle = pressureColor(p); c.lineWidth = p > 0 ? 2.6 : 1.4;
      c.beginPath(); c.moveTo(xx, by2); c.lineTo(xx, n.y + d.h); c.stroke();
      tag(c, name, xx + 5, n.y + d.h - 8, 'left', '#cfe8ff', 10);
    }
    // outputs (top): end positions, position, force
    const val = [out[0] ? 'out ▸' : 'out', Math.round(CC.num(out[1])) + '%', out[2] ? '◂ in' : 'in', (Math.round(CC.num(out[3]) * 10) / 10) + 'kN'];
    d.outs.forEach((pin, i) => {
      const q = pinPos(n, 'out', i, true);
      tag(c, val[i], q.x, q.y + 11, 'center', pin.bool && out[i] ? '#ff8080' : 'rgba(255,255,255,.75)', 10);
    });
  }

  /** Limit sensor: an inductive proximity sensor (no lever). It detects a rod that comes near its face. */
  function drawLimit(c, n, d, out) {
    const on = !!out[0];
    frame(c, n, d, '');
    const cy = n.y + d.h / 2, fx = n.x + 10, x2 = n.x + 66, r = 12;
    // detection field in front of the face
    if (on) {
      c.save();
      const g = c.createRadialGradient(fx, cy, 2, fx, cy, 22);
      g.addColorStop(0, 'rgba(255,170,60,.55)'); g.addColorStop(1, 'rgba(255,170,60,0)');
      c.fillStyle = g; c.beginPath(); c.arc(fx, cy, 22, Math.PI * 0.5, Math.PI * 1.5); c.fill();
      c.restore();
    }
    c.save(); c.setLineDash([2, 3]); c.strokeStyle = on ? 'rgba(255,190,90,.9)' : 'rgba(255,255,255,.28)'; c.lineWidth = 1;
    for (const rr of [8, 14]) { c.beginPath(); c.arc(fx, cy, rr, Math.PI * 0.62, Math.PI * 1.38); c.stroke(); }
    c.restore();
    // threaded metal barrel
    const bg = c.createLinearGradient(0, cy - r, 0, cy + r);
    bg.addColorStop(0, '#e3e8ed'); bg.addColorStop(0.45, '#9ba6b2'); bg.addColorStop(1, '#4f5964');
    c.fillStyle = bg; c.fillRect(fx + 4, cy - r, x2 - fx - 4, 2 * r);
    c.strokeStyle = 'rgba(40,48,56,.55)'; c.lineWidth = 1;
    for (let x = fx + 8; x < x2 - 2; x += 3.2) { c.beginPath(); c.moveTo(x, cy - r); c.lineTo(x + 1.6, cy + r); c.stroke(); }
    c.strokeStyle = '#2b333c'; c.lineWidth = 1.2; c.strokeRect(fx + 4, cy - r, x2 - fx - 4, 2 * r);
    // two lock nuts
    for (const nx of [fx + 14, x2 - 16]) {
      const ng = c.createLinearGradient(0, cy - r - 4, 0, cy + r + 4); ng.addColorStop(0, '#c7ced6'); ng.addColorStop(1, '#5a6470');
      c.fillStyle = ng; c.fillRect(nx, cy - r - 4, 7, 2 * r + 8); c.strokeStyle = '#2b333c'; c.strokeRect(nx, cy - r - 4, 7, 2 * r + 8);
    }
    // sensing face (plastic cap)
    roundRect(c, fx - 2, cy - r + 1, 7, 2 * r - 2, 2); c.fillStyle = on ? '#ffb347' : '#e08a2e'; c.fill(); c.strokeStyle = '#7a4a10'; c.stroke();
    // rear housing with LED ring, cable to the pins
    roundRect(c, x2, cy - r + 2, 14, 2 * r - 4, 2); c.fillStyle = '#20262d'; c.fill(); c.strokeStyle = '#3c4650'; c.stroke();
    c.beginPath(); c.arc(x2 + 7, cy, 4, 0, Math.PI * 2);
    if (on) { c.save(); c.shadowColor = '#ffb020'; c.shadowBlur = 10; c.fillStyle = '#ffcc33'; c.fill(); c.restore(); } else { c.fillStyle = '#4a3a10'; c.fill(); }
    c.strokeStyle = '#111'; c.lineWidth = 3;
    for (let i = 0; i < 2; i++) { const q = pinPos(n, 'out', i, true); c.beginPath(); c.moveTo(x2 + 14, cy + (i ? 3 : -3)); c.quadraticCurveTo(x2 + 20, q.y, q.x - 4, q.y); c.stroke(); }
    tag(c, 'Limit Sensor', n.x + 4, n.y + 8, 'left', 'rgba(255,255,255,.55)', 8);
    d.outs.forEach((pin, i) => { const q = pinPos(n, 'out', i, true); tag(c, pin.n, q.x - 6, q.y + (i ? 10 : -10), 'right', out[i] ? '#ff8080' : 'rgba(255,255,255,.6)', 8); });
  }

  /** Motor-pump unit: electric motor (fins, fan cover, terminal box) coupled to a gear pump. */
  function drawPump(c, n, d, mem, ins) {
    const p = mem.p || 0, max = Math.max(1, Number(n.value) || 100), on = p > 0.5;
    const powered = truthy(ins[0]);
    frame(c, n, d, 'Pump');
    const now = performance.now();
    const ang = (motorAngle.get(n.id) || 0) + (powered ? 10 : (p / max) * 10) * Math.min(0.1, (now - (motorAngle.get(n.id + ':t') || now)) / 1000);
    motorAngle.set(n.id, ang); motorAngle.set(n.id + ':t', now);
    const cy = n.y + d.h / 2 - 2;
    const X = (v) => n.x + v, Y = (v) => cy + v;
    // base plate
    c.fillStyle = '#2a3139'; roundRect(c, X(10), Y(22), 118, 6, 2); c.fill();
    c.fillStyle = '#3a434d'; c.fillRect(X(22), Y(17), 10, 6); c.fillRect(X(62), Y(17), 10, 6); c.fillRect(X(100), Y(17), 10, 6);
    // electric motor body with cooling fins
    const mg = c.createLinearGradient(0, Y(-19), 0, Y(19));
    mg.addColorStop(0, '#6f9fd2'); mg.addColorStop(0.45, '#2f67a5'); mg.addColorStop(1, '#173a63');
    roundRect(c, X(18), Y(-19), 60, 38, 6); c.fillStyle = mg; c.fill(); c.strokeStyle = '#0e2440'; c.lineWidth = 1.2; c.stroke();
    c.strokeStyle = 'rgba(10,25,45,.55)'; c.lineWidth = 1.4;
    for (let x = 24; x < 76; x += 5) { c.beginPath(); c.moveTo(X(x), Y(-17)); c.lineTo(X(x), Y(17)); c.stroke(); }
    // fan cover (left end) with a turning fan behind the grille
    roundRect(c, X(9), Y(-16), 11, 32, 3); c.fillStyle = '#20272e'; c.fill(); c.strokeStyle = '#4b5661'; c.stroke();
    c.save(); c.beginPath(); c.rect(X(9), Y(-16), 11, 32); c.clip();
    c.strokeStyle = powered ? 'rgba(160,190,220,.8)' : 'rgba(160,190,220,.35)'; c.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) { const yy = ((i * 6 + (powered ? ang * 30 : 0)) % 36) - 18; c.beginPath(); c.moveTo(X(10), Y(yy)); c.lineTo(X(19), Y(yy + 3)); c.stroke(); }
    c.restore();
    // terminal box + status LED, cable from the Power pin
    const tg = c.createLinearGradient(0, Y(-28), 0, Y(-19)); tg.addColorStop(0, '#5d8fc5'); tg.addColorStop(1, '#244f80');
    roundRect(c, X(38), Y(-28), 22, 10, 2); c.fillStyle = tg; c.fill(); c.strokeStyle = '#0e2440'; c.stroke();
    c.beginPath(); c.arc(X(54), Y(-23), 2.4, 0, Math.PI * 2);
    if (powered) { c.save(); c.shadowColor = '#3cff7a'; c.shadowBlur = 6; c.fillStyle = '#3cff7a'; c.fill(); c.restore(); } else { c.fillStyle = '#1d3a24'; c.fill(); }
    const pinY = pinPos(n, 'in', 0, true).y;
    c.strokeStyle = powered ? ON : '#151a1f'; c.lineWidth = 2.6;
    c.beginPath(); c.moveTo(n.x, pinY); c.bezierCurveTo(X(10), pinY, X(30), Y(-34), X(42), Y(-28)); c.stroke();
    // coupling / bell housing
    const bg = c.createLinearGradient(0, Y(-11), 0, Y(11)); bg.addColorStop(0, '#d5dbe1'); bg.addColorStop(1, '#6f7a86');
    c.fillStyle = bg; c.fillRect(X(78), Y(-11), 12, 22); c.strokeStyle = '#3a434d'; c.lineWidth = 1; c.strokeRect(X(78), Y(-11), 12, 22);
    // gear pump block with a turning gear
    const pg = c.createLinearGradient(0, Y(-17), 0, Y(17)); pg.addColorStop(0, '#e6eaee'); pg.addColorStop(0.5, '#a9b3bd'); pg.addColorStop(1, '#6a7480');
    roundRect(c, X(90), Y(-17), 34, 34, 4); c.fillStyle = pg; c.fill(); c.strokeStyle = '#3a434d'; c.lineWidth = 1.2; c.stroke();
    c.save(); c.translate(X(107), Y(0)); c.rotate(ang);
    c.beginPath();
    for (let i = 0; i < 20; i++) { const a2 = (i / 20) * Math.PI * 2, r = i % 2 ? 8 : 11; c.lineTo(Math.cos(a2) * r, Math.sin(a2) * r); }
    c.closePath(); c.fillStyle = on ? '#f5a524' : '#5b6672'; c.fill(); c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1; c.stroke();
    c.beginPath(); c.arc(0, 0, 3, 0, Math.PI * 2); c.fillStyle = '#e6eaee'; c.fill();
    c.restore();
    // outlet to the P port
    const outY = pinPos(n, 'out', 0, true).y;
    c.fillStyle = '#9aa5b1'; c.fillRect(X(124), outY - 6, 6, 12);
    c.strokeStyle = pressureColor(p); c.lineWidth = on ? 3 : 1.6; c.beginPath(); c.moveTo(X(130), outY); c.lineTo(n.x + d.w, outY); c.stroke();
    tag(c, 'P', n.x + d.w - 6, outY - 10, 'right', '#cfe8ff', 10);
    // pressure readout
    roundRect(c, n.x + d.w / 2 - 34, n.y + d.h - 17, 68, 13, 3); c.fillStyle = '#071526'; c.fill();
    tag(c, Math.round(p) + ' / ' + max + ' bar', n.x + d.w / 2, n.y + d.h - 10.5, 'center', on ? '#7fd0ff' : 'rgba(127,208,255,.5)', 9);
  }

  const GAUGE_RANGES = [10, 16, 20, 40, 60, 100, 160, 200, 400, 600, 1000];
  function gaugeRange(n) {
    const set = Number(n.range);
    if (GAUGE_RANGES.includes(set)) return set;
    const trip = Math.max(0, Number(n.value) || 0);
    return GAUGE_RANGES.find((s) => s >= Math.max(10, trip * 1.25)) || 1000;
  }
  /** Bourdon-tube pressure gauge: chrome bezel, white dial with 5 numbers, black needle, brass fitting. */
  function drawGauge(c, n, d, ins, out) {
    const p = Math.max(0, CC.num(ins[0])), trip = Math.max(0, Number(n.value) || 0);
    frame(c, n, d, '');
    // ranges whose quarter steps are round numbers (0, ¼, ½, ¾, full)
    // Fixed range like a real gauge: the one set in the inspector, else picked from the set pressure (never from the live pressure).
    const scale = gaugeRange(n);
    const overRange = p > scale;
    const cx = n.x + 68, cy = n.y + 62, R = 46;
    const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
    const angOf = (v) => A0 + (Math.min(v, scale * 1.03) / scale) * SWEEP;
    const at = (ang, r) => [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    // brass fitting down to the P port
    const fy = cy + R + 4, py = n.y + d.h;
    const brass = c.createLinearGradient(cx - 12, 0, cx + 12, 0);
    brass.addColorStop(0, '#8a6a1f'); brass.addColorStop(0.45, '#f3d27a'); brass.addColorStop(1, '#7a5a15');
    c.fillStyle = brass; c.fillRect(cx - 12, fy, 24, 14);
    c.fillRect(cx - 7, fy + 14, 14, py - fy - 18);
    c.strokeStyle = 'rgba(80,55,10,.7)'; c.lineWidth = 1;
    for (let y = fy + 17; y < py - 5; y += 3) { c.beginPath(); c.moveTo(cx - 7, y); c.lineTo(cx + 7, y + 1.5); c.stroke(); }
    c.strokeStyle = pressureColor(p); c.lineWidth = p > 0 ? 2.6 : 1.4; c.beginPath(); c.moveTo(cx, py - 4); c.lineTo(cx, py); c.stroke();
    // chrome bezel
    const bz = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    bz.addColorStop(0, '#f2f4f6'); bz.addColorStop(0.35, '#8e98a3'); bz.addColorStop(0.6, '#e3e7eb'); bz.addColorStop(1, '#4b545e');
    c.beginPath(); c.arc(cx, cy, R + 6, 0, Math.PI * 2); c.fillStyle = bz; c.fill();
    c.beginPath(); c.arc(cx, cy, R + 1.5, 0, Math.PI * 2); c.fillStyle = '#2a3038'; c.fill();
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = '#fbfbfa'; c.fill();
    // scale: 40 small ticks, longer every 5, numbers on the 5 main ticks
    c.strokeStyle = '#111'; c.lineCap = 'butt';
    for (let k = 0; k <= 40; k++) {
      const ang = A0 + (k / 40) * SWEEP, main = k % 10 === 0, mid = k % 5 === 0;
      const r1 = R - 4, r2 = R - (main ? 13 : mid ? 10 : 7);
      const [x1, y1] = at(ang, r1), [x2, y2] = at(ang, r2);
      c.lineWidth = main ? 2.4 : mid ? 1.6 : 1.1;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      if (main) {
        const [tx, ty] = at(ang, R - 22);
        const v = (scale * k) / 40;
        c.fillStyle = '#111'; c.font = '600 11px Arial, "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(String(Math.round(v * 10) / 10), tx, ty);
      }
    }
    // red mark at the set pressure
    if (trip > 0 && trip <= scale) {
      const ang = angOf(trip), [x1, y1] = at(ang, R - 3), [x2, y2] = at(ang, R - 14);
      c.strokeStyle = '#d61f1f'; c.lineWidth = 3; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
    }
    c.fillStyle = '#111'; c.font = '600 12px Arial, "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('bar', cx, cy + R - 12);
    // needle: thin pointer, wide counterweight tail, brass screw
    const na = angOf(p), cos = Math.cos(na), sin = Math.sin(na);
    c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 3; c.shadowOffsetY = 1.5;
    c.beginPath();
    c.moveTo(cx + cos * (R - 6), cy + sin * (R - 6));
    c.lineTo(cx - sin * 2.2, cy + cos * 2.2);
    c.lineTo(cx - cos * 10 - sin * 5, cy - sin * 10 + cos * 5);
    c.quadraticCurveTo(cx - cos * 19, cy - sin * 19, cx - cos * 10 + sin * 5, cy - sin * 10 - cos * 5);
    c.lineTo(cx + sin * 2.2, cy - cos * 2.2);
    c.closePath(); c.fillStyle = '#121212'; c.fill(); c.restore();
    c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fillStyle = '#121212'; c.fill();
    c.beginPath(); c.arc(cx, cy, 2.6, 0, Math.PI * 2); c.fillStyle = '#e8c76a'; c.fill();
    // glass reflection
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
    c.beginPath(); c.ellipse(cx - 14, cy - 22, R * 0.75, R * 0.32, -0.5, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,.18)'; c.fill(); c.restore();
    // "Over" contact on the right
    const oy = pinPos(n, 'out', 0, true).y, lx = n.x + d.w - 14, on = !!out[0];
    c.beginPath(); c.arc(lx, oy - 16, 4, 0, Math.PI * 2);
    if (on) { c.save(); c.shadowColor = ON; c.shadowBlur = 8; c.fillStyle = ON; c.fill(); c.restore(); } else { c.fillStyle = 'rgba(255,255,255,.18)'; c.fill(); }
    tag(c, 'Over', lx - 3, oy + 13, 'center', on ? '#ff8080' : 'rgba(255,255,255,.65)', 9);
    tag(c, '≥' + Math.round(trip), lx - 3, oy + 24, 'center', 'rgba(255,255,255,.5)', 8);
    tag(c, 'P', cx + 11, py - 7, 'left', '#cfe8ff', 10);
    tag(c, (Math.round(p * 10) / 10).toFixed(1) + ' bar', cx - 17, fy + 8, 'right', overRange ? '#ff6b6b' : p > 0 ? '#7fd0ff' : 'rgba(255,255,255,.55)', 10);
    if (overRange) tag(c, 'over range!', cx - 17, fy + 20, 'right', '#ff6b6b', 9);
  }

  /** Knob geometry (node coordinates) and value range, for modules that have a knob. */
  function knobOf(n) {
    if (n.kind === 'POT') return { x: n.x + 50, y: n.y + 64, r: 21 };
    if (n.kind === 'FLOW_1W') return { x: n.x + 75, y: n.y + 120, r: 15 };
    return { x: n.x + 62, y: n.y + 98, r: 15 };
  }
  function knobRange(n) {
    if (n.kind === 'POT') { const r = CC.potRange(n); return { ...r, value: CC.potValue(n), wheel: (r.max - r.min) / 20 }; }
    return { min: 0, max: 100, value: CC.flowOpening(n, null), wheel: 5 };
  }
  const KNOB_A0 = Math.PI * 0.75, KNOB_SWEEP = Math.PI * 1.5;
  /** A knob with a 270° scale; frac 0…1. */
  function drawKnob(c, k, frac, dim, big) {
    for (let i = 0; i <= 10; i++) {
      const ang = KNOB_A0 + (i / 10) * KNOB_SWEEP, l = i % 5 ? 4 : 7;
      c.beginPath(); c.moveTo(k.x + Math.cos(ang) * (k.r + 3), k.y + Math.sin(ang) * (k.r + 3)); c.lineTo(k.x + Math.cos(ang) * (k.r + 3 + l), k.y + Math.sin(ang) * (k.r + 3 + l));
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1; c.stroke();
    }
    // lit arc up to the value
    c.beginPath(); c.arc(k.x, k.y, k.r + 3, KNOB_A0, KNOB_A0 + frac * KNOB_SWEEP); c.strokeStyle = dim ? 'rgba(255,209,102,.35)' : '#ffd166'; c.lineWidth = 2.2; c.stroke();
    const kg = c.createRadialGradient(k.x - k.r * 0.3, k.y - k.r * 0.35, 2, k.x, k.y, k.r);
    kg.addColorStop(0, '#6a7682'); kg.addColorStop(1, '#1b2128');
    c.beginPath(); c.arc(k.x, k.y, k.r, 0, Math.PI * 2); c.fillStyle = kg; c.fill();
    c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1.3; c.stroke();
    if (big) for (let i = 0; i < 12; i++) { // grip ridges
      const a = (i / 12) * Math.PI * 2;
      c.beginPath(); c.moveTo(k.x + Math.cos(a) * (k.r - 1), k.y + Math.sin(a) * (k.r - 1)); c.lineTo(k.x + Math.cos(a) * (k.r - 4), k.y + Math.sin(a) * (k.r - 4));
      c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1.2; c.stroke();
    }
    const ka = KNOB_A0 + frac * KNOB_SWEEP;
    c.beginPath(); c.moveTo(k.x + Math.cos(ka) * 4, k.y + Math.sin(ka) * 4); c.lineTo(k.x + Math.cos(ka) * (k.r - 3), k.y + Math.sin(ka) * (k.r - 3));
    c.strokeStyle = '#ffd166'; c.lineWidth = big ? 3 : 2.6; c.lineCap = 'round'; c.stroke();
  }
  const fmtKnob = (v) => String(Math.round(v * 100) / 100);

  /** Flow control valve (throttle): ISO symbol plus a knob that sets the opening. */
  function drawFlow(c, n, d, ins, out) {
    const open = CC.flowOpening(n, ins), p = CC.num(ins[0]);
    const setWired = typeof ins[1] === 'number' ? ins[1] >= 0 : typeof ins[1] === 'boolean';
    frame(c, n, d, 'Flow Control');
    const y = pinPos(n, 'in', 0, true).y, cx = n.x + d.w / 2;
    const flowing = p > 0 && open > 0;
    // line through the throttle
    c.strokeStyle = pressureColor(p); c.lineWidth = p > 0 ? 2.6 : 1.4;
    c.beginPath(); c.moveTo(n.x, y); c.lineTo(cx - 6, y); c.stroke();
    c.strokeStyle = flowing ? HYD_ON : LINE; c.lineWidth = flowing ? 2.6 : 1.4;
    c.beginPath(); c.moveTo(cx + 6, y); c.lineTo(n.x + d.w, y); c.stroke();
    // throttle: two arcs pinching the line, gap = opening
    const gap = 1.5 + (open / 100) * 6;
    c.strokeStyle = LINE; c.lineWidth = 1.8;
    c.beginPath(); c.arc(cx, y - 13 - gap, 13, Math.PI * 0.2, Math.PI * 0.8); c.stroke();
    c.beginPath(); c.arc(cx, y + 13 + gap, 13, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
    if (flowing) { c.strokeStyle = HYD_ON; c.lineWidth = Math.max(1, gap * 0.6); c.beginPath(); c.moveTo(cx - 6, y); c.lineTo(cx + 6, y); c.stroke(); }
    // adjustable arrow through it
    c.strokeStyle = LINE; c.lineWidth = 1.3; c.beginPath(); c.moveTo(cx - 16, y + 16); c.lineTo(cx + 13, y - 13); c.stroke();
    arrowTo(c, cx - 16, y + 16, cx + 16, y - 16, LINE);
    // Set signal (dashed) from the top pin
    c.save(); c.setLineDash([4, 3]); c.strokeStyle = setWired ? ON : DIM; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(cx, n.y); c.lineTo(cx, y - 22); c.stroke(); c.restore();
    // knob
    const k = knobOf(n);
    drawKnob(c, k, open / 100, setWired, false);
    tag(c, Math.round(open) + '%', n.x + d.w - 8, k.y + 2, 'right', '#ffd166', 11);
    tag(c, setWired ? 'by Set' : 'speed', n.x + 8, k.y + 2, 'left', 'rgba(255,255,255,.55)', 9);
  }
  /** One-way flow control: throttle in the main line, check valve in a bypass, knob. */
  function drawFlow1W(c, n, d, ins, out) {
    const open = CC.flowOpening(n, null), p = CC.num(ins[0]);
    const meterIn = n.mode !== 'out';
    frame(c, n, d, 'Throttle Check Valve');
    const y = pinPos(n, 'in', 0, true).y, cx = n.x + d.w / 2, x1 = n.x + 26, x2 = n.x + d.w - 26, by = y - 34;
    const live = p > 0;
    // main line with the throttle
    c.strokeStyle = live ? HYD_ON : LINE; c.lineWidth = live ? 2.6 : 1.4;
    c.beginPath(); c.moveTo(n.x, y); c.lineTo(cx - 6, y); c.stroke();
    c.strokeStyle = CC.num(out[0]) > 0 ? HYD_ON : LINE; c.lineWidth = CC.num(out[0]) > 0 ? 2.6 : 1.4;
    c.beginPath(); c.moveTo(cx + 6, y); c.lineTo(n.x + d.w, y); c.stroke();
    const gap = 1.5 + (open / 100) * 6;
    c.strokeStyle = LINE; c.lineWidth = 1.8;
    c.beginPath(); c.arc(cx, y - 13 - gap, 13, Math.PI * 0.2, Math.PI * 0.8); c.stroke();
    c.beginPath(); c.arc(cx, y + 13 + gap, 13, Math.PI * 1.2, Math.PI * 1.8); c.stroke();
    if (live && open > 0) { c.strokeStyle = HYD_ON; c.lineWidth = Math.max(1, gap * 0.6); c.beginPath(); c.moveTo(cx - 6, y); c.lineTo(cx + 6, y); c.stroke(); }
    c.strokeStyle = LINE; c.lineWidth = 1.3; c.beginPath(); c.moveTo(cx - 16, y + 16); c.lineTo(cx + 13, y - 13); c.stroke();
    arrowTo(c, cx - 16, y + 16, cx + 16, y - 16, LINE);
    // bypass with the check valve (free flow one way)
    c.strokeStyle = live ? HYD_ON : LINE; c.lineWidth = live ? 2.2 : 1.4;
    c.beginPath(); c.moveTo(x1, y); c.lineTo(x1, by); c.lineTo(cx - 12, by); c.moveTo(cx + 10, by); c.lineTo(x2, by); c.lineTo(x2, y); c.stroke();
    c.beginPath(); c.arc(x1, y, 2.5, 0, Math.PI * 2); c.arc(x2, y, 2.5, 0, Math.PI * 2); c.fillStyle = live ? HYD_ON : LINE; c.fill();
    // seat (V) + ball: free flow from the V's point towards the ball
    const dir = meterIn ? -1 : 1; // meter-out: free towards the cylinder (left → right)
    const sx = cx - dir * 6;
    c.strokeStyle = LINE; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(sx + dir * 8, by - 8); c.lineTo(sx, by); c.lineTo(sx + dir * 8, by + 8); c.stroke();
    c.beginPath(); c.arc(sx + dir * 9, by, 5, 0, Math.PI * 2); c.fillStyle = '#0a1c3a'; c.fill(); c.stroke();
    arrowTo(c, cx - dir * 30, by - 10, cx - dir * 18, by - 10, 'rgba(255,255,255,.55)');
    c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1; c.beginPath(); c.moveTo(cx - dir * 38, by - 10); c.lineTo(cx - dir * 24, by - 10); c.stroke();
    tag(c, 'free', cx - dir * 44, by - 10, dir > 0 ? 'right' : 'left', 'rgba(255,255,255,.55)', 8);
    // knob
    const k = knobOf(n);
    drawKnob(c, k, open / 100, false, false);
    tag(c, Math.round(open) + '%', n.x + d.w - 10, k.y + 2, 'right', '#ffd166', 11);
    {
      const po = CC.num(out[0]), frac = p > 0 ? Math.min(1, po / p) : po > 0 ? 1 : 0;
      const bx0 = cx + 22, bx1 = n.x + d.w - 8, yb = y + 14;
      roundRect(c, bx0, yb, bx1 - bx0, 5, 2); c.fillStyle = 'rgba(255,255,255,.12)'; c.fill();
      if (frac > 0) { roundRect(c, bx0, yb, Math.max(2, (bx1 - bx0) * frac), 5, 2); c.fillStyle = HYD_ON; c.fill(); }
      tag(c, (Math.round(po * 10) / 10).toFixed(1) + ' bar', bx1, yb + 13, 'right', po > 0 ? '#9fdcff' : 'rgba(255,255,255,.5)', 9);
    }
    tag(c, meterIn ? 'meter-in' : 'meter-out', n.x + 8, k.y + 2, 'left', 'rgba(255,255,255,.55)', 9);
  }

  // ------------------------------------------------------------------ text display (green VFD, typewriter)
  const typing = new Map(); // node id -> time the display turned on
  function drawDisplay(c, n, d, ins) {
    const text = String(n.text ?? '');
    const v = ins[0];
    const textMode = text.length > 0;
    const on = textMode ? truthy(v) : v !== undefined;
    const now = performance.now();
    if (on && !typing.has(n.id)) typing.set(n.id, now);
    if (!on) typing.delete(n.id);
    frame(c, n, d, '');
    // housing + glass
    const hx = n.x + 6, hy = n.y + 14, hw = d.w - 12, hh = d.h - 20;
    const hg = c.createLinearGradient(0, hy, 0, hy + hh); hg.addColorStop(0, '#3b434c'); hg.addColorStop(1, '#14181c');
    roundRect(c, hx, hy, hw, hh, 6); c.fillStyle = hg; c.fill(); c.strokeStyle = '#596370'; c.lineWidth = 1.2; c.stroke();
    const gx = hx + 7, gy = hy + 6, gw = hw - 14, gh = hh - 12;
    roundRect(c, gx, gy, gw, gh, 3); c.fillStyle = '#04120a'; c.fill();
    c.save(); roundRect(c, gx, gy, gw, gh, 3); c.clip();
    c.font = '600 17px "Cascadia Mono", Consolas, monospace'; c.textBaseline = 'middle'; c.textAlign = 'left';
    const cw = c.measureText('8').width, cols = Math.max(1, Math.floor((gw - 10) / cw)), ty = gy + gh / 2 + 1;
    c.fillStyle = 'rgba(57,255,122,.07)'; c.fillText('8'.repeat(cols), gx + 5, ty); // unlit cells
    if (on) {
      let shown;
      if (textMode) {
        const n2 = Math.min(text.length, Math.floor((now - typing.get(n.id)) / 85) + 1); // ~12 letters per second
        shown = text.slice(0, n2);
        if (shown.length > cols) { // longer text: scroll once it is typed
          const extra = shown.length - cols;
          const scroll = n2 >= text.length ? Math.floor(((now - typing.get(n.id) - text.length * 85) / 250) % (extra + 6)) : extra;
          shown = shown.slice(Math.min(extra, Math.max(0, scroll)), Math.min(extra, Math.max(0, scroll)) + cols);
        }
        if (n2 < text.length || Math.floor(now / 450) % 2) shown += n2 < text.length ? '█' : '';
      } else shown = fmt(v).slice(0, cols);
      c.shadowColor = '#39ff7a'; c.shadowBlur = 8; c.fillStyle = '#5dff95';
      c.fillText(shown, gx + 5, ty);
    }
    c.restore();
    // glass reflection
    c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(gx, gy, gw, gh * 0.4);
    tag(c, 'Display', n.x + 5, n.y + 7, 'left', 'rgba(255,255,255,.55)', 8);
    c.beginPath(); c.arc(hx + hw - 8, hy + hh - 4.5, 2, 0, Math.PI * 2); c.fillStyle = on ? '#3cff7a' : '#173a24'; c.fill();
  }
  function displayAnimating(n) {
    const t0 = typing.get(n.id);
    return t0 !== undefined && String(n.text ?? '').length > 0;
  }

  // ------------------------------------------------------------------ electric motor (side view + spinning pulley)
  function drawMotor(c, n, d, ins) {
    const speed = motorSpeed(n), running = speed !== 0;
    const now = performance.now();
    const ang = (motorAngle.get(n.id) || 0) + speed * 7 * Math.min(0.1, (now - (motorAngle.get(n.id + ':t') || now)) / 1000);
    motorAngle.set(n.id, ang); motorAngle.set(n.id + ':t', now);
    frame(c, n, d, 'Electric Motor');
    const cy = n.y + d.h / 2 + 4, X = (v) => n.x + v, Y = (v) => cy + v;
    // feet / base
    c.fillStyle = '#2a3139'; roundRect(c, X(22), Y(26), 106, 6, 2); c.fill();
    c.fillStyle = '#3a434d'; c.fillRect(X(34), Y(20), 12, 7); c.fillRect(X(102), Y(20), 12, 7);
    // fan cover
    roundRect(c, X(12), Y(-22), 14, 44, 4); c.fillStyle = '#1d242b'; c.fill(); c.strokeStyle = '#4b5661'; c.lineWidth = 1.2; c.stroke();
    c.save(); c.beginPath(); c.rect(X(12), Y(-22), 14, 44); c.clip();
    c.strokeStyle = running ? 'rgba(170,200,230,.85)' : 'rgba(170,200,230,.3)'; c.lineWidth = 1.3;
    for (let i = 0; i < 8; i++) { const yy = ((i * 6 + (running ? ang * 25 : 0)) % 48 + 48) % 48 - 24; c.beginPath(); c.moveTo(X(13), Y(yy)); c.lineTo(X(25), Y(yy + 4)); c.stroke(); }
    c.restore();
    // body with cooling fins
    const mg = c.createLinearGradient(0, Y(-25), 0, Y(25));
    mg.addColorStop(0, '#74a5d8'); mg.addColorStop(0.42, '#2f67a5'); mg.addColorStop(1, '#132f52');
    roundRect(c, X(24), Y(-25), 98, 50, 9); c.fillStyle = mg; c.fill(); c.strokeStyle = '#0d2342'; c.lineWidth = 1.3; c.stroke();
    c.strokeStyle = 'rgba(8,22,42,.55)'; c.lineWidth = 1.5;
    for (let x = 32; x < 116; x += 6) { c.beginPath(); c.moveTo(X(x), Y(-23)); c.lineTo(X(x), Y(23)); c.stroke(); }
    c.fillStyle = 'rgba(255,255,255,.14)'; roundRect(c, X(26), Y(-23), 94, 8, 5); c.fill();
    // name plate + terminal box with LED, cable from the Power pin
    roundRect(c, X(56), Y(-6), 32, 14, 2); c.fillStyle = '#c9d1d9'; c.fill();
    c.fillStyle = '#1d2329'; c.font = '700 7px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(Math.abs(speed) ? Math.round(Math.abs(speed) * 60) + ' rpm' : '0 rpm', X(72), Y(1));
    const tg = c.createLinearGradient(0, Y(-36), 0, Y(-25)); tg.addColorStop(0, '#5d8fc5'); tg.addColorStop(1, '#244f80');
    roundRect(c, X(52), Y(-36), 28, 12, 2); c.fillStyle = tg; c.fill(); c.strokeStyle = '#0d2342'; c.stroke();
    c.beginPath(); c.arc(X(73), Y(-30), 2.5, 0, Math.PI * 2);
    if (running) { c.save(); c.shadowColor = '#3cff7a'; c.shadowBlur = 6; c.fillStyle = '#3cff7a'; c.fill(); c.restore(); } else { c.fillStyle = '#1d3a24'; c.fill(); }
    const pinY = pinPos(n, 'in', 0, true).y;
    c.strokeStyle = truthy(ins[0]) ? ON : '#151a1f'; c.lineWidth = 2.8;
    c.beginPath(); c.moveTo(n.x, pinY); c.bezierCurveTo(X(8), pinY, X(36), Y(-44), X(56), Y(-36)); c.stroke();
    // front flange + shaft
    c.fillStyle = '#9aa5b1'; c.fillRect(X(122), Y(-18), 6, 36); c.strokeStyle = '#3a434d'; c.lineWidth = 1; c.strokeRect(X(122), Y(-18), 6, 36);
    const sg = c.createLinearGradient(0, Y(-4), 0, Y(4)); sg.addColorStop(0, '#eef2f5'); sg.addColorStop(1, '#7d8894');
    c.fillStyle = sg; c.fillRect(X(128), Y(-4), 22, 8);
    // pulley seen at an angle, spinning
    const px = X(158), pr = 22;
    c.save(); c.translate(px, cy); c.scale(0.42, 1);
    c.beginPath(); c.arc(0, 0, pr, 0, Math.PI * 2); c.fillStyle = '#3a434d'; c.fill(); c.strokeStyle = running ? '#7fdbff' : '#8a96a3'; c.lineWidth = 3; c.stroke();
    c.rotate(ang);
    for (let i = 0; i < 4; i++) { c.rotate(Math.PI / 2); c.beginPath(); c.moveTo(0, 0); c.lineTo(pr - 3, 0); c.strokeStyle = '#d6dde5'; c.lineWidth = 4; c.stroke(); }
    c.restore();
    c.beginPath(); c.ellipse(px, cy, 3.5, 6, 0, 0, Math.PI * 2); c.fillStyle = '#eef2f5'; c.fill();
    if (running) { // motion arcs
      c.strokeStyle = 'rgba(127,219,255,.7)'; c.lineWidth = 1.4;
      const dir = speed > 0 ? 1 : -1;
      c.beginPath(); c.ellipse(px, cy, 13, 30, 0, dir > 0 ? -1.2 : 1.9, dir > 0 ? -0.4 : 2.7); c.stroke();
    }
    tag(c, running ? (speed > 0 ? '▶ ' : '◀ ') + (Math.round(Math.abs(speed) * 60)) + ' rpm' : 'off', n.x + d.w - 6, n.y + d.h - 8, 'right', running ? '#bfe9ff' : 'rgba(255,255,255,.55)', 9);
  }

  // ------------------------------------------------------------------ steel blocks + bedrock
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function drawBlock(c, n) {
    const g = CC.blockGeom(n, memOf(n.id));
    const w = g.w, h = g.h;
    c.save();
    c.translate(g.center.x, g.center.y); c.rotate(g.ang);
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 10; c.shadowOffsetY = 4;
    if (n.kind === 'BEDROCK') {
      c.fillStyle = '#2b2d31'; c.fillRect(-w / 2, -h / 2, w, h);
      c.shadowColor = 'transparent';
      let seed = hash(n.id);
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      const cells = Math.max(6, Math.round((w * h) / 90));
      for (let i = 0; i < cells; i++) { // speckled stone
        const x = -w / 2 + rnd() * w, y = -h / 2 + rnd() * h, s = 3 + rnd() * 9, v = rnd();
        c.fillStyle = v < 0.33 ? '#45484e' : v < 0.66 ? '#1a1b1e' : '#5a5d63';
        c.fillRect(Math.min(x, w / 2 - s), Math.min(y, h / 2 - s), s, s);
      }
      c.strokeStyle = '#101113'; c.lineWidth = 3; c.strokeRect(-w / 2 + 1.5, -h / 2 + 1.5, w - 3, h - 3);
      c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '700 9px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle';
      if (w > 50 && h > 24) c.fillText('BEDROCK', 0, 0);
    } else {
      const sg = c.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
      sg.addColorStop(0, '#dfe5ea'); sg.addColorStop(0.45, '#9aa6b2'); sg.addColorStop(0.55, '#b7c1cb'); sg.addColorStop(1, '#5d6874');
      c.fillStyle = sg; c.fillRect(-w / 2, -h / 2, w, h);
      c.shadowColor = 'transparent';
      c.save(); c.beginPath(); c.rect(-w / 2, -h / 2, w, h); c.clip(); // brushed lines
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
      for (let k = -w - h; k < w + h; k += 5) { c.beginPath(); c.moveTo(-w / 2 + k, -h / 2); c.lineTo(-w / 2 + k + h, h / 2); c.stroke(); }
      c.restore();
      c.strokeStyle = '#3a434d'; c.lineWidth = 2; c.strokeRect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2);
      c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.beginPath(); c.moveTo(-w / 2 + 3, h / 2 - 3); c.lineTo(-w / 2 + 3, -h / 2 + 3); c.lineTo(w / 2 - 3, -h / 2 + 3); c.stroke();
      const bolt = (x, y) => { c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fillStyle = '#4b5661'; c.fill(); c.beginPath(); c.arc(x - 0.8, y - 0.8, 1.2, 0, Math.PI * 2); c.fillStyle = '#e6eaee'; c.fill(); };
      if (w > 24 && h > 24) { bolt(-w / 2 + 7, -h / 2 + 7); bolt(w / 2 - 7, -h / 2 + 7); bolt(-w / 2 + 7, h / 2 - 7); bolt(w / 2 - 7, h / 2 - 7); }
      if (n.fixed && !g.pivotLocal) { // anchored: hatched border
        c.strokeStyle = 'rgba(239,68,68,.85)'; c.lineWidth = 2; c.setLineDash([5, 4]); c.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8); c.setLineDash([]);
      }
      if (g.pivotLocal) { // rotation point
        const px = g.pivotLocal.x - w / 2, py = g.pivotLocal.y - h / 2;
        c.beginPath(); c.arc(px, py, 6, 0, Math.PI * 2); c.fillStyle = '#1d2329'; c.fill(); c.strokeStyle = '#facc15'; c.lineWidth = 2; c.stroke();
        c.beginPath(); c.moveTo(px - 3.5, py); c.lineTo(px + 3.5, py); c.moveTo(px, py - 3.5); c.lineTo(px, py + 3.5); c.strokeStyle = '#facc15'; c.lineWidth = 1.4; c.stroke();
      }
    }
    c.restore();
    if (n.kind === 'STEEL' || n.kind === 'BEDROCK') inFrame(c, n, () => { const gp = gearPos(n); drawGear(c, gp.x, gp.y, hoverGear === n.id || propsFor === n.id); });
  }

  // ------------------------------------------------------------------ extra parts (media/parts-draw.js)
  let PD = null, partsAnim = false;
  const partsDraw = () => PD || (PD = window.CollabPartsDraw({ tag, roundRect, ON, LINE, DIM, HYD_ON, FONT, truthy, num: CC.num, pinPos, shade, fmt, frame, wantFrames: () => { partsAnim = true; } }));
  function drawSpringPart(c, n) {
    const sz = CC.sizeOf(n), e = springEnds.get(n.id);
    let ax, ay, bx, by;
    if (e) [ax, ay, bx, by] = e;
    else { const cx = n.x + sz.w / 2, cy = n.y + sz.h / 2, a = ((n.rot || 0) * Math.PI) / 180, dx = (Math.cos(a) * sz.w) / 2, dy = (Math.sin(a) * sz.w) / 2; ax = cx - dx; ay = cy - dy; bx = cx + dx; by = cy + dy; }
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux;
    c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
    if (n.kind === 'ROPE') {
      const slack = Math.max(0, sz.w - L) * 0.45, mx = (ax + bx) / 2, my = (ay + by) / 2 + slack;
      c.beginPath(); c.moveTo(ax, ay); c.quadraticCurveTo(mx, my, bx, by); c.strokeStyle = '#a16207'; c.lineWidth = 3; c.stroke();
      c.setLineDash([2, 3]); c.strokeStyle = '#fde68a'; c.lineWidth = 1; c.stroke(); c.setLineDash([]);
    } else {
      const turns = 10, amp = 7;
      c.beginPath(); c.moveTo(ax, ay);
      for (let k = 1; k < turns * 2; k++) { const t = k / (turns * 2), side = k % 2 ? amp : -amp; c.lineTo(ax + ux * L * t + nx * side, ay + uy * L * t + ny * side); }
      c.lineTo(bx, by); c.strokeStyle = n.color && n.color !== '#ffffff' ? n.color : '#cbd5e1'; c.lineWidth = 2.2; c.stroke();
    }
    for (const [x, y] of [[ax, ay], [bx, by]]) { c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fillStyle = '#374151'; c.fill(); c.strokeStyle = '#e5e7eb'; c.lineWidth = 1.2; c.stroke(); }
    c.restore();
    inFrame(c, n, () => { const gp = gearPos(n); drawGear(c, gp.x, gp.y, hoverGear === n.id || propsFor === n.id); });
  }

  function drawFluid(c, n, d, ins, out, mem) {
    const pd = partsDraw()[n.kind];
    if (pd) { pd(c, n, d, ins, out, mem); return; }
    if (d.valve) drawValve(c, n, d, mem, ins, out);
    else if (n.kind === 'CYLINDER' || n.kind === 'CYL_DA') drawCylinder(c, n, d, mem, ins, out);
    else if (n.kind === 'LIMIT') drawLimit(c, n, d, out);
    else if (n.kind === 'PUMP') drawPump(c, n, d, mem, ins);
    else if (n.kind === 'GAUGE') drawGauge(c, n, d, ins, out);
    else if (n.kind === 'FLOW') drawFlow(c, n, d, ins, out);
    else if (n.kind === 'FLOW_1W') drawFlow1W(c, n, d, ins, out);
    else if (n.kind === 'DISPLAY') drawDisplay(c, n, d, ins);
    else if (n.kind === 'MOTOR') drawMotor(c, n, d, ins);
    c.lineWidth = 2;
  }

  // ------------------------------------------------------------------ settings gear on modules
  const EDIT_IN_PLACE = ['NUMBER', 'CLOCK', 'DELAY', 'PULSE', 'COUNTER'];
  const hasSettings = (n) => n && n.type === 'node' && (INSPECT.has(n.kind) || EDIT_IN_PLACE.includes(n.kind));
  function gearPos(n) { const d = def(n.kind), sz = CC.sizeOf(n); return { x: n.x + sz.w - 11, y: n.y + (d.bare ? 10 : 12) }; }
  let hoverGear = null;
  function drawGear(c, x, y, hot) {
    c.save();
    c.translate(x, y);
    c.fillStyle = hot ? '#ffd166' : 'rgba(255,255,255,.78)';
    c.beginPath();
    for (let i = 0; i < 16; i++) { // 8 teeth
      const a = (i / 16) * Math.PI * 2, r = i % 2 ? 4.4 : 6.2, a2 = ((i + 1) / 16) * Math.PI * 2;
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r); c.lineTo(Math.cos(a2) * r, Math.sin(a2) * r);
    }
    c.closePath(); c.fill();
    c.beginPath(); c.arc(0, 0, 2, 0, Math.PI * 2); c.fillStyle = hot ? '#7a5a00' : '#123f7a'; c.fill();
    c.restore();
  }
  /** The module whose gear is under the pointer. */
  function gearAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const n = shapes[i];
      if (!hasSettings(n)) continue;
      const q = local(n, p), g = gearPos(n);
      if (Math.hypot(q.x - g.x, q.y - g.y) < Math.max(8, 7 / view.z)) return n;
    }
    return null;
  }
  function openSettings(n) {
    if (INSPECT.has(n.kind)) openProps(n);
    else if (!readOnly) startEdit(n, false);
  }

  function drawNode(c, n) {
    const d = def(n.kind);
    if (!d) return;
    const out = values.get(n.id) || [];
    const ins = inputsOf.get(n.id) || [];
    const mem = memOf(n.id);
    const connectedIn = new Set(), connectedOut = new Set();
    for (const s of shapes) if (s.type === 'wire') {
      if (s.b.n === n.id) connectedIn.add(s.b.p);
      if (s.a.n === n.id) connectedOut.add(s.a.p);
    }
    const color = n.color && n.color !== '#ffffff' ? n.color : '#ffffff';
    c.save();
    c.lineWidth = 2; c.setLineDash([]);
    if (d.cat === 'gate') {
      const on = !!out[0];
      c.save();
      c.shadowColor = on ? 'rgba(255,49,49,.55)' : 'rgba(0,0,0,.45)'; c.shadowBlur = on ? 14 : 10; c.shadowOffsetY = on ? 0 : 3;
      gatePath(c, n.kind, n.x, n.y, d.w, d.h);
      const gg = c.createLinearGradient(0, n.y, 0, n.y + d.h);
      if (on) { gg.addColorStop(0, '#7a1d24'); gg.addColorStop(1, '#3d0d12'); } else { gg.addColorStop(0, '#13703f'); gg.addColorStop(1, '#083a21'); }
      c.fillStyle = gg; c.fill();
      c.restore();
      gatePath(c, n.kind, n.x, n.y, d.w, d.h);
      c.strokeStyle = on ? '#ff8a8a' : color === '#ffffff' ? '#d4af37' : color; c.lineWidth = 2; c.stroke();
      c.save(); gatePath(c, n.kind, n.x, n.y, d.w, d.h); c.clip(); c.fillStyle = 'rgba(255,255,255,.10)'; c.fillRect(n.x, n.y, d.w, d.h * 0.38); c.restore();
      if (/^XN?OR/.test(n.kind)) { c.beginPath(); c.moveTo(n.x + 2, n.y); c.quadraticCurveTo(n.x + 16, n.y + d.h / 2, n.x + 2, n.y + d.h); c.stroke(); }
      const bodyW = d.w - 14;
      const bubble = ['NAND', 'NOR', 'XNOR', 'NOT'].includes(n.kind);
      if (bubble) { c.beginPath(); c.arc(n.x + bodyW + 4, n.y + d.h / 2, 4, 0, Math.PI * 2); c.fillStyle = '#123f7a'; c.fill(); c.stroke(); }
      c.beginPath(); c.moveTo(n.x + bodyW + (bubble ? 8 : 0), n.y + d.h / 2); c.lineTo(n.x + d.w, n.y + d.h / 2); c.stroke();
      c.fillStyle = on ? '#ffe0e0' : '#ffffff'; c.font = '700 11px "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(d.title, n.x + bodyW / 2 + 2, n.y + d.h / 2);
    } else if (d.bare) {
      drawFluid(c, n, d, ins, out, mem);
    } else {
      body(c, n, d, color);
      const cx = n.x + d.w / 2, cy = n.y + 24 + (d.h - 24) / 2;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      if (d.cat === 'func') pinLabels(c, n, d, out);
      else if (d.cat === 'mem') {
        pinLabels(c, n, d, out);
        if (n.kind === 'COUNTER') {
          c.fillStyle = '#ffd166'; c.font = '700 18px ' + FONT; c.textAlign = 'center';
          c.fillText(String(mem.count ?? 0), cx - 4, cy - 2);
          c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '10px ' + FONT; c.fillText('max ' + (Math.round(Number(n.value)) || 9), cx - 4, cy + 14);
        } else {
          const q = !!mem.q;
          roundRect(c, cx - 4 - 17, cy - 11, 34, 22, 4);
          c.fillStyle = q ? 'rgba(255,49,49,.25)' : 'rgba(255,255,255,.08)'; c.fill();
          c.strokeStyle = q ? ON : 'rgba(255,255,255,.4)'; c.lineWidth = 1.2; c.stroke(); c.lineWidth = 2;
          c.fillStyle = q ? ON : 'rgba(255,255,255,.7)'; c.font = '700 13px ' + FONT; c.textAlign = 'center';
          c.fillText(q ? '1' : '0', cx - 4, cy + 1);
        }
      } else if (d.cat === 'time') {
        c.fillStyle = out[0] ? ON : 'rgba(255,255,255,.8)'; c.font = '600 12px ' + FONT;
        c.fillText(secs(n.value), cx, cy);
      } else if (n.kind === 'BUTTON') {
        // Industrial push button, seen from above.
        const on = n.nc ? !truthy(out[0]) : truthy(out[0]); // cap pressed in
        tag(c, n.nc ? 'NC' : 'NO', n.x + 5, n.y + 36, 'left', n.nc ? '#ffb3b3' : 'rgba(255,255,255,.8)', 9);
        if (n.latch) tag(c, 'latch', n.x + 4, n.y + 50, 'left', 'rgba(255,255,255,.65)', 8);
        const cap = n.color && n.color !== '#ffffff' ? n.color : '#e03131';
        roundRect(c, cx - 21, cy - 21, 42, 42, 7);
        const hg = c.createLinearGradient(cx - 21, cy - 21, cx + 21, cy + 21);
        hg.addColorStop(0, '#59636f'); hg.addColorStop(1, '#262d36');
        c.fillStyle = hg; c.fill(); c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 1.2; c.stroke();
        for (const [sx, sy] of [[-15, -15], [15, -15], [-15, 15], [15, 15]]) { c.beginPath(); c.arc(cx + sx, cy + sy, 1.8, 0, Math.PI * 2); c.fillStyle = '#9aa5b1'; c.fill(); }
        c.beginPath(); c.arc(cx, cy, 15, 0, Math.PI * 2); c.fillStyle = '#11161c'; c.fill(); // collar
        const r = on ? 11.5 : 13;
        const g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
        g.addColorStop(0, on ? cap : '#ffffff'); g.addColorStop(on ? 0.15 : 0.08, cap); g.addColorStop(1, on ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.25)');
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = cap; c.fill(); c.fillStyle = g; c.fill();
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1; c.stroke();
        // status LED (= contact output)
        c.beginPath(); c.arc(n.x + d.w - 9, n.y + 32, 3, 0, Math.PI * 2);
        if (truthy(out[0])) { c.save(); c.shadowColor = ON; c.shadowBlur = 8; c.fillStyle = ON; c.fill(); c.restore(); } else { c.fillStyle = 'rgba(255,255,255,.2)'; c.fill(); }
        c.lineWidth = 2;
      } else if (n.kind === 'POT') {
        const r = knobRange(n), k = knobOf(n);
        drawKnob(c, k, (r.value - r.min) / (r.max - r.min), false, true);
        tag(c, fmtKnob(r.min), k.x - k.r - 2, k.y + k.r + 9, 'center', 'rgba(255,255,255,.55)', 9);
        tag(c, fmtKnob(r.max), k.x + k.r + 2, k.y + k.r + 9, 'center', 'rgba(255,255,255,.55)', 9);
        tag(c, fmtKnob(r.value), n.x + d.w - 10, k.y - 14, 'right', '#ffd166', 13);
        c.lineWidth = 2;
      } else if (n.kind === 'LEVER') {
        const on = !!n.value;
        roundRect(c, cx - 22, cy + 6, 44, 12, 3);
        c.fillStyle = '#4b5562'; c.fill(); c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; c.stroke();
        const a = ((on ? 35 : -35) * Math.PI) / 180;
        const tx = cx + Math.sin(a) * 22, ty = cy + 10 - Math.cos(a) * 22;
        c.beginPath(); c.moveTo(cx, cy + 10); c.lineTo(tx, ty); c.strokeStyle = '#c8a46e'; c.lineWidth = 4; c.lineCap = 'round'; c.stroke();
        c.beginPath(); c.arc(tx, ty, 5.5, 0, Math.PI * 2); c.fillStyle = on ? ON : '#d0d0d0'; c.fill();
        if (on) { c.save(); c.shadowColor = ON; c.shadowBlur = 10; c.fill(); c.restore(); }
        c.fillStyle = on ? ON : 'rgba(255,255,255,.55)'; c.font = '600 9px ' + FONT; c.fillText(on ? 'ON' : 'OFF', cx, cy + 25 > n.y + d.h - 4 ? n.y + d.h - 6 : cy + 25);
        c.lineWidth = 2;
      } else if (n.kind === 'SWITCH') {
        const on = !!n.value;
        roundRect(c, cx - 18, cy - 8, 36, 16, 8); c.fillStyle = on ? '#3cb44b' : 'rgba(255,255,255,.2)'; c.fill();
        c.beginPath(); c.arc(on ? cx + 10 : cx - 10, cy, 6, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
      } else if (n.kind === 'NUMBER') {
        c.fillStyle = '#ffd166'; c.font = '600 13px ' + FONT; c.fillText(fmt(Number(n.value) || 0), cx, cy);
      } else if (n.kind === 'CLOCK') {
        // square-wave icon, lit while high
        const on = !!out[0];
        c.strokeStyle = on ? ON : 'rgba(255,255,255,.6)'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(cx - 34, cy + 5); c.lineTo(cx - 26, cy + 5); c.lineTo(cx - 26, cy - 5); c.lineTo(cx - 18, cy - 5); c.lineTo(cx - 18, cy + 5); c.lineTo(cx - 10, cy + 5); c.stroke();
        c.fillStyle = on ? ON : 'rgba(255,255,255,.75)'; c.font = '600 11px ' + FONT; c.textAlign = 'left';
        c.fillText(secs(n.value), cx - 4, cy);
        c.lineWidth = 2;
      } else if (n.kind === 'LAMP') {
        const on = truthy(ins[0]);
        const lc = n.color && n.color !== '#ffffff' ? n.color : '#ffd166';
        c.beginPath(); c.arc(cx, cy, 14, 0, Math.PI * 2);
        if (on) { c.save(); c.shadowColor = lc; c.shadowBlur = 22; c.fillStyle = lc; c.fill(); c.restore(); } else { c.fillStyle = 'rgba(255,255,255,.12)'; c.fill(); }
        c.strokeStyle = '#fff'; c.stroke();
      } else if (n.kind === 'SEG7') {
        roundRect(c, n.x + 16, n.y + 30, d.w - 24, d.h - 36, 4); c.fillStyle = '#0b0f14'; c.fill();
        const v = Math.trunc(CC.num(ins[0]));
        seg7(c, n.x + 26, n.y + 38, d.w - 44, d.h - 52, ((v % 16) + 16) % 16, connectedIn.has(0));
      } else if (n.kind === 'BUZZER') {
        const on = truthy(ins[0]);
        const col = on ? '#ffd166' : 'rgba(255,255,255,.6)';
        c.fillStyle = col; c.beginPath(); c.rect(cx - 26, cy - 6, 8, 12); c.fill();
        c.beginPath(); c.moveTo(cx - 18, cy - 6); c.lineTo(cx - 8, cy - 13); c.lineTo(cx - 8, cy + 13); c.lineTo(cx - 18, cy + 6); c.closePath(); c.fill();
        if (on) {
          const ph = (performance.now() / 120) % 3;
          c.strokeStyle = '#ffd166'; c.lineWidth = 1.6;
          for (let k = 0; k < 3; k++) { c.globalAlpha = 1 - ((k + ph) % 3) / 3; c.beginPath(); c.arc(cx - 6, cy, 6 + k * 5, -0.7, 0.7); c.stroke(); }
          c.globalAlpha = 1;
        }
        c.fillStyle = col; c.font = '600 10px ' + FONT; c.textAlign = 'left';
        c.fillText((Math.round(Number(n.value)) || 440) + ' Hz', cx + 12, cy - 5);
        c.font = '9px ' + FONT; c.fillText((n.wave || 'square').replace('sawtooth', 'saw'), cx + 12, cy + 8);
        c.lineWidth = 2;
      } else if (n.kind === 'DRUMKIT') {
        // Drum kit: one input per drum; each pad flashes when it plays.
        const now = performance.now();
        DRUMS.forEach((name, i) => {
          const p = pinPos(n, 'in', i, true);
          const flash = Math.max(0, 1 - (now - (noteFlash.get(n.id + ':' + i) || 0)) / 250);
          roundRect(c, p.x + 10, p.y - 8, d.w - 20, 16, 3);
          c.fillStyle = flash ? `rgba(255,49,49,${0.25 + flash * 0.6})` : 'rgba(255,255,255,.07)'; c.fill();
          c.fillStyle = '#fff'; c.font = '600 10px ' + FONT; c.textAlign = 'left'; c.fillText(name, p.x + 16, p.y + 1);
        });
      } else if (n.kind === 'NOTE') {
        const flash = Math.max(0, 1 - (performance.now() - (noteFlash.get(n.id) || 0)) / 400);
        roundRect(c, cx - 30, cy - 15, 60, 30, 4);
        c.fillStyle = `rgba(160,110,60,${0.55 + flash * 0.45})`; c.fill(); c.strokeStyle = flash ? '#ffd166' : 'rgba(255,255,255,.5)'; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = flash ? '#fff7d6' : '#ffffff'; c.font = '700 15px "Segoe UI", sans-serif'; c.textAlign = 'center';
        c.fillText('♪ ' + CC.noteName(n.value), cx, cy - 4);
        c.font = '600 9px ' + FONT; c.fillStyle = 'rgba(255,255,255,.85)';
        c.fillText((INSTRUMENTS.find(([k]) => k === (n.inst || 'piano')) || INSTRUMENTS[0])[1].replace(' (cowbell)', ''), cx, cy + 10);
        c.lineWidth = 2;
      }
    }
    if (hasSettings(n) && n.id !== '_ghost') { const g = gearPos(n); drawGear(c, g.x, g.y, hoverGear === n.id || propsFor === n.id); }
    d.ins.forEach((pin, i) => drawPin(c, pinPos(n, 'in', i, true), connectedIn.has(i), ins[i], pin.hyd ? HYD_ON : pin.at && !pin.pilot ? '#ffd166' : '#ffffff', pin.hyd));
    d.outs.forEach((pin, i) => drawPin(c, pinPos(n, 'out', i, true), connectedOut.has(i) || out[i] !== undefined, out[i], pin.hyd ? HYD_ON : pin.bool ? '#ffffff' : '#7fdbff', pin.hyd));
    c.restore();
  }

  let frameMs = 0;
  function draw() {
    const _t0 = performance.now();
    evaluate();
    updatePoses();
    const w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    grid(ctx, w, h, view.x * dpr, view.y * dpr, view.z);
    ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
    const preview = drag && drag.preview ? new Map(drag.preview.map((s) => [s.id, s])) : null;
    const list = preview ? shapes.map((s) => preview.get(s.id) || s) : shapes;
    if (preview) for (const s of drag.preview) if (!byId.has(s.id)) list.push(s);
    // Draw order: shapes, then wires, then nodes on top.
    const nodesOnTop = (s) => (s.type === 'node' ? 2 : s.type === 'wire' ? 1 : 0);
    const ordered = list.slice().sort((a, b) => nodesOnTop(a) - nodesOnTop(b));
    if (preview) for (const s of ordered) if (s.type === 'node') byId.set(s.id, s); // wires follow nodes being dragged
    for (const s of ordered) drawShape(ctx, s);
    if (preview) for (const s of shapes) if (s.type === 'node') byId.set(s.id, s);
    if (drag && drag.kind === 'wire') drawWire(ctx, null, drag.from, { ...drag.to, dx: -(drag.from.dx ?? 1), dy: -(drag.from.dy ?? 0) });
    if (placing) {
      const d = def(placing);
      ctx.globalAlpha = .5; drawNode(ctx, { id: '_ghost', type: 'node', kind: placing, x: snapV(mouseWorld.x - d.w / 2), y: snapV(mouseWorld.y - d.h / 2) }); ctx.globalAlpha = 1;
    }
    // Selection outline + resize handles.
    if (selection.size) {
      ctx.strokeStyle = '#7fdbff'; ctx.lineWidth = 1 / view.z; ctx.setLineDash([5 / view.z, 4 / view.z]);
      for (const id of selection) {
        const s = (preview && preview.get(id)) || byId.get(id);
        if (!s) continue;
        const b = bbox(s);
        inFrame(ctx, s, () => ctx.strokeRect(b.x1 - 5, b.y1 - 5, b.x2 - b.x1 + 10, b.y2 - b.y1 + 10));
      }
      ctx.setLineDash([]);
      const single = selection.size === 1 ? (preview && preview.get([...selection][0])) || byId.get([...selection][0]) : null;
      if (single && single.type !== 'wire' && !readOnly) {
        inFrame(ctx, single, () => {
          if (resizable(single)) for (const hd of handles(single)) { ctx.fillStyle = '#fff'; ctx.fillRect(hd.x - 4 / view.z, hd.y - 4 / view.z, 8 / view.z, 8 / view.z); }
          const r = rotateHandle(single);
          ctx.strokeStyle = '#7fdbff'; ctx.lineWidth = 1 / view.z;
          ctx.beginPath(); ctx.moveTo(r.x, bbox(single).y1 - 5); ctx.lineTo(r.x, r.y); ctx.stroke();
          ctx.beginPath(); ctx.arc(r.x, r.y, 6 / view.z, 0, Math.PI * 2); ctx.fillStyle = '#7fdbff'; ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.stroke();
        });
        if (drag && drag.kind === 'rotate') {
          const o = center(single);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const sp = toScreen(o.x, o.y);
          ctx.save();
          ctx.font = '600 12px ' + FONT; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
          ctx.fillText(normDeg(single.rot || 0) + '°', sp.x, sp.y - 4);
          ctx.restore();
          ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
        }
      }
    }
    if (drag && drag.kind === 'box') {
      ctx.strokeStyle = '#7fdbff'; ctx.lineWidth = 1 / view.z; ctx.setLineDash([4 / view.z, 3 / view.z]);
      ctx.fillStyle = 'rgba(127,219,255,.08)';
      const x = Math.min(drag.start.x, drag.cur.x), y = Math.min(drag.start.y, drag.cur.y);
      ctx.fillRect(x, y, Math.abs(drag.cur.x - drag.start.x), Math.abs(drag.cur.y - drag.start.y));
      ctx.strokeRect(x, y, Math.abs(drag.cur.x - drag.start.x), Math.abs(drag.cur.y - drag.start.y));
      ctx.setLineDash([]);
    }
    if (hoverPin) {
      const bad = drag && drag.kind === 'wire' && hoverPin.side !== drag.pin.side && pinKind(hoverPin) !== pinKind(drag.pin);
      ctx.beginPath(); ctx.arc(hoverPin.x, hoverPin.y, 8, 0, Math.PI * 2); ctx.strokeStyle = bad ? '#ff4d4d' : '#ffd166'; ctx.lineWidth = 2 / view.z; ctx.stroke();
    }
    // Port tip: what the port is, its type and live value.
    if (hoverPin && (!drag || drag.kind === 'wire')) {
      const pd = pinDef(hoverPin);
      if (pd) {
        const vals = hoverPin.side === 'out' ? values.get(hoverPin.n) : inputsOf.get(hoverPin.n);
        const v = vals ? vals[hoverPin.p] : undefined;
        const kind = pd.hyd ? 'hydraulic · bar' : pd.bool ? 'signal on/off' : 'number';
        const live = v === undefined ? '' : pd.hyd ? Math.round(CC.num(v)) + ' bar' : typeof v === 'boolean' ? (v ? 'on' : 'off') : fmt(v);
        const head = (pd.n || (hoverPin.side === 'out' ? 'Out' : 'In')) + (pd.t ? ' — ' + pd.t : '');
        const sub = (hoverPin.side === 'out' ? 'output' : 'input') + ' · ' + kind + (live !== '' ? ' · now ' + live : '');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const sp = toScreen(hoverPin.x, hoverPin.y);
        ctx.font = '600 12px ' + FONT; const w1 = ctx.measureText(head).width;
        ctx.font = '11px ' + FONT; const w2 = ctx.measureText(sub).width;
        const bw = Math.max(w1, w2) + 16, bx = Math.min(cv.width / dpr - bw - 6, sp.x + 12), by = sp.y + 12;
        ctx.fillStyle = 'rgba(8,20,40,.94)'; ctx.strokeStyle = pd.hyd ? HYD_ON : '#ffd166'; ctx.lineWidth = 1;
        roundRect(ctx, bx, by, bw, 38, 5); ctx.fill(); ctx.stroke();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff'; ctx.font = '600 12px ' + FONT; ctx.fillText(head, bx + 8, by + 12);
        ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '11px ' + FONT; ctx.fillText(sub, bx + 8, by + 27);
        ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
      }
    }
    if (notice && Date.now() < notice.until) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sp = toScreen(notice.x, notice.y);
      ctx.font = '600 12px ' + FONT; const tw = ctx.measureText(notice.text).width + 18;
      ctx.fillStyle = 'rgba(120,10,10,.94)'; roundRect(ctx, sp.x - tw / 2, sp.y - 34, tw, 24, 5); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(notice.text, sp.x, sp.y - 22);
      ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
    }
    // Other people's pointers.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = Date.now();
    for (const [id, p] of pointers) {
      if (now - p.at > 5000) { pointers.delete(id); continue; }
      const s = toScreen(p.x, p.y);
      ctx.globalAlpha = Math.min(1, (5000 - (now - p.at)) / 1000);
      ctx.fillStyle = p.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 4, s.y + 15); ctx.lineTo(s.x + 8, s.y + 9); ctx.lineTo(s.x + 15, s.y + 8); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.font = '600 11px "Segoe UI", sans-serif';
      const tw = ctx.measureText(p.name).width + 10;
      ctx.fillStyle = p.color; ctx.fillRect(s.x + 12, s.y + 14, tw, 17);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(p.name, s.x + 17, s.y + 23);
      ctx.globalAlpha = 1;
    }
    document.getElementById('scale').textContent = Math.round(view.z * 100) + '%';
    frameMs = frameMs * 0.9 + (performance.now() - _t0) * 0.1;
    updateLive();
    if (animating()) redraw();
  }
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  setInterval(() => { if (pointers.size) redraw(); }, 250);

  function sortShapes() {
    routeVersion++;
    boardMeta = byId.get('__board') || null;
    document.documentElement.style.setProperty('--paper', bgTheme().paper);
    syncBg();
    shapes = [...byId.values()].filter((s) => s.type !== 'meta').sort((a, b) => ((a.z ?? a.t) - (b.z ?? b.t)) || (a.id < b.id ? -1 : 1));
    const authors = [...new Set(shapes.map((s) => s.by).filter(Boolean))];
    document.getElementById('authors').textContent = authors.length ? authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' +' + (authors.length - 4) : '') : '—';
    for (const id of [...selection]) if (!byId.has(id)) selection.delete(id);
    syncSelBar();
  }
  let isHost = true, perfOn = true;
  /** Host only: background choice for everyone (stored in the board's "meta" entry). */
  function syncBg() {
    const physOn = !(boardMeta && boardMeta.physics === false);
    const pb = document.getElementById('physbtn');
    if (pb) { pb.style.display = isHost && !readOnly ? '' : 'none'; pb.classList.toggle('on', physOn); document.getElementById('physlabel').textContent = 'Physics: ' + (physOn ? 'on' : 'off'); }
    const po = document.getElementById('physoff'); if (po) po.style.display = physOn ? 'none' : 'block';
    const pick = document.getElementById('bgpick');
    if (!pick) return;
    pick.style.display = isHost && !readOnly ? 'flex' : 'none';
    const cust = document.getElementById('bgcustom');
    if (cust && boardMeta && boardMeta.bgColor) cust.value = boardMeta.bgColor;
    cust?.classList.toggle('on', (boardMeta && boardMeta.bg) === 'custom');
    const cur = (boardMeta && boardMeta.bg) || 'blue';
    for (const b of pick.querySelectorAll('[data-bg]')) b.classList.toggle('on', b.dataset.bg === cur);
  }
  document.getElementById('physbtn')?.addEventListener('click', () => {
    if (!isHost || readOnly) return;
    const on = !(boardMeta && boardMeta.physics === false);
    commit([{ ...(boardMeta || {}), id: '__board', type: 'meta', physics: !on }]);
  });
  document.getElementById('bgcustom')?.addEventListener('input', (e) => {
    if (!isHost || readOnly) return;
    commit([{ ...(boardMeta || {}), id: '__board', type: 'meta', bg: 'custom', bgColor: e.target.value }], [], false);
  });
  document.getElementById('bgcustom')?.addEventListener('change', (e) => {
    if (!isHost || readOnly) return;
    commit([{ ...(boardMeta || {}), id: '__board', type: 'meta', bg: 'custom', bgColor: e.target.value }]);
  });
  document.getElementById('bgpick')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bg]');
    if (!b || !isHost || readOnly) return;
    commit([{ ...(boardMeta || {}), id: '__board', type: 'meta', bg: b.dataset.bg }]);
  });
  // ------------------------------------------------------------------ inventory + help (built from catalog.js)
  const CAT = window.CollabCatalog;
  const previewCache = new Map();
  /** A small picture of a module, drawn with the real renderer. */
  function preview(kind, w, h) {
    const key = kind + ':' + w + 'x' + h;
    if (previewCache.has(key)) return previewCache.get(key);
    const d = def(kind);
    let url = '';
    if (d) {
      const cv2 = document.createElement('canvas');
      const pr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      cv2.width = w * pr; cv2.height = h * pr;
      const c = cv2.getContext('2d');
      const bw = d.w + 24, bh = d.h + 24, sc = Math.min(w / bw, h / bh) * pr;
      c.setTransform(sc, 0, 0, sc, (w * pr - d.w * sc) / 2, (h * pr - d.h * sc) / 2);
      try { drawShape(c, { id: '_preview_' + kind, type: 'node', kind, x: 0, y: 0, value: d.value, text: kind === 'DISPLAY' ? 'HELLO' : undefined }); } catch { /* preview only */ }
      url = cv2.toDataURL();
    }
    previewCache.set(key, url);
    return url;
  }
  const helpOf = (k) => (CAT.HELP[k] || [(def(k) || {}).title || k, (def(k) || {}).help || ''] );
  function buildInventory(filter) {
    const box = nodesMenu;
    box.replaceChildren();
    const head = document.createElement('div'); head.className = 'inv-head';
    const title = document.createElement('div'); title.className = 'inv-title'; title.textContent = 'Inventory';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search parts…'; search.value = filter || ''; search.className = 'inv-search';
    const close = document.createElement('button'); close.className = 'inv-close'; close.textContent = '✕'; close.title = 'Close (Esc)';
    close.onclick = () => { nodesMenu.classList.remove('open'); syncBar(); };
    head.append(title, search, close); box.append(head);
    const body = document.createElement('div'); body.className = 'inv-body'; box.append(body);
    const q = (filter || '').trim().toLowerCase();
    let any = false;
    for (const cat of CAT.CATEGORIES) {
      const items = cat.items.filter((k) => def(k) && (!q || (helpOf(k)[0] + ' ' + helpOf(k)[1] + ' ' + k).toLowerCase().includes(q)));
      if (!items.length) continue;
      any = true;
      const sec = document.createElement('section'); sec.className = 'inv-sec'; sec.style.setProperty('--accent', cat.color);
      const h4 = document.createElement('h4'); h4.innerHTML = '<span class="inv-ico"></span>'; h4.firstChild.textContent = cat.icon; h4.append(cat.title);
      const grid2 = document.createElement('div'); grid2.className = 'inv-grid';
      for (const k of items) {
        const bt = document.createElement('button'); bt.dataset.node = k; bt.className = 'inv-card'; bt.title = helpOf(k)[1];
        const img = document.createElement('img'); img.src = preview(k, 120, 64); img.alt = '';
        const nm = document.createElement('span'); nm.textContent = helpOf(k)[0];
        bt.append(img, nm); grid2.append(bt);
      }
      sec.append(h4, grid2); body.append(sec);
    }
    if (!any) { const e = document.createElement('div'); e.className = 'inv-empty'; e.textContent = 'Nothing found.'; body.append(e); }
    search.oninput = () => { const pos = search.selectionStart; buildInventory(search.value); const s2 = nodesMenu.querySelector('.inv-search'); s2.focus(); s2.setSelectionRange(pos, pos); };
    search.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { nodesMenu.classList.remove('open'); syncBar(); } };
  }
  const helpBox = document.getElementById('helpbox');
  function openHelp(kind) {
    helpBox.replaceChildren();
    const card = document.createElement('div'); card.className = 'help-card';
    const head = document.createElement('div'); head.className = 'inv-head';
    const title = document.createElement('div'); title.className = 'inv-title'; title.textContent = 'Help — every part explained';
    const close = document.createElement('button'); close.className = 'inv-close'; close.textContent = '✕'; close.onclick = () => helpBox.classList.remove('open');
    head.append(title, close);
    const nav = document.createElement('nav'); nav.className = 'help-nav';
    const main = document.createElement('div'); main.className = 'help-main';
    const intro = document.createElement('div'); intro.className = 'help-intro';
    intro.innerHTML = '<b>Basics</b><br>Open the <b>Inventory</b> (G) and click a part to place it. Drag from a pin to another pin to wire it: <span style="color:#ff6b6b">red</span> = on, black = off, gray = not powered, <span style="color:#f5a524">orange</span> = hydraulic oil. Point at a pin to see what it does. Click the ⚙ gear on a part for its settings. Scroll to zoom, right-drag to pan, S toggles snap to the grid.';
    main.append(intro);
    for (const cat of CAT.CATEGORIES) {
      const items = cat.items.filter((k) => def(k));
      if (!items.length) continue;
      const link = document.createElement('a'); link.textContent = cat.icon + '  ' + cat.title; link.style.setProperty('--accent', cat.color);
      const sec = document.createElement('section'); sec.className = 'help-sec'; sec.style.setProperty('--accent', cat.color);
      const h3 = document.createElement('h3'); h3.textContent = cat.icon + '  ' + cat.title; sec.append(h3);
      link.onclick = () => sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      nav.append(link);
      for (const k of items) {
        const d = def(k), [name, text] = helpOf(k);
        const it = document.createElement('div'); it.className = 'help-item'; it.id = 'help-' + k;
        const img = document.createElement('img'); img.src = preview(k, 150, 84); img.alt = '';
        const tx = document.createElement('div');
        const h5 = document.createElement('h5'); h5.textContent = name;
        const p = document.createElement('p'); p.textContent = text;
        tx.append(h5, p);
        const pins = [...d.ins.map((q) => ['in', q]), ...d.outs.map((q) => ['out', q])].filter(([, q]) => q.n || q.t);
        if (pins.length) {
          const ul = document.createElement('ul');
          for (const [side, q] of pins) {
            const li = document.createElement('li');
            li.textContent = (side === 'in' ? '→ ' : '← ') + (q.n || (side === 'in' ? 'In' : 'Out')) + (q.t ? ': ' + q.t : '') + (q.hyd ? ' (hydraulic)' : '');
            ul.append(li);
          }
          tx.append(ul);
        }
        it.append(img, tx); sec.append(it);
      }
      main.append(sec);
    }
    card.append(head, nav, main); helpBox.append(card);
    helpBox.classList.add('open');
    if (kind) setTimeout(() => document.getElementById('help-' + kind)?.scrollIntoView({ block: 'center' }), 0);
  }
  helpBox.addEventListener('click', (e) => { if (e.target === helpBox) helpBox.classList.remove('open'); });
  helpBox.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') helpBox.classList.remove('open'); });
  document.getElementById('help')?.addEventListener('click', () => openHelp());

  // ------------------------------------------------------------------ performance overlay (top left)
  let lastPerf = null;
  function showPerf() {
    const el = document.getElementById('perf');
    if (!el) return;
    el.style.display = perfOn ? 'block' : 'none';
    if (!perfOn) return;
    const p = lastPerf;
    const bar = (v) => { const n = Math.max(0, Math.min(10, Math.round((v || 0) / 10))); return '▮'.repeat(n) + '▯'.repeat(10 - n); };
    const rows = [];
    if (p) {
      rows.push(['EXT', 'CPU ' + p.ext.cpu.toFixed(1) + '%', 'RAM ' + p.ext.rssMb + ' MB']);
      rows.push(['PC', 'CPU ' + Math.round(p.sys.cpu) + '% ' + bar(p.sys.cpu), 'RAM ' + p.sys.usedGb.toFixed(1) + '/' + Math.round(p.sys.totalGb) + ' GB']);
      rows.push(['GPU', p.gpu === undefined ? 'n/a' : Math.round(p.gpu) + '% ' + bar(p.gpu), 'draw ' + frameMs.toFixed(1) + ' ms']);
    } else rows.push(['', 'draw ' + frameMs.toFixed(1) + ' ms', '']);
    el.replaceChildren(...rows.map((r) => { const d = document.createElement('div'); for (const t of r) { const s = document.createElement('span'); s.textContent = t; d.append(s); } return d; }));
  }
  setInterval(() => { if (perfOn && !lastPerf) showPerf(); }, 1500);

  function setShapes(list) {
    byId.clear();
    for (const s of list) byId.set(s.id, s);
    sortShapes();
    redraw();
  }

  // ------------------------------------------------------------------ toolbar
  const bar = document.getElementById('bar');
  const nodesMenu = document.getElementById('nodes');
  function syncPopButtons() {
    const sb = document.getElementById('shapebtn');
    if (sb) {
      const cur = document.querySelector('#pop-shapes [data-tool="' + tool + '"]');
      const icon = (cur || document.querySelector('#pop-shapes [data-tool="rect"]')).querySelector('svg');
      if (icon) sb.replaceChildren(icon.cloneNode(true), Object.assign(document.createElement('span'), { className: 'caret', textContent: '▾' }));
      sb.classList.toggle('on', !!cur);
    }
    const dot = document.querySelector('#colorbtn .cdot');
    if (dot) dot.style.background = style.color;
  }
  function syncBar() {
    syncPopButtons();
    bar.querySelectorAll('[data-tool]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === tool || (b.dataset.tool === 'nodes' && (placing || nodesMenu.classList.contains('open'))));
      b.disabled = readOnly && !['hand', 'select'].includes(b.dataset.tool);
    });
    bar.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === style.color));
    bar.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('on', Number(b.dataset.width) === style.w));
    document.getElementById('dash').classList.toggle('on', style.dash);
    document.getElementById('fill').classList.toggle('on', style.fill);
    document.getElementById('snap').classList.toggle('on', snap);
    const ws = document.getElementById('wirestyle'); if (ws) { ws.classList.toggle('on', wireStyle === 'square'); ws.title = wireStyle === 'square' ? 'Square wires & arrows (click for curved)' : 'Curved wires & arrows (click for square)'; }
    for (const id of ['undo', 'redo', 'clear', 'dash', 'fill']) document.getElementById(id).disabled = readOnly;
    document.getElementById('ro').style.display = readOnly ? 'block' : 'none';
    cv.style.cursor = placing ? 'copy' : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : tool === 'bucket' ? BUCKET_CURSOR : tool === 'select' ? 'default' : 'crosshair';
    syncSelBar();
  }
  function syncSelBar() {
    const sb = document.getElementById('selbar');
    sb.style.display = selection.size && !readOnly ? 'flex' : 'none';
    document.getElementById('selcount').textContent = selection.size + ' selected';
  }
  const BUCKET_CURSOR = 'url("data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="black" stroke-width="3.2" stroke-linejoin="round"><path d="M10 3l8 8-7 7-8-8z"/><path d="M19 13c1.5 2.2 2.2 3.4 2.2 4.4a2.2 2.2 0 01-4.4 0c0-1 .7-2.2 2.2-4.4z"/></g><g fill="none" stroke="white" stroke-width="1.6" stroke-linejoin="round"><path d="M10 3l8 8-7 7-8-8z"/><path d="M19 13c1.5 2.2 2.2 3.4 2.2 4.4a2.2 2.2 0 01-4.4 0c0-1 .7-2.2 2.2-4.4z"/></g><path d="M3 10h15" stroke="white" stroke-width="1.4"/></svg>') + '") 19 21, crosshair';
  function setTool(t) {
    tool = t; placing = null; nodesMenu.classList.remove('open');
    if (t !== 'select') selection.clear();
    syncBar(); redraw();
  }
  /** Changing a style also restyles the selected shapes. */
  function restyle(patch) {
    Object.assign(style, patch);
    if (selection.size && !readOnly) {
      commit([...selection].map((id) => byId.get(id)).filter((s) => s && s.type !== 'wire').map((s) => {
        const c = clone(s);
        if ('color' in patch) c.color = patch.color;
        if ('w' in patch && s.type !== 'node') c.w = patch.w;
        if ('dash' in patch && s.type !== 'node') c.dash = patch.dash || undefined;
        if ('fill' in patch && ['rect', 'ellipse', 'diamond'].includes(s.type)) c.fill = patch.fill || undefined;
        return c;
      }));
    }
    syncBar();
  }
  function closePops(except) { for (const p of document.querySelectorAll('.pop.open')) if (p !== except) p.classList.remove('open'); }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.popwrap')) closePops(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.pop) { const p = document.getElementById('pop-' + b.dataset.pop); const open = !p.classList.contains('open'); closePops(); p.classList.toggle('open', open); return; }
    if (b.closest('.pop') && !b.closest('#bgpick') && b.id !== 'physbtn') setTimeout(() => closePops(), 0);
    if (b.dataset.tool === 'nodes') { nodesMenu.classList.toggle('open'); if (nodesMenu.classList.contains('open')) { buildInventory(''); setTimeout(() => nodesMenu.querySelector('.inv-search')?.focus(), 0); } syncBar(); return; }
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.color) restyle({ color: b.dataset.color });
    if (b.dataset.width) restyle({ w: Number(b.dataset.width) });
    if (b.id === 'dash') restyle({ dash: !style.dash });
    if (b.id === 'fill') restyle({ fill: !style.fill });
    if (b.id === 'snap') { snap = !snap; syncBar(); }
    if (b.id === 'wirestyle') {
      wireStyle = wireStyle === 'square' ? 'curve' : 'square';
      try { localStorage.setItem('collab.wireStyle', wireStyle); } catch { /* ignore */ }
      // Selected lines/arrows switch style too.
      const ls = selected().filter((x) => x.type === 'line' || x.type === 'arrow');
      if (ls.length && !readOnly) commit(ls.map((x) => ({ ...clone(x), elbow: wireStyle === 'square' || undefined })));
      syncBar(); redraw();
    }
    if (b.id === 'open') vscode.postMessage({ type: 'open' });
    if (b.id === 'sound') {
      // First click turns sound on (browsers need a click before playing audio); later clicks mute/unmute.
      if (!audio || audio.state !== 'running') { unlockAudio(); muted = false; } else muted = !muted;
      updateSound(); syncSound();
    }
    if (b.id === 'undo') undo();
    if (b.id === 'redo') redo();
    if (b.id === 'fit') fit();
    if (b.id === 'export') exportPng();
    if (b.id === 'clear') {
      if (b.dataset.armed) {
        commit([], shapes.map((s) => s.id));
        delete b.dataset.armed; b.lastChild.textContent = 'Clear';
      } else {
        b.dataset.armed = '1'; b.lastChild.textContent = 'Click again to clear';
        setTimeout(() => { delete b.dataset.armed; b.lastChild.textContent = 'Clear'; }, 3000);
      }
    }
  });
  document.getElementById('custom').addEventListener('input', (e) => restyle({ color: e.target.value }));
  nodesMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-node]');
    if (!b || readOnly) return;
    placing = b.dataset.node; tool = 'select'; selection.clear();
    nodesMenu.classList.remove('open');
    syncBar(); redraw();
  });
  document.getElementById('selbar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'dup') duplicate();
    if (b.id === 'front') reorder(true);
    if (b.id === 'back') reorder(false);
    if (b.id === 'del') deleteSelection();
    if (b.id === 'rotl') rotateBy(-90);
    if (b.id === 'rotr') rotateBy(90);
  });

  // ------------------------------------------------------------------ selection actions
  function selected() { return [...selection].map((id) => byId.get(id)).filter(Boolean); }
  function deleteSelection() { if (selection.size) { commit([], withWires([...selection])); selection.clear(); syncSelBar(); } }
  function copySel() { clipboard = clone(selected().filter((s) => s.type !== 'wire')); }
  function paste(offset = 24) {
    if (!clipboard.length || readOnly) return;
    const ids = new Map();
    let z = maxZ();
    const copies = clipboard.map((s) => { const c = moved(s, offset, offset); ids.set(s.id, c.id = uid()); c.by = me.name; c.t = Date.now(); c.z = ++z; return c; });
    // Copy wires between copied nodes too.
    const wires = shapes.filter((w) => w.type === 'wire' && ids.has(w.a.n) && ids.has(w.b.n))
      .map((w) => ({ ...clone(w), id: uid(), a: { n: ids.get(w.a.n), p: w.a.p }, b: { n: ids.get(w.b.n), p: w.b.p } }));
    commit([...copies, ...wires]);
    selection = new Set(copies.map((c) => c.id));
    clipboard = clone(copies);
    syncSelBar(); redraw();
  }
  function duplicate() { copySel(); paste(); }
  function reorder(front) {
    let z = front ? maxZ() : minZ();
    commit(selected().map((s) => ({ ...clone(s), z: front ? ++z : --z })));
  }
  function rotateBy(deg) {
    commit(selected().filter((s) => s.type !== 'wire').map((s) => ({ ...clone(s), rot: normDeg((s.rot || 0) + deg) || undefined })));
  }
  function nudge(dx, dy) { commit(selected().filter((s) => s.type !== 'wire').map((s) => moved(s, dx, dy))); }

  // ------------------------------------------------------------------ pointer input
  function topAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].type === 'node' && hit(shapes[i], p)) return shapes[i];
    for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].type !== 'node' && hit(shapes[i], p)) return shapes[i];
    return null;
  }
  /** A slider or joystick handle under the pointer. */
  function ctlAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type !== 'node' || (s.kind !== 'SLIDER' && s.kind !== 'JOYSTICK')) continue;
      const q = local(s, p), sz = CC.sizeOf(s);
      if (s.kind === 'SLIDER' && q.x > s.x + 8 && q.x < s.x + sz.w - 8 && q.y > s.y + 16 && q.y < s.y + sz.h - 4) return s;
      if (s.kind === 'JOYSTICK' && Math.hypot(q.x - (s.x + sz.w / 2), q.y - (s.y + sz.h / 2 + 5)) < 36) return s;
    }
    return null;
  }
  function ctlDrag(d, p) {
    const s = d.s, q = local(s, p), sz = CC.sizeOf(s), cur = clone(byId.get(s.id) || s);
    if (s.kind === 'SLIDER') { const max = Number(s.max ?? 100), x0 = s.x + 16, x1 = s.x + sz.w - 16; cur.value = Math.round(Math.max(0, Math.min(1, (q.x - x0) / (x1 - x0))) * max * 10) / 10; }
    else { let jx = (q.x - (s.x + sz.w / 2)) / 24, jy = (q.y - (s.y + sz.h / 2 + 5)) / 24; const m = Math.hypot(jx, jy); if (m > 1) { jx /= m; jy /= m; } cur.jx = Math.round(jx * 100) / 100; cur.jy = Math.round(jy * 100) / 100; }
    const t = Date.now();
    byId.set(s.id, cur); redraw();
    if (t - d.sent > 66) { d.sent = t; commit([cur], [], false); }
  }
  /** A flow control whose knob is under the pointer. */
  function knobAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type !== 'node' || !['FLOW', 'FLOW_1W', 'POT'].includes(s.kind)) continue;
      const q = local(s, p), k = knobOf(s);
      if (Math.hypot(q.x - k.x, q.y - k.y) < k.r + 6) return s;
    }
    return null;
  }
  /** Knob value from a drag: turn around the knob (or move up/down near its middle). */
  function knobDrag(d, p) {
    const n = d.s, r = knobRange(n), k = knobOf(n), q = local(n, p);
    const dist = Math.hypot(q.x - k.x, q.y - k.y);
    let v = d.v;
    if (dist > 8) {
      const a = Math.atan2(q.y - k.y, q.x - k.x);
      if (d.lastA !== undefined) {
        let da = a - d.lastA;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        v += (da / KNOB_SWEEP) * (r.max - r.min);
      }
      d.lastA = a;
    } else {
      v += ((d.lastY - p.y) / 120) * (r.max - r.min);
      d.lastA = undefined;
    }
    d.lastY = p.y;
    d.v = Math.min(r.max, Math.max(r.min, v));
    const step = n.kind === 'POT' ? (r.max - r.min) / 100 : 1;
    return Number((Math.round(d.v / step) * step).toFixed(4));
  }
  const roundKnob = (n, v) => { const r = knobRange(n); const step = n.kind === 'POT' ? (r.max - r.min) / 100 : 1; return Number((Math.round(Math.min(r.max, Math.max(r.min, v)) / step) * step).toFixed(4)); };
  /** Port info: the module's pin definition. */
  function pinDef(pin) { const n = byId.get(pin.n), d = n && def(n.kind); return d ? (pin.side === 'out' ? d.outs : d.ins)[pin.p] : null; }
  const pinKind = (pin) => (pinDef(pin) || {}).hyd ? 'hyd' : 'sig';
  let notice = null;
  function pinAt(p) {
    // Grab radius: about 9 screen pixels, but at most 12 board units (zoomed out, pins used to
    // cover whole modules). Over a module's body you have to be close to the pin itself.
    const r = Math.min(9 / view.z, 12);
    const inside = shapes.some((n) => n.type === 'node' && insideNode(n, p));
    let best = null, bestD = inside ? Math.min(r, 7) : r;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const n = shapes[i];
      if (n.type !== 'node') continue;
      const d = def(n.kind);
      if (!d) continue;
      for (const side of ['out', 'in']) {
        const list = side === 'out' ? d.outs : d.ins;
        for (let k = 0; k < list.length; k++) {
          const q = pinPos(n, side, k);
          const dist = Math.hypot(q.x - p.x, q.y - p.y);
          if (dist < bestD) { bestD = dist; best = { n: n.id, p: k, side, ...q }; }
        }
      }
    }
    return best;
  }
  /** Strictly inside a module's body (no margin). */
  function insideNode(n, p) {
    const b = bbox(n), q = local(n, p);
    return q.x > b.x1 + 1 && q.x < b.x2 - 1 && q.y > b.y1 + 1 && q.y < b.y2 - 1;
  }
  function handles(s) {
    const b = bbox(s);
    return [{ x: b.x1 - 5, y: b.y1 - 5, ox: 'x2', oy: 'y2' }, { x: b.x2 + 5, y: b.y1 - 5, ox: 'x1', oy: 'y2' },
      { x: b.x1 - 5, y: b.y2 + 5, ox: 'x2', oy: 'y1' }, { x: b.x2 + 5, y: b.y2 + 5, ox: 'x1', oy: 'y1' }];
  }
  function rotateHandle(s) {
    const b = bbox(s);
    return { x: (b.x1 + b.x2) / 2, y: b.y1 - 5 - 24 / view.z };
  }
  function handleAt(p) {
    if (selection.size !== 1) return null;
    const s = byId.get([...selection][0]);
    if (!s || s.type === 'wire') return null;
    const lp = local(s, p);
    const r = rotateHandle(s);
    if (Math.hypot(lp.x - r.x, lp.y - r.y) < 9 / view.z) return { s, rotate: true };
    if (!resizable(s)) return null;
    const h = handles(s).find((q) => Math.abs(q.x - lp.x) < 7 / view.z && Math.abs(q.y - lp.y) < 7 / view.z);
    return h ? { s, h } : null;
  }

  cv.addEventListener('pointerdown', (e) => {
    unlockAudio();
    closeProps();
    cv.focus();
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-released pointer
    }
    const p = toWorld(e);
    finishEdit(true);
    nodesMenu.classList.remove('open');
    if (e.button === 1 || spaceDown || tool === 'hand' || e.button === 2) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; cv.style.cursor = 'grabbing'; return;
    }
    if (e.button !== 0) return;
    if (placing) {
      const d = def(placing);
      const n = { id: uid(), type: 'node', kind: placing, x: snapV(p.x - d.w / 2), y: snapV(p.y - d.h / 2), by: me.name, t: Date.now(), z: maxZ() + 1 };
      if (d.value !== undefined) n.value = d.value;
      if (['SWITCH', 'LEVER', 'BUTTON'].includes(placing)) n.value = false;
      commit([n]);
      if (!e.shiftKey) placing = null;
      selection = new Set([n.id]);
      syncBar(); redraw();
      return;
    }
    if (tool === 'select' && !e.shiftKey) {
      const g = gearAt(p);
      if (g) { selection = new Set([g.id]); syncSelBar(); openSettings(g); redraw(); return; }
    }
    if (tool === 'select' && !readOnly && !e.shiftKey) {
      const ctl = ctlAt(p);
      if (ctl) { drag = { kind: 'ctl', s: ctl, orig: clone(ctl), sent: 0 }; ctlDrag(drag, p); return; }
    }
    if (tool === 'select' && !readOnly && !e.shiftKey) {
      const kn = knobAt(p);
      if (kn) { const r = knobRange(kn); drag = { kind: 'knob', s: kn, orig: clone(kn), v: r.value, lastY: p.y, preview: [kn], sent: 0, sentValue: kn.value }; knobDrag(drag, p); cv.style.cursor = 'grabbing'; return; }
    }
    if (tool === 'select') {
      const pin = !readOnly && pinAt(p);
      if (pin) { drag = { kind: 'wire', pin, from: { x: pin.x, y: pin.y, dx: pin.dx, dy: pin.dy }, to: p }; return; }
      const hd = !readOnly && handleAt(p);
      if (hd && hd.rotate) { drag = { kind: 'rotate', s: hd.s, c: center(hd.s), preview: [hd.s] }; return; }
      if (hd) { drag = { kind: 'resize', s: hd.s, h: hd.h, b0: bbox(hd.s), preview: [hd.s] }; return; }
      const s = topAt(p);
      // Press a button (below its title bar): on while held, off when released. Not part of undo.
      if (s && s.type === 'node' && s.kind === 'BUTTON' && s.latch && !readOnly && !e.shiftKey && local(s, p).y > s.y + 24) {
        commit([{ ...clone(s), value: !s.value }]); // latching: each press switches
        return;
      }
      if (s && s.type === 'node' && s.kind === 'LIMIT' && !readOnly && !e.shiftKey && local(s, p).x < s.x + 32) {
        commit([{ ...clone(s), value: true }], [], false); // hold the roller with the mouse
        drag = { kind: 'press', id: s.id };
        return;
      }
      if (s && s.type === 'node' && s.kind === 'BUTTON' && !readOnly && !e.shiftKey && local(s, p).y > s.y + 24) {
        commit([{ ...clone(s), value: true }], [], false);
        drag = { kind: 'press', id: s.id };
        return;
      }
      if (s) {
        if (e.shiftKey) { selection.has(s.id) ? selection.delete(s.id) : selection.add(s.id); }
        else if (!selection.has(s.id)) selection = new Set([s.id]);
        drag = { kind: 'move', start: p, moved: false, clickOn: s, preview: null };
      } else {
        if (!e.shiftKey) selection.clear();
        drag = { kind: 'box', start: p, cur: p };
      }
      syncSelBar(); redraw();
      return;
    }
    if (readOnly) { drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
    const sp = { x: snapV(p.x), y: snapV(p.y) };
    if (tool === 'pen') drag = { kind: 'draw', shape: { ...base('pen'), pts: [p.x, p.y] } };
    else if (['line', 'arrow', 'rect', 'ellipse', 'diamond', 'dim'].includes(tool)) drag = { kind: 'draw', shape: { ...base(tool), x1: sp.x, y1: sp.y, x2: sp.x, y2: sp.y, ...(wireStyle === 'square' && (tool === 'line' || tool === 'arrow') ? { elbow: true } : {}) } };
    else if (tool === 'eraser') { drag = { kind: 'erase', ids: new Set() }; eraseAt(p); }
    else if (tool === 'bucket') bucketAt(p, e.shiftKey);
    else if (tool === 'text') startEdit({ ...base('text'), x: sp.x, y: sp.y, size: 12 + style.w * 3, text: '' }, true);
    else if (tool === 'note') {
      const note = { ...base('note'), x: sp.x, y: sp.y, w: 170, h: 120, text: '', color: style.color === '#ffffff' ? '#ffd166' : style.color };
      delete note.dash; delete note.fill;
      commit([note]);
      startEdit(note, false);
    }
    if (drag && drag.kind === 'draw') drag.preview = [drag.shape];
    redraw();
  });

  cv.addEventListener('pointermove', (e) => {
    const p = toWorld(e);
    mouseWorld = p;
    const now = Date.now();
    if (now - lastPtr > 40) { lastPtr = now; vscode.postMessage({ type: 'pointer', x: p.x, y: p.y }); }
    if (placing) redraw();
    if (!drag) {
      const pin = tool === 'select' && !readOnly ? pinAt(p) : null;
      if ((pin && !hoverPin) || (!pin && hoverPin) || (pin && hoverPin && (pin.n !== hoverPin.n || pin.p !== hoverPin.p || pin.side !== hoverPin.side))) { hoverPin = pin; redraw(); }
      if (tool === 'select') {
        const t = topAt(p);
        const clickable = !readOnly && t && t.type === 'node' && ((['BUTTON', 'LEVER', 'SWITCH'].includes(t.kind) && local(t, p).y > t.y + 24) || (t.kind === 'LIMIT' && local(t, p).x < t.x + 32));
        const hd = handleAt(p);
        const gear = gearAt(p);
        if ((gear ? gear.id : null) !== hoverGear) { hoverGear = gear ? gear.id : null; redraw(); }
        cv.style.cursor = placing ? 'copy' : gear ? 'pointer' : !readOnly && knobAt(p) ? 'grab' : pin ? 'crosshair' : hd ? (hd.rotate ? 'grab' : 'nwse-resize') : clickable ? 'pointer' : t ? 'move' : 'default';
      }
      return;
    }
    switch (drag.kind) {
      case 'pan':
        view.x = drag.vx - (e.clientX - drag.sx) / view.z; view.y = drag.vy - (e.clientY - drag.sy) / view.z; break;
      case 'wire':
        drag.to = p; hoverPin = pinAt(p); break;
      case 'box':
        drag.cur = p; break;
      case 'move': {
        if (readOnly) break;
        let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) * view.z < 3) break;
        drag.moved = true;
        if (snap) {
          const first = byId.get([...selection][0]);
          const b = first && bbox(first);
          if (b) { dx = snapV(b.x1 + dx) - b.x1; dy = snapV(b.y1 + dy) - b.y1; }
        }
        drag.preview = selected().filter((s) => s.type !== 'wire').map((s) => moved(s, dx, dy));
        break;
      }
      case 'rotate': {
        let deg = (Math.atan2(p.y - drag.c.y, p.x - drag.c.x) * 180) / Math.PI + 90;
        if (!e.shiftKey) deg = Math.round(deg / 15) * 15; // snap to 15°, Shift = free
        drag.preview = [{ ...clone(drag.s), rot: normDeg(deg) || undefined }];
        break;
      }
      case 'resize': {
        const q = local(drag.s, p); // the pointer in the shape's own (unrotated) frame
        const b0 = drag.b0, o = drag.h;
        const fx = o.ox === 'x1' ? b0.x1 : b0.x2, fy = o.oy === 'y1' ? b0.y1 : b0.y2;
        // Keep the offset between the handle and the shape's corner (no jump when grabbing).
        const cx = o.ox === 'x1' ? b0.x2 : b0.x1, cy = o.oy === 'y1' ? b0.y2 : b0.y1;
        let x = snapV(q.x - (o.x - cx)), y = snapV(q.y - (o.y - cy));
        if (e.shiftKey) { const r = Math.max(Math.abs(x - fx) / Math.max(1, b0.x2 - b0.x1), Math.abs(y - fy) / Math.max(1, b0.y2 - b0.y1)); x = fx + Math.sign(x - fx || 1) * r * (b0.x2 - b0.x1); y = fy + Math.sign(y - fy || 1) * r * (b0.y2 - b0.y1); }
        const b1 = { x1: Math.min(fx, x), y1: Math.min(fy, y), x2: Math.max(fx, x), y2: Math.max(fy, y) };
        drag.preview = [scaled(drag.s, b0, b1)];
        break;
      }
      case 'erase': eraseAt(p); break;
      case 'ctl': ctlDrag(drag, p); break;
      case 'knob': {
        const v = knobDrag(drag, p);
        drag.preview = [{ ...clone(drag.s), value: v }];
        const t = Date.now();
        if (v !== drag.sentValue && t - drag.sent > 66) { drag.sent = t; drag.sentValue = v; commit([{ ...clone(drag.s), value: v }], [], false); } // live
        break;
      }
      case 'draw': {
        const s = drag.shape;
        if (s.type === 'pen') {
          const n = s.pts.length;
          if (Math.hypot(p.x - s.pts[n - 2], p.y - s.pts[n - 1]) > 1.5 / view.z) s.pts.push(p.x, p.y);
        } else {
          s.x2 = snapV(p.x); s.y2 = snapV(p.y);
          if (e.shiftKey) {
            if (['rect', 'ellipse', 'diamond'].includes(s.type)) {
              const d = Math.max(Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
              s.x2 = s.x1 + Math.sign(s.x2 - s.x1 || 1) * d; s.y2 = s.y1 + Math.sign(s.y2 - s.y1 || 1) * d;
            } else {
              const a = Math.round(Math.atan2(p.y - s.y1, p.x - s.x1) / (Math.PI / 12)) * (Math.PI / 12);
              const l = Math.hypot(p.x - s.x1, p.y - s.y1);
              s.x2 = s.x1 + Math.cos(a) * l; s.y2 = s.y1 + Math.sin(a) * l;
            }
          }
        }
        break;
      }
    }
    redraw();
  });

  function endDrag(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    const p = e ? toWorld(e) : mouseWorld;
    switch (d.kind) {
      case 'pan': syncBar(); break;
      case 'wire': {
        const target = pinAt(p);
        if (target && target.n !== d.pin.n && target.side !== d.pin.side && pinKind(target) !== pinKind(d.pin)) {
          notice = { text: pinKind(d.pin) === 'hyd' ? 'Hydraulic hoses only connect to hydraulic ports (orange)' : 'Signal wires can’t go into hydraulic ports (orange)', x: p.x, y: p.y, until: Date.now() + 2200 };
          setTimeout(redraw, 2300);
        } else if (target && target.n !== d.pin.n && target.side !== d.pin.side) {
          const out = d.pin.side === 'out' ? d.pin : target, inp = d.pin.side === 'in' ? d.pin : target;
          // An input takes one wire: replace any existing one.
          const old = shapes.filter((w) => w.type === 'wire' && w.b.n === inp.n && w.b.p === inp.p).map((w) => w.id);
          commit([{ id: uid(), type: 'wire', a: { n: out.n, p: out.p }, b: { n: inp.n, p: inp.p }, by: me.name, t: Date.now(), z: 0 }], old);
        }
        hoverPin = null;
        break;
      }
      case 'box': {
        const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x), y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
        if (x2 - x1 > 2 || y2 - y1 > 2) {
          for (const s of shapes) { const b = worldBox(s); if (b.x1 >= x1 && b.x2 <= x2 && b.y1 >= y1 && b.y2 <= y2) selection.add(s.id); }
        }
        syncSelBar();
        break;
      }
      case 'move':
        if (d.moved && d.preview && d.preview.length) commit(d.preview);
        else if (!d.moved && d.clickOn && d.clickOn.type === 'node' && d.clickOn.kind === 'SELECTOR' && !readOnly) {
          commit([{ ...clone(byId.get(d.clickOn.id) || d.clickOn), value: ((Math.round(Number(d.clickOn.value)) || 0) + 1) % 3 }]);
        }
        else if (!d.moved && d.clickOn && d.clickOn.type === 'node' && (d.clickOn.kind === 'SWITCH' || d.clickOn.kind === 'LEVER' || d.clickOn.kind === 'ESTOP') && !readOnly) {
          commit([{ ...clone(byId.get(d.clickOn.id) || d.clickOn), value: !d.clickOn.value }]); // click a switch/lever to flip it
        }
        break;
      case 'resize': if (d.preview) commit(d.preview); break;
      case 'rotate': if (d.preview && (d.preview[0].rot || 0) !== (d.s.rot || 0)) commit(d.preview); break;
      case 'press': {
        const b = byId.get(d.id);
        if (b) commit([{ ...clone(b), value: false }], [], false);
        break;
      }
      case 'erase': break;
      case 'knob': if (d.preview && d.preview[0].value !== d.orig.value) commit(d.preview, [], true, [d.orig]); break;
      case 'ctl': { const cur = clone(byId.get(d.s.id) || d.s); if (cur.kind === 'JOYSTICK') { cur.jx = 0; cur.jy = 0; } commit([cur], [], true, [d.orig]); break; }
      case 'draw': {
        const s = d.shape;
        const b = bbox(s);
        if (s.type === 'pen' || Math.hypot(b.x2 - b.x1, b.y2 - b.y1) > 3) {
          if (s.type === 'pen') s.pts = s.pts.map((v) => Math.round(v * 10) / 10);
          commit([s]);
        }
        break;
      }
    }
    redraw();
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', () => endDrag());
  window.addEventListener('blur', () => { if (drag && drag.kind === 'press') endDrag(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('dblclick', (e) => {
    if (readOnly) return;
    const s = topAt(toWorld(e));
    if (!s) return;
    if (s.type === 'text' || s.type === 'note') startEdit(s, false);
    // Module settings open only from their gear button (no double-click).
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const kn = !readOnly && tool === 'select' && knobAt(toWorld(e));
    if (kn) { // turn a knob with the mouse wheel
      const r = knobRange(kn);
      const v = roundKnob(kn, r.value + (e.deltaY < 0 ? r.wheel : -r.wheel));
      if (v !== kn.value) commit([{ ...clone(kn), value: v }]);
      return;
    }
    const before = toWorld(e);
    view.z = Math.min(6, Math.max(0.15, view.z * Math.exp(-e.deltaY * 0.0015)));
    const r = cv.getBoundingClientRect();
    view.x = before.x - (e.clientX - r.left) / view.z;
    view.y = before.y - (e.clientY - r.top) / view.z;
    redraw();
  }, { passive: false });

  function eraseAt(p) {
    const s = topAt(p);
    if (s && !drag.ids.has(s.id)) {
      const ids = s.type === 'node' ? withWires([s.id]) : [s.id];
      ids.forEach((id) => drag.ids.add(id));
      commit([], ids);
    }
  }

  // ------------------------------------------------------------------ in-place text editing
  let editing = null;
  function startEdit(shape, isNew) {
    editing = { shape, isNew };
    editingId = shape.type === 'node' ? null : shape.id;
    const isNode = shape.type === 'node';
    const sp = toScreen(isNode ? shape.x + 10 : shape.type === 'note' ? shape.x + 6 : shape.x, isNode ? shape.y + 28 : shape.type === 'note' ? shape.y + 6 : shape.y);
    editBox.style.display = 'block';
    editBox.style.left = sp.x + 'px'; editBox.style.top = sp.y + 'px';
    if (shape.rot && shape.type !== 'node') {
      const o = center(shape), oc = toScreen(o.x, o.y);
      editBox.style.transformOrigin = (oc.x - sp.x) + 'px ' + (oc.y - sp.y) + 'px';
      editBox.style.transform = 'rotate(' + shape.rot + 'deg)';
    } else editBox.style.transform = '';
    const size = shape.type === 'text' ? shape.size : 13;
    editBox.style.fontSize = size * view.z + 'px';
    editBox.style.color = shape.type === 'note' ? '#1b2433' : shape.color || '#fff';
    editBox.style.background = shape.type === 'note' ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.35)';
    editBox.style.width = (shape.type === 'note' ? (shape.w - 12) * view.z : isNode ? 90 * view.z : 240) + 'px';
    editBox.style.height = (shape.type === 'note' ? (shape.h - 12) * view.z : (size * 1.6) * view.z + 6) + 'px';
    editBox.value = isNode ? (shape.kind === 'NOTE' ? CC.noteName(shape.value) : String(shape.value ?? '')) : shape.text || '';
    editBox.placeholder = isNode ? ({ CLOCK: 'period in seconds', DELAY: 'seconds', PULSE: 'seconds', COUNTER: 'max value', BUZZER: 'pitch in Hz', NOTE: 'note, e.g. C5', PUMP: 'max pressure (bar)', CYLINDER: 'load (bar)', GAUGE: 'trip pressure (bar)' }[shape.kind] || 'number') : 'Type…';
    redraw();
    setTimeout(() => { editBox.focus(); editBox.select(); }, 0);
  }
  function finishEdit(save) {
    if (!editing) return;
    const { shape, isNew } = editing;
    editing = null;
    editingId = null;
    editBox.style.display = 'none';
    if (!save) { if (isNew) redraw(); return; }
    const v = editBox.value;
    if (shape.type === 'node') {
      const k = shape.kind;
      let n = k === 'NOTE' ? CC.parseNote(v) : Number(v.replace(',', '.'));
      if (n !== null && Number.isFinite(n)) {
        if (k === 'CLOCK') n = Math.max(0.1, n);
        if (k === 'DELAY' || k === 'PULSE') n = Math.max(0.05, n);
        if (k === 'COUNTER') n = Math.max(1, Math.round(n));
        if (k === 'BUZZER') n = Math.min(4000, Math.max(40, n));
        if (k === 'NOTE') n = Math.min(36, Math.max(-12, n));
        if (k === 'PUMP') n = Math.min(1000, Math.max(1, n));
        if (k === 'CYLINDER' || k === 'GAUGE') n = Math.min(1000, Math.max(0, n));
        commit([{ ...clone(byId.get(shape.id) || shape), value: n }]);
      }
    } else if (shape.type === 'text') {
      if (v.trim()) commit([{ ...clone(byId.get(shape.id) || shape), text: v }]);
      else if (!isNew) commit([], [shape.id]);
    } else if (shape.type === 'note') {
      commit([{ ...clone(byId.get(shape.id) || shape), text: v }]);
    }
    redraw();
  }
  editBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') finishEdit(false);
    if (e.key === 'Enter' && !e.shiftKey && editing && editing.shape.type !== 'note') { e.preventDefault(); finishEdit(true); }
  });
  editBox.addEventListener('blur', () => finishEdit(true));

  // ------------------------------------------------------------------ view + export
  function contentBox() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of shapes) { const b = worldBox(s); x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2); }
    return shapes.length ? { x1, y1, x2, y2 } : null;
  }
  let pendingFit = false;
  function fit() {
    // A board opened in a background tab has no size yet: fit once it becomes visible.
    if (innerWidth < 50 || innerHeight < 50) { pendingFit = true; return; }
    pendingFit = false;
    const b = contentBox();
    if (!b) { view = { x: -60, y: -110, z: 1 }; redraw(); return; }
    const z = Math.min(3, Math.max(0.15, Math.min(innerWidth / (b.x2 - b.x1 + 160), (innerHeight - 120) / (b.y2 - b.y1 + 160))));
    view = { z, x: (b.x1 + b.x2) / 2 - innerWidth / 2 / z, y: (b.y1 + b.y2) / 2 - (innerHeight + 60) / 2 / z };
    redraw();
  }
  function exportPng() {
    const b = contentBox() || { x1: 0, y1: 0, x2: 800, y2: 600 };
    const x1 = b.x1 - 60, y1 = b.y1 - 60, x2 = b.x2 + 60, y2 = b.y2 + 60;
    const scale = 2, w = Math.min(8000, Math.ceil((x2 - x1) * scale)), h = Math.min(8000, Math.ceil((y2 - y1) * scale));
    const off = document.createElement('canvas'); off.width = w; off.height = h;
    const c = off.getContext('2d');
    grid(c, w, h, x1 * scale, y1 * scale, scale);
    c.setTransform(scale, 0, 0, scale, -x1 * scale, -y1 * scale);
    const order = (s) => (s.type === 'node' ? 2 : s.type === 'wire' ? 1 : 0);
    for (const s of shapes.slice().sort((a, b2) => order(a) - order(b2))) drawShape(c, s);
    vscode.postMessage({ type: 'save', png: off.toDataURL('image/png') });
  }
  function resize() {
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
    if (pendingFit) fit();
    draw();
  }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target === editBox) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
    if (e.key === 'Escape') { helpBox.classList.remove('open'); placing = null; selection.clear(); nodesMenu.classList.remove('open'); syncBar(); redraw(); return; }
    if (readOnly && !(mod && k === 'a')) {
      if (k === 'h') setTool('hand');
      if (k === 'v') setTool('select');
      return;
    }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'c') { e.preventDefault(); copySel(); return; }
    if (mod && k === 'x') { e.preventDefault(); copySel(); deleteSelection(); return; }
    if (mod && k === 'v') { e.preventDefault(); paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod && k === 'a') { e.preventDefault(); tool = 'select'; selection = new Set(shapes.map((s) => s.id)); syncBar(); redraw(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }
    if (e.key.startsWith('Arrow') && selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      return;
    }
    if (mod || e.altKey) return;
    if (e.shiftKey && k === 'r' && selection.size) { rotateBy(90); return; }
    if (e.shiftKey && k === 'l' && selection.size) { rotateBy(-90); return; }
    if (k === ']') { reorder(true); return; }
    if (k === '[') { reorder(false); return; }
    if (k === 'g') { nodesMenu.classList.toggle('open'); if (nodesMenu.classList.contains('open')) buildInventory(''); syncBar(); return; }
    if (e.key === 'F1' || e.key === '?') { e.preventDefault(); openHelp(); return; }
    if (k === 's') { snap = !snap; syncBar(); return; }
    const map = { v: 'select', h: 'hand', p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', i: 'diamond', d: 'dim', t: 'text', n: 'note', e: 'eraser', b: 'bucket' };
    if (map[k]) setTool(map[k]);
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; syncBar(); } });

  // ------------------------------------------------------------------ messages from the extension
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') { me = m.me; isHost = !!m.isHost; perfOn = m.perf !== false; showPerf(); readOnly = !!m.readOnly; setTool(readOnly ? 'hand' : 'select'); setShapes(m.shapes || []); if ((m.shapes || []).length) fit(); }
    else if (m.type === 'shapes') setShapes(m.shapes || []);
    else if (m.type === 'pointer') { pointers.set(m.id, { ...m, at: Date.now() }); redraw(); }
    else if (m.type === 'sim' && m.sim) {
      sim = { v: new Map(Object.entries(m.sim.v || {})), i: new Map(Object.entries(m.sim.i || {})), s: new Map(Object.entries(m.sim.s || {})) };
      posePrev = poseCur; poseCur = new Map(Object.entries(m.sim.p || {})); poseT = performance.now();
      springEnds = new Map(Object.entries(m.sim.sp || {}));
      updateSound();
      redraw();
    }
    else if (m.type === 'readOnly') { readOnly = !!m.value; selection.clear(); setTool(readOnly ? 'hand' : 'select'); }
    else if (m.type === 'me') { me = { ...me, ...m.me }; }
    else if (m.type === 'perf') { lastPerf = m.perf; showPerf(); }
    else if (m.type === 'perfEnabled') { perfOn = !!m.on; showPerf(); }
  });

  // Test page only (test/board-harness.html): expose internals for debugging.
  if (window.__store) window.__wb = { contentBox, bbox, worldBox, shapes: () => shapes, view: () => view, draw, handleAt, selection: () => selection, resizable };
  syncBar();
  syncSound();
  resize();
  vscode.postMessage({ type: 'ready' });
})();

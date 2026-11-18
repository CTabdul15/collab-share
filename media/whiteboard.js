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
  const snapV = (v) => (snap ? Math.round(v / 10) * 10 : v);
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
    return { a: pinPos(A, 'out', w.a.p), b: pinPos(B, 'in', w.b.p), ba: worldBox(A), bb: worldBox(B), skip: [A.id, B.id] };
  }
  // Wire style: curved or square (right angles with rounded corners). A per-person view setting.
  let wireStyle = 'curve';
  try { wireStyle = localStorage.getItem('collab.wireStyle') || 'curve'; } catch { /* ignore */ }
  let routeCache = new Map(), routeVersion = 0, routeCacheVersion = -1;
  function wirePath(a, b, ba, bb, skip) {
    if (wireStyle !== 'square') return bezier(a, b);
    if (routeCacheVersion !== routeVersion) { routeCache = new Map(); routeCacheVersion = routeVersion; }
    const key = [a.x, a.y, a.dx, a.dy, b.x, b.y, b.dx, b.dy, skip && skip.join()].join('|');
    let r = routeCache.get(key);
    if (!r) { r = elbow(a, b, ba, bb, skip); if (routeCache.size < 5000) routeCache.set(key, r); }
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
  /** Right-angle route between two pins that leaves/enters each pin in its own direction. */
  function elbow(a, b, ba, bb, skip) {
    const S = 18;
    const adx = a.dx ?? 1, ady = a.dy ?? 0, bdx = b.dx ?? -1, bdy = b.dy ?? 0;
    const a1 = { x: a.x + adx * S, y: a.y + ady * S }, b1 = { x: b.x + bdx * S, y: b.y + bdy * S };
    const aH = Math.abs(adx) >= Math.abs(ady), bH = Math.abs(bdx) >= Math.abs(bdy);
    const pts = [{ x: a.x, y: a.y }, a1];
    if (aH && bH) {
      // Forward = the target pin lies ahead of the source pin (judged by the pins, not the stubs).
      const forward = adx > 0 ? b.x > a.x + 4 : b.x < a.x - 4;
      if (forward && Math.abs(a.y - b.y) < 1.5) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]; // straight across
      if (forward || !ba || !bb) {
        // Pick the vertical lane that crosses the fewest other modules (ties: closest to the middle).
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x), mid = (a.x + b.x) / 2;
        const boxes = ba && bb ? obstacles(skip) : [];
        const lanes = [mid, lo + 14, hi - 14];
        for (const bx of boxes) lanes.push(bx.x1 - 14, bx.x2 + 14);
        let best = null;
        for (const mx of lanes) {
          if (mx < lo + 6 || mx > hi - 6) continue;
          const cand = [{ x: a.x, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: b.x, y: b.y }];
          const score = crossings(cand, boxes) * 1000 + Math.abs(mx - mid);
          if (!best || score < best.score) best = { score, cand };
        }
        if (best && best.score >= 1000) {
          // Still runs through a module: try a detour through a free horizontal lane (two turns).
          const ys = [Math.min(a.y, b.y) - 30, Math.max(a.y, b.y) + 30];
          for (const bx of boxes) ys.push(bx.y1 - 14, bx.y2 + 14);
          const len = (pts) => pts.reduce((sum, p, i) => (i ? sum + Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) : 0), 0);
          for (const mx1 of [lo + 14, mid]) {
            for (const my of ys) {
              for (const mx2 of [hi - 14, mid]) {
                if (mx2 < mx1) continue;
                const cand = [{ x: a.x, y: a.y }, { x: mx1, y: a.y }, { x: mx1, y: my }, { x: mx2, y: my }, { x: mx2, y: b.y }, { x: b.x, y: b.y }];
                const score = crossings(cand, boxes) * 1000 + len(cand) * 0.05;
                if (score < best.score) best = { score, cand };
              }
            }
          }
        }
        if (best) return best.cand.filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 0.5);
        pts.push({ x: mid, y: a1.y }, { x: mid, y: b1.y });
      } else {
        // Target is behind the source: go around the modules instead of through them,
        // through the gap between them, or below both when they overlap vertically.
        let my;
        if (ba.y2 + 16 < bb.y1) my = (ba.y2 + bb.y1) / 2;
        else if (bb.y2 + 16 < ba.y1) my = (bb.y2 + ba.y1) / 2;
        else my = Math.max(ba.y2, bb.y2) + 24;
        pts.push({ x: a1.x, y: my }, { x: b1.x, y: my });
      }
    }
    else if (!aH && !bH) { const my = (a1.y + b1.y) / 2; pts.push({ x: a1.x, y: my }, { x: b1.x, y: my }); }
    else if (aH) pts.push({ x: b1.x, y: a1.y });
    else pts.push({ x: a1.x, y: b1.y });
    pts.push(b1, { x: b.x, y: b.y });
    return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 0.5);
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
      case 'node': { const d = def(s.kind) || { w: 60, h: 40 }; return { x1: s.x, y1: s.y, x2: s.x + d.w, y2: s.y + d.h }; }
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

  function hit(s, p) {
    p = local(s, p);
    const tol = 6 / view.z + (s.w || 2) / 2;
    switch (s.type) {
      case 'pen':
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
    return c;
  }
  const resizable = (s) => s && !['node', 'wire'].includes(s.type);

  // ------------------------------------------------------------------ changes (synced + undoable)
  /** Applies changes, sends them to everyone, and records them for undo. */
  function commit(set, del = [], record = true) {
    set = set.filter(Boolean);
    const ids = [...new Set([...set.map((s) => s.id), ...del])];
    if (!ids.length || readOnly) return;
    const before = ids.map((id) => (byId.has(id) ? clone(byId.get(id)) : null));
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
  function grid(c, w, h, vx, vy, z) {
    c.fillStyle = '#123f7a';
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.8);
    g.addColorStop(0, 'rgba(40,110,190,.35)'); g.addColorStop(1, 'rgba(0,0,0,.25)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const lines = (step, alpha) => {
      const s = step * z;
      if (s < 6) return;
      c.strokeStyle = 'rgba(255,255,255,' + alpha + ')'; c.lineWidth = 1; c.beginPath();
      for (let x = ((-vx * z) % s + s) % s; x < w; x += s) { c.moveTo(Math.round(x) + .5, 0); c.lineTo(Math.round(x) + .5, h); }
      for (let y = ((-vy * z) % s + s) % s; y < h; y += s) { c.moveTo(0, Math.round(y) + .5); c.lineTo(w, Math.round(y) + .5); }
      c.stroke();
    };
    lines(20, .07);
    lines(100, .16);
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
    inFrame(c, s, () => drawShapeInner(c, s));
  }
  function drawShapeInner(c, s) {
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = s.w || 2; c.lineCap = 'round'; c.lineJoin = 'round';
    c.setLineDash(s.dash ? [8, 6] : []);
    const fill = () => { if (s.fill) { c.save(); c.globalAlpha = 0.22; c.fill(); c.restore(); } };
    switch (s.type) {
      case 'pen': {
        const p = s.pts;
        c.beginPath(); c.moveTo(p[0], p[1]);
        if (p.length === 2) c.lineTo(p[0] + .1, p[1] + .1);
        for (let i = 2; i < p.length - 2; i += 2) c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
        if (p.length > 2) c.lineTo(p[p.length - 2], p[p.length - 1]);
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
        textLines(s).forEach((l, i) => c.fillText(l, s.x, s.y + i * s.size * 1.25)); break;
      case 'note': {
        c.setLineDash([]);
        c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 8; c.shadowOffsetY = 3;
        c.fillStyle = s.color === '#ffffff' ? '#ffd166' : s.color;
        c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x + s.w, s.y); c.lineTo(s.x + s.w, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h); c.lineTo(s.x, s.y + s.h); c.closePath();
        c.fill(); c.restore();
        c.fillStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.moveTo(s.x + s.w, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h - 14); c.lineTo(s.x + s.w - 14, s.y + s.h); c.closePath(); c.fill();
        c.fillStyle = '#1b2433'; c.font = '13px ' + FONT; c.textBaseline = 'top';
        wrap(c, s.text || '', s.w - 16).slice(0, Math.floor((s.h - 12) / 17)).forEach((l, i) => c.fillText(l, s.x + 8, s.y + 8 + i * 17));
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
  function wireColor(w) {
    const out = values.get(w.a.n);
    return sigColor(out ? out[w.a.p] : undefined);
  }
  function drawWire(c, w, a, b) {
    const p = a && b ? { a, b } : wirePoints(w);
    if (!p) return;
    const pts = wirePath(p.a, p.b, p.ba, p.bb, p.skip);
    const col = w ? wireColor(w) : '#ffffff';
    const path = () => { c.beginPath(); if (wireStyle === 'square') roundedPoly(c, pts, 8); else { c.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) c.lineTo(q.x, q.y); } };
    if (col === OFF) { path(); c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 4.5; c.stroke(); } // keep black wires visible on blue
    c.save();
    if (col === ON) { c.shadowColor = ON; c.shadowBlur = 8; }
    path(); c.strokeStyle = col; c.lineWidth = 2.5; c.stroke();
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
  function closeProps() { if (props) props.style.display = 'none'; propsFor = null; }
  function openProps(n) {
    if (!props) return;
    propsFor = n.id;
    props.replaceChildren();
    const row = (label, el) => { const r = document.createElement('label'); const s = document.createElement('span'); s.textContent = label; r.append(s, el); props.append(r); return el; };
    const select = (opts, value) => { const s = document.createElement('select'); for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; o.selected = v === value; s.append(o); } return s; };
    const input = (value, placeholder) => { const i = document.createElement('input'); i.value = value; i.placeholder = placeholder; i.spellcheck = false; return i; };
    const update = (patch) => { const cur = byId.get(n.id); if (cur && !readOnly) commit([{ ...clone(cur), ...patch }]); };
    const title = document.createElement('div'); title.className = 'ptitle'; title.textContent = def(n.kind).title; props.append(title);
    let test;
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
    const bar = document.createElement('div'); bar.className = 'pbar';
    const play = document.createElement('button'); play.textContent = '▶ Test sound';
    play.onclick = () => { unlockAudio(); muted = false; syncSound(); if (audio && test) test(); };
    const done = document.createElement('button'); done.textContent = 'Done'; done.onclick = closeProps;
    bar.append(play, done); props.append(bar);
    const sp = toScreen(n.x + def(n.kind).w + 10, n.y);
    props.style.left = Math.min(innerWidth - 230, Math.max(8, sp.x)) + 'px';
    props.style.top = Math.min(innerHeight - 200, Math.max(60, sp.y)) + 'px';
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
    for (const n of shapes) {
      if (n.type !== 'node') continue;
      if (n.kind === 'MOTOR' && motorSpeed(n) !== 0) return true;
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
  function drawPin(c, p, connected, value, accent) {
    c.beginPath(); c.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    c.fillStyle = connected ? sigColor(value) : '#123f7a'; c.fill();
    c.strokeStyle = connected ? (accent || '#ffffff') : NOPOWER; c.lineWidth = 1.5; c.stroke();
  }
  const HEADER = { func: '#3f8f6a', mem: '#7b4fb8', time: '#2a8c9c', in: '#b07d12', out: '#4a6fa5' };
  const ICON = { func: 'ƒ ', mem: '⧉ ', time: '⏱ ', in: '', out: '' };
  const secs = (v) => (Math.round((Number(v) || 0) * 100) / 100) + ' s';

  function body(c, n, d, color) {
    roundRect(c, n.x, n.y, d.w, d.h, 6);
    c.fillStyle = '#0a1c3a'; c.fill(); c.strokeStyle = color; c.stroke();
    c.save(); roundRect(c, n.x, n.y, d.w, 24, 6); c.clip(); c.fillStyle = HEADER[d.cat] || HEADER.func; c.fillRect(n.x, n.y, d.w, 24); c.restore();
    c.beginPath(); c.moveTo(n.x, n.y + 24); c.lineTo(n.x + d.w, n.y + 24); c.strokeStyle = color; c.stroke();
    c.fillStyle = '#ffffff'; c.font = '700 12px "Segoe UI", sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText((ICON[d.cat] || '') + d.title, n.x + 8, n.y + 12);
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
      gatePath(c, n.kind, n.x, n.y, d.w, d.h);
      c.fillStyle = on ? 'rgba(255,49,49,.18)' : 'rgba(10,40,85,.75)'; c.fill();
      c.strokeStyle = color; c.stroke();
      if (/^XN?OR/.test(n.kind)) { c.beginPath(); c.moveTo(n.x + 2, n.y); c.quadraticCurveTo(n.x + 16, n.y + d.h / 2, n.x + 2, n.y + d.h); c.stroke(); }
      const bodyW = d.w - 14;
      const bubble = ['NAND', 'NOR', 'XNOR', 'NOT'].includes(n.kind);
      if (bubble) { c.beginPath(); c.arc(n.x + bodyW + 4, n.y + d.h / 2, 4, 0, Math.PI * 2); c.fillStyle = '#123f7a'; c.fill(); c.stroke(); }
      c.beginPath(); c.moveTo(n.x + bodyW + (bubble ? 8 : 0), n.y + d.h / 2); c.lineTo(n.x + d.w, n.y + d.h / 2); c.stroke();
      c.fillStyle = color; c.font = '600 10px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(d.title, n.x + bodyW / 2 + 2, n.y + d.h / 2);
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
        const on = truthy(out[0]);
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
        // status LED
        c.beginPath(); c.arc(n.x + d.w - 9, n.y + 32, 3, 0, Math.PI * 2);
        if (on) { c.save(); c.shadowColor = ON; c.shadowBlur = 8; c.fillStyle = ON; c.fill(); c.restore(); } else { c.fillStyle = 'rgba(255,255,255,.2)'; c.fill(); }
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
      } else if (n.kind === 'DISPLAY') {
        roundRect(c, n.x + 18, cy - 9, d.w - 26, 18, 3); c.fillStyle = '#0a1a33'; c.fill();
        c.fillStyle = ON; c.font = '600 13px ' + FONT; c.fillText(fmt(ins[0] ?? 0), cx + 5, cy + 1);
      } else if (n.kind === 'SEG7') {
        roundRect(c, n.x + 16, n.y + 30, d.w - 24, d.h - 36, 4); c.fillStyle = '#0b0f14'; c.fill();
        const v = Math.trunc(CC.num(ins[0]));
        seg7(c, n.x + 26, n.y + 38, d.w - 44, d.h - 52, ((v % 16) + 16) % 16, connectedIn.has(0));
      } else if (n.kind === 'MOTOR') {
        // Electric motor: rotor spins while powered (faster for bigger numbers).
        const speed = motorSpeed(n);
        const now = performance.now();
        const ang = (motorAngle.get(n.id) || 0) + speed * 7 * Math.min(0.1, (now - (motorAngle.get(n.id + ':t') || now)) / 1000);
        motorAngle.set(n.id, ang); motorAngle.set(n.id + ':t', now);
        const r = 28;
        const hg = c.createRadialGradient(cx - 8, cy - 8, 4, cx, cy, r + 4);
        hg.addColorStop(0, '#b8c2cc'); hg.addColorStop(1, '#4a535d');
        c.beginPath(); c.arc(cx, cy, r + 3, 0, Math.PI * 2); c.fillStyle = hg; c.fill(); c.strokeStyle = speed ? ON : 'rgba(255,255,255,.6)'; c.lineWidth = 2; c.stroke();
        c.beginPath(); c.arc(cx, cy, r - 3, 0, Math.PI * 2); c.fillStyle = '#1c232b'; c.fill();
        c.save(); c.translate(cx, cy); c.rotate(ang);
        for (let k = 0; k < 3; k++) {
          c.rotate((Math.PI * 2) / 3);
          c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(10, -6, r - 6, -2); c.quadraticCurveTo(14, 6, 0, 0);
          c.fillStyle = speed ? '#7fdbff' : '#8a96a3'; c.fill();
        }
        c.restore();
        c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fillStyle = '#e6e6e6'; c.fill();
        c.fillStyle = speed ? '#ffd6d6' : 'rgba(255,255,255,.7)'; c.font = '600 10px ' + FONT; c.textAlign = 'right';
        c.fillText(speed ? (Math.abs(speed) * 60).toFixed(0) + ' rpm' : 'off', n.x + d.w - 8, n.y + 12);
        c.lineWidth = 2;
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
    d.ins.forEach((pin, i) => drawPin(c, pinPos(n, 'in', i, true), connectedIn.has(i), ins[i], pin.at ? '#ffd166' : '#ffffff'));
    d.outs.forEach((pin, i) => drawPin(c, pinPos(n, 'out', i, true), connectedOut.has(i) || out[i] !== undefined, out[i], pin.bool ? '#ffffff' : '#7fdbff'));
    c.restore();
  }

  function draw() {
    evaluate();
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
    if (hoverPin) { ctx.beginPath(); ctx.arc(hoverPin.x, hoverPin.y, 8, 0, Math.PI * 2); ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2 / view.z; ctx.stroke(); }
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
    if (animating()) redraw();
  }
  let raf = 0;
  const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
  setInterval(() => { if (pointers.size) redraw(); }, 250);

  function sortShapes() {
    routeVersion++;
    shapes = [...byId.values()].sort((a, b) => ((a.z ?? a.t) - (b.z ?? b.t)) || (a.id < b.id ? -1 : 1));
    const authors = [...new Set(shapes.map((s) => s.by).filter(Boolean))];
    document.getElementById('authors').textContent = authors.length ? authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' +' + (authors.length - 4) : '') : '—';
    for (const id of [...selection]) if (!byId.has(id)) selection.delete(id);
    syncSelBar();
  }
  function setShapes(list) {
    byId.clear();
    for (const s of list) byId.set(s.id, s);
    sortShapes();
    redraw();
  }

  // ------------------------------------------------------------------ toolbar
  const bar = document.getElementById('bar');
  const nodesMenu = document.getElementById('nodes');
  function syncBar() {
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
    cv.style.cursor = placing ? 'copy' : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : tool === 'select' ? 'default' : 'crosshair';
    syncSelBar();
  }
  function syncSelBar() {
    const sb = document.getElementById('selbar');
    sb.style.display = selection.size && !readOnly ? 'flex' : 'none';
    document.getElementById('selcount').textContent = selection.size + ' selected';
  }
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
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.tool === 'nodes') { nodesMenu.classList.toggle('open'); syncBar(); return; }
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
  function pinAt(p) {
    const r = 9 / view.z;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const n = shapes[i];
      if (n.type !== 'node') continue;
      const d = def(n.kind);
      if (!d) continue;
      for (let k = 0; k < d.outs.length; k++) { const q = pinPos(n, 'out', k); if (Math.hypot(q.x - p.x, q.y - p.y) < r) return { n: n.id, p: k, side: 'out', ...q }; }
      for (let k = 0; k < d.ins.length; k++) { const q = pinPos(n, 'in', k); if (Math.hypot(q.x - p.x, q.y - p.y) < r) return { n: n.id, p: k, side: 'in', ...q }; }
    }
    return null;
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
    if (tool === 'select') {
      const pin = !readOnly && pinAt(p);
      if (pin) { drag = { kind: 'wire', pin, from: { x: pin.x, y: pin.y, dx: pin.dx, dy: pin.dy }, to: p }; return; }
      const hd = !readOnly && handleAt(p);
      if (hd && hd.rotate) { drag = { kind: 'rotate', s: hd.s, c: center(hd.s), preview: [hd.s] }; return; }
      if (hd) { drag = { kind: 'resize', s: hd.s, h: hd.h, b0: bbox(hd.s), preview: [hd.s] }; return; }
      const s = topAt(p);
      // Press a button (below its title bar): on while held, off when released. Not part of undo.
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
        const clickable = t && t.type === 'node' && ['BUTTON', 'LEVER', 'SWITCH'].includes(t.kind) && local(t, p).y > t.y + 24 && !readOnly;
        cv.style.cursor = placing ? 'copy' : pin ? 'crosshair' : handleAt(p) ? 'nwse-resize' : clickable ? 'pointer' : t ? 'move' : 'default';
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
        p = local(drag.s, p);
        const b0 = drag.b0, o = drag.h;
        const fx = o.ox === 'x1' ? b0.x1 : b0.x2, fy = o.oy === 'y1' ? b0.y1 : b0.y2;
        // Keep the offset between the handle and the shape's corner (no jump when grabbing).
        const cx = o.ox === 'x1' ? b0.x2 : b0.x1, cy = o.oy === 'y1' ? b0.y2 : b0.y1;
        let x = snapV(p.x - (o.x - cx)), y = snapV(p.y - (o.y - cy));
        if (e.shiftKey) { const r = Math.max(Math.abs(x - fx) / Math.max(1, b0.x2 - b0.x1), Math.abs(y - fy) / Math.max(1, b0.y2 - b0.y1)); x = fx + Math.sign(x - fx || 1) * r * (b0.x2 - b0.x1); y = fy + Math.sign(y - fy || 1) * r * (b0.y2 - b0.y1); }
        const b1 = { x1: Math.min(fx, x), y1: Math.min(fy, y), x2: Math.max(fx, x), y2: Math.max(fy, y) };
        drag.preview = [scaled(drag.s, b0, b1)];
        break;
      }
      case 'erase': eraseAt(p); break;
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
        if (target && target.n !== d.pin.n && target.side !== d.pin.side) {
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
        else if (!d.moved && d.clickOn && d.clickOn.type === 'node' && (d.clickOn.kind === 'SWITCH' || d.clickOn.kind === 'LEVER') && !readOnly) {
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
    else if (s.type === 'node' && (s.kind === 'NOTE' || s.kind === 'BUZZER')) openProps(s);
    else if (s.type === 'node' && ['NUMBER', 'CLOCK', 'DELAY', 'PULSE', 'COUNTER'].includes(s.kind)) startEdit(s, false);
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
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
    editBox.placeholder = isNode ? ({ CLOCK: 'period in seconds', DELAY: 'seconds', PULSE: 'seconds', COUNTER: 'max value', BUZZER: 'pitch in Hz', NOTE: 'note, e.g. C5' }[shape.kind] || 'number') : 'Type…';
    setTimeout(() => { editBox.focus(); editBox.select(); }, 0);
  }
  function finishEdit(save) {
    if (!editing) return;
    const { shape, isNew } = editing;
    editing = null;
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
    if (e.key === 'Escape') { placing = null; selection.clear(); nodesMenu.classList.remove('open'); syncBar(); redraw(); return; }
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
    if (k === 'g') { nodesMenu.classList.toggle('open'); syncBar(); return; }
    if (k === 's') { snap = !snap; syncBar(); return; }
    const map = { v: 'select', h: 'hand', p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', i: 'diamond', d: 'dim', t: 'text', n: 'note', e: 'eraser' };
    if (map[k]) setTool(map[k]);
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; syncBar(); } });

  // ------------------------------------------------------------------ messages from the extension
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'init') { me = m.me; readOnly = !!m.readOnly; setTool(readOnly ? 'hand' : 'select'); setShapes(m.shapes || []); if ((m.shapes || []).length) fit(); }
    else if (m.type === 'shapes') setShapes(m.shapes || []);
    else if (m.type === 'pointer') { pointers.set(m.id, { ...m, at: Date.now() }); redraw(); }
    else if (m.type === 'sim' && m.sim) {
      sim = { v: new Map(Object.entries(m.sim.v || {})), i: new Map(Object.entries(m.sim.i || {})), s: new Map(Object.entries(m.sim.s || {})) };
      updateSound();
      redraw();
    }
    else if (m.type === 'readOnly') { readOnly = !!m.value; selection.clear(); setTool(readOnly ? 'hand' : 'select'); }
    else if (m.type === 'me') { me = { ...me, ...m.me }; }
  });

  // Test page only (test/board-harness.html): expose internals for debugging.
  if (window.__store) window.__wb = { contentBox, bbox, worldBox, shapes: () => shapes, view: () => view, draw };
  syncBar();
  syncSound();
  resize();
  vscode.postMessage({ type: 'ready' });
})();

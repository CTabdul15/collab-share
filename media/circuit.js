// Collab Share logic simulator, shared by the whiteboard (browser) and the host's extension (Node).
//
// The host runs one simulation for everyone at 20 ticks per second (like Minecraft redstone ticks)
// and streams the results, so all whiteboards show the same signals. Each tick:
//   1. memory/timing modules update from the inputs they saw at the end of the previous tick
//      (edges = a signal turning on between two ticks), then
//   2. everything else settles instantly (gates, math, displays).
(function (root) {
  'use strict';

  const TICK_MS = 50;
  /** Extensions (physics, extra parts) plug into the simulator here. */
  const hooks = [];
  /** Where a moving part is right now (physics): { x, y, a } of its center, or null. */
  let poseProvider = null;
  const truthy = (v) => !!v && v !== 0;
  const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Number.isFinite(v) ? v : 0);
  const rising = (cur, prev) => truthy(cur) && !truthy(prev);
  const ticksOf = (seconds, min = 1) => Math.max(min, Math.round((Number(seconds) || 0) * (1000 / TICK_MS)));

  // ------------------------------------------------------------------ module catalog
  // ins: { n: label, at: 'left'|'top'|'bottom', clk: clock input, dflt: value when not wired }
  // outs: { n: label, bool: true for on/off signals }
  const B = (n) => ({ n, bool: true });
  const QQ = [B('Q'), B('Q̄')];
  const SET = { n: 'Set', at: 'top' };
  const RESET = { n: 'Reset', at: 'bottom' };
  // t: what the port is for (shown when you point at it)
  const HYD = (n, t) => ({ n, hyd: true, t });
  const HYD_IN = (n, t) => ({ n, hyd: true, t });
  const PILOT = (n, at, t) => ({ n, at, t, pilot: true });

  // ------------------------------------------------------------------ fluid power helpers
  /** Directional valve geometry: switching boxes side by side, ports as fractions of a box. */
  const VLAYOUT = {
    VALVE: { boxes: 2, bw: 48, w: 210, top: { A: 0.5 }, bottom: { P: 0.5 } },
    VALVE_3_2: { boxes: 2, bw: 56, w: 240, top: { A: 0.5 }, bottom: { P: 0.3, R: 0.7 } },
    VALVE_5_2: { boxes: 2, bw: 60, w: 250, top: { A: 0.3, B: 0.7 }, bottom: { R: 0.15, P: 0.5, S: 0.85 } },
    VALVE_4_3: { boxes: 3, bw: 50, w: 320, top: { A: 0.3, B: 0.7 }, bottom: { P: 0.3, T: 0.7 } },
  };
  const VALVE_H = 76, BOX_Y1 = 20, BOX_Y2 = 56;

  /**
   * The switching boxes of a valve, left to right. c: connections [from, to] (first is the
   * source side), b: blocked ports. Left box = 14 actuated; right box = 12 / spring.
   */
  function valveBoxes(kind, node) {
    const mode = node || {};
    switch (kind) {
      case 'VALVE': return [{ c: [['P', 'A']] }, { b: ['P', 'A'] }];
      case 'VALVE_3_2': {
        const on = { c: [['P', 'A']], b: ['R'] }, off = { c: [['A', 'R']], b: ['P'] };
        return mode.no ? [off, on] : [on, off];
      }
      case 'VALVE_5_2': return [{ c: [['P', 'A'], ['B', 'S']] }, { c: [['P', 'B'], ['A', 'R']] }];
      case 'VALVE_4_3': {
        const center = mode.center === 'float' ? { c: [['A', 'T'], ['B', 'T']], b: ['P'] }
          : mode.center === 'tandem' ? { c: [['P', 'T']], b: ['A', 'B'] }
          : { b: ['P', 'T', 'A', 'B'] };
        return [{ c: [['P', 'A'], ['B', 'T']] }, center, { c: [['P', 'B'], ['A', 'T']] }];
      }
    }
    return [];
  }

  /** Index of the box that is switched in, from the pilot inputs (and the last position). */
  function valvePosition(kind, node, ins, last) {
    const a = truthy(ins[1]), b = truthy(ins[2]);
    if (kind === 'VALVE') return a ? 0 : 1;
    if (kind === 'VALVE_4_3') {
      const c = (typeof ins[1] === 'number' ? Math.sign(ins[1]) : a ? 1 : 0) - (b ? 1 : 0);
      return c > 0 ? 0 : c < 0 ? 2 : 1;
    }
    if (a && !b) return 0;
    if (b && !a) return 1;
    return node.mode === 'bistable' ? last ?? 1 : 1;
  }

  function valve(kind, title, ins, outs, help) {
    const L = VLAYOUT[kind];
    const f = (frac) => 0.5 + ((frac - 0.5) * L.bw) / L.w; // port position as a fraction of the node width
    const pins = ins.map((p) => (p.n === 'P' ? { ...p, at: 'bottom', f: f(L.bottom.P) } : p));
    return {
      cat: 'hyd', bare: true, valve: true, title, w: L.w, h: VALVE_H, ins: pins,
      outs: outs.map((p) => ({ ...p, at: 'top', f: f(L.top[p.n]) })), help,
      seq: {
        init: () => ({ pos: kind === 'VALVE_4_3' ? 1 : 1 }),
        update(st, inputs, prev, node) { st.pos = valvePosition(kind, node, inputs, st.pos); },
        out(st, node, sim) {
          const p = Math.max(0, num((sim.inputs.get(node.id) || [])[0]));
          const box = valveBoxes(kind, node)[st.pos] || {};
          return outs.map((o) => ((box.c || []).some(([x, y]) => (x === 'P' && y === o.n) || (y === 'P' && x === o.n)) ? p : 0));
        },
        show: (st) => ({ pos: st.pos }),
      },
    };
  }

  /** Range of a speed knob (min, max). */
  function potRange(node) {
    let min = Number(node.min), max = Number(node.max);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 10;
    if (max <= min) max = min + 1;
    return { min, max };
  }
  function potValue(node) {
    const { min, max } = potRange(node), v = Number(node.value);
    return Math.round(Math.min(max, Math.max(min, Number.isFinite(v) ? v : min)) * 100) / 100;
  }
  /** How much of the remaining pressure difference passes per tick through a throttle at this opening. */
  function throttleRate(open) {
    if (open <= 0) return 0;
    return 0.012 + 0.22 * (open / 100) ** 1.4; // 100 % ≈ 0.6 s, 50 % ≈ 1.3 s, 10 % ≈ 5 s to fill
  }
  /** Opening of a flow control valve in % (the Set input wins over the knob when wired). */
  function flowOpening(node, ins) {
    const set = ins ? ins[1] : -1;
    if (typeof set === 'boolean') return set ? 100 : 0;
    if (typeof set === 'number' && set >= 0) return Math.min(100, set);
    const v = Number(node.value);
    return Math.min(100, Math.max(0, Number.isFinite(v) ? v : 50));
  }
  /**
   * How fast a cylinder may move (0–1) in one direction, limited by flow controls on its ports.
   * Port 0 (A, cap side) takes oil in while extending; port 1 (B, rod side) while retracting.
   * A two-way flow control always throttles; a one-way one only in its throttled direction.
   */
  function throttleFactor(node, sim, pins, dir) {
    let f = 1;
    for (const i of pins) {
      const feed = sim && sim.feeds.get(node.id + ':' + i);
      const src = feed && sim.nodes.get(feed.n);
      if (!src) continue;
      const flowIn = (i === 0) === (dir === 'ext');
      if (src.kind === 'FLOW') f = Math.min(f, flowOpening(src, sim.inputs.get(src.id)) / 100);
      else if (src.kind === 'FLOW_1W' && (src.mode !== 'out') === flowIn) f = Math.min(f, flowOpening(src, null) / 100);
    }
    return f;
  }

  /** Cylinder geometry (node coordinates); the rod sticks out to the right of the node. */
  const CYL = { w: 240, h: 104, x1: 12, x2: 186, y1: 26, y2: 74, rodY: 50, out: 36, stroke: 140, plate: 8 };
  const SPRING_KN = 0.4;

  function cylinder(double) {
    const ins = [HYD_IN('A', double ? 'Cap side: pressure here pushes the rod out' : 'Pressure here pushes the rod out')];
    if (double) ins.push(HYD_IN('B', 'Rod side: pressure here pulls the rod in'));
    ins[0] = { ...ins[0], at: 'bottom', f: (CYL.x1 + 14) / CYL.w };
    if (double) ins[1] = { ...ins[1], at: 'bottom', f: (CYL.x2 - 14) / CYL.w };
    return {
      cat: 'hyd', bare: true, title: double ? 'Double-acting Cylinder' : 'Single-acting Cylinder', w: CYL.w, h: CYL.h, ins,
      outs: [
        { n: 'out', bool: true, at: 'top', f: 0.3, t: 'Extended: on at the front end position' },
        { n: '%', at: 'top', f: 0.48, t: 'Rod position, 0–100 %' },
        { n: 'in', bool: true, at: 'top', f: 0.12, t: 'Retracted: on at the rear end position' },
        { n: 'kN', at: 'top', f: 0.66, t: 'Piston force in kN (positive = pushing out)' },
      ],
      help: (double ? 'Pressure on A pushes the rod out, pressure on B pulls it in.' : 'Pressure on A pushes the rod out; a spring pulls it back.') +
        ' It moves when the force beats the load (faster with more force). Its rod presses limit switches it touches. Click the gear for bore and load.',
      seq: {
        init: () => ({ x: 0, f: 0 }),
        update(st, inputs, prev, node, sim) {
          const pins = double ? [0, 1] : [0];
          const tExt = throttleFactor(node, sim, pins, 'ext'), tRet = throttleFactor(node, sim, pins, 'ret');
          const bore = Math.min(400, Math.max(5, Number(node.bore) || 40));
          const rod = Math.min(bore - 2, Math.max(2, Number(node.rod) || Math.round(bore * 0.4)));
          const aCap = Math.PI * (bore / 2000) ** 2, aRing = aCap - Math.PI * (rod / 2000) ** 2;
          const pA = Math.max(0, num(inputs[0])), pB = double ? Math.max(0, num(inputs[1])) : 0;
          // bar × 100 000 Pa × m² = N; / 1000 = kN
          const F = pA * aCap * 100 - (double ? pB * aRing * 100 : SPRING_KN);
          const load = Math.max(0, Number(node.load ?? 1) || 0);
          const speed = (excess) => 0.05 * Math.min(1, Math.max(0.15, excess / 5));
          let throttle = Math.min(tExt, tRet);
          if (F > load) { st.x = Math.min(1, st.x + speed(F - load) * tExt); throttle = tExt; }
          else if (double ? F < -load : F < 0) { st.x = Math.max(0, st.x - (double ? speed(-F - load) : 0.04) * tRet); throttle = tRet; }
          st.throttle = throttle;
          st.f = F;
        },
        out: (st) => [st.x >= 0.999, Math.round(st.x * 100), st.x <= 0.001, Math.round(st.f * 10) / 10],
        show: (st) => ({ x: st.x, f: st.f, throttle: st.throttle ?? 1 }),
      },
    };
  }

  // ------------------------------------------------------------------ physics: steel blocks, bedrock
  const rot2 = (p, c, a) => { const cos = Math.cos(a), sin = Math.sin(a); return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos }; };
  /** Size of a module that can be resized (blocks), else its catalog size. */
  function sizeOf(n) {
    const d = def(n.kind) || { w: 60, h: 40 }; // def() also works out heights that depend on the number of pins
    return { w: Math.max(10, Number(n.bw) || d.w || 60), h: Math.max(10, Number(n.bh) || d.h || 40) };
  }
  /** Rotation point of a steel block in its own coordinates, or null (it slides). */
  function pivotOf(n, w, h) {
    const e = (v) => Math.min(10, v / 2);
    switch (n.pivot) {
      case 'center': return { x: w / 2, y: h / 2 };
      case 'left': return { x: e(w), y: h / 2 };
      case 'right': return { x: w - e(w), y: h / 2 };
      case 'top': return { x: w / 2, y: e(h) };
      case 'bottom': return { x: w / 2, y: h - e(h) };
      case 'custom': return { x: (w * Math.min(100, Math.max(0, Number(n.pivX) || 0))) / 100, y: (h * Math.min(100, Math.max(0, Number(n.pivY) || 0))) / 100 };
      default: return null;
    }
  }
  /** Where a block is now: corners, center, total angle and pivot (base geometry + how far it was pushed). */
  function blockGeom(n, st) {
    const { w, h } = sizeOf(n);
    const rot = ((n.rot || 0) * Math.PI) / 180, c0 = { x: n.x + w / 2, y: n.y + h / 2 };
    const pl = n.kind === 'STEEL' ? pivotOf(n, w, h) : null;
    const P0 = pl ? rot2({ x: n.x + pl.x, y: n.y + pl.y }, c0, rot) : null;
    const dx = (st && st.dx) || 0, dy = (st && st.dy) || 0, da = (st && st.da) || 0;
    const c1 = P0 ? rot2(c0, P0, da) : { ...c0 };
    const center = { x: c1.x + dx, y: c1.y + dy }, ang = rot + da, cos = Math.cos(ang), sin = Math.sin(ang);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos }));
    return { w, h, center, ang, pts, pivot: P0 ? { x: P0.x + dx, y: P0.y + dy } : null, pivotLocal: pl };
  }
  function insidePoly(q, pts) {
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const cr = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      if (Math.abs(cr) < 1e-9) continue;
      if (!sign) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false;
    }
    return true;
  }
  /** Distance from a point inside a convex polygon to its edge, going in direction v. */
  function exitDistance(p, v, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ex = b.x - a.x, ey = b.y - a.y;
      const den = v.x * ey - v.y * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den, s = ((a.x - p.x) * v.y - (a.y - p.y) * v.x) / den;
      if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6) best = Math.min(best, t);
    }
    return best === Infinity ? 0 : best;
  }
  /** Separating-axis test for two convex polygons: null, or how deep they overlap (axis points from A to B). */
  function overlap(A, B, cA, cB) {
    let best = null;
    for (const poly of [A, B]) for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let ax = -(b.y - a.y), ay = b.x - a.x; const l = Math.hypot(ax, ay); if (l < 1e-9) continue; ax /= l; ay /= l;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of A) { const d = p.x * ax + p.y * ay; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const p of B) { const d = p.x * ax + p.y * ay; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      const o = Math.min(maxA, maxB) - Math.max(minA, minB);
      if (o <= 0) return null;
      if (!best || o < best.depth) best = { depth: o, x: ax, y: ay };
    }
    if (best && (cB.x - cA.x) * best.x + (cB.y - cA.y) * best.y < 0) { best.x = -best.x; best.y = -best.y; }
    return best;
  }
  function blocks(sim) {
    const out = [];
    for (const [id, n] of sim.nodes) if (n.kind === 'STEEL' || n.kind === 'BEDROCK') out.push({ n, st: sim.state.get(id) || {} });
    return out;
  }
  const isFreeSteel = (b) => b.n.kind === 'STEEL' && !b.n.fixed && !pivotOf(b.n, sizeOf(b.n).w, sizeOf(b.n).h);
  /** Is another cylinder's rod (not the pushing one) inside this polygon? Rods count as solid. */
  function rodInside(pts, sim, exceptId) {
    for (const [id, n] of sim.nodes) {
      if (id === exceptId || (n.kind !== 'CYLINDER' && n.kind !== 'CYL_DA')) continue;
      const st = sim.state.get(id), [a, b] = rodSegment(n, st ? st.x : 0);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= len; t += 2) if (insidePoly({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len }, pts)) return true;
    }
    return false;
  }
  /** Moves a block pushed at point E in direction u by depth; false if something solid is in the way. */
  function moveBlock(b, u, depth, E, sim, all, pusher) {
    const { n, st } = b;
    if (n.kind !== 'STEEL') return false;
    const g0 = blockGeom(n, st);
    if (n.fixed && !g0.pivot) return false;
    const saved = { dx: st.dx, dy: st.dy, da: st.da };
    if (g0.pivot) {
      const r = { x: E.x - g0.pivot.x, y: E.y - g0.pivot.y }, cross = r.x * u.y - r.y * u.x;
      if (Math.abs(cross) < 3) return false; // pushing straight at the pivot: it can't turn
      st.da += depth / cross;
    } else { st.dx += u.x * depth; st.dy += u.y * depth; }
    const g1 = blockGeom(n, st);
    if (rodInside(g1.pts, sim, pusher)) { Object.assign(st, saved); return false; } // another rod holds it
    const moved = [];
    for (const o of all) {
      if (o.n.id === n.id) continue;
      const go = blockGeom(o.n, o.st), m = overlap(g1.pts, go.pts, g1.center, go.center);
      if (!m || m.depth < 0.3) continue;
      if (isFreeSteel(o)) { // push the next block along
        const os = { dx: o.st.dx, dy: o.st.dy };
        o.st.dx += m.x * m.depth; o.st.dy += m.y * m.depth;
        const g2 = blockGeom(o.n, o.st);
        const blocked = rodInside(g2.pts, sim, pusher) || all.some((q) => q.n.id !== o.n.id && q.n.id !== n.id && (() => { const gq = blockGeom(q.n, q.st), mm = overlap(g2.pts, gq.pts, g2.center, gq.center); return mm && mm.depth >= 0.3; })());
        if (blocked) { o.st.dx = os.dx; o.st.dy = os.dy; for (const [q, s] of moved) { q.st.dx = s.dx; q.st.dy = s.dy; } Object.assign(st, saved); return false; }
        moved.push([o, os]); o.st.lastMove = sim.tick;
      } else { for (const [q, s] of moved) { q.st.dx = s.dx; q.st.dy = s.dy; } Object.assign(st, saved); return false; }
    }
    st.lastMove = sim.tick;
    return true;
  }
  /** A cylinder's rod tip pushes the block it runs into (or stops against bedrock). */
  function pushByRod(cyl, st, sim) {
    const all = blocks(sim);
    if (!all.length) return;
    for (let guard = 0; guard < 4; guard++) {
      const [base, tip] = rodSegment(cyl, st.x);
      const L = Math.hypot(tip.x - base.x, tip.y - base.y);
      if (L < 1) return;
      const u = { x: (tip.x - base.x) / L, y: (tip.y - base.y) / L };
      const b = all.find((q) => insidePoly(tip, blockGeom(q.n, q.st).pts));
      if (!b) return;
      const depth = exitDistance(tip, { x: -u.x, y: -u.y }, blockGeom(b.n, b.st).pts) + 0.01;
      const E = { x: tip.x - u.x * depth, y: tip.y - u.y * depth };
      if (!moveBlock(b, u, depth, E, sim, all, cyl.id)) { st.x = Math.max(0, st.x - depth / CYL.stroke); return; }
    }
  }
  /** Blocks that were pushed and have come to rest: their new place, to store in the board. */
  function settledBlocks(sim) {
    const out = [];
    for (const { n, st } of blocks(sim)) {
      if (n.kind !== 'STEEL' || !(st.dx || st.dy || st.da) || sim.tick - (st.lastMove || 0) < 8) continue;
      const g = blockGeom(n, st);
      let rot = ((g.ang * 180) / Math.PI) % 360; if (rot < 0) rot += 360;
      out.push({ id: n.id, x: Math.round((g.center.x - g.w / 2) * 100) / 100, y: Math.round((g.center.y - g.h / 2) * 100) / 100, rot: Math.round(rot * 100) / 100 });
    }
    return out;
  }

  /** The rod of a cylinder on the board (rotated with the node): from the barrel to the tip. */
  function rodSegment(n, x) {
    const local = [{ x: n.x + CYL.x2, y: n.y + CYL.rodY }, { x: n.x + CYL.x2 + CYL.out + Math.max(0, Math.min(1, x)) * CYL.stroke + CYL.plate, y: n.y + CYL.rodY }];
    if (!n.rot) return local;
    const cx = n.x + CYL.w / 2, cy = n.y + CYL.h / 2, a = (n.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    return local.map((p) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos }));
  }

  /** The area of a limit switch that a rod can press (its roller side, on the board). */
  function limitZone(n) {
    const d = KINDS.LIMIT, fy = n.y + d.h / 2;
    // a small field right in front of the sensing face (about 2 rod widths high), not the whole module
    const pts = [[n.x - 10, fy - 12], [n.x + 16, fy - 12], [n.x - 10, fy + 12], [n.x + 16, fy + 12]];
    const cx = n.x + d.w / 2, cy = n.y + d.h / 2, a = ((n.rot || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const r = pts.map(([x, y]) => ({ x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos }));
    return { r, inside: (p) => {
      // point in the rotated rectangle r[0] r[1] r[3] r[2]
      const ux = r[1].x - r[0].x, uy = r[1].y - r[0].y, vx = r[2].x - r[0].x, vy = r[2].y - r[0].y;
      const px = p.x - r[0].x, py = p.y - r[0].y;
      const s = (px * ux + py * uy) / (ux * ux + uy * uy), t = (px * vx + py * vy) / (vx * vx + vy * vy);
      return s >= 0 && s <= 1 && t >= 0 && t <= 1;
    } };
  }

  function limitHit(node, sim) {
    const zone = limitZone(node);
    for (const h of hooks) if (h.zoneHit && h.zoneHit(zone, sim, node)) return true;
    for (const [id, n] of sim.nodes) {
      if (n.kind !== 'CYLINDER' && n.kind !== 'CYL_DA') continue;
      const st = sim.state.get(id);
      const [a, b] = rodSegment(n, st ? st.x : 0);
      for (let t = 0; t <= 1.0001; t += 0.04) if (zone.inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return true;
    }
    return false;
  }


  /** Flip-flop update shared by D/T/JK: Reset and Set act immediately (Reset wins). */
  const ff = (onClock) => ({
    init: () => ({ q: false }),
    update(st, ins, prev, node, sim, k) {
      const set = truthy(ins[k.set]), reset = truthy(ins[k.reset]);
      if (reset) st.q = false;
      else if (set) st.q = true;
      else if (rising(ins[k.clock], prev[k.clock])) st.q = onClock(st.q, ins);
    },
    out: (st) => [st.q, !st.q],
    show: (st) => ({ q: st.q }),
  });

  const gate = (title, ins, f) => ({ cat: 'gate', title, w: 76, h: 48, ins: Array.from({ length: ins }, () => ({ n: '' })), outs: [B('')], comb: (a) => [f(a.map(truthy))] });
  const fn = (title, ins, outs, f, bool) => ({ cat: 'func', title, w: 158, ins: ins.map((n) => ({ n })), outs: outs.map((n) => ({ n, bool })), comb: (a) => f(a.map(num)) });

  const KINDS = {
    // Logic gates
    AND: gate('AND', 2, (a) => a[0] && a[1]),
    OR: gate('OR', 2, (a) => a[0] || a[1]),
    XOR: gate('XOR', 2, (a) => a[0] !== a[1]),
    NAND: gate('NAND', 2, (a) => !(a[0] && a[1])),
    NOR: gate('NOR', 2, (a) => !(a[0] || a[1])),
    XNOR: gate('XNOR', 2, (a) => a[0] === a[1]),
    NOT: gate('NOT', 1, (a) => !a[0]),
    BUF: gate('BUF', 1, (a) => a[0]),
    AND3: gate('AND', 3, (a) => a[0] && a[1] && a[2]),
    OR3: gate('OR', 3, (a) => a[0] || a[1] || a[2]),

    // Math & compare
    CLAMP: fn('Clamp', ['Value', 'Min', 'Max'], ['Result'], (a) => [Math.min(Math.max(a[0], a[1]), a[2])]),
    ADD: fn('Add', ['A', 'B'], ['A + B'], (a) => [a[0] + a[1]]),
    SUB: fn('Subtract', ['A', 'B'], ['A − B'], (a) => [a[0] - a[1]]),
    MUL: fn('Multiply', ['A', 'B'], ['A × B'], (a) => [a[0] * a[1]]),
    DIV: fn('Divide', ['A', 'B'], ['A ÷ B'], (a) => [a[1] === 0 ? 0 : a[0] / a[1]]),
    MOD: fn('Modulo', ['A', 'B'], ['A mod B'], (a) => [a[1] === 0 ? 0 : ((a[0] % a[1]) + a[1]) % a[1]]),
    MIN: fn('Min', ['A', 'B'], ['Min'], (a) => [Math.min(a[0], a[1])]),
    MAX: fn('Max', ['A', 'B'], ['Max'], (a) => [Math.max(a[0], a[1])]),
    ABS: fn('Abs', ['Value'], ['|Value|'], (a) => [Math.abs(a[0])]),
    LERP: fn('Lerp', ['A', 'B', 'Alpha'], ['Result'], (a) => [a[0] + (a[1] - a[0]) * a[2]]),
    SELECT: { ...fn('Select', ['Condition', 'If true', 'If false'], ['Result'], () => []), comb: (a) => [truthy(a[0]) ? num(a[1]) : num(a[2])] },
    GT: fn('Greater', ['A', 'B'], ['A > B'], (a) => [a[0] > a[1]], true),
    LT: fn('Less', ['A', 'B'], ['A < B'], (a) => [a[0] < a[1]], true),
    EQ: fn('Equal', ['A', 'B'], ['A = B'], (a) => [a[0] === a[1]], true),

    // Memory
    DFF: {
      cat: 'mem', title: 'D Flip-Flop', w: 150, ins: [{ n: 'D' }, { n: 'Clock', clk: true }, SET, RESET], outs: QQ,
      help: 'On each Clock pulse, Q copies D. Set/Reset force Q on/off.',
      seq: ff((q, ins) => truthy(ins[0])), k: { clock: 1, set: 2, reset: 3 },
    },
    TFF: {
      cat: 'mem', title: 'T Flip-Flop', w: 150, ins: [{ n: 'T', dflt: true }, { n: 'Clock', clk: true }, SET, RESET], outs: QQ,
      help: 'On each Clock pulse, Q flips while T is on (T is on when not wired). Set/Reset force Q on/off.',
      seq: ff((q, ins) => (truthy(ins[0]) ? !q : q)), k: { clock: 1, set: 2, reset: 3 },
    },
    JKFF: {
      cat: 'mem', title: 'JK Flip-Flop', w: 150, ins: [{ n: 'J' }, { n: 'K' }, { n: 'Clock', clk: true }, SET, RESET], outs: QQ,
      help: 'On each Clock pulse: J turns Q on, K turns it off, both flip it.',
      seq: ff((q, ins) => { const j = truthy(ins[0]), k = truthy(ins[1]); return j && k ? !q : j ? true : k ? false : q; }),
      k: { clock: 2, set: 3, reset: 4 },
    },
    SR: {
      cat: 'mem', title: 'SR Latch', w: 150, ins: [{ n: 'Set' }, { n: 'Reset' }], outs: QQ,
      help: 'Set turns Q on and it stays on; Reset turns it off.',
      seq: {
        init: () => ({ q: false }),
        update(st, ins) { const s = truthy(ins[0]), r = truthy(ins[1]); if (r) st.q = false; else if (s) st.q = true; },
        out: (st) => [st.q, !st.q], show: (st) => ({ q: st.q }),
      },
    },
    DLATCH: {
      cat: 'mem', title: 'D Latch', w: 150, ins: [{ n: 'D' }, { n: 'Enable' }], outs: QQ,
      help: 'While Enable is on, Q follows D; otherwise Q holds.',
      seq: {
        init: () => ({ q: false }),
        update(st, ins) { if (truthy(ins[1])) st.q = truthy(ins[0]); },
        out: (st) => [st.q, !st.q], show: (st) => ({ q: st.q }),
      },
    },
    COUNTER: {
      cat: 'mem', title: 'Counter', w: 150, ins: [{ n: 'Count', clk: true }, { n: 'Down' }, RESET], outs: [{ n: 'Value' }, B('At max')],
      help: 'Counts up (or down while Down is on) on each pulse; wraps around. Click the gear to set the max.',
      value: 9,
      seq: {
        init: () => ({ count: 0 }),
        update(st, ins, prev, node) {
          const max = Math.max(1, Math.round(Number(node.value) || 9));
          if (truthy(ins[2])) st.count = 0;
          else if (rising(ins[0], prev[0])) st.count = truthy(ins[1]) ? (st.count <= 0 ? max : st.count - 1) : st.count >= max ? 0 : st.count + 1;
        },
        out: (st, node) => [st.count, st.count >= Math.max(1, Math.round(Number(node.value) || 9))],
        show: (st) => ({ count: st.count }),
      },
    },

    // Timing
    CLOCK: {
      cat: 'in', title: 'Clock', w: 96, h: 50, ins: [], outs: [B('Tick')], value: 1,
      help: 'Turns on and off by itself. Click the gear to set the period (seconds, 0.1 or more).',
      // Exact period in ticks; the on-part may be one tick shorter than the off-part.
      src: (node, sim) => { const n = ticksOf(node.value, 2); return [sim.tick % n >= Math.ceil(n / 2)]; },
    },
    DELAY: {
      cat: 'time', title: 'Delay', w: 110, h: 50, ins: [{ n: 'In' }], outs: [B('Out')], value: 0.2,
      help: 'Passes the signal on after a delay (like a repeater). Click the gear to set seconds.',
      seq: {
        init: () => ({ buf: [] }),
        update(st, ins, prev, node) { const n = ticksOf(node.value); st.buf.push(truthy(ins[0])); while (st.buf.length > n) st.buf.shift(); st.out = st.buf.length >= n ? st.buf[0] : false; },
        out: (st) => [!!st.out],
      },
    },
    PULSE: {
      cat: 'time', title: 'Pulse', w: 110, h: 50, ins: [{ n: 'In' }], outs: [B('Out')], value: 0.5,
      help: 'When In turns on, Out stays on for a set time. Click the gear to set seconds.',
      seq: {
        init: () => ({ until: -1 }),
        update(st, ins, prev, node, sim) { if (rising(ins[0], prev[0])) st.until = sim.tick + ticksOf(node.value); },
        out: (st, node, sim) => [sim.tick < st.until],
      },
    },

    // Inputs
    BUTTON: {
      cat: 'in', title: 'Button', w: 92, h: 70, ins: [], outs: [{ n: 'Out', bool: true, t: 'Button contact (on/off)' }],
      help: 'Momentary: on while you hold it. Latching: each press switches it on or off. NC (normally closed) inverts the contact. Click the gear to change.',
      src: (node, sim) => {
        const pressed = node.latch ? !!node.value : !!node.value || sim.tick - (sim.pressed.get(node.id) ?? -99) <= 1;
        return [node.nc ? !pressed : pressed];
      },
    },
    LIMIT: {
      cat: 'in', bare: true, title: 'Limit Sensor', w: 96, h: 96, ins: [],
      outs: [{ n: 'NO', bool: true, t: 'Normally open: on while something is in front of the sensor' }, { n: 'NC', bool: true, t: 'Normally closed: off while something is in front of the sensor' }],
      help: 'Proximity sensor (no lever): it switches when a cylinder rod comes in front of its orange sensing face. You can also hold the face with the mouse to test it.',
      src: (node, sim) => { const hit = limitHit(node, sim) || !!node.value || sim.tick - (sim.pressed.get(node.id) ?? -99) <= 1; return [hit, !hit]; },
    },
    LEVER: { cat: 'in', title: 'Lever', w: 92, h: 62, ins: [], outs: [B('Out')], help: 'Click to flip on/off.', src: (node) => [!!node.value] },
    SWITCH: { cat: 'in', title: 'Switch', w: 92, h: 48, ins: [], outs: [B('Out')], help: 'Click to flip on/off.', src: (node) => [!!node.value] },
    POT: {
      cat: 'in', title: 'Speed Knob', w: 124, h: 106, ins: [], value: 5,
      outs: [{ n: 'Value', t: 'Knob position as a number (min … max). Wire it to a Motor for its speed, or to a Flow Control Set input.' }],
      help: 'Electrical speed knob (potentiometer). Turn it by dragging around it or with the mouse wheel; it outputs a number between min and max (0–10 by default, 0 = off). Wire it to a Motor to set its speed. Click the gear for the range.',
      src: (node) => [potValue(node)],
    },
    NUMBER: { cat: 'in', title: 'Number', w: 104, h: 48, ins: [], outs: [{ n: 'Value' }], value: 0, help: 'Click the gear to type a number.', src: (node) => [Number(node.value) || 0] },

    // Outputs
    LAMP: { cat: 'out', title: 'Lamp', w: 64, h: 66, ins: [{ n: 'In' }], outs: [] },
    DISPLAY: { cat: 'out', bare: true, title: 'Display', w: 210, h: 70, ins: [{ n: 'In', t: 'On = show the text (letter by letter). With no text set, the number here is shown.' }], outs: [], help: 'Green digital display. Click the gear to type a text; it appears letter by letter when the input turns on and disappears when it turns off.' },
    SEG7: { cat: 'out', title: '7-Segment', w: 76, h: 104, ins: [{ n: 'Value' }], outs: [], help: 'Shows 0–9 and A–F.' },
    MOTOR: { cat: 'out', bare: true, title: 'Electric Motor', w: 190, h: 110, ins: [{ n: 'Power', t: 'On = run. A number sets the speed (up to 10); negative runs backwards.' }], outs: [], help: 'Spins while powered; a bigger number spins faster, a negative one reverses it.' },
    BUZZER: { cat: 'out', title: 'Buzzer', w: 116, h: 64, ins: [{ n: 'In' }], outs: [], value: 440, help: 'Beeps while on. Click the gear to set the pitch (Hz).' },
    DRUMKIT: {
      cat: 'out', title: 'Drum Kit', w: 118, h: 136, ins: [{ n: 'Kick' }, { n: 'Snare' }, { n: 'Hi-Hat' }, { n: 'Clap' }, { n: 'Cowbell' }], outs: [],
      help: 'Each input plays its drum when it turns on (Kick, Snare, Hi-Hat, Clap, phonk Cowbell).',
      seq: {
        init: () => ({ plays: [0, 0, 0, 0, 0] }),
        update(st, ins, prev) { ins.forEach((v, i) => { if (rising(v, prev[i])) st.plays[i]++; }); },
        out: () => [], show: (st) => ({ plays: st.plays.slice() }),
      },
    },
    NOTE: {
      cat: 'out', title: 'Note Block', w: 104, h: 70, ins: [{ n: 'Play' }], outs: [], value: 12,
      help: 'Plays a note each time Play turns on. Click the gear to pick the instrument (piano, square, phonk bell, 808…) and note.',
      seq: { init: () => ({ plays: 0 }), update(st, ins, prev) { if (rising(ins[0], prev[0])) st.plays++; }, out: () => [], show: (st) => ({ plays: st.plays }) },
    },

    // Fluid power (ISO 1219 style). Pressure in bar flows through hydraulic hoses (orange oil);
    // a port that is vented or blocked carries 0 bar.
    PUMP: {
      cat: 'hyd', bare: true, title: 'Pump', w: 150, h: 104, value: 100,
      ins: [{ n: 'Power', dflt: true, t: 'Motor on/off (runs when not wired)' }],
      outs: [HYD('P', 'Pressure supply (bar)')],
      help: 'Pressure supply. Builds pressure while powered (about half a second) and loses it when off. Runs on its own when Power is not wired. Click the gear to set the pressure.',
      seq: {
        init: () => ({ p: 0 }),
        update(st, ins, prev, node) {
          const max = Math.max(1, Math.min(1000, Number(node.value) || 100));
          const target = truthy(ins[0]) ? max : 0;
          const step = max / 10;
          st.p = st.p < target ? Math.min(target, st.p + step) : Math.max(target, st.p - step * 1.5);
        },
        out: (st) => [Math.round(st.p)],
        show: (st) => ({ p: st.p }),
      },
    },
    VALVE: valve('VALVE', '2/2 Valve', [HYD_IN('P', 'Pressure supply'), PILOT('Open', 'left', 'Opens the valve (P → A) while on')], [HYD('A', 'Working port')],
      'Shut-off valve: P → A while Open is on, blocked otherwise (spring return).'),
    VALVE_3_2: valve('VALVE_3_2', '3/2 Valve', [HYD_IN('P', 'Pressure supply'), PILOT('14', 'left', 'Actuate (moves to the left box)'), PILOT('12', 'right', 'Return (moves to the right box)')], [HYD('A', 'Working port')],
      '3 ports, 2 positions. NC: A is vented to R until 14 is on, then P → A. NO is the other way round. Spring return, or bistable (14 / 12 switch it and it stays).'),
    VALVE_5_2: valve('VALVE_5_2', '5/2 Valve', [HYD_IN('P', 'Pressure supply'), PILOT('14', 'left', 'Switch to P → A, B → S'), PILOT('12', 'right', 'Switch to P → B, A → R')], [HYD('A', 'Working port A (e.g. cylinder extend)'), HYD('B', 'Working port B (e.g. cylinder retract)')],
      '5 ports, 2 positions, for double-acting cylinders. 14: P → A and B vented. 12 or spring: P → B and A vented. Bistable: stays in the last position.'),
    VALVE_4_3: valve('VALVE_4_3', '4/3 Valve', [HYD_IN('P', 'Pressure supply'), PILOT('14', 'left', 'P → A, B → T (a negative number here means P → B)'), PILOT('12', 'right', 'P → B, A → T')], [HYD('A', 'Working port A'), HYD('B', 'Working port B')],
      '4 ports, 3 positions, spring centered. 14: P → A, 12: P → B, neither: center (closed, float or tandem). A number on 14 also works: +1 = A, −1 = B, 0 = center.'),
    CYLINDER: cylinder(false),
    CYL_DA: cylinder(true),
    FLOW: {
      cat: 'hyd', bare: true, title: 'Flow Control', w: 124, h: 122, value: 50,
      ins: [HYD_IN('In', 'Oil / air in'), { n: 'Set', at: 'top', dflt: -1, t: 'Optional: opening in % from a signal (0–100). Overrides the knob.' }],
      outs: [HYD('Out', 'Oil / air out (throttled)')],
      help: 'Speed adjuster (throttle). Put it between a valve and a cylinder: the opening sets how fast the cylinder moves (100 % = full speed, 0 % = closed). Turn the knob: drag it up/down or use the mouse wheel on it. A number on Set overrides the knob.',
      comb: (a, node) => [flowOpening(node, a) > 0 ? Math.max(0, num(a[0])) : 0],
    },
    FLOW_1W: {
      cat: 'hyd', bare: true, title: 'Throttle Check Valve', w: 150, h: 150, value: 50,
      ins: [HYD_IN('In', 'From the valve / pump')], outs: [HYD('Out', 'Throttled pressure (builds up slowly)')],
      help: 'Throttle check valve: in the throttled direction the pressure behind it builds up slowly (like filling through a small hole); the knob sets how fast (100 % = quick, 10 % = several seconds, 0 % = closed). The other direction is free through the check valve, so the pressure follows at once. Meter-in (default): pressure rises slowly and drops at once. Meter-out: rises at once and drops slowly. It also slows a cylinder in its throttled direction.',
      seq: {
        init: () => ({ p: 0 }),
        update(st, ins, prev, node) {
          const pin = Math.max(0, num(ins[0]));
          const k = throttleRate(flowOpening(node, null));
          const slowUp = node.mode !== 'out'; // meter-in: slow rise; meter-out: slow fall
          if (pin > st.p) st.p = slowUp ? st.p + (pin - st.p) * k : pin;
          else if (pin < st.p) st.p = slowUp ? pin : st.p + (pin - st.p) * k;
          if (k > 0 && Math.abs(pin - st.p) < 0.05) st.p = pin; // settled
        },
        out: (st) => [Math.round(st.p * 10) / 10],
        show: (st) => ({ p: st.p }),
      },
    },
    STEEL: {
      cat: 'phys', bare: true, resizable: true, title: 'Steel Block', w: 80, h: 80, ins: [], outs: [],
      help: 'A solid block a cylinder rod can push. Resize it with its corner handles. Gear: a rotation point (then it turns like a lever), or fix it in place.',
      seq: {
        init: () => ({ dx: 0, dy: 0, da: 0, lastMove: 0 }),
        sig: (n) => [n.x, n.y, n.rot || 0, n.bw, n.bh, n.pivot, n.pivX, n.pivY, n.fixed, n.resetAt].join('|'),
        update() { /* moved by cylinder rods (see pushByRod) */ },
        out: () => [],
        show: (st) => ({ dx: st.dx, dy: st.dy, da: st.da }),
      },
    },
    BEDROCK: {
      cat: 'phys', bare: true, resizable: true, title: 'Bedrock', w: 80, h: 80, ins: [], outs: [],
      help: 'A block that never moves. Rods and steel blocks stop against it.',
      comb: () => [],
    },
    GAUGE: {
      cat: 'hyd', bare: true, title: 'Pressure Gauge', w: 150, h: 150, value: 50,
      ins: [{ ...HYD_IN('P', 'Pressure to measure'), at: 'bottom', f: 68 / 150 }], outs: [{ n: 'Over', bool: true, t: 'On at or above the set pressure' }],
      help: 'Shows the pressure. Over turns on at or above the set pressure. Click the gear to set it (bar).',
      comb: (a, node) => [num(a[0]) >= (Number(node.value) || 0) && num(a[0]) > 0],
    },
  };

  function def(kind) {
    const k = KINDS[kind];
    if (!k) return null;
    const left = k.ins.filter((p) => !p.at || p.at === 'left').length;
    const right = k.outs.filter((p) => !p.at || p.at === 'right').length;
    const rows = Math.max(left, right);
    const h = k.h ?? 30 + rows * 22 + 8;
    return { kind, ...k, h, bool: k.outs.every((o) => o.bool) };
  }

  /** Which side of the module a pin sits on (inputs default to the left, outputs to the right). */
  const sideOf = (pin, side) => pin.at || (side === 'out' ? 'right' : 'left');

  /** Pin position + outward direction, on the board (rotated with the node unless raw). */
  function pinPos(n, side, i, raw) {
    const d = def(n.kind);
    if (!d) return { x: n.x, y: n.y, dx: 1, dy: 0 };
    const sz = sizeOf(n); // resized parts keep their pins on their edges
    let p;
    // Modules with a title bar keep their side pins below it (gates and fluid symbols have none).
    const top = d.cat === 'gate' || d.bare ? 0 : 24;
    const spread = (j, count) => top + ((sz.h - top) * (j + 1)) / (count + 1);
    const list = side === 'out' ? d.outs : d.ins;
    const pin = list[i] || {};
    const at = sideOf(pin, side);
    if (at === 'top' || at === 'bottom') {
      let x;
      if (pin.f !== undefined) x = sz.w * pin.f;
      else {
        const same = [...d.ins.filter((q) => q.at === at), ...d.outs.filter((q) => q.at === at)];
        x = (sz.w * (same.indexOf(pin) + 1)) / (same.length + 1);
      }
      p = { x: n.x + x, y: at === 'top' ? n.y : n.y + sz.h, dx: 0, dy: at === 'top' ? -1 : 1 };
    } else {
      const same = list.filter((q) => sideOf(q, side) === at);
      const j = same.indexOf(pin);
      const rowsLayout = (d.cat === 'func' || d.cat === 'mem') && at === (side === 'out' ? 'right' : 'left');
      const y = rowsLayout ? 30 + j * 22 + 11 : spread(j, same.length);
      p = at === 'left' ? { x: n.x, y: n.y + y, dx: -1, dy: 0 } : { x: n.x + sz.w, y: n.y + y, dx: 1, dy: 0 };
    }
    const P = !raw && poseProvider ? poseProvider(n) : null;
    if (P) { // part moved by physics: rotate around its center to where it is now
      const sz = sizeOf(n), cx0 = n.x + sz.w / 2, cy0 = n.y + sz.h / 2, ca = Math.cos(P.a), sa = Math.sin(P.a);
      return { x: P.x + (p.x - cx0) * ca - (p.y - cy0) * sa, y: P.y + (p.x - cx0) * sa + (p.y - cy0) * ca, dx: p.dx * ca - p.dy * sa, dy: p.dx * sa + p.dy * ca };
    }
    if (raw || !n.rot) return p;
    const cx = n.x + sz.w / 2, cy = n.y + sz.h / 2, a = (n.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    return {
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
      dx: p.dx * cos - p.dy * sin, dy: p.dx * sin + p.dy * cos,
    };
  }

  // ------------------------------------------------------------------ simulator
  class Sim {
    constructor() {
      this.tick = 0;
      this.nodes = new Map();
      this.feeds = new Map();
      this.state = new Map();
      this.prev = new Map();
      this.feedKey = new Map();
      this.values = new Map();
      this.inputs = new Map();
      this.pressed = new Map();
    }

    /** Remember a button press so even a very short click lasts at least one tick. */
    press(id) { this.pressed.set(id, this.tick); }

    /** (Re)loads the board: nodes, wires, values. Keeps memory of nodes that still exist. */
    load(shapes) {
      this.meta = shapes.find((s) => s && s.type === 'meta') || null; // board settings (host only)
      this.nodes = new Map();
      for (const s of shapes) if (s && s.type === 'node' && KINDS[s.kind]) this.nodes.set(s.id, s);
      this.feeds = new Map();
      for (const s of shapes) {
        if (s && s.type === 'wire' && this.nodes.has(s.a.n) && this.nodes.has(s.b.n)) this.feeds.set(s.b.n + ':' + s.b.p, { n: s.a.n, p: s.a.p, id: s.id });
      }

      for (const m of [this.state, this.prev, this.values, this.inputs, this.feedKey]) for (const id of [...m.keys()]) if (!this.nodes.has(id)) m.delete(id);
      for (const [id, n] of this.nodes) {
        const k = KINDS[n.kind];
        if (k.seq && (!this.state.has(id) || this.state.get(id).__kind !== n.kind)) this.state.set(id, { ...k.seq.init(n), __kind: n.kind });
        if (k.seq && n.resetAt && this.state.get(id).__reset !== n.resetAt) Object.assign(this.state.get(id), k.seq.init(n), { __reset: n.resetAt, __kind: n.kind }); // Reset button
        if (k.seq && k.seq.sig) { const st = this.state.get(id), sig = k.seq.sig(n); if (st.__sig !== sig) Object.assign(st, k.seq.init(n), { __sig: sig, __kind: n.kind }); }
      }
      for (const h of hooks) if (h.load) h.load(this);
      this.settle();
      // Connecting or removing a wire is not a signal edge.
      for (const [id, n] of this.nodes) {
        const k = KINDS[n.kind];
        if (!k.seq) continue;
        const key = k.ins.map((_, i) => (this.feeds.get(id + ':' + i) || {}).id || '').join('|');
        if (this.feedKey.get(id) !== key) {
          this.feedKey.set(id, key);
          this.prev.set(id, (this.inputs.get(id) || []).slice());
        }
      }
    }

    /** Advances one tick. */
    step() {
      this.tick++;

      for (const [id, n] of this.nodes) {
        const k = KINDS[n.kind];
        if (!k.seq) continue;
        const ins = this.inputs.get(id) || [];
        const prev = this.prev.get(id) || ins;
        k.seq.update(this.state.get(id), ins, prev, n, this, k.k);
        this.prev.set(id, ins.slice());
      }
      for (const h of hooks) if (h.step) h.step(this);
      this.settle();
    }

    settle() {
      const ids = [...this.nodes.keys()];
      for (let pass = 0; pass < Math.min(64, ids.length + 4); pass++) {
        let changed = false;
        for (const id of ids) {
          const n = this.nodes.get(id), k = KINDS[n.kind];
          const ins = k.ins.map((pin, i) => {
            const f = this.feeds.get(id + ':' + i);
            if (!f) return pin.dflt ?? false;
            const src = this.values.get(f.n);
            return src ? src[f.p] ?? false : false;
          });
          this.inputs.set(id, ins);
          const out = k.seq ? k.seq.out(this.state.get(id), n, this) : k.src ? k.src(n, this) : k.comb ? k.comb(ins, n, this) : [];
          const norm = out.map((v, i) => (k.outs[i] && k.outs[i].bool ? !!v : num(v)));
          const before = this.values.get(id);
          if (!before || norm.length !== before.length || norm.some((v, i) => v !== before[i])) changed = true;
          this.values.set(id, norm);
        }
        if (!changed) break;
      }
    }

    /** Pushed blocks that came to rest (the host writes their new place into the board). */
    settledBlocks() { const out = []; for (const h of hooks) if (h.settled) out.push(...h.settled(this)); return out; }

    /** What the whiteboards need to draw: outputs, inputs and visible memory, per node. */
    snapshot() {
      const v = {}, i = {}, s = {};
      for (const [id, n] of this.nodes) {
        v[id] = this.values.get(id) || [];
        i[id] = this.inputs.get(id) || [];
        const k = KINDS[n.kind];
        if (k.seq && k.seq.show) s[id] = k.seq.show(this.state.get(id));
      }
      const snap = { tick: this.tick, v, i, s };
      for (const h of hooks) if (h.snapshot) h.snapshot(this, snap);
      return snap;
    }
  }

  // ------------------------------------------------------------------ notes
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  /** Note number 0 = C4 … 24 = C6. */
  const noteName = (v) => { const n = Math.round(Number(v) || 0); return NOTE_NAMES[((n % 12) + 12) % 12] + (4 + Math.floor(n / 12)); };
  const noteHz = (v) => 261.63 * Math.pow(2, (Math.round(Number(v) || 0)) / 12);
  function parseNote(text) {
    const m = /^\s*([A-Ga-g])(#|b)?\s*(-?\d)?\s*$/.exec(text);
    if (!m) { const n = Number(text); return Number.isFinite(n) ? Math.round(n) : null; }
    let i = NOTE_NAMES.indexOf(m[1].toUpperCase());
    if (m[2] === '#') i++;
    if (m[2] === 'b') i--;
    return i + 12 * ((m[3] !== undefined ? Number(m[3]) : 4) - 4);
  }

  const api = { KINDS, TICK_MS, def, pinPos, Sim, truthy, num, ticksOf, noteName, noteHz, parseNote, VLAYOUT, VALVE_H, BOX_Y1, BOX_Y2, valveBoxes, CYL, rodSegment, limitZone, flowOpening, potRange, potValue, sizeOf, blockGeom, settledBlocks,
    hooks, addHook: (h) => hooks.push(h), setPoseProvider: (f) => { poseProvider = f; }, getPoseProvider: () => poseProvider, B, HYD, HYD_IN, PILOT, rising };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollabCircuit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

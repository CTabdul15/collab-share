// Drawings for the Sandbox's extra parts (browser only). Each draws a part in its own coordinates
// (n.x, n.y, size from CC.sizeOf); the Sandbox moves/rotates it to where the physics put it.
(function (root) {
  'use strict';
  root.CollabPartsDraw = function (H) {
    const { tag, roundRect, ON, LINE, DIM, HYD_ON, FONT, truthy, num, pinPos, shade, fmt } = H;
    const CC = root.CollabCircuit;
    const sz = (n) => CC.sizeOf(n);
    const now = () => performance.now();
    const tint = (n, def) => (n.color && n.color !== '#ffffff' ? n.color : def);
    const metal = (c, x, y, w, h, base) => {
      const g = c.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, shade(base, 0.45)); g.addColorStop(0.5, base); g.addColorStop(1, shade(base, -0.45));
      return g;
    };
    const bolt = (c, x, y, r = 3) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = '#3d4650'; c.fill(); c.beginPath(); c.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, Math.PI * 2); c.fillStyle = '#e6eaee'; c.fill(); };
    const pcb = (c, x, y, w, h, r = 6) => { // green circuit-board panel
      const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, '#11663f'); g.addColorStop(1, '#0a3d26');
      roundRect(c, x, y, w, h, r); c.fillStyle = g; c.fill(); c.strokeStyle = '#d4af37'; c.lineWidth = 1.2; c.stroke();
      c.save(); roundRect(c, x, y, w, h, r); c.clip(); c.strokeStyle = 'rgba(160,230,180,.12)'; c.lineWidth = 1;
      for (let k = 0; k < 4; k++) { c.beginPath(); c.moveTo(x + 6, y + h * (0.25 + k * 0.18)); c.lineTo(x + w * 0.4, y + h * (0.25 + k * 0.18)); c.lineTo(x + w * 0.5, y + h * (0.15 + k * 0.18)); c.stroke(); }
      c.restore();
    };
    const label = (c, n, text, y) => tag(c, text, n.x + 4, y ?? n.y + 7, 'left', 'rgba(255,255,255,.55)', 8);
    const lamp = (c, x, y, r, color, on, amount = 1) => {
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
      if (on) { c.save(); c.shadowColor = color; c.shadowBlur = 14 * amount; c.globalAlpha = 0.35 + 0.65 * amount; c.fillStyle = color; c.fill(); c.restore(); }
      else { c.fillStyle = shade(color, -0.7); c.fill(); }
      c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1; c.stroke();
      c.beginPath(); c.arc(x - r * 0.3, y - r * 0.35, r * 0.3, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,.35)'; c.fill();
    };
    const pinLabel = (c, n, side, i, text) => { const q = pinPos(n, side, i, true); tag(c, text, q.x + (side === 'in' ? 7 : -7), q.y, side === 'in' ? 'left' : 'right', 'rgba(255,255,255,.8)', 9); };
    const scopes = new Map();

    const D = {
      // ---------------------------------------------------------------- mechanics
      STEEL(c, n) {
        const s = sz(n), x = n.x, y = n.y, base = tint(n, '#9aa6b2');
        c.fillStyle = metal(c, x, y, s.w, s.h, base); c.fillRect(x, y, s.w, s.h);
        c.save(); c.beginPath(); c.rect(x, y, s.w, s.h); c.clip(); c.strokeStyle = 'rgba(255,255,255,.1)'; c.lineWidth = 1;
        for (let k = -s.h; k < s.w; k += 5) { c.beginPath(); c.moveTo(x + k, y); c.lineTo(x + k + s.h, y + s.h); c.stroke(); }
        c.restore();
        c.strokeStyle = shade(base, -0.6); c.lineWidth = 2; c.strokeRect(x + 1, y + 1, s.w - 2, s.h - 2);
        if (s.w > 26 && s.h > 26) { bolt(c, x + 7, y + 7); bolt(c, x + s.w - 7, y + 7); bolt(c, x + 7, y + s.h - 7); bolt(c, x + s.w - 7, y + s.h - 7); }
        if (n.fixed) { c.strokeStyle = 'rgba(239,68,68,.85)'; c.setLineDash([5, 4]); c.strokeRect(x + 4, y + 4, s.w - 8, s.h - 8); c.setLineDash([]); }
        if (n.pivot) {
          const e = (v) => Math.min(10, v / 2);
          const P = { center: [s.w / 2, s.h / 2], left: [e(s.w), s.h / 2], right: [s.w - e(s.w), s.h / 2], top: [s.w / 2, e(s.h)], bottom: [s.w / 2, s.h - e(s.h)], custom: [(s.w * (Number(n.pivX) || 0)) / 100, (s.h * (Number(n.pivY) || 0)) / 100] }[n.pivot];
          if (P) { c.beginPath(); c.arc(x + P[0], y + P[1], 6, 0, Math.PI * 2); c.fillStyle = '#1d2329'; c.fill(); c.strokeStyle = '#facc15'; c.lineWidth = 2; c.stroke(); }
        }
      },
      COUNTERWEIGHT(c, n) {
        const s = sz(n), x = n.x, y = n.y, base = tint(n, '#4b5563');
        c.fillStyle = metal(c, x, y, s.w, s.h, base); roundRect(c, x, y, s.w, s.h, 4); c.fill(); c.strokeStyle = '#111827'; c.lineWidth = 2; c.stroke();
        const kg = Math.round((s.w * s.h * 11.3) / 1000);
        c.fillStyle = 'rgba(255,255,255,.85)'; c.font = '700 ' + Math.max(9, Math.min(18, s.h / 3)) + 'px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(kg + ' kg', x + s.w / 2, y + s.h / 2);
        c.beginPath(); c.arc(x + s.w / 2, y + 6, 4, Math.PI, 0); c.strokeStyle = '#9ca3af'; c.lineWidth = 2; c.stroke();
      },
      BEAM(c, n) {
        const s = sz(n), x = n.x, y = n.y, base = tint(n, '#b8c2cc');
        c.fillStyle = metal(c, x, y, s.w, s.h, base); roundRect(c, x, y, s.w, s.h, 3); c.fill();
        c.strokeStyle = shade(base, -0.55); c.lineWidth = 1.5; c.stroke();
        c.fillStyle = shade(base, -0.5);
        const r = Math.min(3.2, s.h / 4);
        for (let k = x + 12; k < x + s.w - 6; k += 16) { c.beginPath(); c.arc(k, y + s.h / 2, r, 0, Math.PI * 2); c.fill(); }
        c.strokeStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.moveTo(x + 2, y + 2); c.lineTo(x + s.w - 2, y + 2); c.stroke();
      },
      BALL(c, n) {
        const s = sz(n), r = Math.min(s.w, s.h) / 2, cx = n.x + s.w / 2, cy = n.y + s.h / 2, base = tint(n, '#e5e7eb');
        const g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
        g.addColorStop(0, shade(base, 0.5)); g.addColorStop(0.7, base); g.addColorStop(1, shade(base, -0.5));
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = g; c.fill();
        c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
        c.strokeStyle = 'rgba(30,41,59,.55)'; c.lineWidth = Math.max(1, r / 14); // panel seams (turn with the ball)
        const hex = (hx, hy, hr) => { c.beginPath(); for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; c.lineTo(hx + Math.cos(a) * hr, hy + Math.sin(a) * hr); } c.closePath(); c.stroke(); };
        hex(cx, cy, r * 0.38);
        for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; hex(cx + Math.cos(a) * r * 0.78, cy + Math.sin(a) * r * 0.78, r * 0.38); }
        c.restore();
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1.2; c.stroke();
      },
      WHEEL(c, n, d, ins) {
        const s = sz(n), r = Math.min(s.w, s.h) / 2, cx = n.x + s.w / 2, cy = n.y + s.h / 2;
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = '#16181b'; c.fill();
        c.strokeStyle = '#2b2f35'; c.lineWidth = 2;
        for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; c.beginPath(); c.moveTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86); c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.stroke(); }
        const rimR = r * 0.62, base = tint(n, '#c3ccd5');
        const g = c.createRadialGradient(cx - rimR * 0.3, cy - rimR * 0.3, 1, cx, cy, rimR); g.addColorStop(0, shade(base, 0.4)); g.addColorStop(1, shade(base, -0.35));
        c.beginPath(); c.arc(cx, cy, rimR, 0, Math.PI * 2); c.fillStyle = g; c.fill();
        c.strokeStyle = shade(base, -0.55); c.lineWidth = Math.max(2, r / 9);
        for (let k = 0; k < 5; k++) { const a = (k / 5) * Math.PI * 2; c.beginPath(); c.moveTo(cx + Math.cos(a) * rimR * 0.3, cy + Math.sin(a) * rimR * 0.3); c.lineTo(cx + Math.cos(a) * rimR * 0.92, cy + Math.sin(a) * rimR * 0.92); c.stroke(); }
        c.beginPath(); c.arc(cx, cy, rimR * 0.3, 0, Math.PI * 2); c.fillStyle = '#374151'; c.fill();
        const on = ins && ins[0] !== undefined && num(ins[0]) !== 0;
        c.beginPath(); c.arc(cx, cy, rimR * 0.14, 0, Math.PI * 2); c.fillStyle = on ? ON : '#9ca3af'; c.fill();
      },
      RAMP(c, n) {
        const s = sz(n), x = n.x, y = n.y;
        c.beginPath(); c.moveTo(x, y + s.h); c.lineTo(x + s.w, y); c.lineTo(x + s.w, y + s.h); c.closePath();
        if (n.loose) { c.fillStyle = metal(c, x, y, s.w, s.h, tint(n, '#9aa6b2')); c.fill(); c.strokeStyle = '#3a434d'; c.lineWidth = 2; c.stroke(); return; }
        ground(c, x, y, s.w, s.h, () => { c.beginPath(); c.moveTo(x, y + s.h); c.lineTo(x + s.w, y); c.lineTo(x + s.w, y + s.h); c.closePath(); });
        c.beginPath(); c.moveTo(x, y + s.h); c.lineTo(x + s.w, y); c.strokeStyle = '#e5e7eb'; c.lineWidth = 3; c.stroke();
      },
      BEDROCK(c, n) {
        const s = sz(n);
        ground(c, n.x, n.y, s.w, s.h, () => { c.beginPath(); c.rect(n.x, n.y, s.w, s.h); });
        c.fillStyle = '#e5e7eb'; c.fillRect(n.x, n.y, s.w, 3); // engineering "fixed ground" edge
      },
      TRAMPOLINE(c, n) {
        const s = sz(n), x = n.x, y = n.y;
        c.fillStyle = '#374151'; c.fillRect(x + 6, y + s.h * 0.45, 6, s.h * 0.55); c.fillRect(x + s.w - 12, y + s.h * 0.45, 6, s.h * 0.55);
        roundRect(c, x, y, s.w, s.h * 0.5, 4); c.fillStyle = '#1f2937'; c.fill();
        roundRect(c, x + 4, y + 2, s.w - 8, s.h * 0.5 - 4, 3); c.fillStyle = tint(n, '#2563eb'); c.fill();
        c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1;
        for (let k = x + 10; k < x + s.w - 8; k += 8) { c.beginPath(); c.moveTo(k, y + 2); c.lineTo(k, y + s.h * 0.5 - 2); c.stroke(); }
      },
      BUMPER(c, n) {
        const s = sz(n), r = Math.min(s.w, s.h) / 2, cx = n.x + s.w / 2, cy = n.y + s.h / 2;
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = tint(n, '#dc2626'); c.fill();
        c.beginPath(); c.arc(cx, cy, r * 0.72, 0, Math.PI * 2); c.fillStyle = '#e5e7eb'; c.fill();
        c.beginPath(); c.arc(cx, cy, r * 0.32, 0, Math.PI * 2); c.fillStyle = '#6b7280'; c.fill();
      },
      CONVEYOR(c, n, d, ins) {
        const s = sz(n), x = n.x, y = n.y, h = s.h, run = ins && ins[0] !== undefined ? (typeof ins[0] === 'boolean' ? (ins[0] ? 4 : 0) : Math.max(-10, Math.min(10, num(ins[0])))) : 0;
        roundRect(c, x, y, s.w, h, h / 2); c.fillStyle = '#1f2937'; c.fill(); c.strokeStyle = '#4b5563'; c.lineWidth = 1.5; c.stroke();
        const off = ((now() / 1000) * run * 30) % 12;
        c.save(); roundRect(c, x, y, s.w, h, h / 2); c.clip(); c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 2;
        for (let k = x - 12 + off; k < x + s.w + 12; k += 12) { c.beginPath(); c.moveTo(k, y + 1); c.lineTo(k - 4, y + 5); c.stroke(); }
        c.restore();
        for (let k = x + h / 2; k <= x + s.w - h / 2 + 0.1; k += Math.max(h, (s.w - h) / Math.max(1, Math.round((s.w - h) / 40)))) { c.beginPath(); c.arc(k, y + h / 2, h / 2 - 4, 0, Math.PI * 2); c.fillStyle = '#9ca3af'; c.fill(); c.beginPath(); c.arc(k, y + h / 2, 2.5, 0, Math.PI * 2); c.fillStyle = '#374151'; c.fill(); }
        if (run) H.wantFrames();
      },
      GLUE(c, n) {
        const s = sz(n), x = n.x, y = n.y;
        c.save(); c.globalAlpha = 0.55;
        c.beginPath();
        const k = 10, r = Math.min(s.w, s.h) / 2;
        for (let i = 0; i <= k; i++) { const a = (i / k) * Math.PI * 2, wob = 1 + Math.sin(i * 2.7 + n.x) * 0.08; c.lineTo(x + s.w / 2 + Math.cos(a) * (s.w / 2) * wob, y + s.h / 2 + Math.sin(a) * (s.h / 2) * wob); }
        c.closePath(); c.fillStyle = tint(n, '#fbbf24'); c.fill(); c.globalAlpha = 1;
        c.strokeStyle = 'rgba(146,64,14,.9)'; c.lineWidth = 1.5; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]);
        c.restore();
        tag(c, 'GLUE', x + s.w / 2, y + s.h / 2, 'center', '#78350f', Math.max(7, Math.min(10, r / 2)));
      },
      AXLE(c, n) { const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2; c.beginPath(); c.arc(cx, cy, 9, 0, Math.PI * 2); c.fillStyle = '#d1d5db'; c.fill(); c.strokeStyle = '#374151'; c.lineWidth = 2; c.stroke(); c.beginPath(); c.arc(cx, cy, 3.5, 0, Math.PI * 2); c.fillStyle = '#374151'; c.fill(); },
      WELD(c, n) { const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2; c.fillStyle = '#f59e0b'; c.beginPath(); c.moveTo(cx - 9, cy + 7); c.lineTo(cx + 9, cy + 7); c.lineTo(cx, cy - 8); c.closePath(); c.fill(); c.strokeStyle = '#78350f'; c.lineWidth = 1.5; c.stroke(); },
      SERVO(c, n, d, ins) {
        const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2;
        roundRect(c, cx - 13, cy - 13, 26, 26, 4); c.fillStyle = '#1f2937'; c.fill(); c.strokeStyle = '#6b7280'; c.lineWidth = 1.2; c.stroke();
        const a = (num(ins && ins[0]) * Math.PI) / 180;
        c.save(); c.translate(cx, cy); c.rotate(a); c.fillStyle = '#e5e7eb'; roundRect(c, -3, -11, 6, 14, 3); c.fill(); c.restore();
        c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fillStyle = '#9ca3af'; c.fill();
      },
      THRUSTER(c, n, d, ins) {
        const s = sz(n), x = n.x, y = n.y, t = ins && ins[0] !== undefined ? (typeof ins[0] === 'boolean' ? (ins[0] ? 0.5 : 0) : Math.max(0, Math.min(10, num(ins[0]))) / 10) : 0;
        if (t > 0) { // flame out of the back (it pushes forward = to the right)
          const fl = 10 + t * 28 + Math.sin(now() / 40) * 3;
          const g = c.createLinearGradient(x, 0, x - fl, 0); g.addColorStop(0, '#fff7cc'); g.addColorStop(0.4, '#fb923c'); g.addColorStop(1, 'rgba(239,68,68,0)');
          c.beginPath(); c.moveTo(x + 4, y + s.h / 2 - 8); c.quadraticCurveTo(x - fl, y + s.h / 2, x + 4, y + s.h / 2 + 8); c.fillStyle = g; c.fill(); H.wantFrames();
        }
        c.fillStyle = metal(c, x, y, s.w, s.h, '#9ca3af'); c.beginPath(); c.moveTo(x, y + 2); c.lineTo(x + 12, y + 6); c.lineTo(x + 12, y + s.h - 6); c.lineTo(x, y + s.h - 2); c.closePath(); c.fill();
        roundRect(c, x + 12, y + 3, s.w - 12, s.h - 6, 5); c.fillStyle = metal(c, x, y, s.w, s.h, '#6b7280'); c.fill(); c.strokeStyle = '#111827'; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = '#f59e0b'; c.fillRect(x + s.w - 10, y + 6, 3, s.h - 12);
      },
      MAGNET(c, n, d, ins) {
        const s = sz(n), x = n.x, y = n.y, on = truthy(ins && ins[0]);
        roundRect(c, x, y, s.w, s.h * 0.62, 4); c.fillStyle = metal(c, x, y, s.w, s.h, '#4b5563'); c.fill();
        c.strokeStyle = '#b45309'; c.lineWidth = 2; for (let k = x + 8; k < x + s.w - 6; k += 5) { c.beginPath(); c.moveTo(k, y + 3); c.lineTo(k, y + s.h * 0.62 - 3); c.stroke(); }
        c.fillStyle = '#9ca3af'; c.fillRect(x + 2, y + s.h * 0.62, s.w - 4, s.h * 0.38);
        tag(c, on ? 'ON' : 'OFF', x + s.w / 2, y + s.h * 0.81, 'center', on ? '#7f1d1d' : '#374151', 9);
        if (on) { c.strokeStyle = 'rgba(147,197,253,.55)'; c.lineWidth = 1.2; for (let k = 1; k <= 3; k++) { c.beginPath(); c.ellipse(x + s.w / 2, y + s.h, s.w * 0.25 * k, 8 * k, 0, 0, Math.PI); c.stroke(); } }
      },
      // ---------------------------------------------------------------- sensors
      DETECTOR(c, n, d, ins, out) {
        const s = sz(n), x = n.x, y = n.y, cy = y + s.h / 2, hit = !!(out && out[0]);
        c.save(); c.strokeStyle = hit ? 'rgba(239,68,68,.95)' : 'rgba(239,68,68,.45)'; c.lineWidth = hit ? 2.4 : 1.4; if (!hit) c.setLineDash([6, 4]);
        if (hit) { c.shadowColor = '#ef4444'; c.shadowBlur = 8; }
        c.beginPath(); c.moveTo(x + 14, cy); c.lineTo(x + s.w - 14, cy); c.stroke(); c.restore();
        for (const bx of [x, x + s.w - 14]) { roundRect(c, bx, y + 2, 14, s.h - 4, 3); c.fillStyle = '#1f2937'; c.fill(); c.strokeStyle = '#6b7280'; c.lineWidth = 1; c.stroke(); }
        c.beginPath(); c.arc(x + 10, cy, 3, 0, Math.PI * 2); c.fillStyle = '#ef4444'; c.fill();
        c.beginPath(); c.arc(x + s.w - 10, cy, 3, 0, Math.PI * 2); c.fillStyle = hit ? '#4b5563' : '#22c55e'; c.fill();
        tag(c, String(out && out[1] !== undefined ? out[1] : 0), x + s.w / 2, y + 4, 'center', 'rgba(255,255,255,.7)', 9);
      },
      NEWTON(c, n, d, ins, out) {
        const s = sz(n), x = n.x, y = n.y, f = num(out && out[0]);
        c.fillStyle = metal(c, x, y, s.w, 6, '#d1d5db'); c.fillRect(x, y, s.w, 6);
        roundRect(c, x + 2, y + 6, s.w - 4, s.h - 6, 3); c.fillStyle = '#1f2937'; c.fill();
        roundRect(c, x + s.w / 2 - 30, y + 8, 60, s.h - 10, 2); c.fillStyle = '#04120a'; c.fill();
        tag(c, (f >= 1000 ? (f / 1000).toFixed(2) + ' kN' : Math.round(f) + ' N'), x + s.w / 2, y + 6 + (s.h - 6) / 2, 'center', '#5dff95', 10);
        if (out && out[1]) lamp(c, x + s.w - 10, y + 6 + (s.h - 6) / 2, 3, '#ef4444', true);
      },
      ZONE(c, n, d, ins, out) {
        const s = sz(n), cnt = num(out && out[1]);
        c.save(); c.setLineDash([8, 5]); c.strokeStyle = cnt ? 'rgba(34,197,94,.9)' : 'rgba(34,197,94,.45)'; c.lineWidth = 2; c.strokeRect(n.x, n.y, s.w, s.h); c.restore();
        c.fillStyle = cnt ? 'rgba(34,197,94,.12)' : 'rgba(34,197,94,.04)'; c.fillRect(n.x, n.y, s.w, s.h);
        tag(c, 'Area · ' + cnt, n.x + 6, n.y + 10, 'left', '#86efac', 9);
      },
      SPEEDO(c, n, d, ins, out) {
        const s = sz(n); pcb(c, n.x, n.y, s.w, s.h, 4);
        tag(c, Math.round(num(out && out[0])) + '', n.x + s.w / 2, n.y + s.h / 2 - 3, 'center', '#5dff95', 10);
        tag(c, 'cm/s', n.x + s.w / 2, n.y + s.h - 6, 'center', 'rgba(255,255,255,.55)', 7);
      },
      PRESSURE_SW(c, n, d, ins, out) {
        const s = sz(n), x = n.x, y = n.y, on = !!(out && out[0]);
        H.frame(c, n, d, 'Pressure Switch');
        roundRect(c, x + 22, y + 18, s.w - 44, 30, 3); c.strokeStyle = LINE; c.lineWidth = 1.5; c.stroke();
        c.beginPath(); c.moveTo(x + 30, y + 40); c.lineTo(x + s.w - 30, y + (on ? 40 : 28)); c.stroke(); // contact
        c.beginPath(); c.moveTo(x + s.w / 2, y + 48); c.lineTo(x + s.w / 2, y + s.h); c.strokeStyle = num(ins && ins[0]) > 0 ? HYD_ON : LINE; c.stroke();
        tag(c, '≥ ' + (Number(n.value) || 0) + ' bar', x + s.w / 2, y + 58, 'center', 'rgba(255,255,255,.6)', 8);
        lamp(c, x + s.w - 14, y + 14, 3.5, '#ef4444', on);
      },
      // ---------------------------------------------------------------- hydraulics
      NOZZLE(c, n, d, ins) {
        const s = sz(n), x = n.x, y = n.y, p = num(ins && ins[0]);
        if (p > 0) { // jet
          const t = now() / 60; c.fillStyle = 'rgba(245,165,36,.25)';
          c.beginPath(); c.moveTo(x + s.w, y + s.h / 2 - 4); c.lineTo(x + s.w + 160, y + s.h / 2 - 40); c.lineTo(x + s.w + 160, y + s.h / 2 + 40); c.lineTo(x + s.w, y + s.h / 2 + 4); c.fill();
          c.fillStyle = 'rgba(255,230,170,.8)'; for (let k = 0; k < 10; k++) { const a = ((t + k * 13) % 100) / 100; c.beginPath(); c.arc(x + s.w + a * 150, y + s.h / 2 + Math.sin(k * 7.1) * a * 30, 1.6, 0, Math.PI * 2); c.fill(); }
          H.wantFrames();
        }
        c.fillStyle = metal(c, x, y, s.w, s.h, '#d1a43a'); c.beginPath(); c.moveTo(x, y + 4); c.lineTo(x + s.w * 0.55, y + 4); c.lineTo(x + s.w, y + s.h / 2 - 3); c.lineTo(x + s.w, y + s.h / 2 + 3); c.lineTo(x + s.w * 0.55, y + s.h - 4); c.lineTo(x, y + s.h - 4); c.closePath(); c.fill();
        c.strokeStyle = '#78350f'; c.lineWidth = 1.2; c.stroke();
      },
      ACCUMULATOR(c, n, d, ins, out, mem) {
        const s = sz(n), x = n.x, y = n.y, p = num(mem && mem.p), max = Number(n.value) || 120, cx = x + s.w / 2;
        H.frame(c, n, d, 'Accumulator');
        const vx = cx - 22, vy = y + 16, vw = 44, vh = s.h - 36;
        roundRect(c, vx, vy, vw, vh, 20); c.fillStyle = '#374151'; c.fill(); c.strokeStyle = '#d1a43a'; c.lineWidth = 2; c.stroke();
        const lvl = Math.min(1, p / max);
        c.save(); roundRect(c, vx, vy, vw, vh, 20); c.clip(); c.fillStyle = 'rgba(245,165,36,.75)'; c.fillRect(vx, vy + vh * (1 - lvl), vw, vh * lvl); c.restore();
        c.beginPath(); c.moveTo(cx, vy + vh); c.lineTo(cx, y + s.h); c.strokeStyle = num(ins && ins[0]) > 0 ? HYD_ON : LINE; c.lineWidth = 2; c.stroke();
        tag(c, Math.round(p) + ' bar', cx, vy + 12, 'center', '#fde68a', 9);
      },
      RELIEF(c, n, d, ins, out) { isoBox(c, n, d, 'Relief', num(ins && ins[0]) > Math.max(0, num(out && out[0])) + 0.5, '≤ ' + (Number(n.value) || 0) + ' bar'); },
      SHUTTLE(c, n, d) { isoBox(c, n, d, 'Shuttle (OR)', false, 'max(X, Y)'); },
      TWOPRESS(c, n, d) { isoBox(c, n, d, 'Two-pressure (AND)', false, 'X and Y'); },
      HYDMOTOR(c, n, d, ins, out) {
        const s = sz(n), cx = n.x + s.w / 2 - 6, cy = n.y + s.h / 2, r = 24, rpm = num(out && out[0]);
        H.frame(c, n, d, 'Hydraulic Motor');
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = 'rgba(245,165,36,.12)'; c.fill(); c.strokeStyle = LINE; c.lineWidth = 2; c.stroke();
        c.beginPath(); c.moveTo(cx - r + 2, cy); c.lineTo(cx - r + 13, cy - 6); c.lineTo(cx - r + 13, cy + 6); c.closePath(); c.fillStyle = rpm ? HYD_ON : LINE; c.fill(); // ISO: triangle pointing in
        const a = (now() / 1000) * (rpm / 60) * Math.PI * 2;
        c.save(); c.translate(cx, cy); c.rotate(a); c.strokeStyle = rpm ? '#fde68a' : DIM; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, r - 8, 0.3, 1.9); c.stroke(); c.restore();
        tag(c, rpm + ' rpm', n.x + s.w / 2, n.y + s.h - 8, 'center', rpm ? '#fde68a' : 'rgba(255,255,255,.55)', 9);
        if (rpm) H.wantFrames();
      },
      // ---------------------------------------------------------------- controls
      ESTOP(c, n) {
        const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2 + 4, hit = !!n.value;
        roundRect(c, n.x + 4, n.y + 4, s.w - 8, s.h - 8, 8); c.fillStyle = '#facc15'; c.fill(); c.strokeStyle = '#854d0e'; c.lineWidth = 1.5; c.stroke();
        tag(c, 'EMERGENCY STOP', cx, n.y + 13, 'center', '#1f2937', 7);
        c.beginPath(); c.arc(cx, cy, 28, 0, Math.PI * 2); c.fillStyle = '#1f2937'; c.fill();
        const r = hit ? 21 : 25, g = c.createRadialGradient(cx - 7, cy - 8, 2, cx, cy, r); g.addColorStop(0, '#fca5a5'); g.addColorStop(0.35, '#dc2626'); g.addColorStop(1, '#7f1d1d');
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = g; c.fill();
        tag(c, hit ? 'PRESSED' : '', cx, cy, 'center', '#fff', 7);
      },
      SELECTOR(c, n) {
        const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2 + 6, p = (Math.round(Number(n.value)) || 0) % 3;
        pcb(c, n.x, n.y, s.w, s.h, 8); label(c, n, 'Selector');
        ['0', '1', '2'].forEach((t, i) => { const a = -Math.PI / 2 + (i - 1) * 0.9; tag(c, t, cx + Math.cos(a) * 34, cy + Math.sin(a) * 34, 'center', i === p ? '#fde68a' : 'rgba(255,255,255,.6)', 10); });
        c.beginPath(); c.arc(cx, cy, 22, 0, Math.PI * 2); c.fillStyle = '#111827'; c.fill(); c.strokeStyle = '#9ca3af'; c.lineWidth = 1.5; c.stroke();
        const a = -Math.PI / 2 + (p - 1) * 0.9;
        c.save(); c.translate(cx, cy); c.rotate(a + Math.PI / 2); roundRect(c, -5, -20, 10, 40, 4); c.fillStyle = '#e5e7eb'; c.fill(); c.fillStyle = '#ef4444'; c.fillRect(-1.5, -18, 3, 10); c.restore();
      },
      SLIDER(c, n) {
        const s = sz(n), max = Number(n.max ?? 100), v = Math.max(0, Math.min(max, Number(n.value) || 0)), x0 = n.x + 16, x1 = n.x + s.w - 16, y = n.y + s.h / 2 + 6;
        pcb(c, n.x, n.y, s.w, s.h, 8); label(c, n, 'Slider');
        roundRect(c, x0, y - 3, x1 - x0, 6, 3); c.fillStyle = '#04120a'; c.fill();
        const hx = x0 + ((x1 - x0) * v) / (max || 1);
        roundRect(c, x0, y - 3, hx - x0, 6, 3); c.fillStyle = '#facc15'; c.fill();
        roundRect(c, hx - 7, y - 11, 14, 22, 3); c.fillStyle = '#e5e7eb'; c.fill(); c.strokeStyle = '#374151'; c.lineWidth = 1.2; c.stroke();
        tag(c, String(Math.round(v * 10) / 10), n.x + s.w - 30, n.y + 9, 'right', '#fde68a', 10);
      },
      JOYSTICK(c, n) {
        const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2 + 5, jx = Number(n.jx) || 0, jy = Number(n.jy) || 0;
        pcb(c, n.x, n.y, s.w, s.h, 10); label(c, n, 'Joystick');
        c.beginPath(); c.arc(cx, cy, 34, 0, Math.PI * 2); c.fillStyle = '#111827'; c.fill(); c.strokeStyle = '#4b5563'; c.lineWidth = 1; c.stroke();
        c.beginPath(); c.moveTo(cx - 30, cy); c.lineTo(cx + 30, cy); c.moveTo(cx, cy - 30); c.lineTo(cx, cy + 30); c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
        const kx = cx + jx * 24, ky = cy + jy * 24;
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(kx, ky); c.strokeStyle = '#6b7280'; c.lineWidth = 6; c.stroke();
        const g = c.createRadialGradient(kx - 4, ky - 4, 1, kx, ky, 12); g.addColorStop(0, '#f87171'); g.addColorStop(1, '#991b1b');
        c.beginPath(); c.arc(kx, ky, 12, 0, Math.PI * 2); c.fillStyle = g; c.fill();
      },
      // ---------------------------------------------------------------- indicators
      LED(c, n, d, ins) {
        const s = sz(n), cx = n.x + s.w / 2, v = ins && ins[0], amt = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : truthy(v) ? 1 : 0, col = tint(n, '#22c55e');
        c.fillStyle = '#9ca3af'; c.fillRect(cx - 5, n.y + s.h - 14, 2, 12); c.fillRect(cx + 3, n.y + s.h - 14, 2, 12);
        c.beginPath(); c.arc(cx, n.y + 16, 11, Math.PI, 0); c.lineTo(cx + 11, n.y + 32); c.lineTo(cx - 11, n.y + 32); c.closePath();
        if (amt > 0) { c.save(); c.shadowColor = col; c.shadowBlur = 18 * amt; c.globalAlpha = 0.4 + 0.6 * amt; c.fillStyle = col; c.fill(); c.restore(); } else { c.fillStyle = shade(col, -0.65); c.fill(); }
        c.fillStyle = shade(col, -0.3); c.fillRect(cx - 13, n.y + 32, 26, 4);
      },
      RGBLED(c, n, d, ins) {
        const s = sz(n), cx = n.x + s.w / 2 + 6, cy = n.y + s.h / 2;
        const ch = (v) => Math.round(255 * (typeof v === 'number' ? Math.max(0, Math.min(1, v)) : truthy(v) ? 1 : 0));
        const r = ch(ins && ins[0]), g = ch(ins && ins[1]), b = ch(ins && ins[2]), on = r + g + b > 0;
        pcb(c, n.x, n.y, s.w, s.h, 6);
        lamp(c, cx, cy, 14, 'rgb(' + r + ',' + g + ',' + b + ')', on);
        ['R', 'G', 'B'].forEach((t, i) => pinLabel(c, n, 'in', i, t));
      },
      BARGRAPH(c, n, d, ins) {
        const s = sz(n), max = Number(n.value) || 10, v = num(ins && ins[0]), lit = Math.round(Math.max(0, Math.min(1, v / max)) * 10);
        pcb(c, n.x, n.y, s.w, s.h, 5);
        const x0 = n.x + 14, w = (s.w - 24) / 10;
        for (let k = 0; k < 10; k++) { const col = k < 6 ? '#22c55e' : k < 8 ? '#facc15' : '#ef4444'; roundRect(c, x0 + k * w + 1, n.y + 12, w - 3, s.h - 24, 2); if (k < lit) { c.save(); c.shadowColor = col; c.shadowBlur = 8; c.fillStyle = col; c.fill(); c.restore(); } else { c.fillStyle = shade(col, -0.75); c.fill(); } }
      },
      STACKLIGHT(c, n, d, ins) {
        const s = sz(n), cx = n.x + s.w / 2, cols = ['#ef4444', '#f59e0b', '#22c55e'], segH = (s.h - 34) / 3;
        c.fillStyle = '#374151'; c.fillRect(cx - 4, n.y + s.h - 16, 8, 12); roundRect(c, cx - 18, n.y + s.h - 8, 36, 8, 2); c.fillStyle = '#1f2937'; c.fill();
        cols.forEach((col, i) => {
          const on = truthy(ins && ins[i]), y = n.y + 8 + i * segH;
          roundRect(c, cx - 16, y, 32, segH - 2, 4);
          if (on) { c.save(); c.shadowColor = col; c.shadowBlur = 16; c.fillStyle = col; c.fill(); c.restore(); } else { c.fillStyle = shade(col, -0.7); c.fill(); }
          c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(cx - 12, y + 3, 6, segH - 8);
        });
        roundRect(c, cx - 17, n.y + 4, 34, 6, 3); c.fillStyle = '#111827'; c.fill();
      },
      BEACON(c, n, d, ins) {
        const s = sz(n), cx = n.x + s.w / 2, cy = n.y + s.h / 2, on = truthy(ins && ins[0]), col = tint(n, '#f59e0b');
        roundRect(c, cx - 22, n.y + s.h - 16, 44, 12, 3); c.fillStyle = '#1f2937'; c.fill();
        c.beginPath(); c.arc(cx, n.y + s.h - 16, 20, Math.PI, 0); c.closePath(); c.fillStyle = on ? col : shade(col, -0.6); c.fill();
        if (on) {
          const a = (now() / 300) % (Math.PI * 2);
          c.save(); c.globalAlpha = 0.35; c.fillStyle = col; c.beginPath(); c.moveTo(cx, cy + 6); c.arc(cx, cy + 6, 60, a - 0.35, a + 0.35); c.closePath(); c.fill(); c.restore();
          c.save(); c.shadowColor = col; c.shadowBlur = 20; c.beginPath(); c.arc(cx, n.y + s.h - 16, 20, Math.PI, 0); c.fill(); c.restore();
          H.wantFrames();
        }
      },
      METER(c, n, d, ins) {
        const s = sz(n), v = num(ins && ins[0]), max = Number(n.value) || 100, cx = n.x + s.w / 2, cy = n.y + s.h - 22, r = Math.min(s.w / 2 - 10, s.h - 36);
        roundRect(c, n.x + 4, n.y + 4, s.w - 8, s.h - 8, 6); c.fillStyle = '#f3f4f6'; c.fill(); c.strokeStyle = '#111827'; c.lineWidth = 3; c.stroke();
        c.strokeStyle = '#111827'; c.lineWidth = 1.2;
        for (let k = 0; k <= 10; k++) { const a = Math.PI * (1 + k / 10), l = k % 5 ? 5 : 9; c.beginPath(); c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); c.lineTo(cx + Math.cos(a) * (r - l), cy + Math.sin(a) * (r - l)); c.stroke(); }
        tag(c, '0', cx - r + 8, cy - 4, 'center', '#111827', 8); tag(c, String(max), cx + r - 10, cy - 4, 'center', '#111827', 8);
        const a = Math.PI * (1 + Math.max(0, Math.min(1.02, v / max)));
        c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); c.strokeStyle = '#dc2626'; c.lineWidth = 2; c.stroke();
        c.beginPath(); c.arc(cx, cy, 4, 0, Math.PI * 2); c.fillStyle = '#111827'; c.fill();
        tag(c, (Math.round(v * 10) / 10).toString(), cx, n.y + s.h - 10, 'center', '#111827', 9);
      },
      SCOPE(c, n, d, ins) {
        const s = sz(n), x = n.x + 22, y = n.y + 10, w = s.w - 34, h = s.h - 20, full = Number(n.value) || 10;
        let hist = scopes.get(n.id); if (!hist) { hist = []; scopes.set(n.id, hist); }
        const t = now(); if (!hist.length || t - hist[hist.length - 1].t > 50) { hist.push({ t, a: num(ins && ins[0]), b: num(ins && ins[1]) }); while (hist.length && t - hist[0].t > 10000) hist.shift(); }
        roundRect(c, n.x, n.y, s.w, s.h, 8); c.fillStyle = '#1f2937'; c.fill(); c.strokeStyle = '#4b5563'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = '#031a0c'; c.fillRect(x, y, w, h);
        c.strokeStyle = 'rgba(93,255,149,.12)'; c.lineWidth = 1;
        for (let k = 1; k < 10; k++) { c.beginPath(); c.moveTo(x + (w * k) / 10, y); c.lineTo(x + (w * k) / 10, y + h); c.stroke(); }
        for (let k = 1; k < 8; k++) { c.beginPath(); c.moveTo(x, y + (h * k) / 8); c.lineTo(x + w, y + (h * k) / 8); c.stroke(); }
        const trace = (key, col) => { c.beginPath(); hist.forEach((p, i) => { const px = x + w - ((t - p.t) / 10000) * w, py = y + h - Math.max(0, Math.min(1, p[key] / full)) * h; if (i) c.lineTo(px, py); else c.moveTo(px, py); }); c.strokeStyle = col; c.lineWidth = 1.6; c.stroke(); };
        trace('a', '#facc15'); trace('b', '#22d3ee');
        tag(c, 'CH1', x + 4, y + 8, 'left', '#facc15', 8); tag(c, 'CH2', x + 30, y + 8, 'left', '#22d3ee', 8); tag(c, full + '/div·8', x + w - 4, y + 8, 'right', 'rgba(255,255,255,.5)', 7);
        H.wantFrames();
      },
      // ---------------------------------------------------------------- electrical
      RELAY(c, n, d, ins, out) {
        const s = sz(n), x = n.x, y = n.y, on = !!(out && out[0]);
        pcb(c, x, y, s.w, s.h, 6);
        roundRect(c, x + 18, y + 14, s.w - 36, s.h - 28, 4); c.fillStyle = '#1e3a8a'; c.fill(); c.strokeStyle = '#93c5fd'; c.lineWidth = 1; c.stroke();
        tag(c, 'RELAY', x + s.w / 2, y + 22, 'center', '#dbeafe', 8);
        c.strokeStyle = '#e5e7eb'; c.lineWidth = 2; c.beginPath(); c.moveTo(x + 32, y + s.h - 26); c.lineTo(x + s.w - 32, y + s.h - (on ? 26 : 36)); c.stroke();
        lamp(c, x + s.w - 12, y + 10, 3, '#ef4444', truthy(ins && ins[0]));
        pinLabel(c, n, 'out', 0, 'NO'); pinLabel(c, n, 'out', 1, 'NC');
      },
      BATTERY(c, n) {
        const s = sz(n), x = n.x + 6, y = n.y + 10, w = s.w - 20, h = s.h - 20;
        roundRect(c, x, y, w, h, 5); c.fillStyle = metal(c, x, y, w, h, '#1f2937'); c.fill();
        roundRect(c, x + w, y + h / 2 - 7, 6, 14, 2); c.fillStyle = '#9ca3af'; c.fill();
        c.fillStyle = '#facc15'; c.fillRect(x + 3, y + 3, w * 0.3, h - 6);
        tag(c, (Number(n.value) || 24) + ' V', x + w * 0.62, y + h / 2, 'center', '#fff', 11);
        const p0 = pinPos(n, 'out', 0, true), p1 = pinPos(n, 'out', 1, true);
        tag(c, '+', p0.x - 8, p0.y, 'right', '#ef4444', 12); tag(c, '−', p1.x - 8, p1.y, 'right', '#e5e7eb', 12);
      },
    };
    function isoBox(c, n, d, title, active, sub) {
      const s = sz(n), x = n.x, y = n.y;
      H.frame(c, n, d, title);
      roundRect(c, x + 24, y + 18, s.w - 48, 30, 2); c.strokeStyle = LINE; c.lineWidth = 1.5; c.stroke();
      c.beginPath(); c.moveTo(x + 30, y + 40); c.lineTo(x + s.w - 30, y + 26); c.stroke();
      if (active) { c.save(); c.strokeStyle = HYD_ON; c.lineWidth = 2.5; c.beginPath(); c.moveTo(x + s.w / 2, y + 48); c.lineTo(x + s.w / 2, y + s.h - 4); c.stroke(); c.restore(); }
      tag(c, sub, x + s.w / 2, y + s.h - 10, 'center', 'rgba(255,255,255,.6)', 8);
    }
    function ground(c, x, y, w, h, path) {
      c.save(); path(); c.fillStyle = '#20242b'; c.fill(); c.clip();
      c.strokeStyle = 'rgba(148,163,184,.35)'; c.lineWidth = 1.2;
      for (let k = -h; k < w + h; k += 9) { c.beginPath(); c.moveTo(x + k, y + h); c.lineTo(x + k + h, y); c.stroke(); }
      c.restore();
      path(); c.strokeStyle = '#94a3b8'; c.lineWidth = 1.5; c.stroke();
    }
    return D;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

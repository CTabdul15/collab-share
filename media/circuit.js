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
      help: 'Counts up (or down while Down is on) on each pulse; wraps around. Double-click to set the max.',
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
      help: 'Turns on and off by itself. Double-click to set the period (seconds, 0.1 or more).',
      // Exact period in ticks; the on-part may be one tick shorter than the off-part.
      src: (node, sim) => { const n = ticksOf(node.value, 2); return [sim.tick % n >= Math.ceil(n / 2)]; },
    },
    DELAY: {
      cat: 'time', title: 'Delay', w: 110, h: 50, ins: [{ n: 'In' }], outs: [B('Out')], value: 0.2,
      help: 'Passes the signal on after a delay (like a repeater). Double-click to set seconds.',
      seq: {
        init: () => ({ buf: [] }),
        update(st, ins, prev, node) { const n = ticksOf(node.value); st.buf.push(truthy(ins[0])); while (st.buf.length > n) st.buf.shift(); st.out = st.buf.length >= n ? st.buf[0] : false; },
        out: (st) => [!!st.out],
      },
    },
    PULSE: {
      cat: 'time', title: 'Pulse', w: 110, h: 50, ins: [{ n: 'In' }], outs: [B('Out')], value: 0.5,
      help: 'When In turns on, Out stays on for a set time. Double-click to set seconds.',
      seq: {
        init: () => ({ until: -1 }),
        update(st, ins, prev, node, sim) { if (rising(ins[0], prev[0])) st.until = sim.tick + ticksOf(node.value); },
        out: (st, node, sim) => [sim.tick < st.until],
      },
    },

    // Inputs
    BUTTON: {
      cat: 'in', title: 'Button', w: 92, h: 70, ins: [], outs: [B('Out')],
      help: 'On while you hold it down (at least one tick).',
      src: (node, sim) => [!!node.value || sim.tick - (sim.pressed.get(node.id) ?? -99) <= 1],
    },
    LEVER: { cat: 'in', title: 'Lever', w: 92, h: 62, ins: [], outs: [B('Out')], help: 'Click to flip on/off.', src: (node) => [!!node.value] },
    SWITCH: { cat: 'in', title: 'Switch', w: 92, h: 48, ins: [], outs: [B('Out')], help: 'Click to flip on/off.', src: (node) => [!!node.value] },
    NUMBER: { cat: 'in', title: 'Number', w: 104, h: 48, ins: [], outs: [{ n: 'Value' }], value: 0, help: 'Double-click to type a number.', src: (node) => [Number(node.value) || 0] },

    // Outputs
    LAMP: { cat: 'out', title: 'Lamp', w: 64, h: 66, ins: [{ n: 'In' }], outs: [] },
    DISPLAY: { cat: 'out', title: 'Display', w: 112, h: 48, ins: [{ n: 'Value' }], outs: [] },
    SEG7: { cat: 'out', title: '7-Segment', w: 76, h: 104, ins: [{ n: 'Value' }], outs: [], help: 'Shows 0–9 and A–F.' },
    MOTOR: { cat: 'out', title: 'Motor', w: 96, h: 100, ins: [{ n: 'Power' }], outs: [], help: 'Spins while powered; a bigger number spins faster.' },
    BUZZER: { cat: 'out', title: 'Buzzer', w: 116, h: 64, ins: [{ n: 'In' }], outs: [], value: 440, help: 'Beeps while on. Double-click to set the pitch (Hz).' },
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
      help: 'Plays a note each time Play turns on. Double-click to pick the instrument (piano, square, phonk bell, 808…) and note.',
      seq: { init: () => ({ plays: 0 }), update(st, ins, prev) { if (rising(ins[0], prev[0])) st.plays++; }, out: () => [], show: (st) => ({ plays: st.plays }) },
    },
  };

  function def(kind) {
    const k = KINDS[kind];
    if (!k) return null;
    const left = k.ins.filter((p) => !p.at || p.at === 'left').length;
    const rows = Math.max(left, k.outs.length);
    const h = k.h ?? 30 + rows * 22 + 8;
    return { kind, ...k, h, bool: k.outs.every((o) => o.bool) };
  }

  /** Pin position + outward direction, on the board (rotated with the node unless raw). */
  function pinPos(n, side, i, raw) {
    const d = def(n.kind);
    if (!d) return { x: n.x, y: n.y, dx: 1, dy: 0 };
    let p;
    // Modules with a title bar keep their pins in the body below it (gates have no title bar).
    const top = d.cat === 'gate' ? 0 : 24;
    const spread = (j, count) => top + ((d.h - top) * (j + 1)) / (count + 1);
    if (side === 'out') {
      const y = d.cat === 'func' || d.cat === 'mem' ? 30 + i * 22 + 11 : spread(i, d.outs.length);
      p = { x: n.x + d.w, y: n.y + y, dx: 1, dy: 0 };
    } else {
      const pin = d.ins[i] || {};
      const at = pin.at || 'left';
      const same = d.ins.filter((q) => (q.at || 'left') === at);
      const j = same.indexOf(pin);
      if (at === 'top' || at === 'bottom') {
        p = { x: n.x + (d.w * (j + 1)) / (same.length + 1), y: at === 'top' ? n.y : n.y + d.h, dx: 0, dy: at === 'top' ? -1 : 1 };
      } else {
        const y = d.cat === 'func' || d.cat === 'mem' ? 30 + j * 22 + 11 : spread(j, same.length);
        p = { x: n.x, y: n.y + y, dx: -1, dy: 0 };
      }
    }
    if (raw || !n.rot) return p;
    const cx = n.x + d.w / 2, cy = n.y + d.h / 2, a = (n.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
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
      }
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

    /** What the whiteboards need to draw: outputs, inputs and visible memory, per node. */
    snapshot() {
      const v = {}, i = {}, s = {};
      for (const [id, n] of this.nodes) {
        v[id] = this.values.get(id) || [];
        i[id] = this.inputs.get(id) || [];
        const k = KINDS[n.kind];
        if (k.seq && k.seq.show) s[id] = k.seq.show(this.state.get(id));
      }
      return { tick: this.tick, v, i, s };
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

  const api = { KINDS, TICK_MS, def, pinPos, Sim, truthy, num, ticksOf, noteName, noteHz, parseNote };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollabCircuit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

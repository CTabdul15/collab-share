// Unit tests for the logic simulator (node test/circuit.test.cjs).
const C = require('../media/circuit.js');
let fails = 0;
const ok = (c, name, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + name + (d ? ' — ' + d : '')); if (!c) fails++; };

function board() {
  const shapes = new Map();
  const sim = new C.Sim();
  const api = {
    sim,
    node(id, kind, extra = {}) { shapes.set(id, { id, type: 'node', kind, x: 0, y: 0, ...extra }); sim.load([...shapes.values()]); },
    wire(a, ap, b, bp) { const id = `${a}.${ap}-${b}.${bp}`; shapes.set(id, { id, type: 'wire', a: { n: a, p: ap }, b: { n: b, p: bp } }); sim.load([...shapes.values()]); },
    set(id, value) { const s = shapes.get(id); shapes.set(id, { ...s, value }); if (s.kind === 'BUTTON' && value) sim.press(id); sim.load([...shapes.values()]); },
    out(id, i = 0) { return sim.values.get(id)?.[i]; },
    ticks(n) { for (let i = 0; i < n; i++) sim.step(); },
    press(id) { api.set(id, true); api.set(id, false); api.ticks(4); }, // a click shorter than one tick
  };
  return api;
}

// T flip-flop driven by a button on Clock (T not wired = on)
{
  const b = board();
  b.node('btn', 'BUTTON'); b.node('t', 'TFF'); b.wire('btn', 0, 't', 1); b.ticks(2);
  const seq = [];
  for (let i = 0; i < 4; i++) { b.press('btn'); seq.push(b.out('t')); }
  ok(JSON.stringify(seq) === '[true,false,true,false]', 'T flip-flop toggles once per (very short) button press', JSON.stringify(seq));
  ok(b.out('t', 1) === !b.out('t'), 'Q̄ is the opposite of Q');
  // T = off: clock does nothing
  b.node('tl', 'LEVER', { value: false }); b.wire('tl', 0, 't', 0); b.ticks(2);
  const before = b.out('t'); b.press('btn');
  ok(b.out('t') === before, 'T off: clock pulse does not flip');
}
// D flip-flop with Set (top) and Reset (bottom)
{
  const b = board();
  b.node('d', 'LEVER', { value: true }); b.node('clk', 'BUTTON'); b.node('set', 'BUTTON'); b.node('rst', 'BUTTON'); b.node('ff', 'DFF');
  b.wire('d', 0, 'ff', 0); b.wire('clk', 0, 'ff', 1); b.wire('set', 0, 'ff', 2); b.wire('rst', 0, 'ff', 3); b.ticks(2);
  ok(b.out('ff') === false, 'D flip-flop starts off');
  b.set('d', false); b.ticks(2); b.set('d', true); b.ticks(2);
  ok(b.out('ff') === false, 'changing D alone does nothing');
  b.press('clk');
  ok(b.out('ff') === true, 'clock pulse stores D=1');
  b.press('rst');
  ok(b.out('ff') === false, 'Reset (bottom) turns Q off');
  b.set('d', false); b.ticks(1); b.press('set');
  ok(b.out('ff') === true, 'Set (top) turns Q on');
  b.press('clk');
  ok(b.out('ff') === false, 'clock pulse stores D=0');
  b.set('rst', true); b.ticks(2); b.set('d', true); b.press('clk');
  ok(b.out('ff') === false, 'held Reset blocks the clock');
  b.set('rst', false);
}
// JK
{
  const b = board();
  b.node('j', 'LEVER', { value: true }); b.node('k', 'LEVER', { value: true }); b.node('c', 'BUTTON'); b.node('ff', 'JKFF');
  b.wire('j', 0, 'ff', 0); b.wire('k', 0, 'ff', 1); b.wire('c', 0, 'ff', 2); b.ticks(2);
  b.press('c'); const a = b.out('ff'); b.press('c'); const c2 = b.out('ff');
  b.set('k', false); b.ticks(1); b.press('c'); const set = b.out('ff');
  b.set('j', false); b.set('k', true); b.ticks(1); b.press('c'); const reset = b.out('ff');
  ok(a === true && c2 === false && set === true && reset === false, 'JK: J+K flip, J sets, K resets');
}
// Counter, wraps at max, resets, counts down
{
  const b = board();
  b.node('c', 'BUTTON'); b.node('r', 'BUTTON'); b.node('dn', 'LEVER', { value: false }); b.node('cnt', 'COUNTER', { value: 3 });
  b.wire('c', 0, 'cnt', 0); b.wire('dn', 0, 'cnt', 1); b.wire('r', 0, 'cnt', 2); b.ticks(2);
  const vals = [];
  for (let i = 0; i < 5; i++) { b.press('c'); vals.push(b.out('cnt')); }
  ok(JSON.stringify(vals) === '[1,2,3,0,1]', 'Counter counts and wraps at max', JSON.stringify(vals));
  b.press('r');
  ok(b.out('cnt') === 0, 'Counter Reset');
  b.set('dn', true); b.ticks(1); b.press('c');
  ok(b.out('cnt') === 3, 'Counter counts down (wraps to max)');
}
// Clock periods: 0.1 s = 2 ticks per cycle, 0.5 s = 10 ticks
for (const period of [0.1, 0.25, 0.5, 1]) {
  const b = board();
  b.node('clk', 'CLOCK', { value: period }); b.node('t', 'TFF'); b.wire('clk', 0, 't', 1); b.ticks(1);
  let edges = 0, last = b.out('clk'), toggles = 0, lastQ = b.out('t');
  const n = 200; // 10 seconds
  for (let i = 0; i < n; i++) { b.ticks(1); const v = b.out('clk'); if (v && !last) edges++; last = v; if (b.out('t') !== lastQ) toggles++; lastQ = b.out('t'); }
  const expected = Math.round(10 / Math.max(0.1, period));
  ok(Math.abs(edges - expected) <= 1 && Math.abs(toggles - edges) <= 1, `Clock ${period}s: ${edges} pulses in 10s, flip-flop flipped ${toggles} times`, `expected ~${expected}`);
}
// Delay and Pulse
{
  const b = board();
  b.node('l', 'LEVER', { value: false }); b.node('d', 'DELAY', { value: 0.5 }); b.wire('l', 0, 'd', 0); b.ticks(12);
  b.set('l', true);
  let t = 0; while (!b.out('d') && t < 40) { b.ticks(1); t++; }
  ok(t >= 9 && t <= 11, 'Delay 0.5 s turns on after ~10 ticks', t + ' ticks');
  const p = board();
  p.node('btn', 'BUTTON'); p.node('p', 'PULSE', { value: 1 }); p.wire('btn', 0, 'p', 0); p.ticks(2);
  p.set('btn', true); p.set('btn', false);
  let on = 0; for (let i = 0; i < 40; i++) { p.ticks(1); if (p.out('p')) on++; }
  ok(on >= 19 && on <= 21, 'Pulse 1 s stays on ~20 ticks after a tap', on + ' ticks');
}
// Wiring is not an edge; gates; SR from NOR gates (feedback loop)
{
  const b = board();
  b.node('l', 'LEVER', { value: true }); b.node('t', 'TFF'); b.ticks(2);
  b.wire('l', 0, 't', 1); b.ticks(3);
  ok(b.out('t') === false, 'connecting a wire that is already on does not flip a flip-flop');
  const g = board();
  g.node('s', 'BUTTON'); g.node('r', 'BUTTON'); g.node('n1', 'NOR'); g.node('n2', 'NOR');
  g.wire('s', 0, 'n1', 0); g.wire('n2', 0, 'n1', 1); g.wire('r', 0, 'n2', 1); g.wire('n1', 0, 'n2', 0);
  g.ticks(2); g.press('s');
  const q1 = g.out('n2'); g.ticks(5); const held = g.out('n2'); g.press('r');
  ok(q1 === true && held === true && g.out('n2') === false, 'SR latch built from two NOR gates works (feedback)');
}
// Note block counts plays
{
  const b = board();
  b.node('btn', 'BUTTON'); b.node('nb', 'NOTE', { value: 0 }); b.wire('btn', 0, 'nb', 0); b.ticks(2);
  b.press('btn'); b.press('btn');
  ok(b.sim.snapshot().s.nb.plays === 2, 'Note block plays once per press');
  ok(C.noteName(0) === 'C4' && C.noteName(13) === 'C#5' && C.parseNote('F#4') === 6 && C.parseNote('c5') === 12, 'note names');
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);

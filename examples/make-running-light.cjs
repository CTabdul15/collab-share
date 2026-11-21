// Builds examples/running-light.board.json: a light that travels across 8 lamps, then starts over.
//
// How it works (a self-starting "ring counter"):
//   - 8 D flip-flops share one clock. Each D takes the previous flip-flop's Q, so on every tick the
//     single "1" moves one place to the right (a shift register).
//   - The first D gets  NOT(Q1 OR Q2 … OR Q7) of lamps 1–7: when none of them is lit (the light is on lamp 8,
//     or nothing is lit yet), a new 1 enters on the left. So it starts by itself and never gets
//     stuck with zero or several lights.
//   - A Lever turns the clock on/off (AND gate). The Reset button clears everything; it restarts.
//
// Run:  node examples/make-running-light.cjs   (also simulates it and checks the result)
const fs = require('fs');
const path = require('path');
const C = require('../media/circuit.js');

const shapes = [];
let t = 1;
const by = 'Collab Share example';
const node = (id, kind, x, y, extra = {}) => shapes.push({ id, type: 'node', kind, x, y, by, t: t++, z: t, ...extra });
const wire = (a, ap, b, bp) => shapes.push({ id: `w-${a}.${ap}-${b}.${bp}`, type: 'wire', a: { n: a, p: ap }, b: { n: b, p: bp }, by, t: t++, z: 0 });
// DFF pins: in 0 = D, 1 = Clock, 2 = Set (top), 3 = Reset (bottom) · out 0 = Q, 1 = Q̄
const D = 0, CLK = 1, RESET = 3, Q = 0;

const N = 8, X0 = 300, DX = 210, Y_LAMP = 20, Y_FF = 170;

// Controls on the left
node('clock', 'CLOCK', 0, 150, { value: 0.25 });
node('run', 'LEVER', 0, 230, { value: true });
node('gate', 'AND', 150, 205);
node('reset', 'BUTTON', 0, 330, { value: false });
wire('clock', 0, 'gate', 0);
wire('run', 0, 'gate', 1);

// The register + lamps
for (let i = 0; i < N; i++) {
  node(`ff${i}`, 'DFF', X0 + i * DX, Y_FF);
  node(`lamp${i}`, 'LAMP', X0 + i * DX + 150 + 14 - 32, Y_LAMP, { color: '#ff3131', rot: 270 });
  wire(`ff${i}`, Q, `lamp${i}`, 0);
  wire('gate', 0, `ff${i}`, CLK);
  wire('reset', 0, `ff${i}`, RESET);
  if (i > 0) wire(`ff${i - 1}`, Q, `ff${i}`, D);
}

// Feedback: D of the first flip-flop = NOT(lamp 1 OR … OR lamp 7) — "light is at the end (or none) → send a new one".
// Built as a chain of OR gates under the row, each one picking up the flip-flop above it.
const Y_OR = Y_FF + 150;
node('or1', 'OR', X0 + DX + 100, Y_OR);
wire('ff0', Q, 'or1', 0); wire('ff1', Q, 'or1', 1);
for (let k = 2; k <= 6; k++) {
  node(`or${k}`, 'OR', X0 + k * DX + 100, Y_OR);
  wire(`or${k - 1}`, 0, `or${k}`, 0);
  wire(`ff${k}`, Q, `or${k}`, 1);
}
node('not', 'NOT', X0 + 7 * DX + 100, Y_OR);
wire('or6', 0, 'not', 0);
wire('not', 0, 'ff0', D);

shapes.push({
  id: 'note', type: 'note', x: 0, y: 460, w: 280, h: 150, color: '#ffd166', by, t: t++, z: t,
  text: 'Running light: 8 D flip-flops share one clock. Each D takes the previous Q, so the light moves one lamp per tick. ' +
    'The first D = NOT(lamps 1-7): a new light enters when it reaches the end. Lever = run/pause. Button = reset. ' +
    'Click the gear on the Clock to change the speed.',
});

// ------------------------------------------------------------------ verify with the simulator
const sim = new C.Sim();
sim.load(shapes);
const lit = () => Array.from({ length: N }, (_, i) => (sim.values.get(`ff${i}`)[0] ? '█' : '·')).join('');
const frames = [];
let last = lit();
frames.push(last);
for (let tick = 0; tick < 200 && frames.length < 20; tick++) {
  sim.step();
  const now = lit();
  if (now !== last) { frames.push(now); last = now; }
}
console.log(frames.join('\n'));
const oneHot = frames.slice(1).every((f) => (f.match(/█/g) || []).length === 1);
const order = frames.slice(1, 17).map((f) => f.indexOf('█'));
const expected = Array.from({ length: 16 }, (_, i) => i % N);
const ok = oneHot && JSON.stringify(order) === JSON.stringify(expected);
console.log(ok ? 'OK: exactly one light, moving 0→7 and starting over' : 'PROBLEM: ' + JSON.stringify(order));
if (!ok) process.exit(1);

const out = path.join(__dirname, 'running-light.board.json');
fs.writeFileSync(out, JSON.stringify({ format: 'collab-share-whiteboard', version: 1, saved: new Date().toISOString(), shapes }, null, 1));
console.log('wrote', out);

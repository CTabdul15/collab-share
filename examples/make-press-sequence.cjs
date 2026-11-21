// Builds examples/press-sequence.board.json: a fluid power demo.
//
//   Start (pushbutton, NO) ─┐
//                           OR ─ AND ─ 14 ┐
//   Auto (lever) ───────────┘     │       5/2 valve (bistable) ─ A/B ─ double-acting cylinder
//   cylinder "in" (retracted) ────┘       12 ┘                                 │ rod
//   Limit switch (pressed by the rod) ─ Delay 0.5 s ───────┘          Limit switch ◄┘
//   Stop (pushbutton, NC) ─ Pump power;  Flow control (speed knob) between valve A and cylinder A
//
// Press Start: the valve switches to P → A, the cylinder extends, its rod reaches the limit sensor,
// after 0.5 s the valve switches back (P → B) and the cylinder returns. With Auto on it keeps cycling.
// Holding Stop (an NC contact) switches the pump off.
//
// Run:  node examples/make-press-sequence.cjs   (also simulates it and checks the result)
const fs = require('fs');
const path = require('path');
const C = require('../media/circuit.js');

const shapes = [];
let t = 1;
const by = 'Collab Share example';
const node = (id, kind, x, y, extra = {}) => shapes.push({ id, type: 'node', kind, x, y, by, t: t++, z: t, ...extra });
const wire = (a, ap, b, bp) => shapes.push({ id: `w-${a}.${ap}-${b}.${bp}`, type: 'wire', a: { n: a, p: ap }, b: { n: b, p: bp }, by, t: t++, z: 0 });

// Pin numbers (see media/circuit.js)
const V_P = 0, V_14 = 1, V_12 = 2, V_A = 0, V_B = 1; // valves
const C_A = 0, C_B = 1, C_IN = 2; // cylinder: ins A/B, out 2 = retracted
const LS_NO = 0;

shapes.push({
  id: 'readme', type: 'note', x: -300, y: -190, w: 360, h: 190, color: '#ffd166', by, t: t++, z: t,
  text: 'Fluid power demo: press START (or turn AUTO on). The 5/2 valve sends pressure to A, the cylinder extends and its rod presses the limit switch. 0.5 s later the valve switches back and the cylinder returns. Turn the THROTTLE CHECK VALVE knob to change the extend speed (it slows the air/oil coming out of B; the return stroke stays fast). Hold STOP (NC contact) to stop the pump. Click the gear on a part for its settings.',
});

node('start', 'BUTTON', -300, 210, { value: false });
node('auto', 'LEVER', -300, 300, { value: false });
node('or', 'OR', -160, 250);
node('and', 'AND', 0, 300);
node('stop', 'BUTTON', -300, 480, { value: false, nc: true, color: '#e03131' });
node('pump', 'PUMP', -120, 470, { value: 100 });
node('valve', 'VALVE_5_2', 150, 330, { mode: 'bistable' });
node('cyl', 'CYL_DA', 200, 110, { bore: 40, load: 1 });
node('speed', 'FLOW_1W', 430, 225, { value: 60, mode: 'out' });
node('gauge', 'GAUGE', 470, 440, { value: 50 });
// The rod tip reaches x = 200 + 140 + 30 + 110 + 6 = 486 when fully out; the roller side starts at x − 4.
// The rod tip reaches 200 + x2 + out + stroke + plate when fully out; the sensor detects from x − 4.
node('ls', 'LIMIT', 200 + C.CYL.x2 + C.CYL.out + C.CYL.stroke + C.CYL.plate + 2, 110 + C.CYL.rodY - C.def('LIMIT').h / 2);
node('delay', 'DELAY', 740, 260, { value: 0.5 });
node('lamp', 'LAMP', 740, 80);

wire('start', 0, 'or', 0);
wire('auto', 0, 'or', 1);
wire('or', 0, 'and', 0);
wire('cyl', C_IN, 'and', 1);
wire('and', 0, 'valve', V_14);
wire('stop', 0, 'pump', 0);
wire('pump', 0, 'valve', V_P);
wire('valve', V_A, 'cyl', C_A);
wire('valve', V_B, 'speed', 0);
wire('speed', 0, 'cyl', C_B);
wire('valve', V_A, 'gauge', 0);
wire('ls', LS_NO, 'delay', 0);
wire('ls', LS_NO, 'lamp', 0);
wire('delay', 0, 'valve', V_12);

// ------------------------------------------------------------------ check it in the simulator
const sim = new C.Sim();
const byId = new Map(shapes.map((s) => [s.id, s]));
const load = () => { for (const s of shapes) if ((s.kind === 'BUTTON' || s.kind === 'LIMIT') && s.value) sim.press(s.id); sim.load(shapes); };
const steps = (n) => { for (let i = 0; i < n; i++) sim.step(); };
const cyl = () => sim.values.get('cyl');
const expect = (cond, what) => { if (!cond) { console.error('FAIL', what); process.exit(1); } console.log('ok  ', what); };

load(); steps(20);
expect(sim.values.get('pump')[0] === 100, 'pump builds 100 bar');
expect(cyl()[C_IN] === true && cyl()[1] === 0, 'cylinder starts retracted');
byId.get('start').value = true; load(); steps(2); byId.get('start').value = false; load();
let maxPos = 0, lsSeen = false, up = 0, down = 0, last = 0;
for (let i = 0; i < 120; i++) { sim.step(); const x = cyl()[1]; if (x > last) up++; if (x < last) down++; last = x; maxPos = Math.max(maxPos, x); lsSeen ||= sim.values.get('ls')[LS_NO]; }
expect(maxPos === 100, 'Start: cylinder extends fully');
expect(up > down * 1.4, `throttle check valve (meter-out on B, 60 %): extend takes ${up} ticks, return only ${down}`);
expect(lsSeen, 'rod reaches the limit sensor');
expect(cyl()[C_IN] === true, 'after the delay it returns and stays in');
byId.get('auto').value = true; load();
let cycles = 0, wasOut = false;
for (let i = 0; i < 400; i++) { sim.step(); const out = cyl()[0]; if (out && !wasOut) cycles++; wasOut = out; }
expect(cycles >= 3, `Auto: keeps cycling (${cycles} strokes in 20 s)`);
byId.get('auto').value = false; byId.get('stop').value = true; load(); steps(30);
expect(sim.values.get('pump')[0] === 0, 'Stop (NC) switches the pump off');

byId.get('stop').value = false; byId.get('auto').value = false;
const out = path.join(__dirname, 'press-sequence.board.json');
fs.writeFileSync(out, JSON.stringify({ format: 'collab-share-whiteboard', version: 1, saved: new Date().toISOString(), shapes }, null, 1));
console.log('wrote', out);

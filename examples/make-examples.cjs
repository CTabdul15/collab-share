// Builds the extra example boards in examples/ and checks each one in the simulator:
//   traffic-light.board.json   – clock + counter + compare gates drive red / yellow / green lamps
//   counter-7seg.board.json    – push buttons count up/down on a 7-segment display
//   drum-machine.board.json    – an 8-step beat: kick, snare, hi-hat, clap and an 808 note
//   hydraulic-jog.board.json   – 4/3 valve jogged by two buttons, speed knob, gauge, end lamps
//   pressure-lockout.board.json – lever, pump, cylinder, limit sensor, 3/2 valve, two throttle check valves, gauge lockout
//
// Run:  node examples/make-examples.cjs
const fs = require('fs');
const path = require('path');
const C = require('../media/circuit.js');
require('../media/parts.js'); // extra parts + 2D physics

const by = 'Collab Share example';
function board() {
  const shapes = [];
  let t = 1;
  return {
    shapes,
    node: (id, kind, x, y, extra = {}) => shapes.push({ id, type: 'node', kind, x, y, by, t: t++, z: t, ...extra }),
    wire: (a, ap, b, bp) => shapes.push({ id: `w-${a}.${ap}-${b}.${bp}`, type: 'wire', a: { n: a, p: ap }, b: { n: b, p: bp }, by, t: t++, z: 0 }),
    note: (x, y, w, h, text) => shapes.push({ id: 'readme', type: 'note', x, y, w, h, text, color: '#ffd166', by, t: t++, z: t }),
  };
}
function simOf(shapes) {
  const sim = new C.Sim();
  const load = () => { for (const s of shapes) if ((s.kind === 'BUTTON' || s.kind === 'LIMIT') && s.value) sim.press(s.id); sim.load(shapes); };
  load();
  return { sim, load, steps: (n, each) => { for (let i = 0; i < n; i++) { sim.step(); if (each) each(i); } }, v: (id) => sim.values.get(id), i: (id) => sim.inputs.get(id) };
}
let failed = false;
const expect = (cond, what) => { console.log(cond ? 'ok  ' : 'FAIL', what); if (!cond) failed = true; };
function save(name, shapes) {
  const file = path.join(__dirname, name);
  fs.writeFileSync(file, JSON.stringify({ format: 'collab-share-whiteboard', version: 1, saved: '2026-11-21T12:00:00.000Z', shapes }, null, 1));
  console.log('wrote', file);
}

// ===================================================================== traffic light
{
  const b = board();
  b.note(-260, -150 - 40, 340, 150, 'Traffic light: the clock ticks once a second and the counter runs 0…7. Compare modules turn that into red (0–3), red + yellow (3), green (4–6) and yellow (7). Flip RUN to pause.');
  b.node('clock', 'CLOCK', -260, 0, { value: 1 });
  b.node('run', 'LEVER', -260, 80, { value: true });
  b.node('gate', 'AND', -120, 30);
  b.node('count', 'COUNTER', 10, 10, { value: 7 });
  b.node('n3', 'NUMBER', 10, 140, { value: 3 });
  b.node('n4', 'NUMBER', 10, 210, { value: 4 });
  b.node('n7', 'NUMBER', 10, 280, { value: 7 });
  b.node('red', 'LT', 230, -60);
  b.node('is3', 'EQ', 230, 40);
  b.node('is7', 'EQ', 230, 140);
  b.node('after3', 'GT', 230, 240);
  b.node('before7', 'LT', 230, 340);
  b.node('yellow', 'OR', 450, 90);
  b.node('green', 'AND', 450, 290);
  b.node('lampR', 'LAMP', 620, -40, { color: '#ff3131' });
  b.node('lampY', 'LAMP', 620, 80, { color: '#ffd166' });
  b.node('lampG', 'LAMP', 620, 280, { color: '#3cb44b' });
  b.node('disp', 'DISPLAY', 10, 360);
  b.wire('clock', 0, 'gate', 0); b.wire('run', 0, 'gate', 1); b.wire('gate', 0, 'count', 0);
  b.wire('count', 0, 'red', 0); b.wire('n4', 0, 'red', 1);
  b.wire('count', 0, 'is3', 0); b.wire('n3', 0, 'is3', 1);
  b.wire('count', 0, 'is7', 0); b.wire('n7', 0, 'is7', 1);
  b.wire('count', 0, 'after3', 0); b.wire('n3', 0, 'after3', 1);
  b.wire('count', 0, 'before7', 0); b.wire('n7', 0, 'before7', 1);
  b.wire('is3', 0, 'yellow', 0); b.wire('is7', 0, 'yellow', 1);
  b.wire('after3', 0, 'green', 0); b.wire('before7', 0, 'green', 1);
  b.wire('red', 0, 'lampR', 0); b.wire('yellow', 0, 'lampY', 0); b.wire('green', 0, 'lampG', 0);
  b.wire('count', 0, 'disp', 0);
  const s = simOf(b.shapes);
  const seen = new Map();
  s.steps(400, () => { const v = s.v('count')[0]; seen.set(v, [s.i('lampR')[0], s.i('lampY')[0], s.i('lampG')[0]].map((x) => (x ? 1 : 0)).join('')); });
  expect(seen.size === 8, 'traffic light: counter runs through 0–7');
  expect(seen.get(0) === '100' && seen.get(3) === '110' && seen.get(5) === '001' && seen.get(7) === '010', 'traffic light: red → red+yellow → green → yellow');
  save('traffic-light.board.json', b.shapes);
}

// ===================================================================== counter + 7-segment
{
  const b = board();
  b.note(-260, -150 - 40, 340, 150, 'Counter: press COUNT to add one (hold DOWN to count down). RESET goes back to 0. The lamp lights at the maximum (9; click the counter’s gear to change it).');
  b.node('btn', 'BUTTON', -260, 0, { value: false });
  b.node('down', 'LEVER', -260, 90, { value: false });
  b.node('reset', 'BUTTON', -260, 180, { value: false, color: '#4363d8' });
  b.node('count', 'COUNTER', -60, 40, { value: 9 });
  b.node('seg', 'SEG7', 160, -20);
  b.node('disp', 'DISPLAY', 160, 110);
  b.node('max', 'LAMP', 160, 200, { color: '#3cb44b' });
  b.wire('btn', 0, 'count', 0); b.wire('down', 0, 'count', 1); b.wire('reset', 0, 'count', 2);
  b.wire('count', 0, 'seg', 0); b.wire('count', 0, 'disp', 0); b.wire('count', 1, 'max', 0);
  const s = simOf(b.shapes);
  const press = (id) => { const n = b.shapes.find((x) => x.id === id); n.value = true; s.load(); s.steps(2); n.value = false; s.load(); s.steps(2); };
  for (let k = 0; k < 3; k++) press('btn');
  expect(s.v('count')[0] === 3, 'counter: three presses = 3');
  b.shapes.find((x) => x.id === 'down').value = true; s.load(); press('btn');
  expect(s.v('count')[0] === 2, 'counter: DOWN counts back');
  b.shapes.find((x) => x.id === 'down').value = false; s.load(); press('reset');
  expect(s.v('count')[0] === 0, 'counter: RESET goes to 0');
  save('counter-7seg.board.json', b.shapes);
}

// ===================================================================== drum machine
{
  const b = board();
  b.note(-280, -170 - 40, 340, 150, 'Drum machine: turn SOUND on (top bar) and flip PLAY. An 8-step counter plays kick on 1 and 5, snare on 3 and 7, a clap on 8, the 808 on 1 and a hi-hat on every step. Click the clock’s gear to change the tempo.');
  b.node('clock', 'CLOCK', -280, 0, { value: 0.25 });
  b.node('play', 'LEVER', -280, 80, { value: false });
  b.node('gate', 'AND', -150, 30);
  b.node('step', 'COUNTER', -20, 10, { value: 7 });
  b.node('n4', 'NUMBER', -20, 140, { value: 4 });
  b.node('n0', 'NUMBER', -20, 210, { value: 0 });
  b.node('n2', 'NUMBER', -20, 280, { value: 2 });
  b.node('n7', 'NUMBER', -20, 350, { value: 7 });
  b.node('beat', 'MOD', 190, 0);
  b.node('kick', 'EQ', 400, -40);
  b.node('snare', 'EQ', 400, 60);
  b.node('clap', 'EQ', 400, 160);
  b.node('first', 'EQ', 400, 260);
  b.node('drums', 'DRUMKIT', 620, -20);
  b.node('bass', 'NOTE', 620, 160, { value: 0, inst: 'bass808' });
  b.node('seg', 'SEG7', 190, 130);
  b.wire('clock', 0, 'gate', 0); b.wire('play', 0, 'gate', 1); b.wire('gate', 0, 'step', 0);
  b.wire('step', 0, 'beat', 0); b.wire('n4', 0, 'beat', 1);
  b.wire('beat', 0, 'kick', 0); b.wire('n0', 0, 'kick', 1);
  b.wire('beat', 0, 'snare', 0); b.wire('n2', 0, 'snare', 1);
  b.wire('step', 0, 'clap', 0); b.wire('n7', 0, 'clap', 1);
  b.wire('step', 0, 'first', 0); b.wire('n0', 0, 'first', 1);
  b.wire('kick', 0, 'drums', 0); b.wire('snare', 0, 'drums', 1); b.wire('gate', 0, 'drums', 2); b.wire('clap', 0, 'drums', 3);
  b.wire('first', 0, 'bass', 0);
  b.wire('step', 0, 'seg', 0);
  b.shapes.find((x) => x.id === 'play').value = true;
  const s = simOf(b.shapes);
  s.steps(5 * 8 * 8 + 5);
  const plays = s.sim.snapshot().s.drums.plays;
  const bass = s.sim.snapshot().s.bass.plays;
  expect(plays[0] >= 15 && plays[1] >= 15 && plays[2] >= 60 && plays[3] >= 7 && bass >= 7, `drum machine: kick ${plays[0]}, snare ${plays[1]}, hi-hat ${plays[2]}, clap ${plays[3]}, 808 ${bass} in 8 bars`);
  b.shapes.find((x) => x.id === 'play').value = false; // ships paused: you start it
  save('drum-machine.board.json', b.shapes);
}

// ===================================================================== hydraulic jog (4/3 valve)
{
  const b = board();
  b.note(-300, -170 - 40, 340, 150, 'Hydraulic jog: hold EXTEND or RETRACT. The 4/3 valve sends oil to A or B; let go and it springs to the center (closed), so the cylinder stops and holds. Turn the flow control knob to change the speed. The lamps show the end positions.');
  b.node('pump', 'PUMP', -300, 260, { value: 120 });
  b.node('gauge', 'GAUGE', -310, 400, { value: 100, range: 160 });
  b.node('ext', 'BUTTON', -300, 20, { value: false, color: '#3cb44b' });
  b.node('ret', 'BUTTON', -300, 120, { value: false, color: '#4363d8' });
  b.node('valve', 'VALVE_4_3', 0, 300, { center: 'closed' });
  b.node('speed', 'FLOW', 40, 130, { value: 50 });
  b.node('cyl', 'CYL_DA', 220, 0, { bore: 50, load: 2 });
  b.node('lampOut', 'LAMP', 660, -40, { color: '#3cb44b' });
  b.node('lampIn', 'LAMP', 660, 60, { color: '#4363d8' });
  b.wire('pump', 0, 'valve', 0); b.wire('pump', 0, 'gauge', 0);
  b.wire('ext', 0, 'valve', 1); b.wire('ret', 0, 'valve', 2);
  b.wire('valve', 0, 'speed', 0); b.wire('speed', 0, 'cyl', 0); b.wire('valve', 1, 'cyl', 1);
  b.wire('cyl', 0, 'lampOut', 0); b.wire('cyl', 2, 'lampIn', 0);
  const s = simOf(b.shapes);
  const hold = (id, ticks) => { const n = b.shapes.find((x) => x.id === id); n.value = true; s.load(); s.steps(ticks, () => s.sim.press(id)); n.value = false; s.load(); };
  s.steps(20);
  { const n = b.shapes.find((x) => x.id === 'ext'); n.value = true; s.load(); for (let i = 0; i < 300 && s.v('cyl')[1] < 40; i++) { s.sim.press('ext'); s.sim.step(); } n.value = false; s.load(); } // hold EXTEND until it is 40 % out
  s.steps(4);
  const mid = s.v('cyl')[1];
  s.steps(40);
  expect(mid > 10 && mid < 90 && s.v('cyl')[1] === mid, `hydraulic jog: stops and holds at ${mid} % when you let go`);
  hold('ext', 200);
  expect(s.v('cyl')[0] === true, 'hydraulic jog: EXTEND runs to the end');
  hold('ret', 200);
  expect(s.v('cyl')[2] === true, 'hydraulic jog: RETRACT goes back in');
  save('hydraulic-jog.board.json', b.shapes);
}

// ===================================================================== pressure lockout
// Lever → pump → single-acting cylinder; at the end the rod reaches the limit sensor, which opens a
// 3/2 valve. Its pressure fills slowly through a throttle check valve (meter-in) and a second one
// the other way (meter-out) into a gauge. When the gauge goes over its set pressure, a latch locks
// the lever out: the pump stops, the cylinder springs back and the gauge slowly drains to 0 bar.
// Turning the lever off resets the lock.
{
  const b = board();
  b.note(-440, -400, 400, 250, 'Pressure lockout: turn START on. The pump runs and the cylinder pushes out; at the end its rod reaches the limit sensor, which opens the 3/2 valve. The pressure fills slowly through the first throttle check valve (meter-in) into the gauge. When the gauge goes over 80 bar the lever is locked out: the pump stops, the cylinder returns and the second throttle check valve (meter-out) lets the gauge drain slowly to 0 bar. Turn START off to reset the lock. Turn the knobs to change the speeds.');
  const CYL = C.CYL;
  b.node('start', 'LEVER', -420, 20, { value: false });
  b.node('notStart', 'NOT', -420, 150);
  b.node('lock', 'SR', -280, 110);
  b.node('enable', 'AND', -60, 40);
  b.node('locked', 'LAMP', -60, 170, { color: '#ff3131' });
  b.node('pump', 'PUMP', 60, 10, { value: 100 });
  b.node('cyl', 'CYLINDER', 300, -170, { bore: 40, load: 1 });
  b.node('ls', 'LIMIT', 300 + CYL.x2 + CYL.out + CYL.stroke + CYL.plate + 2, -170 + CYL.rodY - C.def('LIMIT').h / 2);
  b.node('v32', 'VALVE_3_2', 380, 130);
  b.node('fill', 'FLOW_1W', 700, 60, { value: 40, mode: 'in' });
  b.node('drain', 'FLOW_1W', 890, 60, { value: 12, mode: 'out' });
  b.node('gauge', 'GAUGE', 1080, 30, { value: 80, range: 100 });
  b.wire('start', 0, 'enable', 0); b.wire('lock', 1, 'enable', 1);
  b.wire('start', 0, 'notStart', 0); b.wire('notStart', 0, 'lock', 1);
  b.wire('gauge', 0, 'lock', 0); b.wire('lock', 0, 'locked', 0);
  b.wire('enable', 0, 'pump', 0);
  b.wire('pump', 0, 'cyl', 0); b.wire('pump', 0, 'v32', 0);
  b.wire('ls', 0, 'v32', 1);
  b.wire('v32', 0, 'fill', 0); b.wire('fill', 0, 'drain', 0); b.wire('drain', 0, 'gauge', 0);
  const s = simOf(b.shapes);
  const lever = b.shapes.find((x) => x.id === 'start');
  s.steps(10);
  expect(s.v('pump')[0] === 0 && s.v('cyl')[2] === true, 'lockout: nothing runs while START is off');
  lever.value = true; s.load();
  let t = 0, tExtended = -1, tSensor = -1, tOver = -1, peak = 0;
  while (t < 400 && tOver < 0) {
    s.sim.step(); t++;
    if (tExtended < 0 && s.v('cyl')[0]) tExtended = t;
    if (tSensor < 0 && s.v('ls')[0]) tSensor = t;
    peak = Math.max(peak, s.i('gauge')[0]);
    if (s.v('gauge')[0]) tOver = t;
  }
  expect(tExtended > 0 && tSensor >= tExtended - 1, 'lockout: cylinder extends and its rod reaches the limit sensor (' + (tExtended / 20).toFixed(1) + ' s)');
  expect(tOver > tSensor + 10, 'lockout: gauge pressure builds up slowly to 80 bar (' + ((tOver - tSensor) / 20).toFixed(1) + ' s after the sensor)');
  s.steps(30);
  expect(s.v('lock')[0] === true && s.v('pump')[0] === 0, 'lockout: gauge over 80 bar locks the lever out and the pump stops');
  s.steps(40);
  expect(s.v('cyl')[2] === true, 'lockout: cylinder springs back');
  const g1 = s.i('gauge')[0]; s.steps(40); const g2 = s.i('gauge')[0];
  expect(g1 > 5 && g2 < g1 && g2 > 0, 'lockout: gauge drains slowly (' + Math.round(g1) + ' → ' + Math.round(g2) + ' bar in 2 s)');
  s.steps(600);
  expect(s.i('gauge')[0] < 1, 'lockout: gauge reaches 0 bar');
  expect(s.v('pump')[0] === 0, 'lockout: stays locked while START is still on');
  lever.value = false; s.load(); s.steps(5); lever.value = true; s.load(); s.steps(40);
  expect(s.v('lock')[0] === false && s.v('pump')[0] > 0, 'lockout: START off and on again resets the lock');
  lever.value = false;
  save('pressure-lockout.board.json', b.shapes);
}

// ===================================================================== physics playground
// A car driven by a joystick, a ball to push, a light barrier with a counter, a seesaw with a counterweight,
// a pendulum on a rope, a conveyor and a trampoline.
{
  const b = board();
  b.note(-640, -420, 380, 170, 'Physics playground: drag the JOYSTICK right/left to drive the car and push the ball over the light barrier (it counts). The CONVEYOR lever runs the belt. Drop a steel block on the seesaw or the trampoline and watch it bounce. Everything is real 2D physics with gravity: place wheels on a beam to build your own vehicles.');
  b.node('floor', 'BEDROCK', -660, 400, { bw: 2460, bh: 40 });
  b.node('wallL', 'BEDROCK', -700, 100, { bw: 40, bh: 340 });
  b.node('ramp', 'RAMP', 520, 320, { bw: 220, bh: 80 });
  b.node('joy', 'JOYSTICK', -640, 140);
  b.node('car', 'BEAM', -420, 318, { bw: 220, bh: 20, color: '#ef4444' });
  b.node('wf', 'WHEEL', -440, 308); b.node('wr', 'WHEEL', -240, 308);
  b.node('cab', 'STEEL', -380, 268, { bw: 70, bh: 50, color: '#ef4444' }); b.node('weld', 'WELD', -356, 307); // on the seam between cab and beam
  b.wire('joy', 0, 'wf', 0); b.wire('joy', 0, 'wr', 0);
  b.node('ball', 'BALL', 0, 300, { bw: 70, bh: 70 });
  b.node('barrier', 'DETECTOR', 220, 250, { bw: 150, bh: 26, rot: 90 });
  b.node('count', 'SEG7', 300, 120);
  b.wire('barrier', 1, 'count', 0);
  b.node('beacon', 'BEACON', 380, 110); b.wire('barrier', 0, 'beacon', 0);
  // seesaw: beam on an axle over a fixed post, counterweight on one end
  b.node('post', 'BEDROCK', 900, 330, { bw: 30, bh: 70 });
  b.node('seesaw', 'BEAM', 790, 312, { bw: 250, bh: 16, color: '#facc15' });
  b.node('pivot', 'AXLE', 904, 309);
  b.node('cw', 'COUNTERWEIGHT', 1000, 250, { bw: 36, bh: 36 });
  // pendulum
  b.node('hook', 'BEDROCK', 1180, 40, { bw: 60, bh: 20 });
  b.node('rope', 'ROPE', 1150, 120, { bw: 160, bh: 10, rot: 60 });
  b.node('bob', 'BALL', 1245, 169, { bw: 50, bh: 50, material: 'steel', color: '#9ca3af' }); // centered on the rope's lower end
  // conveyor + trampoline
  b.node('runBelt', 'LEVER', 1300, 160, { value: false });
  b.node('belt', 'CONVEYOR', 1300, 300, { bw: 240, bh: 24 });
  b.wire('runBelt', 0, 'belt', 0);
  b.node('box', 'STEEL', 1330, 230, { bw: 50, bh: 50, color: '#3b82f6' });
  b.node('tramp', 'TRAMPOLINE', 1600, 376, { bw: 140, bh: 24 });
  b.node('drop', 'BALL', 1645, 120, { bw: 44, bh: 44, color: '#22c55e' });
  const s = simOf(b.shapes);
  s.steps(30); // let everything settle
  const W = s.sim.__phys.world.bodies;
  const x0 = W.get('car').x;
  const joy = b.shapes.find((x) => x.id === 'joy');
  joy.jx = 1; s.load();
  let maxTilt = 0;
  for (let i = 0; i < 300 && W.get('ball').x < 400; i++) { s.sim.step(); maxTilt = Math.max(maxTilt, Math.abs(W.get('car').a)); }
  expect(W.get('car').x - x0 > 150 && maxTilt < 0.35, 'playground: joystick drives the car (' + Math.round(W.get('car').x - x0) + ' cm, stays level)');
  joy.jx = 0; s.load(); s.steps(60);
  expect(W.get('ball').x > 380, 'playground: the car pushes the ball across the barrier (ball at ' + Math.round(W.get('ball').x) + ')');
  expect(s.v('barrier')[1] >= 1, 'playground: light barrier counted ' + s.v('barrier')[1]);
  joy.jx = 0; s.load();
  expect(W.get('seesaw').a > 0.05, 'playground: counterweight tips the seesaw (' + Math.round((W.get('seesaw').a * 180) / Math.PI) + '°)');
  const by = W.get('drop').y;
  expect(by < 360, 'playground: the ball bounces on the trampoline');
  b.shapes.find((x) => x.id === 'runBelt').value = true; s.load();
  const bx0 = W.get('box').x; s.steps(40);
  expect(W.get('box').x - bx0 > 30, 'playground: the conveyor carries the box (' + Math.round(W.get('box').x - bx0) + ' cm)');
  b.shapes.find((x) => x.id === 'runBelt').value = false; joy.jx = 0;
  save('physics-playground.board.json', b.shapes);
}

// ===================================================================== marble run
{
  const b = board();
  b.note(-420, -260 - 60, 340, 200, 'Marble run: the ball rolls down two slopes, past a light barrier (counts and flashes the beacon) and drops onto a trampoline. The area sensor at the bottom lights the green lamp when it arrives. Move the slopes or add bumpers and try again (Ctrl+Z puts the ball back).');
  b.node('ball', 'BALL', 0, -40, { bw: 40, bh: 40, color: '#f97316' });
  b.node('slope1', 'BEDROCK', -40, 100, { bw: 380, bh: 20, rot: 12 });
  b.node('slope2', 'BEDROCK', 200, 300, { bw: 380, bh: 20, rot: 348 });
  b.node('stop', 'BUMPER', 560, 210, { bw: 40, bh: 40 });
  b.node('wall', 'BEDROCK', 620, -60, { bw: 40, bh: 640 });
  b.node('floor', 'BEDROCK', -200, 560, { bw: 900, bh: 40 });
  b.node('tramp', 'TRAMPOLINE', 60, 536, { bw: 160, bh: 24 });
  b.node('gate', 'DETECTOR', 380, 230, { bw: 140, bh: 26, rot: 90 });
  b.node('beacon', 'BEACON', 700, 140); b.wire('gate', 0, 'beacon', 0);
  b.node('hits', 'SEG7', 700, 0); b.wire('gate', 1, 'hits', 0);
  b.node('landing', 'ZONE', -200, 440, { bw: 900, bh: 120 });
  b.node('done', 'LAMP', 720, 300, { color: '#22c55e' }); b.wire('landing', 0, 'done', 0);
  const s = simOf(b.shapes);
  let seen = false; s.steps(400, () => { seen = seen || s.v('landing')[0]; });
  expect(s.v('gate')[1] >= 1, 'marble run: the ball passes the light barrier (' + s.v('gate')[1] + ')');
  expect(seen, 'marble run: the ball reaches the landing area');
  save('marble-run.board.json', b.shapes);
}

// ===================================================================== PID control loop
{
  const b = board();
  b.note(-420, -230 - 60, 340, 200, 'PID control: the slider is the setpoint, the low-pass filter is a slow "process" (like a heater). The PID controller drives it so the meter follows the slider. Watch both on the oscilloscope and change Kp / Ki with the gear.');
  b.node('set', 'SLIDER', -420, 0, { value: 70 });
  b.node('pid', 'PID', -180, -10, { kp: 1.2, ki: 0.6, kd: 0, lim: 200 });
  b.node('plant', 'LOWPASS', 60, -10, { value: 1.5 });
  b.node('meter', 'METER', 300, -40, { value: 100 });
  b.node('scope', 'SCOPE', 300, 100, { value: 100 });
  b.wire('set', 0, 'pid', 0); b.wire('pid', 0, 'plant', 0); b.wire('plant', 0, 'pid', 1);
  b.wire('plant', 0, 'meter', 0); b.wire('set', 0, 'scope', 0); b.wire('plant', 0, 'scope', 1);
  const s = simOf(b.shapes);
  s.steps(300);
  const y = s.v('plant')[0];
  expect(Math.abs(y - 70) < 3, 'pid: the process settles at the setpoint (' + y.toFixed(1) + ' / 70)');
  b.shapes.find((x) => x.id === 'set').value = 30; s.load(); s.steps(300);
  expect(Math.abs(s.v('plant')[0] - 30) < 3, 'pid: follows a new setpoint (' + s.v('plant')[0].toFixed(1) + ' / 30)');
  b.shapes.find((x) => x.id === 'set').value = 70;
  save('pid-control.board.json', b.shapes);
}

// ===================================================================== hydraulic press with a force plate
{
  const b = board();
  b.note(-460, -230 - 60, 340, 200, 'Hydraulic press: flip PRESS. The 5/2 valve sends oil to A and the cylinder presses down on the force plate. The meter shows the force in kN; the stack light turns green above 5 kN. Change the cylinder bore or the pump pressure and compare the force.');
  b.node('press', 'LEVER', -460, 60, { value: false });
  b.node('pump', 'PUMP', -460, 200, { value: 100 });
  b.node('valve', 'VALVE_5_2', -270, 220);
  b.node('cyl', 'CYL_DA', 0, 0, { rot: 90, bore: 40 });
  b.node('plate', 'NEWTON', 62, 250, { bw: 120, bh: 22, value: 5000 });
  b.node('base', 'BEDROCK', -20, 272, { bw: 280, bh: 40 });
  b.node('kN', 'DIV', 300, 120); b.node('k1000', 'NUMBER', 300, 260, { value: 1000 });
  b.wire('plate', 0, 'kN', 0); b.wire('k1000', 0, 'kN', 1);
  b.node('meter', 'METER', 520, 100, { value: 20 }); b.wire('kN', 0, 'meter', 0);
  b.node('light', 'STACKLIGHT', 700, 60); b.wire('plate', 1, 'light', 2);
  b.node('notOver', 'NOT', 560, 260); b.wire('plate', 1, 'notOver', 0); b.wire('notOver', 0, 'light', 1);
  b.wire('press', 0, 'valve', 1); b.wire('pump', 0, 'valve', 0); b.wire('valve', 0, 'cyl', 0); b.wire('valve', 1, 'cyl', 1);
  const s = simOf(b.shapes);
  s.steps(20);
  b.shapes.find((x) => x.id === 'press').value = true; s.load(); s.steps(80);
  const F = s.v('plate')[0];
  expect(F > 11000 && F < 14000, 'press: force plate reads the cylinder force (' + (F / 1000).toFixed(1) + ' kN, Ø40 at 100 bar ≈ 12.6 kN)');
  expect(s.v('plate')[1] === true, 'press: stack light green above 5 kN');
  b.shapes.find((x) => x.id === 'press').value = false;
  save('hydraulic-press.board.json', b.shapes);
}

// ===================================================================== rocket cart
{
  const b = board();
  b.note(-520, -230 - 60, 320, 200, 'Rocket cart: hit FIRE (it latches). The thruster mounted on the cart pushes it along the track; the speed sensor on the cart shows its speed. Hit FIRE again to cut the thrust. Aim the thruster by rotating it.');
  b.node('track', 'BEDROCK', -540, 400, { bw: 2600, bh: 40 });
  b.node('endStop', 'BEDROCK', 2020, 240, { bw: 40, bh: 160 });
  b.node('buffer', 'BUMPER', 1980, 340, { bw: 50, bh: 50 });
  b.node('fire', 'BUTTON', -520, 100, { latch: true, value: false, color: '#ef4444' });
  b.node('cart', 'BEAM', -300, 318, { bw: 200, bh: 20, color: '#3b82f6' });
  b.node('w1', 'WHEEL', -320, 308, { bw: 50, bh: 50 }); b.node('w2', 'WHEEL', -150, 308, { bw: 50, bh: 50 });
  b.node('jet', 'THRUSTER', -290, 315, { value: 80 });
  b.node('speed', 'SPEEDO', -180, 314);
  b.node('show', 'DISPLAY', -300, 120); b.wire('speed', 0, 'show', 0);
  b.wire('fire', 0, 'jet', 0);
  const s = simOf(b.shapes);
  s.steps(30);
  const W = s.sim.__phys.world.bodies, x0 = W.get('cart').x;
  b.shapes.find((x) => x.id === 'fire').value = true; s.load(); s.steps(80);
  expect(W.get('cart').x - x0 > 200, 'rocket: the thruster pushes the cart (' + Math.round(W.get('cart').x - x0) + ' cm in 4 s)');
  expect(s.v('speed')[0] > 50, 'rocket: speed sensor reads ' + s.v('speed')[0] + ' cm/s');
  b.shapes.find((x) => x.id === 'fire').value = false;
  save('rocket-cart.board.json', b.shapes);
}

// ===================================================================== dice
{
  const b = board();
  b.note(-420, -200 - 60, 320, 200, 'Electronic dice: hold ROLL — the randomizer runs fast; let go and it stops on 1 … 6. The RGB LED shows a random color for each throw.');
  b.node('roll', 'BUTTON', -420, 20, { value: false });
  b.node('clk', 'CLOCK', -420, 130, { value: 0.1 });
  b.node('gate', 'AND', -260, 70);
  b.node('rnd', 'RANDOM', -140, 40, { value: 5 });
  b.node('one', 'NUMBER', -140, 180, { value: 1 });
  b.node('plus', 'ADD', 80, 40);
  b.node('face', 'SEG7', 320, 0);
  b.node('r', 'RANDOM', 80, 200, { value: 1 }); b.node('g', 'RANDOM', 80, 320, { value: 1 });
  b.node('rgb', 'RGBLED', 320, 160);
  b.wire('roll', 0, 'gate', 0); b.wire('clk', 0, 'gate', 1); b.wire('gate', 0, 'rnd', 0);
  b.wire('rnd', 1, 'plus', 0); b.wire('one', 0, 'plus', 1); b.wire('plus', 0, 'face', 0);
  b.wire('gate', 0, 'r', 0); b.wire('gate', 0, 'g', 0);
  b.wire('r', 0, 'rgb', 0); b.wire('g', 0, 'rgb', 1); b.wire('rnd', 0, 'rgb', 2);
  const s = simOf(b.shapes);
  const roll = b.shapes.find((x) => x.id === 'roll'); const faces = new Set();
  roll.value = true; s.load(); s.steps(200, () => { s.sim.press('roll'); faces.add(s.v('plus')[0]); });
  roll.value = false; s.load(); s.steps(5); const v = s.v('plus')[0]; s.steps(40);
  expect([...faces].every((x) => x >= 1 && x <= 6) && faces.size >= 5, 'dice: rolls 1 … 6 while held (' + [...faces].sort().join(',') + ')');
  expect(s.v('plus')[0] === v, 'dice: stops when you let go (shows ' + v + ')');
  save('electronic-dice.board.json', b.shapes);
}

// ===================================================================== counting conveyor
{
  const b = board();
  b.note(-460, -260 - 60, 360, 200, 'Counting line: turn RUN on. The belt carries the steel parts to the end, where they fall past a light barrier that counts them. After 3 parts the line stops by itself and the stack light turns green. Reset by turning RUN off and on (or move the parts back).');
  b.node('run', 'LEVER', -460, 40, { value: false });
  b.node('belt', 'CONVEYOR', -200, 300, { bw: 420, bh: 24 });
  b.node('p1', 'STEEL', -180, 250, { bw: 44, bh: 44, color: '#ef4444' });
  b.node('p2', 'STEEL', -100, 250, { bw: 44, bh: 44, color: '#facc15' });
  b.node('p3', 'STEEL', -20, 250, { bw: 44, bh: 44, color: '#22c55e' });
  b.node('floor', 'BEDROCK', -300, 480, { bw: 900, bh: 40 });
  b.node('gate', 'DETECTOR', 240, 330, { bw: 140, bh: 26 });
  b.node('three', 'NUMBER', -200, 520, { value: 3 });
  b.node('enough', 'LT', 60, 520);
  b.wire('gate', 1, 'enough', 0); b.wire('three', 0, 'enough', 1);
  b.node('go', 'AND', -200, 120); b.wire('run', 0, 'go', 0); b.wire('enough', 0, 'go', 1); b.wire('go', 0, 'belt', 0);
  b.node('count', 'SEG7', 420, 120); b.wire('gate', 1, 'count', 0);
  b.node('light', 'STACKLIGHT', 540, 100); b.node('full', 'NOT', 420, 300);
  b.wire('enough', 0, 'full', 0); b.wire('full', 0, 'light', 2); b.wire('go', 0, 'light', 1);
  const s = simOf(b.shapes);
  s.steps(20);
  b.shapes.find((x) => x.id === 'run').value = true; s.load(); s.steps(400);
  expect(s.v('gate')[1] >= 3, 'counting line: counts the parts (' + s.v('gate')[1] + ')');
  expect(s.v('go')[0] === false, 'counting line: stops itself after 3 parts');
  b.shapes.find((x) => x.id === 'run').value = false;
  save('counting-line.board.json', b.shapes);
}

if (failed) process.exit(1);

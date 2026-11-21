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

if (failed) process.exit(1);

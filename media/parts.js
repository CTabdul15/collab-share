// Collab Share Sandbox: extra parts (mechanics, vehicles, sensors, hydraulics, logic, math, controls,
// indicators, electrical) and the glue that runs the 2D physics inside the circuit simulator.
// Shared by the host (Node) and the Sandbox page (browser).
(function (root) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const CC = node ? require('./circuit.js') : root.CollabCircuit;
  const PH = node ? require('./physics.js') : root.CollabPhysics;
  const { KINDS, B, HYD, HYD_IN, truthy, num, rising, ticksOf, TICK_MS, sizeOf } = CC;
  const DT = TICK_MS / 1000;
  const N = (n, t) => ({ n, t });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ===================================================================== physical parts (bodies)
  // body(n, size) → { shape, kind, material } in local coordinates around the part's center.
  const circleBody = (n, s, mat) => ({ shape: { type: 'circle', r: Math.min(s.w, s.h) / 2 }, kind: 'dynamic', material: n.material || mat });
  const boxBody = (n, s, mat) => ({ shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, kind: n.fixed ? 'static' : 'dynamic', material: n.material || mat });
  const MATS = 'Material (gear): steel, aluminium, wood, rubber, foam, lead or ice.';

  const PARTS = {
    // ---------------------------------------------------------------- mechanics
    STEEL: { cat: 'phys', bare: true, resizable: true, title: 'Steel Block', w: 80, h: 80, ins: [], outs: [], body: (n, s) => boxBody(n, s, 'steel'),
      help: 'Solid metal block with real physics: it falls, slides, tips over and is pushed by rods, wheels and other blocks. Resize with the corner handles, recolor with the color buttons or the fill bucket. Gear: material, rotation point (lever), fixed.' },
    BEAM: { cat: 'phys', bare: true, resizable: true, title: 'Beam', w: 240, h: 16, ins: [], outs: [], body: (n, s) => boxBody(n, s, 'aluminium'),
      help: 'Long aluminium beam: chassis for vehicles, levers (add an Axle), bridges. Resize and recolor freely.' },
    BALL: { cat: 'phys', bare: true, resizable: true, square: true, title: 'Ball', w: 48, h: 48, ins: [], outs: [], body: (n, s) => circleBody(n, s, 'rubber'),
      help: 'A ball with real 2D physics: it falls, bounces, rolls and spins, and vehicles can push it around. ' + MATS },
    WHEEL: { cat: 'phys', bare: true, resizable: true, square: true, title: 'Wheel', w: 60, h: 60, ins: [N('Drive', 'Motor speed: −10 … 10 (on = 6). Not wired: free wheel.')], outs: [],
      body: (n, s) => circleBody(n, s, 'rubber'),
      help: 'Rubber wheel. Put its center on a beam or block and it is mounted there on an axle. Drive turns its built-in motor (forward/backward). Gear: torque.' },
    COUNTERWEIGHT: { cat: 'phys', bare: true, resizable: true, title: 'Counterweight', w: 60, h: 60, ins: [], outs: [], body: (n, s) => boxBody(n, s, 'lead'),
      help: 'Heavy lead block (11 g/cm³) for balancing levers, cranes and seesaws.' },
    RAMP: { cat: 'phys', bare: true, resizable: true, title: 'Ramp', w: 200, h: 80, ins: [], outs: [],
      body: (n, s) => ({ shape: { type: 'poly', verts: PH.rampVerts(s.w, s.h) }, kind: n.loose ? 'dynamic' : 'static', material: n.material || (n.loose ? 'steel' : 'ground'), centroid: true }),
      help: 'Fixed wedge for slopes and jumps. Rotate or mirror it with the rotate buttons. Gear: loose (then it can be pushed).' },
    BEDROCK: { cat: 'phys', bare: true, resizable: true, title: 'Bedrock', w: 200, h: 40, ins: [], outs: [], body: (n, s) => ({ shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, kind: 'static', material: 'ground' }),
      help: 'Fixed ground. Never moves: floors, walls, stops. Rotate it for slopes.' },
    TRAMPOLINE: { cat: 'phys', bare: true, resizable: true, title: 'Trampoline', w: 140, h: 24, ins: [], outs: [], body: (n, s) => ({ shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, kind: 'static', material: 'rubber', rest: 0.95 }),
      help: 'Fixed elastic pad: things bounce off it almost without losing height.' },
    BUMPER: { cat: 'phys', bare: true, resizable: true, square: true, title: 'Bumper', w: 50, h: 50, ins: [], outs: [], body: (n, s) => ({ shape: { type: 'circle', r: Math.min(s.w, s.h) / 2 }, kind: 'static', material: 'rubber', rest: 0.92 }),
      help: 'Fixed round rubber bumper, like a pinball post.' },
    CONVEYOR: { cat: 'phys', bare: true, resizable: true, title: 'Conveyor Belt', w: 240, h: 24, ins: [N('Run', 'Belt speed −10 … 10 (on = 4); negative runs backwards')], outs: [],
      body: (n, s) => ({ shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, kind: 'static', material: 'rubber' }),
      help: 'Fixed belt: while Run is on, things lying on it are carried along. A number sets speed and direction.' },
    // joints and mounted actuators (drawn small, they ride on what they are attached to)
    GLUE: { cat: 'joint', bare: true, resizable: true, title: 'Glue', w: 60, h: 40, ins: [], outs: [],
      help: 'Industrial adhesive: everything that overlaps the glue patch is stuck together rigidly (several parts at once). Glue a part to bedrock to fix it in place. Resize the patch to cover the joint.' },
    AXLE: { cat: 'joint', bare: true, title: 'Axle / Hinge', w: 22, h: 22, ins: [], outs: [],
      help: 'Pin joint: place it where two parts overlap (e.g. a beam on a block) and they turn around this point. On a single part it pins it to the background.' },
    WELD: { cat: 'joint', bare: true, title: 'Weld', w: 22, h: 22, ins: [], outs: [],
      help: 'Rigid joint: place it where two parts overlap and they move as one (build chassis and frames).' },
    SERVO: { cat: 'joint', bare: true, title: 'Servo Hinge', w: 28, h: 28, ins: [N('Angle', 'Target angle in degrees (−180 … 180)')], outs: [],
      help: 'Motorized hinge: like an axle, but it turns to the angle on its input (flaps, arms, gates, steering).' },
    SPRING: { cat: 'joint', bare: true, resizable: true, title: 'Spring', w: 120, h: 18, ins: [], outs: [], value: 400,
      help: 'Damped spring between its two ends (they attach to what they touch, or to the background). Gear: stiffness. Rotate it to point it.' },
    ROPE: { cat: 'joint', bare: true, resizable: true, title: 'Rope', w: 140, h: 10, ins: [], outs: [],
      help: 'Rope between its two ends: it only pulls when tight (pendulums, cranes, towing).' },
    THRUSTER: { cat: 'joint', bare: true, title: 'Thruster', w: 44, h: 26, ins: [N('Thrust', 'Thrust 0 … 10 (on = 5)')], outs: [], value: 400,
      help: 'Jet thruster: mounts on the part under it and pushes it in the direction it points (rotate to aim). Gear: max force (N).' },
    MAGNET: { cat: 'joint', bare: true, title: 'Electromagnet', w: 56, h: 36, ins: [N('On', 'Power the magnet')], outs: [], value: 600,
      help: 'Pulls steel and lead parts within about 1.5 m while powered. Mounts on the part under it (crane magnets). Gear: strength.' },

    // ---------------------------------------------------------------- sensors
    DETECTOR: { cat: 'sens', bare: true, resizable: true, title: 'Light Barrier', w: 200, h: 34, ins: [{ n: 'Reset', at: 'bottom', t: 'Sets the count back to 0' }], outs: [B('Beam'), N('Count', 'Objects that passed')],
      help: 'Infrared light barrier: Beam turns on while something blocks the beam between emitter and receiver. Count adds one for each object passing. Resize to set the beam length.' },
    NEWTON: { cat: 'sens', bare: true, resizable: true, title: 'Force Plate', w: 120, h: 22, ins: [], outs: [N('Force', 'Force on the plate in N'), B('Over')], value: 100,
      body: (n, s) => ({ shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, kind: 'static', material: 'steel' }),
      help: 'Newton meter: measures the force pressing on its plate in newtons (weights standing on it, impacts, a cylinder rod pushing). Over turns on at the set force (gear).' },
    ZONE: { cat: 'sens', bare: true, resizable: true, title: 'Area Sensor', w: 160, h: 100, ins: [], outs: [B('Any'), N('Count', 'Objects inside')],
      help: 'Counts the moving parts whose center is inside its area. Any is on while at least one is there.' },
    SPEEDO: { cat: 'sens', bare: true, title: 'Speed Sensor', w: 44, h: 30, ins: [], outs: [N('Speed', 'cm/s'), N('Angle', 'degrees')],
      help: 'Mount it on a moving part (vehicle, ball): outputs its speed in cm/s and its tilt angle in degrees.' },
    PRESSURE_SW: { cat: 'hyd', bare: true, title: 'Pressure Switch', w: 110, h: 70, value: 50, ins: [{ ...HYD_IN('P', 'Pressure to watch'), at: 'bottom', f: 0.5 }], outs: [B('On')],
      help: 'Turns its contact on when the pressure reaches the set value (gear), off again below it.', comb: (a, n) => [num(a[0]) >= (Number(n.value) || 0) && num(a[0]) > 0] },

    // ---------------------------------------------------------------- hydraulics
    NOZZLE: { cat: 'hyd', bare: true, title: 'Air/Oil Nozzle', w: 56, h: 30, ins: [HYD_IN('P', 'Supply pressure')], outs: [], value: 1,
      help: 'Blows a jet in the direction it points: pushes parts in front of it (up to ~2.5 m), harder with more pressure. Mounts on the part under it.' },
    ACCUMULATOR: { cat: 'hyd', bare: true, title: 'Accumulator', w: 80, h: 110, ins: [{ ...HYD_IN('In', 'Charge'), at: 'bottom', f: 0.5 }, { n: 'Dump', t: 'Releases all stored pressure' }], outs: [HYD('Out', 'Stored pressure')], value: 120,
      help: 'Pressure store: charges from its input and keeps supplying pressure for a while after the pump stops (slowly losing it).',
      seq: { init: () => ({ p: 0 }), update(st, ins, prev, n) { if (truthy(ins[1])) { st.p = 0; return; } const pin = Math.max(0, num(ins[0])); st.p = pin > st.p ? st.p + (pin - st.p) * 0.08 : Math.max(0, st.p - 0.25); }, out: (st) => [Math.round(st.p * 10) / 10], show: (st) => ({ p: st.p }) } },
    RELIEF: { cat: 'hyd', bare: true, title: 'Pressure Relief', w: 100, h: 70, value: 60, ins: [HYD_IN('P', 'In')], outs: [HYD('A', 'Limited pressure')],
      help: 'Limits the pressure to the set value (gear); anything above goes back to the tank.', comb: (a, n) => [Math.min(Math.max(0, num(a[0])), Number(n.value) || 0)] },
    SHUTTLE: { cat: 'hyd', bare: true, title: 'Shuttle Valve', w: 100, h: 70, ins: [HYD_IN('X', 'Input 1'), HYD_IN('Y', 'Input 2')], outs: [HYD('A', 'Higher of the two')],
      help: 'Hydraulic OR: passes whichever input has the higher pressure.', comb: (a) => [Math.max(num(a[0]), num(a[1]), 0)] },
    TWOPRESS: { cat: 'hyd', bare: true, title: 'Two-Pressure Valve', w: 100, h: 70, ins: [HYD_IN('X', 'Input 1'), HYD_IN('Y', 'Input 2')], outs: [HYD('A', 'Lower of the two, only when both have pressure')],
      help: 'Hydraulic AND: passes pressure only when both inputs have it (the lower one).', comb: (a) => [num(a[0]) > 0 && num(a[1]) > 0 ? Math.min(num(a[0]), num(a[1])) : 0] },
    HYDMOTOR: { cat: 'hyd', bare: true, title: 'Hydraulic Motor', w: 100, h: 90, value: 10, ins: [HYD_IN('P', 'Supply')], outs: [N('RPM', 'Speed in rpm')],
      help: 'Turns oil pressure into rotation: RPM = pressure × displacement factor (gear).', comb: (a, n) => [Math.round(Math.max(0, num(a[0])) * (Number(n.value) || 10))] },

    // ---------------------------------------------------------------- logic
    RANDOM: { cat: 'mem', title: 'Randomizer', w: 150, value: 100, ins: [{ n: 'Clock', clk: true }], outs: [B('Bit'), N('Number', '0 … max')],
      help: 'Logic randomizer: on each Clock pulse (or every 0.5 s when Clock is not wired) Bit becomes a random on/off and Number a random whole number from 0 to max (gear).',
      seq: { init: () => ({ bit: false, num: 0 }), update(st, ins, prev, n, sim) { const wired = sim.feeds.has(n.id + ':0'); if (wired ? rising(ins[0], prev[0]) : sim.tick % 10 === 0) { st.bit = Math.random() < 0.5; st.num = Math.floor(Math.random() * ((Math.round(Number(n.value)) || 100) + 1)); } }, out: (st) => [st.bit, st.num], show: (st) => ({ q: st.bit, count: st.num }) } },
    EDGE: { cat: 'mem', title: 'Edge Detector', w: 150, ins: [N('In')], outs: [B('Rise'), B('Fall')],
      help: 'One-tick pulse on Rise when the input turns on, on Fall when it turns off.',
      seq: { init: () => ({ r: false, f: false }), update(st, ins, prev) { st.r = truthy(ins[0]) && !truthy(prev[0]); st.f = !truthy(ins[0]) && truthy(prev[0]); }, out: (st) => [st.r, st.f] } },
    TON: { cat: 'time', title: 'On-Delay Timer', w: 130, h: 60, value: 1, ins: [N('In')], outs: [B('Q')],
      help: 'TON: Q turns on once In has been on for the set time (gear); off as soon as In turns off.',
      seq: { init: () => ({ t: 0 }), update(st, ins) { st.t = truthy(ins[0]) ? st.t + 1 : 0; }, out: (st, n) => [st.t >= ticksOf(n.value)] } },
    TOF: { cat: 'time', title: 'Off-Delay Timer', w: 130, h: 60, value: 1, ins: [N('In')], outs: [B('Q')],
      help: 'TOF: Q turns on with In and stays on for the set time after In turns off.',
      seq: { init: () => ({ t: 1e9 }), update(st, ins) { st.t = truthy(ins[0]) ? 0 : st.t + 1; }, out: (st, n) => [st.t < ticksOf(n.value)] } },
    MUX4: { cat: 'func', title: 'Multiplexer 4:1', w: 158, ins: [N('D0'), N('D1'), N('D2'), N('D3'), N('S0', 'Select bit 0'), N('S1', 'Select bit 1')], outs: [N('Out')],
      help: 'Passes the input chosen by S1 S0 (00 → D0 … 11 → D3).', comb: (a) => [a[(truthy(a[4]) ? 1 : 0) + (truthy(a[5]) ? 2 : 0)] ?? 0] },
    DECODER: { cat: 'func', title: 'Decoder 2→4', w: 158, ins: [N('A0'), N('A1')], outs: [B('Y0'), B('Y1'), B('Y2'), B('Y3')],
      help: 'Turns on exactly one output: the one numbered by A1 A0.', comb: (a) => { const i = (truthy(a[0]) ? 1 : 0) + (truthy(a[1]) ? 2 : 0); return [0, 1, 2, 3].map((k) => k === i); } },
    SHIFT: { cat: 'mem', title: 'Shift Register 8-bit', w: 160, ins: [N('Data'), { n: 'Clock', clk: true }, { n: 'Reset', at: 'bottom' }], outs: [N('Value', '0 … 255'), B('Q0'), B('Q7')],
      help: 'On each Clock pulse all bits move one place and Data enters at Q0. Value is the whole byte.',
      seq: { init: () => ({ v: 0 }), update(st, ins, prev) { if (truthy(ins[2])) st.v = 0; else if (rising(ins[1], prev[1])) st.v = ((st.v << 1) | (truthy(ins[0]) ? 1 : 0)) & 255; }, out: (st) => [st.v, !!(st.v & 1), !!(st.v & 128)], show: (st) => ({ count: st.v }) } },
    REGISTER: { cat: 'mem', title: 'Register', w: 150, ins: [N('D', 'Value to store'), { n: 'Load', clk: true }, { n: 'Reset', at: 'bottom' }], outs: [N('Q')],
      help: 'Stores the number on D at each Load pulse and keeps it.',
      seq: { init: () => ({ v: 0 }), update(st, ins, prev) { if (truthy(ins[2])) st.v = 0; else if (rising(ins[1], prev[1])) st.v = num(ins[0]); }, out: (st) => [st.v], show: (st) => ({ count: st.v }) } },
    SCHMITT: { cat: 'func', title: 'Schmitt Trigger', w: 158, value: 60, ins: [N('In')], outs: [B('Out')],
      help: 'Comparator with hysteresis: turns on above the high level (gear), off only below the low level — no flicker around one threshold.',
      seq: { init: () => ({ q: false }), update(st, ins, prev, n) { const v = num(ins[0]), hi = Number(n.value) || 0, lo = Number(n.low ?? hi * 0.66); if (v >= hi) st.q = true; else if (v <= lo) st.q = false; }, out: (st) => [st.q] } },
    PWM: { cat: 'time', title: 'PWM Generator', w: 130, h: 60, value: 1, ins: [N('Duty', '0 … 100 %')], outs: [B('Out')],
      help: 'Square wave with the period from the gear; Duty sets how much of each period it is on (dimming, speed control).',
      seq: { init: () => ({ t: 0 }), update(st) { st.t++; }, out: (st, n, sim) => { const p = ticksOf(n.value, 2), d = clamp(num((sim.inputs.get(n.id) || [])[0]), 0, 100); return [st.t % p < (p * d) / 100]; } } },

    // ---------------------------------------------------------------- math & control
    SQRT: { cat: 'func', title: 'Square Root', w: 158, ins: [N('A')], outs: [N('√A')], comb: (a) => [Math.sqrt(Math.max(0, num(a[0])))], help: 'Output = √A (0 for negative A).' },
    POW: { cat: 'func', title: 'Power', w: 158, ins: [N('A'), N('B')], outs: [N('A^B')], comb: (a) => { const r = Math.pow(num(a[0]), num(a[1])); return [Number.isFinite(r) ? r : 0]; }, help: 'Output = A to the power B.' },
    SIN: { cat: 'func', title: 'Sine', w: 158, ins: [N('Deg', 'Angle in degrees')], outs: [N('sin'), N('cos')], comb: (a) => [Math.sin((num(a[0]) * Math.PI) / 180), Math.cos((num(a[0]) * Math.PI) / 180)], help: 'Sine and cosine of an angle in degrees.' },
    ROUND: { cat: 'func', title: 'Round', w: 158, ins: [N('A')], outs: [N('Round'), N('Floor'), N('Ceil')], comb: (a) => [Math.round(num(a[0])), Math.floor(num(a[0])), Math.ceil(num(a[0]))], help: 'Nearest whole number, rounded down and rounded up.' },
    MAP: { cat: 'func', title: 'Scale / Map', w: 158, ins: [N('Value'), N('In min'), N('In max'), N('Out min'), N('Out max')], outs: [N('Result')],
      comb: (a) => { const [v, i0, i1, o0, o1] = a.map(num); return [i1 === i0 ? o0 : o0 + ((v - i0) * (o1 - o0)) / (i1 - i0)]; }, help: 'Scales a value from one range to another, e.g. 0…1023 to 0…100 %.' },
    LOWPASS: { cat: 'func', title: 'Low-Pass Filter', w: 158, value: 0.5, ins: [N('In')], outs: [N('Out')], help: 'Smooths a value: follows the input with a time constant (gear, seconds).',
      seq: { init: () => ({ y: 0 }), update(st, ins, prev, n) { const tau = Math.max(0.05, Number(n.value) || 0.5); st.y += (num(ins[0]) - st.y) * Math.min(1, DT / tau); }, out: (st) => [Math.round(st.y * 1000) / 1000] } },
    INTEGRATOR: { cat: 'func', title: 'Integrator', w: 158, ins: [N('In'), { n: 'Reset', at: 'bottom' }], outs: [N('∫')], help: 'Adds up the input over time (per second). Reset sets it to 0.',
      seq: { init: () => ({ y: 0 }), update(st, ins) { st.y = truthy(ins[1]) ? 0 : st.y + num(ins[0]) * DT; }, out: (st) => [Math.round(st.y * 1000) / 1000] } },
    PID: { cat: 'func', title: 'PID Controller', w: 158, ins: [N('Setpoint'), N('Actual'), { n: 'Reset', at: 'bottom', t: 'Clears the integral' }], outs: [N('Output')],
      help: 'Closed-loop controller: drives Output so that Actual reaches Setpoint. Gear: Kp, Ki, Kd and output limit.',
      seq: { init: () => ({ i: 0, e: 0, y: 0 }), update(st, ins, prev, n) { if (truthy(ins[2])) { st.i = 0; st.y = 0; return; } const e = num(ins[0]) - num(ins[1]), kp = Number(n.kp ?? 1), ki = Number(n.ki ?? 0.2), kd = Number(n.kd ?? 0), lim = Number(n.lim ?? 100); st.i = clamp(st.i + e * DT, -lim / Math.max(1e-6, ki || 1e-6), lim / Math.max(1e-6, ki || 1e-6)); st.y = clamp(kp * e + ki * st.i + (kd * (e - st.e)) / DT, -lim, lim); st.e = e; }, out: (st) => [Math.round(st.y * 1000) / 1000] } },
    RATELIMIT: { cat: 'func', title: 'Rate Limiter', w: 158, value: 10, ins: [N('In')], outs: [N('Out')], help: 'Follows the input, but changes at most by the set amount per second (soft start/stop).',
      seq: { init: () => ({ y: 0 }), update(st, ins, prev, n) { const r = Math.abs(Number(n.value) || 10) * DT; st.y += clamp(num(ins[0]) - st.y, -r, r); }, out: (st) => [Math.round(st.y * 1000) / 1000] } },
    SAMPLEHOLD: { cat: 'mem', title: 'Sample & Hold', w: 150, ins: [N('In'), { n: 'Sample', clk: true }, { n: 'Reset', at: 'bottom' }], outs: [N('Out')], help: 'Takes the input value at each Sample pulse and holds it.',
      seq: { init: () => ({ v: 0 }), update(st, ins, prev) { if (truthy(ins[2])) st.v = 0; else if (rising(ins[1], prev[1])) st.v = num(ins[0]); }, out: (st) => [st.v], show: (st) => ({ count: Math.round(st.v * 100) / 100 }) } },

    // ---------------------------------------------------------------- controls
    ESTOP: { cat: 'in', bare: true, title: 'Emergency Stop', w: 90, h: 100, ins: [], outs: [B('Run'), B('Stop')],
      help: 'Latching mushroom button: click to hit it (Run off, Stop on), click again to release. Wire Run into the machine enable.', src: (n) => [!n.value, !!n.value] },
    SELECTOR: { cat: 'in', bare: true, title: 'Selector Switch', w: 96, h: 100, ins: [], outs: [N('Pos', '0, 1 or 2'), B('0'), B('1'), B('2')],
      help: 'Three-position rotary switch (e.g. Hand – Off – Auto). Click to turn it.', src: (n) => { const p = (Math.round(Number(n.value)) || 0) % 3; return [p, p === 0, p === 1, p === 2]; } },
    SLIDER: { cat: 'in', bare: true, title: 'Slider', w: 180, h: 56, ins: [], outs: [N('Value')], value: 50,
      help: 'Linear potentiometer: drag the handle; outputs 0 … max (gear).', src: (n) => [Math.round(clamp(Number(n.value) || 0, 0, Number(n.max ?? 100)) * 100) / 100] },
    JOYSTICK: { cat: 'in', bare: true, title: 'Joystick', w: 110, h: 110, ins: [], outs: [N('X', '−1 … 1'), N('Y', '−1 … 1')],
      help: 'Two-axis joystick: drag the knob; it springs back to the middle when you let go. Great for driving vehicles.', src: (n) => [clamp(Number(n.jx) || 0, -1, 1), clamp(-(Number(n.jy) || 0), -1, 1)] },

    // ---------------------------------------------------------------- indicators
    LED: { cat: 'out', bare: true, title: 'LED', w: 40, h: 52, ins: [N('In')], outs: [], help: 'Indicator LED. Recolor it with the color buttons. A number dims it (0 … 1).' },
    RGBLED: { cat: 'out', bare: true, title: 'RGB LED', w: 60, h: 70, ins: [N('R', '0 … 1'), N('G', '0 … 1'), N('B', '0 … 1')], outs: [], help: 'Mixes red, green and blue (each 0 … 1 or on/off) into any color.' },
    BARGRAPH: { cat: 'out', bare: true, title: 'Bar Graph', w: 150, h: 46, value: 10, ins: [N('Value')], outs: [], help: '10-segment LED bar: shows Value from 0 to max (gear), green → yellow → red.' },
    STACKLIGHT: { cat: 'out', bare: true, title: 'Stack Light', w: 56, h: 150, ins: [N('Red'), N('Amber'), N('Green')], outs: [], help: 'Machine signal tower: red, amber and green lamps.' },
    BEACON: { cat: 'out', bare: true, title: 'Rotating Beacon', w: 70, h: 80, ins: [N('On')], outs: [], help: 'Rotating warning light while its input is on. Recolor it with the color buttons.' },
    METER: { cat: 'out', bare: true, title: 'Panel Meter', w: 130, h: 100, value: 100, ins: [N('Value')], outs: [], help: 'Analog panel meter with a needle: 0 … full scale (gear).' },
    SCOPE: { cat: 'out', bare: true, title: 'Oscilloscope', w: 240, h: 150, value: 10, ins: [N('CH1'), N('CH2')], outs: [], help: 'Two-channel oscilloscope: plots signals over the last 10 s. Gear: vertical scale (full screen = this value).' },

    // ---------------------------------------------------------------- electrical
    RELAY: { cat: 'out', bare: true, title: 'Relay', w: 110, h: 80, ins: [N('Coil')], outs: [B('NO'), B('NC')],
      help: 'Electromechanical relay: the coil pulls the contact over after one tick. NO closes, NC opens.',
      seq: { init: () => ({ on: false }), update(st, ins) { st.on = truthy(ins[0]); }, out: (st) => [st.on, !st.on], show: (st) => ({ q: st.on }) } },
    BATTERY: { cat: 'in', bare: true, title: 'Battery', w: 100, h: 60, value: 24, ins: [], outs: [N('+', 'Voltage'), N('−', '0 V reference')],
      help: 'DC supply: + outputs its voltage (gear, e.g. 24 V), − is 0 V. Wire + to motors, lamps or Number inputs.', src: (n) => [Number(n.value) || 24, 0] },
  };
  for (const [k, p] of Object.entries(PARTS)) KINDS[k] = p;

  // ===================================================================== physics inside the simulator
  const BODY_KINDS = () => Object.keys(KINDS).filter((k) => KINDS[k].body);
  const MOUNTED = new Set(['THRUSTER', 'MAGNET', 'NOZZLE', 'SPEEDO']); // + GLUE (rides on what it holds)
  const JOINTS = new Set(['AXLE', 'WELD', 'SERVO']);
  const center = (n) => { const s = sizeOf(n); return { x: n.x + s.w / 2, y: n.y + s.h / 2 }; };
  const rad = (n) => ((n.rot || 0) * Math.PI) / 180;
  const poses = new Map(); // node id -> { x, y, a } (bodies and parts riding on them)

  function physOf(sim) {
    if (!sim.__phys) sim.__phys = { world: new PH.World(), sig: new Map(), mounts: new Map(), sensors: new Map(), rods: new Map(), base: new Map(), counts: new Map() };
    return sim.__phys;
  }
  const sigOf = (n) => JSON.stringify([n.kind, n.x, n.y, n.rot || 0, n.bw, n.bh, n.material, n.fixed, n.loose, n.pivot, n.pivX, n.pivY, n.resetAt]);

  function load(sim) {
    const P = physOf(sim), W = P.world;
    const want = new Set();
    for (const [id, n] of sim.nodes) {
      const k = KINDS[n.kind];
      if (!k.body) continue;
      want.add(id);
      const sig = sigOf(n);
      if (W.bodies.has(id) && P.sig.get(id) === sig) continue;
      const s = sizeOf(n), spec = k.body(n, s), c = center(n);
      const b = new PH.Body({ id, shape: spec.shape, kind: spec.kind, material: spec.material, rest: spec.rest, x: c.x, y: c.y, a: rad(n) });
      if (spec.kind === 'dynamic' && n.pivot && n.kind === 'STEEL') b.pivotLocal = pivotLocal(n, s);
      b.node = n.kind;
      W.bodies.delete(id); W.add(b);
      P.sig.set(id, sig); P.base.set(id, { x: c.x, y: c.y, a: rad(n) });
      for (const m of P.mounts.values()) if (m.parent === id) m.stale = true;
    }
    for (const id of [...W.bodies.keys()]) if (!want.has(id) && !id.startsWith('rod:')) { W.bodies.delete(id); P.sig.delete(id); P.base.delete(id); }
    // a light barrier that is new or was moved starts counting from 0
    if (!P.detSig) P.detSig = new Map();
    for (const [id, n] of sim.nodes) if (n.kind === 'DETECTOR') { const sg = [n.x, n.y, n.rot, n.bw, n.bh].join('|'); if (P.detSig.get(id) !== sg) { P.detSig.set(id, sg); P.counts.set(id, 0); P.sensors.delete(id); } }
    // joints, springs, mounts (rebuilt from where things are now)
    W.joints = []; W.springs = []; P.ignore = new Set(); P.wheelJoints = new Map(); P.servos = new Map();
    const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const solidAt = (pt, except) => W.bodiesAt(pt, (b) => !b.id.startsWith('rod:') && !except.includes(b.id));
    for (const [id, n] of sim.nodes) {
      const b = W.bodies.get(id);
      if (n.kind === 'STEEL' && b && b.pivotLocal) { const j = new PH.Revolute(b, null, b.toWorld(b.pivotLocal)); W.joints.push(j); }
      if (n.kind === 'WHEEL' && b) {
        // mount on the part the wheel overlaps (closest to its center), even if the center is just outside it
        let parent = null, best = Infinity;
        for (const q of W.bodies.values()) {
          if (q === b || q.kind !== 'dynamic' || q.node === 'WHEEL' || q.node === 'BALL' || q.id.startsWith('rod:')) continue;
          if (!q.contains({ x: b.x, y: b.y }) && !PH.collide(b, q).length) continue;
          const d = Math.hypot(q.x - b.x, q.y - b.y); if (d < best) { best = d; parent = q; }
        }
        const j = parent ? new PH.Revolute(parent, b, { x: b.x, y: b.y }) : null;
        if (j) { W.joints.push(j); P.ignore.add(pairKey(parent.id, id)); }
        P.wheelJoints.set(id, j);
      }
      if (JOINTS.has(n.kind)) {
        const m = P.mounts.get(id);
        const pt = m && !m.stale && W.bodies.get(m.parent) ? W.bodies.get(m.parent).toWorld(m.local) : center(n);
        const under = solidAt(pt, []).filter((q) => q.kind === 'dynamic' || q.kind === 'static');
        const dyn = under.filter((q) => q.kind === 'dynamic');
        if (!dyn.length || (n.kind === 'WELD' && dyn.length < 2)) { P.mounts.delete(id); continue; } // a weld needs two parts
        const A = dyn[0], Bd = dyn[1] || null;
        const j = n.kind === 'WELD' ? new PH.Weld(A, Bd, pt) : new PH.Revolute(A, Bd, pt);
        if (n.kind === 'SERVO') { j.target = 0; j.maxTorque = 3e6; P.servos.set(id, j); }
        W.joints.push(j);
        if (Bd) P.ignore.add(pairKey(A.id, Bd.id));
        P.mounts.set(id, { parent: A.id, local: A.toLocal(pt), relA: rad(n) - A.a });
      }
      if (MOUNTED.has(n.kind)) {
        const m = P.mounts.get(id);
        if (m && !m.stale && W.bodies.get(m.parent)) continue;
        const pt = center(n), parent = solidAt(pt, []).find((q) => q.kind === 'dynamic');
        if (parent) P.mounts.set(id, { parent: parent.id, local: parent.toLocal(pt), relA: rad(n) - parent.a }); else P.mounts.delete(id);
      }
      if (n.kind === 'SPRING' || n.kind === 'ROPE') {
        const s = sizeOf(n), c = center(n), a = rad(n), dx = Math.cos(a) * s.w / 2, dy = Math.sin(a) * s.w / 2;
        const pa = { x: c.x - dx, y: c.y - dy }, pb = { x: c.x + dx, y: c.y + dy };
        const A = solidAt(pa, []).find((q) => q.kind === 'dynamic') || null, Bb = solidAt(pb, []).find((q) => q.kind === 'dynamic' && q !== A) || null;
        if (!A && !Bb) continue;
        const sp = new PH.Spring(A, pa, Bb, pb, { rest: s.w, k: n.kind === 'ROPE' ? 4000 : Number(n.value) || 400, damp: n.kind === 'ROPE' ? 60 : 25, rope: n.kind === 'ROPE' });
        sp.id = id; W.springs.push(sp);
      }
    }
    // glue patches: weld every part they overlap to the first one (or to the background when on fixed ground)
    for (const [id, n] of sim.nodes) {
      if (n.kind !== 'GLUE') continue;
      const s = sizeOf(n), c = center(n), a = rad(n);
      const patch = new PH.Body({ id: '__glue', kind: 'static', shape: { type: 'poly', verts: PH.boxVerts(s.w, s.h) }, x: c.x, y: c.y, a });
      const touched = [...W.bodies.values()].filter((q) => !q.id.startsWith('rod:') && (PH.collide(patch, q).length || q.contains(c)));
      const dyn = touched.filter((q) => q.kind === 'dynamic'), fixed = touched.some((q) => q.kind === 'static');
      if (!dyn.length) continue;
      const first = dyn[0];
      if (fixed) W.joints.push(new PH.Weld(first, null, { x: first.x, y: first.y }));
      for (const q of dyn.slice(1)) {
        const mid = { x: (q.x + first.x) / 2, y: (q.y + first.y) / 2 };
        W.joints.push(new PH.Weld(first, q, mid));
        P.ignore.add(pairKey(first.id, q.id));
        for (const r of dyn.slice(1)) if (r !== q) P.ignore.add(pairKey(r.id, q.id));
      }
      P.mounts.set(id, { parent: first.id, local: first.toLocal(c), relA: a - first.a });
    }
    for (const id of [...P.mounts.keys()]) if (!sim.nodes.has(id)) P.mounts.delete(id);
    W.ignore = (A, B) => P.ignore.has(pairKey(A.id, B.id));
    refreshPoses(sim);
  }

  function pivotLocal(n, s) {
    const e = (v) => Math.min(10, v / 2);
    const m = { center: [s.w / 2, s.h / 2], left: [e(s.w), s.h / 2], right: [s.w - e(s.w), s.h / 2], top: [s.w / 2, e(s.h)], bottom: [s.w / 2, s.h - e(s.h)],
      custom: [(s.w * clamp(Number(n.pivX) || 0, 0, 100)) / 100, (s.h * clamp(Number(n.pivY) || 0, 0, 100)) / 100] }[n.pivot];
    return m ? { x: m[0] - s.w / 2, y: m[1] - s.h / 2 } : null;
  }

  function step(sim) {
    const P = physOf(sim), W = P.world;
    if (sim.meta && sim.meta.physics === false) return; // paused by the host
    if (!W.bodies.size && !P.rods.size) return;
    const inp = (id, i) => (sim.inputs.get(id) || [])[i];
    // cylinder rods are kinematic bodies that follow the piston
    const rodIds = new Set();
    for (const [id, n] of sim.nodes) {
      if (n.kind !== 'CYLINDER' && n.kind !== 'CYL_DA') continue;
      const st = sim.state.get(id); if (!st) continue;
      // a cylinder that was blocked only creeps forward a little each step (no jitter)
      if (!P.lim) P.lim = new Map();
      const lim = P.lim.get(id); if (lim !== undefined && st.x > lim + 0.4 / CC.CYL.stroke) st.x = lim + 0.4 / CC.CYL.stroke;
      // the front part of the rod (fixed length, ends at the tip) moves smoothly through the physics steps
      const [a, b] = CC.rodSegment(n, st.x), L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
      const seg = Math.min(L, 60), cx = b.x - (ux * seg) / 2, cy = b.y - (uy * seg) / 2, ang = Math.atan2(uy, ux), rid = 'rod:' + id;
      let rb = W.bodies.get(rid);
      if (!rb || Math.abs(rb.seg - seg) > 0.5) { W.bodies.delete(rid); rb = W.add(new PH.Body({ id: rid, kind: 'kinematic', shape: { type: 'poly', verts: PH.boxVerts(seg, 14) }, x: cx, y: cy, a: ang, material: 'steel' })); rb.seg = seg; }
      rb.vx = (cx - rb.x) / DT; rb.vy = (cy - rb.y) / DT; rb.w = 0; rb.a = ang; rb.updateWorld();
      rb.cyl = id; rodIds.add(rid);
      for (const o of W.bodies.values()) if (o.kind === 'dynamic' && o.asleep && overlap(rb, o)) o.wake();
    }
    for (const id of [...W.bodies.keys()]) if (id.startsWith('rod:') && !rodIds.has(id)) W.bodies.delete(id);
    P.rods = rodIds;
    // drives and actuators from their inputs
    const level = (v, on) => (typeof v === 'boolean' ? (v ? on : 0) : clamp(num(v), -10, 10));
    W.forces = [];
    for (const [id, n] of sim.nodes) {
      const b = W.bodies.get(id);
      if (n.kind === 'WHEEL' && b) {
        const fed = sim.feeds.has(id + ':0'), raw = fed ? level(inp(id, 0), 6) : 0, speed = typeof inp(id, 0) === 'number' && Math.abs(raw) <= 1 ? raw * 10 : raw, j = P.wheelJoints.get(id), torque = Number(n.torque) || 2e6; // a joystick (−1…1) uses the full speed range
        if (j) { j.motor = fed; j.speed = speed * 1.2; j.maxTorque = torque; } // 10 → 12 rad/s
        else if (fed && speed) W.forces.push(() => { b.torque += speed * torque * 0.02; b.wake(); }); // a free wheel (no axle) spins itself
      }
      if (n.kind === 'CONVEYOR' && b) {
        b.surface = level(inp(id, 0), 4) * 30;
        if (b.surface) for (const o of W.bodies.values()) if (o.asleep && o.box.x2 > b.box.x1 && o.box.x1 < b.box.x2 && o.box.y2 > b.box.y1 - 4 && o.box.y1 < b.box.y2) o.wake();
      }
      if (n.kind === 'SERVO') { const j = P.servos.get(id); if (j) j.target = (clamp(num(inp(id, 0)), -180, 180) * Math.PI) / 180; }
      const m = P.mounts.get(id), parent = m && W.bodies.get(m.parent);
      if (n.kind === 'THRUSTER' && parent) {
        const t = level(inp(id, 0), 5) / 10, F = (Number(n.value) || 400) * 100 * t; // 1 N = 100 kg·cm/s²
        if (t) W.forces.push(() => { const a = parent.a + m.relA, p = parent.toWorld(m.local), f = { x: Math.cos(a) * F, y: Math.sin(a) * F }; parent.fx += f.x; parent.fy += f.y; parent.torque += (p.x - parent.x) * f.y - (p.y - parent.y) * f.x; parent.wake(); });
      }
      if (n.kind === 'MAGNET' && truthy(inp(id, 0))) {
        const S = (Number(n.value) || 600) * 1e6;
        W.forces.push(() => { const p = parent ? parent.toWorld(m.local) : center(n); for (const o of W.bodies.values()) { if (o.kind !== 'dynamic' || !o.magnetic || o === parent) continue; const dx = p.x - o.x, dy = p.y - o.y, d2 = dx * dx + dy * dy; if (d2 > 150 * 150) continue; const d = Math.sqrt(d2) || 1, f = Math.min(S / Math.max(d2, 400), o.mass * 6000); o.fx += (dx / d) * f; o.fy += (dy / d) * f; o.wake(); if (parent) { parent.fx -= (dx / d) * f; parent.fy -= (dy / d) * f; } } });
      }
      if (n.kind === 'NOZZLE') {
        const pr = Math.max(0, num(inp(id, 0)));
        if (pr > 0) W.forces.push(() => { const a = parent ? parent.a + m.relA : rad(n), p = parent ? parent.toWorld(m.local) : center(n), ux = Math.cos(a), uy = Math.sin(a); for (const o of W.bodies.values()) { if (o.kind !== 'dynamic' || o === parent) continue; const dx = o.x - p.x, dy = o.y - p.y, along = dx * ux + dy * uy, side = Math.abs(-dx * uy + dy * ux); if (along < 0 || along > 250 || side > 20 + along * 0.35) continue; const f = pr * 90 * (1 - along / 250) * (Number(n.value) || 1) * 1000; o.fx += ux * f; o.fy += uy * f; o.wake(); if (parent) { parent.fx -= ux * f * 0.3; parent.fy -= uy * f * 0.3; } } });
      }
    }
    W.step(DT);
    // A rod that can't push further stops the cylinder: its tip is in something fixed, or the part it pushes is jammed
    // against something fixed (or another rod). The overlap is measured along the rod.
    for (const rid of rodIds) {
      const rb = W.bodies.get(rid), st = sim.state.get(rb.cyl), cn = sim.nodes.get(rb.cyl);
      if (!st || !cn) continue;
      if (P.lim && P.lim.has(rb.cyl) && st.x < P.lim.get(rb.cyl) - 2 / CC.CYL.stroke) P.lim.delete(rb.cyl); // retracting: free again
      const [ra, tip] = CC.rodSegment(cn, st.x), L = Math.hypot(tip.x - ra.x, tip.y - ra.y) || 1, u = { x: (tip.x - ra.x) / L, y: (tip.y - ra.y) / L };
      const inside = (o) => { if (!o.contains(tip)) return 0; let d = 0; while (d < 200 && o.contains({ x: tip.x - u.x * d, y: tip.y - u.y * d })) d += 1; return d; };
      let blocked = 0, against = null;
      for (const o of W.bodies.values()) {
        if (o === rb || o.id.startsWith('rod:')) continue;
        if (o.kind === 'static') { const d = inside(o); if (d > 1) { blocked = Math.max(blocked, d); against = o; } continue; }
        if (!overlap(rb, o)) continue;
        for (const q of W.bodies.values()) { // squeezed?
          if (q === o || q === rb || (q.kind !== 'static' && !q.id.startsWith('rod:'))) continue;
          for (const c of PH.collide(o, q)) if (c.depth > 1) { blocked = Math.max(blocked, c.depth + inside(o)); against = q; }
        }
      }
      if (blocked > 1) {
        st.x = Math.max(0, st.x - (blocked - 0.5) / CC.CYL.stroke);
        P.lim.set(rb.cyl, st.x);
        const nm = against && against.node === 'NEWTON' ? against : null;
        if (nm) P.sensors.set(nm.id + ':rod', Math.abs(st.f || 0) * 1000);
      }
    }
    // sensors
    for (const [id, n] of sim.nodes) {
      if (n.kind === 'NEWTON') {
        const b = W.bodies.get(id);
        let rodF = 0;
        if (b) for (const rid of rodIds) { const rb = W.bodies.get(rid), cn = sim.nodes.get(rb.cyl), cs = sim.state.get(rb.cyl); if (!cn || !cs) continue; const [ra, tip] = CC.rodSegment(cn, cs.x), L = Math.hypot(tip.x - ra.x, tip.y - ra.y) || 1; if (b.contains({ x: tip.x + ((tip.x - ra.x) / L) * 2, y: tip.y + ((tip.y - ra.y) / L) * 2 })) rodF += Math.max(0, cs.f || 0) * 1000; }
        const f = (b ? b.contactImpulse / DT / 100 : 0) + rodF; P.sensors.delete(id + ':rod'); const prev = P.sensors.get(id) || 0; P.sensors.set(id, prev + (f - prev) * 0.5); }
      if (n.kind === 'DETECTOR') {
        const s = sizeOf(n), c = center(n), a = rad(n), dx = Math.cos(a) * (s.w / 2 - 14), dy = Math.sin(a) * (s.w / 2 - 14);
        const pa = { x: c.x - dx, y: c.y - dy }, pb = { x: c.x + dx, y: c.y + dy };
        let hit = false;
        for (const o of W.bodies.values()) if (o.kind !== 'static' && PH.segmentHitsBody(pa, pb, o)) { hit = true; break; }
        const was = P.sensors.get(id) === true;
        if (truthy(inp(id, 0)) || (n.resetAt && P.resetSeen && P.resetSeen.get(id) !== n.resetAt)) { P.counts.set(id, 0); if (!P.resetSeen) P.resetSeen = new Map(); P.resetSeen.set(id, n.resetAt); }
        else if (hit && !was) P.counts.set(id, (P.counts.get(id) || 0) + 1);
        P.sensors.set(id, hit);
      }
      if (n.kind === 'ZONE') {
        const s = sizeOf(n);
        let cnt = 0;
        for (const o of W.bodies.values()) if (o.kind === 'dynamic' && o.x >= n.x && o.x <= n.x + s.w && o.y >= n.y && o.y <= n.y + s.h) cnt++;
        P.sensors.set(id, cnt);
      }
      if (n.kind === 'SPEEDO') {
        const m = P.mounts.get(id), b = m && W.bodies.get(m.parent);
        P.sensors.set(id, b ? [Math.round(Math.hypot(b.vx, b.vy)), Math.round(((((b.a * 180) / Math.PI) % 360) + 540) % 360 - 180)] : [0, 0]);
      }
    }
    refreshPoses(sim);
  }
  function overlap(a, b) { return !(a.box.x2 < b.box.x1 || b.box.x2 < a.box.x1 || a.box.y2 < b.box.y1 || b.box.y2 < a.box.y1) && PH.collide(a, b).length > 0; }

  function refreshPoses(sim) {
    const P = physOf(sim), W = P.world;
    poses.clear();
    for (const [id, n] of sim.nodes) {
      const b = W.bodies.get(id);
      if (b && b.kind === 'dynamic') { const base = P.base.get(id); if (base && (Math.abs(b.x - base.x) > 0.05 || Math.abs(b.y - base.y) > 0.05 || Math.abs(b.a - base.a) > 0.001)) poses.set(id, { x: b.x, y: b.y, a: b.a }); continue; }
      const m = P.mounts.get(id), pb = m && W.bodies.get(m.parent);
      if (pb && pb.kind === 'dynamic' && poses.has(pb.id)) { const p = pb.toWorld(m.local); poses.set(id, { x: p.x, y: p.y, a: pb.a + m.relA }); }
    }
    P.springEnds = new Map();
    for (const sp of W.springs) { const [a, b] = sp.ends(); P.springEnds.set(sp.id, [a.x, a.y, b.x, b.y]); }
  }

  // sensor outputs (read by the simulator like any other source)
  KINDS.NEWTON.src = (n, sim) => { const f = Math.round((physOf(sim).sensors.get(n.id) || 0) * 10) / 10; return [f, f >= (Number(n.value) || 0) && f > 0]; };
  KINDS.DETECTOR.src = (n, sim) => [physOf(sim).sensors.get(n.id) === true, physOf(sim).counts.get(n.id) || 0];
  KINDS.ZONE.src = (n, sim) => { const c = physOf(sim).sensors.get(n.id) || 0; return [c > 0, c]; };
  KINDS.SPEEDO.src = (n, sim) => physOf(sim).sensors.get(n.id) || [0, 0];

  function snapshot(sim, snap) {
    const P = physOf(sim);
    const p = {};
    for (const [id, q] of poses) p[id] = [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10, Math.round(q.a * 1000) / 1000];
    snap.p = p;
    if (sim.meta && sim.meta.physics === false) snap.off = true;
    if (P.springEnds && P.springEnds.size) { snap.sp = {}; for (const [id, e] of P.springEnds) snap.sp[id] = e.map((x) => Math.round(x * 10) / 10); }
  }

  /** Parts that were moved by physics and are at rest now: their new place, to save into the board. */
  function settled(sim) {
    const P = physOf(sim), W = P.world, out = [];
    for (const [id, n] of sim.nodes) {
      const b = W.bodies.get(id);
      if (!b || b.kind !== 'dynamic' || !b.asleep) continue;
      const base = P.base.get(id);
      if (!base || (Math.hypot(b.x - base.x, b.y - base.y) < 0.5 && Math.abs(b.a - base.a) < 0.005)) continue;
      const s = sizeOf(n);
      let rot = ((b.a * 180) / Math.PI) % 360; if (rot < 0) rot += 360;
      out.push({ id, x: Math.round((b.x - s.w / 2) * 100) / 100, y: Math.round((b.y - s.h / 2) * 100) / 100, rot: Math.round(rot * 100) / 100 });
      for (const [mid, m] of P.mounts) { // parts riding on it move along
        if (m.parent !== id) continue;
        const mn = sim.nodes.get(mid); if (!mn) continue;
        const ms = sizeOf(mn), pt = b.toWorld(m.local);
        let mr = (((b.a + m.relA) * 180) / Math.PI) % 360; if (mr < 0) mr += 360;
        out.push({ id: mid, x: Math.round((pt.x - ms.w / 2) * 100) / 100, y: Math.round((pt.y - ms.h / 2) * 100) / 100, rot: Math.round(mr * 100) / 100 });
      }
    }
    return out;
  }

  function zoneHit(zone, sim) {
    const W = physOf(sim).world;
    const pts = zone.r;
    const minx = Math.min(...pts.map((p) => p.x)), maxx = Math.max(...pts.map((p) => p.x)), miny = Math.min(...pts.map((p) => p.y)), maxy = Math.max(...pts.map((p) => p.y));
    for (const b of W.bodies.values()) {
      if (b.id.startsWith('rod:') || b.box.x2 < minx || b.box.x1 > maxx || b.box.y2 < miny || b.box.y1 > maxy) continue;
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const q = { x: minx + ((maxx - minx) * i) / 4, y: miny + ((maxy - miny) * j) / 4 }; if (zone.inside(q) && b.contains(q)) return true; }
    }
    return false;
  }

  CC.addHook({ load, step, snapshot, settled, zoneHit });
  // In the simulator process, pins of moving parts follow the physics.
  if (!CC.getPoseProvider()) CC.setPoseProvider((n) => poses.get(n.id) || null);

  const api = { PARTS, poses, physOf, MOUNTED, JOINTS };
  if (node) module.exports = api;
  else root.CollabParts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

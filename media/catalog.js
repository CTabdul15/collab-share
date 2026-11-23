// Sandbox inventory catalog + help texts (used by the inventory and the help panel).
(function (root) {
  'use strict';

  const CATEGORIES = [
    { id: 'mech', title: 'Mechanics & vehicles', color: '#94a3b8', icon: '⚙', items: ['WHEEL', 'BEAM', 'STEEL', 'BALL', 'COUNTERWEIGHT', 'RAMP', 'BEDROCK', 'CONVEYOR', 'TRAMPOLINE', 'BUMPER'] },
    { id: 'joints', title: 'Joints & actuators', color: '#f59e0b', icon: '⊕', items: ['AXLE', 'WELD', 'GLUE', 'SERVO', 'SPRING', 'ROPE', 'THRUSTER', 'MAGNET'] },
    { id: 'sensors', title: 'Sensors', color: '#14b8a6', icon: '◎', items: ['LIMIT', 'DETECTOR', 'NEWTON', 'ZONE', 'SPEEDO', 'PRESSURE_SW'] },
    { id: 'gates', title: 'Logic gates', color: '#22c55e', icon: '⋀', items: ['AND', 'OR', 'NOT', 'XOR', 'NAND', 'NOR', 'XNOR', 'BUF', 'AND3', 'OR3'] },
    { id: 'memory', title: 'Memory & digital', color: '#a855f7', icon: '⧉', items: ['SR', 'DLATCH', 'DFF', 'TFF', 'JKFF', 'COUNTER', 'RANDOM', 'EDGE', 'SHIFT', 'REGISTER', 'SAMPLEHOLD', 'MUX4', 'DECODER'] },
    { id: 'timing', title: 'Timing', color: '#06b6d4', icon: '⏱', items: ['CLOCK', 'DELAY', 'PULSE', 'TON', 'TOF', 'PWM'] },
    { id: 'inputs', title: 'Inputs & controls', color: '#eab308', icon: '◉', items: ['BUTTON', 'ESTOP', 'LEVER', 'SWITCH', 'SELECTOR', 'POT', 'SLIDER', 'JOYSTICK', 'NUMBER', 'BATTERY'] },
    { id: 'outputs', title: 'Outputs & indicators', color: '#3b82f6', icon: '◐', items: ['LAMP', 'LED', 'RGBLED', 'STACKLIGHT', 'BEACON', 'BARGRAPH', 'METER', 'SCOPE', 'DISPLAY', 'SEG7', 'MOTOR', 'RELAY'] },
    { id: 'fluid', title: 'Fluid power', color: '#f5a524', icon: '≋', items: ['PUMP', 'VALVE_3_2', 'VALVE_5_2', 'VALVE_4_3', 'VALVE', 'FLOW', 'FLOW_1W', 'CYL_DA', 'CYLINDER', 'GAUGE', 'ACCUMULATOR', 'RELIEF', 'SHUTTLE', 'TWOPRESS', 'HYDMOTOR', 'NOZZLE'] },
    { id: 'math', title: 'Math & control', color: '#10b981', icon: 'ƒ', items: ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'ABS', 'MIN', 'MAX', 'CLAMP', 'LERP', 'SELECT', 'GT', 'LT', 'EQ', 'SQRT', 'POW', 'SIN', 'ROUND', 'MAP', 'SCHMITT', 'LOWPASS', 'INTEGRATOR', 'RATELIMIT', 'PID'] },
    { id: 'sound', title: 'Sound', color: '#ec4899', icon: '♪', items: ['NOTE', 'DRUMKIT', 'BUZZER'] },
  ];


  /** Name in the inventory + what it does (for the help panel and card tooltips). */
  const HELP = {
    AND: ['AND gate', 'Output is on only when ALL inputs are on. Example: a press only runs when both safety buttons are held.'],
    OR: ['OR gate', 'Output is on when ANY input is on. Example: a lamp that lights from either of two switches.'],
    NOT: ['NOT gate (inverter)', 'Output is the opposite of the input: on becomes off, off becomes on.'],
    XOR: ['XOR gate', 'Output is on when the inputs are DIFFERENT (exactly one is on). Used for toggling and comparing bits.'],
    NAND: ['NAND gate', 'NOT-AND: output is off only when all inputs are on. Any logic can be built from NAND gates alone.'],
    NOR: ['NOR gate', 'NOT-OR: output is on only when all inputs are off.'],
    XNOR: ['XNOR gate', 'Output is on when the inputs are the SAME (both on or both off).'],
    BUF: ['Buffer', 'Passes the input straight through. Useful to tidy up wiring or show a signal.'],
    AND3: ['AND gate, 3 inputs', 'Output is on only when all three inputs are on.'],
    OR3: ['OR gate, 3 inputs', 'Output is on when any of the three inputs is on.'],
    SR: ['SR latch', 'A memory bit. Set turns Q on and it STAYS on; Reset turns it off (Reset wins if both are on). Q̄ is always the opposite of Q.'],
    DLATCH: ['D latch', 'While Enable is on, Q follows D. When Enable turns off, Q keeps its last value.'],
    DFF: ['D flip-flop', 'On each rising Clock edge, Q copies D. Set (top) and Reset (bottom) force Q on/off at any time. Build shift registers and counters with it.'],
    TFF: ['T flip-flop', 'On each rising Clock edge, Q flips (on→off→on…) while T is on. T is on when not wired, so it divides a clock by two.'],
    JKFF: ['JK flip-flop', 'On each Clock edge: J sets Q, K resets Q, both flip it, neither keeps it. Set/Reset act at once.'],
    COUNTER: ['Counter', 'Counts up by one on each rising Count edge (down while Down is on) and wraps around at its maximum. Reset goes back to 0. "At max" is on at the top value. Gear: maximum.'],
    CLOCK: ['Clock', 'Turns on and off by itself, forever. Gear: the period in seconds (0.1 s or more). Drives counters, flip-flops and blinking lamps.'],
    DELAY: ['Delay', 'Repeats its input after a delay, like a repeater. Gear: the delay in seconds.'],
    PULSE: ['Pulse', 'When the input turns on, the output stays on for a set time, then turns off (even if the input stays on). Gear: the time.'],
    BUTTON: ['Push button', 'Momentary: on while you hold it. Latching: each press switches on/off. NC (normally closed) inverts the contact, e.g. for an emergency stop. Gear: NO/NC and momentary/latching.'],
    LEVER: ['Lever', 'Click to flip it on or off. Stays where you put it.'],
    SWITCH: ['Switch', 'Click to toggle on/off. A compact version of the lever.'],
    POT: ['Speed knob', 'Electrical potentiometer: turn it (drag around it or use the mouse wheel) to output a number between min and max. Wire it to a Motor for its speed, or to a Flow Control Set input. Gear: range.'],
    NUMBER: ['Number', 'Outputs a fixed number. Gear: the value. Use it with math and compare modules.'],
    LIMIT: ['Limit sensor', 'Inductive proximity sensor. Switches when a cylinder rod (or a steel block) comes right in front of its orange face. NO is on while detecting, NC is the opposite. Click the face to test it by hand.'],
    LAMP: ['Lamp', 'Lights up while its input is on. Its color can be changed with the color buttons or the fill bucket.'],
    DISPLAY: ['Display', 'Green digital display. Gear: type a text. When the input turns on, the text appears letter by letter; off = blank. With no text, it shows the number on its input.'],
    SEG7: ['7-segment display', 'Shows the number on its input (0–9 and A–F for 10–15), like a digital clock digit.'],
    MOTOR: ['Electric motor', 'Spins while powered. A bigger number spins faster (up to 10); a negative number reverses it. Use a Speed Knob for its speed.'],
    PUMP: ['Hydraulic pump', 'Pressure supply: an electric motor drives a gear pump. Builds pressure (bar) while Power is on (or not wired). Gear: the pressure.'],
    VALVE_3_2: ['3/2 directional valve', '3 ports, 2 positions. NC: A is vented until 14 is on, then P → A. NO is the other way round. Spring return or bistable (14 / 12 switch it and it stays).'],
    VALVE_5_2: ['5/2 directional valve', '5 ports, 2 positions, for double-acting cylinders. 14: P → A and B vented. 12 (or the spring): P → B and A vented.'],
    VALVE_4_3: ['4/3 directional valve', '4 ports, 3 positions, spring centered. 14: P → A, 12: P → B, neither: center (closed holds the cylinder, float, or tandem). A number on 14 works too: +1, 0, −1.'],
    VALVE: ['2/2 shut-off valve', 'Opens P → A while Open is on, blocked otherwise.'],
    FLOW: ['Flow control', 'Two-way throttle: limits how fast a cylinder moves in both directions. Turn the knob (0–100 %). A number on Set overrides the knob.'],
    FLOW_1W: ['Throttle check valve', 'One-way flow control: in the throttled direction the pressure builds up (or drops) slowly and a cylinder moves slower; the other direction is free through the check valve. Meter-in or meter-out (gear).'],
    CYL_DA: ['Double-acting cylinder', 'Pressure on A pushes the rod out, pressure on B pulls it in. Force (kN) = pressure × piston area. The rod presses limit sensors and pushes steel blocks. Gear: bore, rod, load.'],
    CYLINDER: ['Single-acting cylinder', 'Pressure on A pushes the rod out; a spring pulls it back when the pressure is gone. Gear: bore, rod, load.'],
    GAUGE: ['Pressure gauge', 'Shows the pressure on a dial. Over turns on at or above the set pressure. Gear: set pressure and dial range.'],
    NOTE: ['Note block', 'Plays a note each time its input turns on. Gear: instrument (piano, square, phonk bell, 808…) and note.'],
    DRUMKIT: ['Drum kit', 'Each input plays its drum when it turns on: kick, snare, hi-hat, clap, cowbell.'],
    BUZZER: ['Buzzer', 'Beeps while its input is on. Gear: pitch (Hz) and wave shape.'],
    ADD: ['Add', 'Output = A + B.'], SUB: ['Subtract', 'Output = A − B.'], MUL: ['Multiply', 'Output = A × B.'],
    DIV: ['Divide', 'Output = A ÷ B (0 when B is 0).'], MOD: ['Modulo', 'Output = the remainder of A ÷ B, e.g. 7 mod 4 = 3.'],
    ABS: ['Absolute value', 'Output = the value without its sign.'], MIN: ['Min', 'Output = the smaller of A and B.'], MAX: ['Max', 'Output = the larger of A and B.'],
    CLAMP: ['Clamp', 'Keeps Value between Min and Max.'], LERP: ['Lerp', 'Blends from A (Alpha 0) to B (Alpha 1).'],
    SELECT: ['Select', 'Outputs "If true" while Condition is on, otherwise "If false".'],
    GT: ['Greater than', 'On while A > B.'], LT: ['Less than', 'On while A < B.'], EQ: ['Equal', 'On while A = B.'],
  };

  const api = { CATEGORIES, HELP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollabCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

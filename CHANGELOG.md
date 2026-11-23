# Changelog

## 1.2.3

- Fixed: resizing by dragging the corner handles did nothing (for all shapes, notes and resizable parts).
- Fixed: hitboxes and selection boxes of many modules were too short; pins of resized parts (e.g. the light barrier) now stay on the part's edge.
- Steel, lead, aluminium and bedrock no longer bounce: hard materials only make a dull impact; rubber, foam and trampolines still bounce.
- **Resets:** the light barrier, PID, sample & hold get a Reset input, the accumulator a Dump input, and every part that remembers something (counters, flip-flops, timers, filters, randomizer…) has a ↺ Reset button in its settings. A light barrier that is new or moved starts counting from 0.
- Examples: marble run displays moved off the wall, the rocket cart track has an end stop.

## 1.2.2

- Fixed: moving parts only updated on screen when something else changed (a button press). Falling, rolling and driving now show continuously for everyone.
- **Physics on/off** for the host (⋯ menu): pauses all physics for everyone; a "Physics paused" badge shows while it is off.
- **Glue**: a resizable adhesive patch that sticks every part it overlaps together, or fixes a part to bedrock.

## 1.2.1

- **6 new examples** in Open: Marble run, Rocket cart, Counting line, Hydraulic press (force plate in kN), PID control loop, Electronic dice.
- Fixed: pushing forces (thrusters, springs, magnets, nozzles) were several times too strong; thrusters now use real newtons (default 400 N).
- Fixed: a force plate kept showing the force of a cylinder resting on it only for a moment; it now shows it the whole time.

## 1.2.0

The Sandbox is now a 2D physics sandbox (side view with gravity):
- **Real 2D physics** for mechanical parts: gravity, collisions, friction, bounce, rotation, joints and motors. Moving parts are drawn smoothly; when they come to rest their new place is saved for everyone.
- **Vehicles:** put Wheels on a Beam (they mount on an axle automatically) and drive them with a signal or a Joystick. Weld parts together, add Thrusters, Servo hinges, Springs, Ropes and Electromagnets.
- **Ball** with bouncy, rolling physics (rubber, steel, foam… materials).
- **Metal pushes metal** properly: steel blocks are solid bodies that push each other, stack, tip over and are recolorable (color buttons / fill bucket). Cylinder rods push them and stop when something is jammed or fixed — two cylinders on one block simply hold.
- **New bedrock design** (engineering "fixed ground" hatch), plus ramps, trampolines, bumpers and conveyor belts.
- **Circuit-board look:** electronics are green PCBs with gold trim; hydraulics are yellowish.
- **61 new parts** — mechanics (Wheel, Beam, Ball, Counterweight, Ramp, Conveyor, Trampoline, Bumper), joints & actuators (Axle, Weld, Servo hinge, Spring, Rope, Thruster, Electromagnet), sensors (Light barrier, Force plate / newton meter, Area sensor, Speed sensor, Pressure switch), hydraulics (Nozzle, Accumulator, Pressure relief, Shuttle valve, Two-pressure valve, Hydraulic motor), logic (Randomizer, Edge detector, Shift register, Register, Sample & hold, Multiplexer, Decoder), timing (On-delay, Off-delay, PWM), math & control (Square root, Power, Sine, Round, Scale, Schmitt trigger, Low-pass, Integrator, Rate limiter, PID), controls (Emergency stop, Selector switch, Slider, Joystick, Battery) and indicators (LED, RGB LED, Stack light, Rotating beacon, Bar graph, Panel meter, Oscilloscope, Relay).
- New example: **Physics playground** (joystick car, ball, light barrier counter, seesaw, pendulum, conveyor, trampoline).

## 1.1.3

- Fixed: an open toolbar dropdown was covered by the selection bar when something was selected.

## 1.1.2

- Removed the oil flow animation: hoses turn orange as soon as they carry pressure and cylinders react right away again (no hose filling, chamber filling or moving streaks). Wires and hoses still go around parts.

## 1.1.1

- **Oil takes time:** hoses fill with oil before pressure arrives — faster with more pressure (about 4 s at 30 bar, 2 s at 100 bar, 1.3 s at 200 bar for a long hose). A cylinder then fills its chamber (you see the oil rise) and only then moves. Everyone sees the same, because it is part of the simulation.
- **Wires and hoses go around parts** instead of through them, for every pin direction and both wire styles (curved ones get smooth bends).
- **Compact toolbar:** shapes, colors and line style are small dropdowns; Fit, Save, Open, Clear and the background are in the ⋯ menu.
- **Background:** the host can also pick any custom color.
- The performance panel now sits below the toolbar, so CPU, RAM and GPU are fully readable.
- Fixed: two cylinders pushing the same blocks from both sides no longer jitter; both stop when the blocks are clamped between their rods.

## 1.1.0

The whiteboard is now the **Sandbox**:
- **Inventory** (was "Nodes"): organized into colored sections with a picture of every part and a search box; it adapts to any window size and zoom.
- **Help** button (or F1): every part explained — from the AND gate to the SR latch, valves, cylinders and blocks — with its inputs and outputs. The ? in a part's settings jumps to its entry.
- **Fluid simulation:** hydraulic oil is orange-yellow. When a pump or valve sends oil, you see it flow along the hoses (oil front and moving streaks) and into the cylinder; vented hoses drain again.
- **Physics:** new **Steel Block** (resizable, can be pushed by cylinder rods, pushes other blocks, can turn around a rotation point like a lever, or be fixed) and **Bedrock** (never moves). Where a pushed block stops is saved for everyone.
- **Background** chosen by the host for everyone: blue, black, gray or green.
- **Display** now shows a text (set with the gear) letter by letter in green digital style while its input is on.
- New look for the **electric motor** (motor with spinning pulley) and for all logic modules and gates.
- Brighter colors in the toolbar: green, red, blue, yellow and orange.
- **Performance panel** (top left): CPU and RAM of VS Code's extension host and of the device, plus GPU load where the system reports it. Turn it off with the setting `collab.performanceOverlay`.
- Fixed: snap to grid now lines up exactly with the blueprint squares.
- Fixed: the limit sensor only reacts to things right in front of its face, not to cylinders passing by its sides.

## 1.0.16

- **New example: Pressure lockout.** A lever starts the pump, the cylinder pushes out, its rod reaches the limit sensor, which opens a 3/2 valve. The pressure fills slowly through a throttle check valve (meter-in) into a gauge; over 80 bar the lever is locked out, the pump stops and a second throttle check valve (meter-out) lets the gauge drain slowly to 0 bar. Turn the lever off to reset.
- Knobs (speed knob, flow control, throttle check valve) now apply while you turn them, not only when you let go. Number fields in the settings apply while you type. One undo step goes back to the value before.
- Single-acting cylinder: the return spring is now a coil around the rod that compresses as the piston moves.

## 1.0.15

- New pump look: an electric motor (cooling fins, fan cover, terminal box with a power LED, cable to the Power pin) coupled to a gear pump with a turning gear, on a base plate, plus a pressure readout.

## 1.0.14

- **Throttle Check Valve:** the pressure behind it now builds up slowly instead of jumping to full pressure. The knob sets how fast (100 % ≈ 0.6 s, 50 % ≈ 1.3 s, 10 % ≈ 5 s); 0 % keeps it closed. Meter-in (now the default) rises slowly and drops at once; meter-out rises at once and drops slowly. A fill bar and the live pressure are shown on the valve.

## 1.0.13

- The one-way flow control is now called **Throttle Check Valve** (in the menu and on the board), its usual name.

## 1.0.12

- **One-way Flow Control** (throttle + check valve), the classic cylinder speed adjuster: it slows the flow one way and lets it pass freely the other way. Meter-out (default) slows what comes out of the cylinder port, meter-in what goes in; switch it with the gear. The knob sets the speed.
- Bigger cylinders: larger barrel, thicker rod and piston, longer stroke and bigger labels.
- The limit switch is now a **Limit Sensor**: an inductive proximity sensor with no lever. It switches when the cylinder rod comes in front of its face (with a glowing detection field and LED).
- The fluid power demo uses a one-way flow control (meter-out on B): slow extend, fast return.

## 1.0.11

- **Speed Knob** (electrical potentiometer, under Inputs): turn it to output a number (0–10 by default, range in its settings). Wire it to a Motor to set its speed, or to a Flow Control's Set input.
- Knobs now turn like real knobs: click and drag around them (or up/down near the middle). The mouse wheel still works.
- New limit switch look: metal housing, lever with a rubber roller that the cylinder rod pushes, NO/NC plate and a status LED.

## 1.0.10

- Module settings now open only with the gear button; double-clicking a module no longer opens them. (Double-click still edits the text of notes and text boxes.)

## 1.0.9

- **Settings gear** on every module that has settings (valves, cylinders, pump, gauge, flow control, buttons, limit switch, clock, delay, pulse, counter, number, note block, buzzer). One click opens its settings; double-click still works too.
- **More examples** in the whiteboard's Open button: Hydraulic jog (4/3 valve), Traffic light, Counter with 7-segment display, and Drum machine, next to the fluid power demo and the running light.

## 1.0.8

- **Fill bucket** tool (B) for the whiteboard: click inside a rectangle, ellipse, diamond or closed pen drawing to fill it with the current color. It also recolors notes, text and modules. Shift+click removes the fill.

## 1.0.7

- Fixed: the pressure gauge changed its scale to match the pump. It now keeps a fixed range like a real gauge (pick 0–10 … 0–1000 bar in its settings; by default it follows the set pressure). Above the range the needle stops at the end and the reading turns red with "over range!".

## 1.0.6

- **Flow Control (speed adjuster):** a throttle valve with a knob. Put it between a valve and a cylinder to set how fast the cylinder moves (0–100 %). Turn the knob by dragging it up/down or with the mouse wheel, or drive it with a number on its Set input.
- **Pressure gauge** redrawn like a real gauge: chrome bezel, white dial with 5 numbers (e.g. 0 / 4 / 8 / 12 / 16), a red mark at the set pressure, a black needle and a brass fitting with the P port underneath.
- The fluid power demo now has a speed knob on the extend stroke.

## 1.0.5

- New pressure gauge design: a round dial with a numbered 270° scale, a red zone above the set pressure, a needle, a digital readout and an Over light.

## 1.0.4

New fluid power system for the whiteboard, drawn like ISO 1219 circuit diagrams:
- **Directional valves:** 3/2 (NC or NO), 5/2 and 4/3 (center closed, float or tandem), plus a 2/2 shut-off valve. The switching boxes slide so the active one sits on the ports, and the open paths light up blue; blocked ports show ⊥ and exhausts show R / S / T. Pilots 14 and 12, spring return or bistable.
- **Cylinders:** single-acting (spring return) and double-acting, with bore, rod and load settings, force in kN, end-position outputs and position %. The rod sticks out of the symbol and presses limit switches it touches.
- **Limit switch** (roller lever) with NO and NC contacts. You can also hold it with the mouse.
- **Pushbutton options:** NO or NC contact, momentary or latching.
- **Pump** as an ISO pressure supply (runs on its own when Power isn't wired).
- **Port labels and tips:** every port is labeled (P, A, B, 14, 12, NO, NC…). Point at a port to see what it does, its type and its live value.
- Hydraulic lines and signal wires can't be mixed up any more: the board refuses the wrong connection and says why.
- **Inspector:** double-click a fluid part or pushbutton to change its settings and watch live values (valve position, pressures, force, stroke).
- **Examples in Open:** the whiteboard's Open button now offers the built-in examples, including a new fluid power demo (pushbuttons → OR/AND → 5/2 valve → cylinder → limit switch → delay → return stroke).

## 1.0.3

- **Hydraulics** for the whiteboard: Pump, Valve, Cylinder and Pressure Gauge, connected with blue hydraulic lines that carry pressure in bar.
- Fixed: while editing a sticky note or text, the old text showed through behind what you type.
- Fixed: module hitboxes. Zoomed out, pins no longer cover whole modules (you can grab and move small gates again), modules no longer steal clicks from nearby wires, and the closest pin is picked.

## 1.0.2

- Faster startup: Collab Share now only starts when you use it (opening its panel, running a command, or joining), instead of with every VS Code window.
- Color picker shows the real colors, and the host can type any custom hex color.

## 1.0.1

- New icon and a store page with pictures.
- Links to the GitHub repository.
- Smaller package: your own saved whiteboards are no longer included.

## 1.0.0

First public release.

- **Real-time co-editing.** The host shares a folder and friends join with an invite link: shared file tree, live typing with conflict-free merging (Yjs), and per-person undo.
- **Works over the Internet.** A free Cloudflare link with a one-click, verified download of cloudflared (host only). Local-network links are also available.
- **Presence.** Map-pin cursors with profile pictures, file highlights in the Explorer and on tabs, follow mode, and colors chosen by the host.
- **Permissions.** Read-only or read/write per person, changeable at any time by the host.
- **IntelliSense for guests** from the host's language servers: completions, hover, go to definition, references, signature help and errors, including types from the host's node_modules.
- **Blueprint whiteboard.**
  - Drawing tools, sticky notes, rotation, square or curved wires.
  - Save and open board files, or export a PNG.
  - A live logic simulator at 20 ticks per second with gates, flip-flops (D/T/JK with Set/Reset), counters, clocks, delay and pulse, buttons, levers, lamps, a motor, a 7-segment display and math nodes.
  - Sound: 9 instruments, a drum kit and a buzzer.
- The session ends for everyone when the host stops sharing or goes offline.

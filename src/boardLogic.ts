import * as vscode from 'vscode';
import * as Y from 'yjs';
// Plain JS shared with the whiteboard webview (bundled by esbuild).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const circuit = require('../media/circuit.js');

export interface SimSnapshot {
  tick: number;
  /** Output values per node id. */
  v: Record<string, unknown[]>;
  /** Input values per node id. */
  i: Record<string, unknown[]>;
  /** Visible memory per node id (flip-flop Q, counter value, note plays…). */
  s: Record<string, unknown>;
}

/**
 * Runs the whiteboard's logic circuits on the host: one simulation at 20 ticks per second for
 * everyone, so all whiteboards show the same signals and no clock pulse or button press is missed
 * or counted twice. Results are streamed to every open whiteboard; the host's own whiteboard
 * doesn't need to be open.
 */
export class BoardLogic {
  private readonly shapes: Y.Map<any>;
  private readonly sim = new circuit.Sim();
  private readonly timer: NodeJS.Timeout;
  private lastTick = 0;
  private lastSent = '';
  private readonly emitter = new vscode.EventEmitter<SimSnapshot>();
  /** Fires whenever what the whiteboards should show changes. */
  readonly onSnapshot = this.emitter.event;
  private readonly observer = (e: Y.YMapEvent<any>) => {
    for (const [key, change] of e.changes.keys) {
      const s = this.shapes.get(key);
      // A click can be shorter than a tick: remember the press so it still counts.
      if (change.action !== 'delete' && s?.kind === 'BUTTON' && s.value) this.sim.press(key);
    }
    this.reload();
  };

  constructor(doc: Y.Doc) {
    this.shapes = doc.getMap('shapes');
    this.shapes.observe(this.observer);
    this.reload();
    this.timer = setInterval(() => this.run(), circuit.TICK_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.shapes.unobserve(this.observer);
    this.emitter.dispose();
  }

  /** Latest state for a whiteboard that just opened. */
  current(): SimSnapshot {
    return this.sim.snapshot();
  }

  private reload(): void {
    this.sim.load([...this.shapes.values()]);
    this.publish();
  }

  /** Advances to the current time; catches up on ticks a slow timer missed (up to 1 s). */
  private run(): void {
    const now = Math.floor(Date.now() / circuit.TICK_MS);
    if (!this.lastTick) this.lastTick = now;
    if (this.sim.nodes.size === 0) {
      this.lastTick = now;
      return;
    }
    const n = Math.min(now - this.lastTick, 20);
    this.lastTick = now;
    for (let i = 0; i < n; i++) this.sim.step();
    if (n > 0) this.publish();
  }

  private publish(): void {
    const snap = this.sim.snapshot() as SimSnapshot;
    const key = JSON.stringify([snap.v, snap.i, snap.s]);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.emitter.fire(snap);
  }
}

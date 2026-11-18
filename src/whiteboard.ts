import * as vscode from 'vscode';
import * as Y from 'yjs';
import { randomBytes } from 'crypto';
import { parseBoard, prepareForAdd, serializeBoard } from './boardFile';

/** What the whiteboard panel needs from a host or guest session. */
export interface BoardConnection {
  /** Shared board document; shapes live in its "shapes" map (id -> shape JSON). Replaced on reset. */
  doc: Y.Doc;
  /** Fires when `doc` was replaced by a fresh copy from the host. */
  onReset?: vscode.Event<void>;
  me: { id: number; name: string; color: string };
  readOnly(): boolean;
  sendPointer(x: number, y: number): void;
  onPointer: vscode.Event<{ id: number; name: string; color: string; x: number; y: number }>;
  onReadOnlyChange: vscode.Event<boolean>;
  /** Live circuit results from the host's simulation. */
  onSim: vscode.Event<unknown>;
  /** Latest circuit results (for a whiteboard that just opened). */
  lastSim(): unknown;
}

/** Shared "blueprint" whiteboard in a webview panel, synced through Yjs like the code files. */
export class WhiteboardPanel {
  private static current: WhiteboardPanel | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private shapes: Y.Map<any>;

  static show(conn: BoardConnection, extensionUri: vscode.Uri): void {
    if (WhiteboardPanel.current?.conn === conn) {
      WhiteboardPanel.current.panel.reveal();
      return;
    }
    WhiteboardPanel.current?.panel.dispose();
    WhiteboardPanel.current = new WhiteboardPanel(conn, extensionUri);
  }

  /** Closes the panel (session ended). */
  static close(): void {
    WhiteboardPanel.current?.panel.dispose();
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly conn: BoardConnection,
    extensionUri: vscode.Uri,
  ) {
    this.shapes = conn.doc.getMap('shapes');
    this.panel = vscode.window.createWebviewPanel('collab.whiteboard', 'Blueprint Whiteboard', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.webview.html = html(this.panel.webview, extensionUri);

    const observer = () => this.post({ type: 'shapes', shapes: [...this.shapes.values()] });
    this.shapes.observe(observer);
    this.subs.push(
      new vscode.Disposable(() => this.shapes.unobserve(observer)),
      conn.onReset?.(() => {
        this.shapes.unobserve(observer);
        this.shapes = conn.doc.getMap('shapes');
        this.shapes.observe(observer);
        observer();
      }) ?? new vscode.Disposable(() => undefined),
      conn.onPointer((p) => this.post({ type: 'pointer', ...p })),
      conn.onReadOnlyChange((ro) => this.post({ type: 'readOnly', value: ro })),
      conn.onSim((sim) => this.post({ type: 'sim', sim })),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      this.panel.onDidDispose(() => {
        for (const s of this.subs) s.dispose();
        if (WhiteboardPanel.current === this) WhiteboardPanel.current = undefined;
      }),
    );
  }

  /** Saves the board as a file that can be opened again, or as a PNG picture. */
  private async save(png: string | undefined): Promise<void> {
    type Item = vscode.QuickPickItem & { id: 'board' | 'png' };
    const pick = await vscode.window.showQuickPick<Item>(
      [
        { id: 'board', label: '$(save) Whiteboard file (.board.json)', detail: 'Everything on the board, including circuits. Open it again later with "Open".' },
        { id: 'png', label: '$(file-media) Picture (.png)', detail: 'An image of the drawing, for sharing.' },
      ],
      { placeHolder: 'Save the whiteboard as…' },
    );
    if (!pick) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (pick.id === 'png') {
      if (!png) return;
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`whiteboard-${stamp}.png`), filters: { 'PNG image': ['png'] } });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      void vscode.window.setStatusBarMessage(`Saved ${target.fsPath}`, 4000);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`whiteboard-${stamp}.board.json`),
      filters: { 'Collab whiteboard': ['json'] },
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(serializeBoard([...this.shapes.values()]), 'utf8'));
    void vscode.window.setStatusBarMessage(`Saved ${target.fsPath}`, 4000);
  }

  /** Opens a saved whiteboard file: replace the board, or add it to what's there. */
  private async open(): Promise<void> {
    if (this.conn.readOnly()) {
      void vscode.window.showInformationMessage('You are read-only in this session, so you can\'t open a whiteboard file here.');
      return;
    }
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Collab whiteboard': ['json'] }, title: 'Open a whiteboard file' });
    if (!files?.[0]) return;
    let shapes: any[];
    try {
      shapes = parseBoard(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
    } catch {
      void vscode.window.showErrorMessage('That file is not a Collab Share whiteboard.');
      return;
    }
    let mode: 'replace' | 'add' = 'replace';
    if (this.shapes.size > 0) {
      const pick = await vscode.window.showQuickPick(
        [
          { id: 'replace' as const, label: '$(replace-all) Replace the board', detail: `Everyone's board is replaced with the ${shapes.length} items from the file.` },
          { id: 'add' as const, label: '$(add) Add to the board', detail: 'Keep what is there and add the file\'s items next to it.' },
        ],
        { placeHolder: `Open ${files[0].path.split('/').pop()}` },
      );
      if (!pick) return;
      mode = pick.id;
    }
    if (mode === 'add') {
      shapes = prepareForAdd([...this.shapes.values()], shapes, () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
    }
    this.conn.doc.transact(() => {
      if (mode === 'replace') this.shapes.clear();
      for (const x of shapes) this.shapes.set(x.id, x);
    }, 'local');
    void vscode.window.setStatusBarMessage(`Opened ${shapes.length} items from ${files[0].path.split('/').pop()}`, 4000);
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
        this.post({ type: 'init', me: this.conn.me, readOnly: this.conn.readOnly(), shapes: [...this.shapes.values()] });
        if (this.conn.lastSim()) this.post({ type: 'sim', sim: this.conn.lastSim() });
        return;
      case 'pointer':
        this.conn.sendPointer(Number(m.x), Number(m.y));
        return;
      case 'save':
        await this.save(typeof m.png === 'string' ? m.png : undefined);
        return;
      case 'open':
        await this.open();
        return;
    }
    if (this.conn.readOnly()) return;
    if (m?.type !== 'batch') return;
    const set = Array.isArray(m.set) ? m.set : [];
    const del = Array.isArray(m.del) ? m.del : [];
    this.conn.doc.transact(() => {
      for (const id of del) this.shapes.delete(String(id));
      for (const shape of set) if (shape && typeof shape.id === 'string') this.shapes.set(shape.id, shape);
    }, 'local');
  }
}

const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  select: svg('<path d="M3 2.5l9 5.2-4 .9 2.3 4.4-1.6.8L6.4 9.4 3.5 12z"/>'),
  hand: svg('<path d="M5.5 8V3.8a1 1 0 012 0V7.5M7.5 7V2.8a1 1 0 012 0V7M9.5 7V3.8a1 1 0 012 0V9c0 3-1.8 4.5-4 4.5S4.2 12.3 3 10.4L2 8.6a1 1 0 011.6-1.1l1.9 1.9"/>'),
  pen: svg('<path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z"/><path d="M9.5 4l2.5 2.5"/>'),
  line: svg('<path d="M3 13L13 3"/>'),
  arrow: svg('<path d="M3 13L13 3"/><path d="M7 3h6v6"/>'),
  rect: svg('<rect x="2.5" y="4" width="11" height="8" rx=".5"/>'),
  ellipse: svg('<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>'),
  diamond: svg('<path d="M8 2l6 6-6 6-6-6z"/>'),
  dim: svg('<path d="M2 5v6M14 5v6M2 8h12"/><path d="M4.5 6.5L2.5 8l2 1.5M11.5 6.5l2 1.5-2 1.5"/>'),
  text: svg('<path d="M3 4V3h10v1M8 3v10M6 13h4"/>'),
  note: svg('<path d="M3 2.5h10v7.5l-3.5 3.5H3z"/><path d="M13 10H9.5v3.5"/>'),
  eraser: svg('<path d="M6 13h7"/><path d="M2.8 9.8l6-6a1.4 1.4 0 012 0l2.4 2.4a1.4 1.4 0 010 2L8.5 12.9H5.9z"/><path d="M6.3 6.3l3.4 3.4"/>'),
  nodes: svg('<rect x="1.5" y="3" width="5" height="4" rx="1"/><rect x="9.5" y="9" width="5" height="4" rx="1"/><path d="M6.5 5c3 0 0 6 3 6"/>'),
  dash: svg('<path d="M2 8h2.5M6.75 8h2.5M11.5 8H14"/>'),
  fill: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="currentColor" fill-opacity=".35"/>'),
  snap: svg('<path d="M2 5.5h12M2 10.5h12M5.5 2v12M10.5 2v12"/>'),
  undo: svg('<path d="M5.5 4.5L2.5 7.5l3 3"/><path d="M2.5 7.5H10a3.5 3.5 0 010 7H8"/>'),
  redo: svg('<path d="M10.5 4.5l3 3-3 3"/><path d="M13.5 7.5H6a3.5 3.5 0 000 7h2"/>'),
  fit: svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  export: svg('<path d="M8 2.5v8M5 7.5l3 3 3-3"/><path d="M3 12.5v1h10v-1"/>'),
  clear: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>'),
  dup: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M11 5V3.5a1 1 0 00-1-1H3.5a1 1 0 00-1 1V10a1 1 0 001 1H5"/>'),
  front: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="currentColor" fill-opacity=".4"/><path d="M10.5 5.5v-3h-8v8h3"/>'),
  back: svg('<rect x="2.5" y="2.5" width="8" height="8" rx="1" fill="currentColor" fill-opacity=".4"/><path d="M5.5 10.5v3h8v-8h-3"/>'),
  rotl: svg('<path d="M3.5 6.5A5 5 0 1 1 3 9.5"/><path d="M3.5 2.5v4h4"/>'),
  rotr: svg('<path d="M12.5 6.5A5 5 0 1 0 13 9.5"/><path d="M12.5 2.5v4h-4"/>'),
  sound: svg('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M10.5 5.5a3.5 3.5 0 010 5M12.5 3.5a6.5 6.5 0 010 9"/>'),
  elbow: svg('<path d="M2 4h5a2 2 0 012 2v4a2 2 0 002 2h3"/><path d="M11.5 10l2.5 2-2.5 2"/>'),
  open: svg('<path d="M2 4.5V12a1 1 0 001 1h9.5l2-6H5L3 12"/><path d="M2 4.5a1 1 0 011-1h3l1.5 1.5H12a1 1 0 011 1V7"/>'),
  del: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>'),
};
const width = (n: number, w: number) =>
  `<button data-width="${n}" title="Line width ${n}"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.5 8h11" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/></svg></button>`;
const tool = (t: keyof typeof ICONS, title: string) => `<button data-tool="${t}" title="${title}">${ICONS[t]}</button>`;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const KINDS = require('../media/circuit.js').KINDS;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const nodeBtn = (k: string, label: string) => `<button data-node="${k}" title="${esc(KINDS[k]?.help ?? KINDS[k]?.title ?? label)}">${label}</button>`;

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('whiteboard.css')}">
<title>Blueprint Whiteboard</title>
</head>
<body>
<canvas id="c" tabindex="0"></canvas>
<div id="bar" class="bar">
  ${tool('select', 'Select, move, resize (V)')}
  ${tool('hand', 'Pan (H, or hold Space / right mouse)')}
  <span class="sep"></span>
  ${tool('pen', 'Pen (P)')}
  ${tool('line', 'Line (L)')}
  ${tool('arrow', 'Arrow (A)')}
  ${tool('rect', 'Rectangle (R)')}
  ${tool('ellipse', 'Ellipse (O)')}
  ${tool('diamond', 'Diamond / decision (I)')}
  ${tool('dim', 'Dimension line with length (D)')}
  ${tool('text', 'Text (T)')}
  ${tool('note', 'Sticky note (N)')}
  ${tool('eraser', 'Eraser (E)')}
  <button data-tool="nodes" title="Blueprint nodes: logic gates, Clamp, math… (G)">${ICONS.nodes}<span>Nodes</span></button>
  <span class="sep"></span>
  <button class="sw" data-color="#ffffff" style="background:#ffffff" title="White"></button>
  <button class="sw" data-color="#7fdbff" style="background:#7fdbff" title="Cyan"></button>
  <button class="sw" data-color="#ffd166" style="background:#ffd166" title="Yellow"></button>
  <button class="sw" data-color="#ff6b6b" style="background:#ff6b6b" title="Red"></button>
  <button class="sw" data-color="#8affc1" style="background:#8affc1" title="Green"></button>
  <button class="sw" data-color="#c792ea" style="background:#c792ea" title="Purple"></button>
  <input id="custom" type="color" value="#ffffff" title="Any color">
  <span class="sep"></span>
  ${width(2, 1.2)}${width(4, 2.4)}${width(8, 4.2)}
  <button id="dash" title="Dashed lines">${ICONS.dash}</button>
  <button id="fill" title="Fill shapes">${ICONS.fill}</button>
  <button id="snap" title="Snap to grid (S)">${ICONS.snap}</button>
  <button id="wirestyle" title="Square wires & arrows">${ICONS.elbow}</button>
  <button id="sound" title="Click to turn on sound">${ICONS.sound}<span>Sound</span></button>
  <span class="sep"></span>
  <button id="undo" title="Undo (Ctrl+Z)">${ICONS.undo}</button>
  <button id="redo" title="Redo (Ctrl+Y)">${ICONS.redo}</button>
  <button id="fit" title="Fit drawing to screen">${ICONS.fit}</button>
  <button id="export" title="Save / download the whiteboard (board file or PNG image)">${ICONS.export}</button>
  <button id="open" title="Open / import a saved whiteboard file">${ICONS.open}</button>
  <button id="clear" title="Clear the whole board">${ICONS.clear}<span>Clear</span></button>
</div>
<div id="selbar" class="bar">
  <span id="selcount" style="font-size:12px;padding:0 6px;opacity:.85"></span>
  <button id="dup" title="Duplicate (Ctrl+D)">${ICONS.dup}<span>Duplicate</span></button>
  <button id="front" title="Bring to front (])">${ICONS.front}</button>
  <button id="back" title="Send to back ([)">${ICONS.back}</button>
  <button id="rotl" title="Rotate left 90° (Shift+L) — or drag the round handle above the shape">${ICONS.rotl}</button>
  <button id="rotr" title="Rotate right 90° (Shift+R) — or drag the round handle above the shape">${ICONS.rotr}</button>
  <button id="del" title="Delete (Del)">${ICONS.del}<span>Delete</span></button>
</div>
<div id="nodes">
  <div><h4>Logic gates</h4><div class="grid">
    ${nodeBtn('AND', 'AND')}${nodeBtn('OR', 'OR')}${nodeBtn('NOT', 'NOT')}${nodeBtn('XOR', 'XOR')}
    ${nodeBtn('NAND', 'NAND')}${nodeBtn('NOR', 'NOR')}${nodeBtn('XNOR', 'XNOR')}${nodeBtn('BUF', 'Buffer')}
    ${nodeBtn('AND3', 'AND (3 in)')}${nodeBtn('OR3', 'OR (3 in)')}
  </div></div>
  <div><h4>Memory</h4><div class="grid one">
    ${nodeBtn('DFF', '⧉ D Flip-Flop')}${nodeBtn('TFF', '⧉ T Flip-Flop')}${nodeBtn('JKFF', '⧉ JK Flip-Flop')}
    ${nodeBtn('SR', '⧉ SR Latch')}${nodeBtn('DLATCH', '⧉ D Latch')}${nodeBtn('COUNTER', '⧉ Counter')}
  </div></div>
  <div><h4>Timing</h4><div class="grid one">
    ${nodeBtn('CLOCK', '⏱ Clock')}${nodeBtn('DELAY', '⏱ Delay')}${nodeBtn('PULSE', '⏱ Pulse')}
  </div></div>
  <div><h4>Inputs</h4><div class="grid one">
    ${nodeBtn('BUTTON', 'Push Button')}${nodeBtn('LEVER', 'Lever')}${nodeBtn('SWITCH', 'Switch')}${nodeBtn('NUMBER', 'Number')}
  </div></div>
  <div><h4>Outputs</h4><div class="grid one">
    ${nodeBtn('LAMP', 'Lamp')}${nodeBtn('MOTOR', 'Electric Motor')}${nodeBtn('SEG7', '7-Segment')}${nodeBtn('DISPLAY', 'Display')}
  </div></div>
  <div><h4>Sound</h4><div class="grid one">
    ${nodeBtn('NOTE', '♪ Note Block')}${nodeBtn('DRUMKIT', '🥁 Drum Kit')}${nodeBtn('BUZZER', '🔊 Buzzer')}
  </div></div>
  <div><h4>Math</h4><div class="grid">
    ${nodeBtn('CLAMP', 'ƒ Clamp')}${nodeBtn('LERP', 'ƒ Lerp')}${nodeBtn('ADD', 'ƒ Add')}${nodeBtn('SUB', 'ƒ Subtract')}
    ${nodeBtn('MUL', 'ƒ Multiply')}${nodeBtn('DIV', 'ƒ Divide')}${nodeBtn('MOD', 'ƒ Modulo')}${nodeBtn('ABS', 'ƒ Abs')}
    ${nodeBtn('MIN', 'ƒ Min')}${nodeBtn('MAX', 'ƒ Max')}${nodeBtn('SELECT', 'ƒ Select')}${nodeBtn('GT', 'A > B')}
    ${nodeBtn('LT', 'A < B')}${nodeBtn('EQ', 'A = B')}
  </div></div>
</div>
<div id="ro">View only — the host made you read-only</div>
<textarea id="edit" spellcheck="false"></textarea>
<div id="props"></div>
<div id="title">
  <div>Collab Share · Blueprint</div>
  <div><span>Drawn by</span><span id="authors">—</span></div>
  <div><span>Zoom <span id="scale">100%</span></span><span>Sheet 01</span></div>
</div>
<div id="hint">Drag from a node's pin to another pin to wire it · hold a Push Button, click a Lever or Switch · double-click a module to change its setting (clock speed, delay, pitch…) · double-click text, notes or numbers to edit · drag the round handle to rotate · scroll to zoom, right-drag to pan</div>
<script nonce="${nonce}" src="${media('circuit.js')}"></script>
<script nonce="${nonce}" src="${media('whiteboard.js')}"></script>
</body>
</html>`;
}

import * as vscode from 'vscode';
import { PeerInfo, PeerSnapshot, Sel } from './protocol';
import { PIN_H, PIN_W } from './pins';

interface PeerState {
  info: PeerInfo;
  path: string | null;
  sel: Sel;
  labelUntil: number;
  deco?: {
    selection: vscode.TextEditorDecorationType;
    caret: vscode.TextEditorDecorationType;
    label: vscode.TextEditorDecorationType;
    labelLeft: vscode.TextEditorDecorationType;
    pin?: vscode.TextEditorDecorationType;
    pinLeft?: vscode.TextEditorDecorationType;
    /** Identifies the color + pin image the decorations were built with. */
    key: string;
  };
}

const LABEL_MS = 3000;

/**
 * Tracks other participants: where they are, renders their cursors/selections in visible editors,
 * and supports "go to" and "follow".
 */
export class Presence implements vscode.Disposable {
  /** Supplies the map-pin image shown at a participant's cursor (set by the extension). */
  static pinIcon: ((info: PeerInfo, side: 'center' | 'left') => vscode.Uri | undefined) | undefined;
  private static readonly instances = new Set<Presence>();
  /** Re-draws cursors everywhere (a pin image or a picture finished loading). */
  static refreshAll(): void {
    for (const p of Presence.instances) p.render();
  }

  private peers = new Map<number, PeerState>();
  private followId: number | undefined;
  private revealing = 0;
  private lineTimer: NodeJS.Timeout | undefined;
  private labelTimer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly toPath: (uri: vscode.Uri) => string | undefined,
    private readonly toUri: (path: string) => vscode.Uri,
  ) {
    Presence.instances.add(this);
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      // Like Live Share: switching to another file yourself stops following.
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (this.followId === undefined || this.revealing > 0 || !ed) return;
        const p = this.peers.get(this.followId);
        if (p && this.toPath(ed.document.uri) !== p.path) {
          const name = p.info.name;
          this.follow(undefined);
          void vscode.window.setStatusBarMessage(`Stopped following ${name}`, 3000);
        }
      }),
    );
  }

  /** URI of a shared file as seen in this window. */
  uriFor(path: string): vscode.Uri {
    return this.toUri(path);
  }

  get following(): number | undefined {
    return this.followId;
  }

  list(): { info: PeerInfo; path: string | null; line: number | undefined }[] {
    return [...this.peers.values()]
      .sort((a, b) => a.info.id - b.info.id)
      .map((p) => ({ info: p.info, path: p.path, line: p.sel[0]?.[2] }));
  }

  get(id: number): PeerInfo | undefined {
    return this.peers.get(id)?.info;
  }

  addPeer(info: PeerInfo | PeerSnapshot): void {
    if (!this.peers.has(info.id)) {
      this.peers.set(info.id, { info: pickInfo(info), path: null, sel: [], labelUntil: 0 });
    }
    if ('path' in info) this.update(info.id, info.path, info.sel, false);
    this.changed.fire();
  }

  /** Updates name/permission/avatar of a participant. */
  updateInfo(info: PeerInfo): void {
    const p = this.peers.get(info.id);
    if (!p) return;
    p.info = { ...p.info, ...pickInfo(info) };
    this.render();
    this.changed.fire();
  }

  removePeer(id: number): void {
    const p = this.peers.get(id);
    if (!p) return;
    this.disposeDeco(p);
    this.peers.delete(id);
    if (this.followId === id) this.followId = undefined;
    this.changed.fire();
  }

  update(id: number, path: string | null, sel: Sel, showLabel = true): void {
    const p = this.peers.get(id);
    if (!p) return;
    const fileChanged = p.path !== path;
    p.path = typeof path === 'string' ? path : null;
    p.sel = Array.isArray(sel) ? sel.filter((s) => Array.isArray(s) && s.length === 4) : [];
    if (showLabel) {
      p.labelUntil = Date.now() + LABEL_MS;
      clearTimeout(this.labelTimer);
      this.labelTimer = setTimeout(() => this.render(), LABEL_MS + 50);
    }
    this.render();
    // File changes show at once; line numbers in the Participants list refresh a few times a second.
    if (fileChanged) this.changed.fire();
    else if (!this.lineTimer) this.lineTimer = setTimeout(() => { this.lineTimer = undefined; this.changed.fire(); }, 300);
    if (this.followId === id && p.path) void this.reveal(p, true);
  }

  async goTo(id: number): Promise<void> {
    const p = this.peers.get(id);
    if (!p) return;
    if (!p.path) {
      void vscode.window.showInformationMessage(`${p.info.name} isn't looking at a shared file right now.`);
      return;
    }
    await this.reveal(p, false);
  }

  follow(id: number | undefined): void {
    this.followId = id;
    this.changed.fire();
    if (id !== undefined) {
      const p = this.peers.get(id);
      if (p) {
        void vscode.window.setStatusBarMessage(`Following ${p.info.name}`, 3000);
        if (p.path) void this.reveal(p, true);
      }
    }
  }

  dispose(): void {
    clearTimeout(this.labelTimer);
    clearTimeout(this.lineTimer);
    Presence.instances.delete(this);
    for (const p of this.peers.values()) this.disposeDeco(p);
    this.peers.clear();
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }

  private async reveal(p: PeerState, following: boolean): Promise<void> {
    if (!p.path) return;
    const uri = this.toUri(p.path);
    this.revealing++;
    try {
      let editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== uri.toString()) {
        const doc = await vscode.workspace.openTextDocument(uri);
        editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: following });
      }
      const s = p.sel[0];
      if (s) {
        const pos = editor.document.validatePosition(new vscode.Position(s[2], s[3]));
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        if (!following) editor.selection = new vscode.Selection(pos, pos);
      }
    } catch {
      // File may have been deleted; ignore.
    } finally {
      // Editor-change events for our own reveal arrive slightly later.
      setTimeout(() => this.revealing--, 300);
    }
  }

  private render(): void {
    const now = Date.now();
    for (const editor of vscode.window.visibleTextEditors) {
      const path = this.toPath(editor.document.uri);
      for (const p of this.peers.values()) {
        const deco = this.ensureDeco(p);
        const selections: vscode.DecorationOptions[] = [];
        const carets: vscode.DecorationOptions[] = [];
        const labels: vscode.DecorationOptions[] = [];
        const pins: vscode.DecorationOptions[] = [];
        const labelsLeft: vscode.DecorationOptions[] = [];
        const pinsLeft: vscode.DecorationOptions[] = [];
        if (path !== undefined && p.path === path) {
          const doc = editor.document;
          for (const [al, ac, hl, hc] of p.sel) {
            const anchor = doc.validatePosition(new vscode.Position(al, ac));
            const active = doc.validatePosition(new vscode.Position(hl, hc));
            const hover = new vscode.MarkdownString(`**${escapeMd(p.info.name)}**`);
            if (!anchor.isEqual(active)) {
              selections.push({ range: new vscode.Range(anchor, active), hoverMessage: hover });
            }
            carets.push({ range: new vscode.Range(active, active), hoverMessage: hover });
            if (pins.length + pinsLeft.length === 0) {
              // Near the start of a line, use the pin whose tip is on its left edge so it isn't cut off.
              const col = visualColumn(doc.lineAt(active.line).text, active.character, editor.options.tabSize);
              (col < 2 ? pinsLeft : pins).push({ range: new vscode.Range(active, active), hoverMessage: hover });
            }
          }
          if (p.labelUntil > now && p.sel[0]) {
            const s = p.sel[0];
            const pos = doc.validatePosition(new vscode.Position(s[2], s[3]));
            const col = visualColumn(doc.lineAt(pos.line).text, pos.character, editor.options.tabSize);
            (col < 2 ? labelsLeft : labels).push({ range: new vscode.Range(pos, pos) });
          }
        }
        editor.setDecorations(deco.selection, selections);
        editor.setDecorations(deco.caret, carets);
        editor.setDecorations(deco.label, labels);
        editor.setDecorations(deco.labelLeft, labelsLeft);
        if (deco.pin) editor.setDecorations(deco.pin, pins);
        if (deco.pinLeft) editor.setDecorations(deco.pinLeft, pinsLeft);
      }
    }
  }

  private ensureDeco(p: PeerState) {
    const pin = Presence.pinIcon?.(p.info, 'center');
    const pinLeft = Presence.pinIcon?.(p.info, 'left');
    const key = `${p.info.color}|${p.info.name}|${pin?.toString() ?? ""}|${pinLeft?.toString() ?? ""}`;
    if (p.deco?.key === key) return p.deco;
    this.disposeDeco(p);
    const c = p.info.color;
    p.deco = {
      key,
      // Map pin with the person's picture, its tip on their cursor.
      pin: pin
        ? vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            before: {
              contentIconPath: pin,
              width: `${PIN_W}px`,
              height: `${PIN_H}px`,
              textDecoration: `none; position: absolute; z-index: 6; pointer-events: none; transform: translate(-${PIN_W / 2}px, calc(-100% + 3px));`,
            },
          })
        : undefined,
      pinLeft: pinLeft
        ? vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            before: {
              contentIconPath: pinLeft,
              width: `${PIN_W}px`,
              height: `${PIN_H}px`,
              textDecoration: `none; position: absolute; z-index: 6; pointer-events: none; transform: translate(-1px, calc(-100% + 3px));`,
            },
          })
        : undefined,
      selection: vscode.window.createTextEditorDecorationType({
        backgroundColor: c + '40',
        borderRadius: '2px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        overviewRulerColor: c,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
      }),
      caret: vscode.window.createTextEditorDecorationType({
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        overviewRulerColor: c,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
        before: {
          contentText: '​',
          // Zero-width, absolutely positioned bar so it doesn't shift the text.
          textDecoration: `none; position: absolute; display: inline-block; width: 2px; height: 1.25em; background-color: ${c}; z-index: 2; pointer-events: none;`,
        },
      }),
      label: this.labelType(p, pin ? `translate(${PIN_W / 2 + 1}px, -${PIN_H - 6}px)` : undefined),
      labelLeft: this.labelType(p, pinLeft ? `translate(${PIN_W}px, -${PIN_H - 6}px)` : undefined),
    };
    return p.deco;
  }

  /** Name tag next to the pin (or above the cursor when there is no pin). */
  private labelType(p: PeerState, besidePin: string | undefined): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: {
        contentText: p.info.name,
        color: '#ffffff',
        backgroundColor: p.info.color,
        textDecoration:
          'none; position: absolute; font-size: 0.8em; font-weight: 600; padding: 0 4px; white-space: nowrap; z-index: 7; pointer-events: none; ' +
          (besidePin ? `transform: ${besidePin}; border-radius: 3px;` : 'transform: translateY(-100%); border-radius: 3px 3px 3px 0;'),
      },
    });
  }

  private disposeDeco(p: PeerState): void {
    if (!p.deco) return;
    p.deco.selection.dispose();
    p.deco.caret.dispose();
    p.deco.label.dispose();
    p.deco.labelLeft.dispose();
    p.deco.pin?.dispose();
    p.deco.pinLeft?.dispose();
    p.deco = undefined;
  }
}

/** Reports the local user's active file and selections (throttled). */
export function trackLocalCursor(
  toPath: (uri: vscode.Uri) => string | undefined,
  send: (path: string | null, sel: Sel) => void,
): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const ed = vscode.window.activeTextEditor;
    if (!ed) return; // focus is in a panel/terminal: keep the last known position
    const path = toPath(ed.document.uri) ?? null;
    const sel: Sel = path
      ? ed.selections.map((s) => [s.anchor.line, s.anchor.character, s.active.line, s.active.character])
      : [];
    send(path, sel);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 40);
  };
  const subs = [
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
  ];
  schedule();
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    subs.forEach((s) => s.dispose());
  });
}

function pickInfo(i: PeerInfo): PeerInfo {
  return { id: i.id, name: i.name, color: i.color, isHost: i.isHost, readOnly: i.readOnly, github: i.github, pic: i.pic };
}

/** Column on screen (tabs expanded). */
function visualColumn(line: string, ch: number, tabSize: unknown): number {
  const tab = typeof tabSize === 'number' ? tabSize : 4;
  let col = 0;
  for (let i = 0; i < ch && i < line.length; i++) col = line[i] === '	' ? col + tab - (col % tab) : col + 1;
  return col;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

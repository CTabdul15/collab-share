import * as vscode from 'vscode';
import * as Y from 'yjs';
import { Connection } from './connection';
import { DocBinding } from './binding';
import { Presence, trackLocalCursor } from './presence';
import { fromB64, Msg, PeerInfo, SCHEME, toB64, Welcome } from './protocol';
import { deserializeDiagnostics } from './lang';
import { BoardConnection } from './whiteboard';

interface GuestDoc {
  path: string;
  doc: vscode.TextDocument;
  ydoc: Y.Doc;
  binding?: DocBinding;
}

/** A guest's connection to a host. Files appear under collab://<address>/<workspace name>/. */
export class GuestSession implements vscode.Disposable {
  readonly presence: Presence;
  private readonly docs = new Map<string, GuestDoc>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fsEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFiles = this.fsEmitter.event;
  private readonly endEmitter = new vscode.EventEmitter<{ byHost: boolean; reason: string }>();
  /** Fires when the session ends for any reason other than dispose(). */
  readonly onDidEnd = this.endEmitter.event;
  private readonly peersEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangePeers = this.peersEmitter.event;
  private ended = false;
  private readonly permissionEmitter = new vscode.EventEmitter<boolean>();
  private readonly selfEmitter = new vscode.EventEmitter<void>();
  private readonly picEmitter = new vscode.EventEmitter<{ id: string; mime: string; data: string }>();
  /** Fires when the host sends someone's custom picture. */
  readonly onDidReceivePicture = this.picEmitter.event;
  /** Fires when this user's own color changed. */
  readonly onDidChangeSelf = this.selfEmitter.event;
  private board: Y.Doc | undefined;
  private boardConn: BoardConnection | undefined;
  private readonly boardPointer = new vscode.EventEmitter<{ id: number; name: string; color: string; x: number; y: number }>();
  private readonly boardOpened = new vscode.EventEmitter<string>();
  /** Fires with a participant's name when they open the whiteboard. */
  readonly onDidOpenBoard = this.boardOpened.event;
  /** Fires with the new read-only state when the host changes this guest's permission. */
  readonly onDidChangePermission = this.permissionEmitter.event;
  /** Errors/warnings computed by the host's language servers. */
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('collab');

  constructor(
    readonly conn: Connection,
    readonly welcome: Welcome,
    readonly folder: vscode.Uri,
    readonly myName = 'Guest',
  ) {
    this.presence = new Presence(
      (uri) => this.toPath(uri),
      (p) => this.toUri(p),
    );
    for (const p of welcome.peers) this.presence.addPeer(p);

    conn.onClose((_code, reason) => this.end(false, reason || 'Connection lost'));
    conn.start((m) => this.onMessage(m));

    this.disposables.push(
      trackLocalCursor(
        (uri) => this.toPath(uri),
        (path, sel) => this.conn.send({ t: 'cursor', path, sel }),
      ),
      vscode.workspace.onDidOpenTextDocument((d) => void this.attach(d)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        const p = this.toPath(d.uri);
        if (p !== undefined && this.docs.get(p)?.doc === d) this.detach(p, true);
      }),
    );
  }

  get hostName(): string {
    return this.welcome.hostName;
  }

  get readOnly(): boolean {
    return this.welcome.readOnly;
  }

  /** Whether a file is currently being co-edited (its content flows through Yjs). */
  isTracked(path: string): boolean {
    return this.docs.has(path);
  }

  /** Binds documents that were already open (restored editors, or after a reconnect). */
  attachOpenDocuments(preferLocal: boolean): void {
    for (const d of vscode.workspace.textDocuments) void this.attach(d, preferLocal);
  }

  request<T = any>(op: string, args: Record<string, unknown>): Promise<T> {
    return this.conn.request<T>(op, args);
  }

  /** Joins the shared whiteboard (downloads its current drawing the first time). */
  async boardConnection(): Promise<BoardConnection> {
    if (!this.board) {
      const doc = this.newBoardDoc(await this.conn.request<string>('wbSync', {}));
      this.board = doc;
      this.boardConn = {
        doc,
        me: { id: this.welcome.id, name: this.myName, color: this.welcome.color },
        readOnly: () => this.readOnly,
        sendPointer: (x, y) => this.conn.send({ t: 'wb-ptr', x, y }),
        onPointer: this.boardPointer.event,
        onReadOnlyChange: this.onDidChangePermission,
        onReset: this.boardReset.event,
        onSim: this.simEmitter.event,
        lastSim: () => this.lastSimSnap,
      };
    }
    return this.boardConn!;
  }

  private readonly boardReset = new vscode.EventEmitter<void>();
  private readonly simEmitter = new vscode.EventEmitter<unknown>();
  private lastSimSnap: unknown;
  /** Live circuit results from the host (tests). */
  readonly onSim = this.simEmitter.event;
  private reloadingBoard = false;

  /** Replaces the local whiteboard copy with the host's (after the host dropped a change). */
  private async reloadBoard(): Promise<void> {
    if (!this.board || !this.boardConn || this.reloadingBoard) return;
    this.reloadingBoard = true;
    try {
      const doc = this.newBoardDoc(await this.conn.request<string>('wbSync', {}));
      this.board.destroy();
      this.board = doc;
      this.boardConn.doc = doc;
      this.boardReset.fire();
    } catch {
      // connection lost; the session will end
    } finally {
      this.reloadingBoard = false;
    }
  }

  private newBoardDoc(state: string): Y.Doc {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromB64(state), 'remote');
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote' && doc === this.board) this.conn.send({ t: 'wb', update: toB64(update) });
    });
    return doc;
  }

  /** Tell everyone this user's GitHub login (for the profile picture). */
  /** This user's GitHub login, if they chose to show their picture. */
  github: string | undefined;

  /** Id of this user's custom picture, if any. */
  pic: string | undefined;

  /** Shares this user's picture: a GitHub username and/or a custom image. */
  setProfile(github: string | undefined, pic: { mime: string; data: string; id: string } | undefined): void {
    this.github = github;
    this.pic = pic?.id;
    this.conn.send({ t: 'profile', github, pic: pic && { mime: pic.mime, data: pic.data } });
  }

  selfInfo(): PeerInfo {
    return { id: this.welcome.id, name: this.myName, color: this.welcome.color, readOnly: this.readOnly, github: this.github, pic: this.pic };
  }

  bindingFor(doc: vscode.TextDocument): DocBinding | undefined {
    const p = this.toPath(doc.uri);
    const entry = p !== undefined ? this.docs.get(p) : undefined;
    return entry?.doc === doc ? entry.binding : undefined;
  }

  /** Waits until remote edits are written into this document (so positions match the host). */
  async settle(uri: vscode.Uri): Promise<void> {
    const p = this.toPath(uri);
    const entry = p !== undefined ? this.docs.get(p) : undefined;
    await entry?.binding?.settle();
  }

  dispose(): void {
    this.ended = true;
    for (const p of [...this.docs.keys()]) this.detach(p, false);
    for (const d of this.disposables) d.dispose();
    this.diagnostics.dispose();
    this.presence.dispose();
    this.conn.close(1000, 'Guest left');
    this.fsEmitter.dispose();
    this.endEmitter.dispose();
    this.permissionEmitter.dispose();
    this.selfEmitter.dispose();
    this.picEmitter.dispose();
    this.board?.destroy();
    this.boardPointer.dispose();
    this.boardOpened.dispose();
    this.boardReset.dispose();
    this.simEmitter.dispose();
    this.peersEmitter.dispose();
  }

  // ---------------------------------------------------------------- paths

  toPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== SCHEME || uri.authority !== this.folder.authority) return undefined;
    const root = this.folder.path.replace(/\/+$/, '');
    if (uri.path === root) return '';
    if (!uri.path.startsWith(root + '/')) return undefined;
    return uri.path.slice(root.length + 1);
  }

  toUri(path: string): vscode.Uri {
    return path ? vscode.Uri.joinPath(this.folder, ...path.split('/')) : this.folder;
  }

  // ---------------------------------------------------------------- messages

  private end(byHost: boolean, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endEmitter.fire({ byHost, reason });
  }

  private onMessage(m: Msg): void {
    switch (m.t) {
      case 'yupdate': {
        const entry = this.docs.get(m.path);
        if (!entry || typeof m.update !== 'string') return;
        if (entry.binding) entry.binding.applyRemote(fromB64(m.update), 'remote');
        else Y.applyUpdate(entry.ydoc, fromB64(m.update), 'remote');
        return;
      }
      case 'reset': {
        // The host reloaded its copy of this file; re-sync, keeping any local edits.
        const entry = this.docs.get(m.path);
        if (!entry) return;
        this.detach(m.path, false);
        if (!entry.doc.isClosed) void this.attach(entry.doc, true);
        return;
      }
      case 'saved': {
        const entry = this.docs.get(m.path);
        if (entry?.doc.isDirty) {
          void entry.binding?.settle().then(() => entry.doc.isDirty && entry.doc.save());
        }
        return;
      }
      case 'diag': {
        if (!this.docs.has(m.path) || !Array.isArray(m.items)) return;
        this.diagnostics.set(this.toUri(String(m.path)), deserializeDiagnostics(m.items));
        return;
      }
      case 'fs': {
        const changes = Array.isArray(m.changes) ? m.changes : [];
        this.fsEmitter.fire(
          changes.map((c: any) => ({ type: c.type as vscode.FileChangeType, uri: this.toUri(String(c.path)) })),
        );
        return;
      }
      case 'cursor':
        this.presence.update(m.id, m.path, m.sel);
        return;
      case 'permission': {
        const ro = !!m.readOnly;
        if (ro === this.welcome.readOnly) return;
        this.welcome.readOnly = ro;
        for (const e of this.docs.values()) e.binding?.setReadOnly(ro);
        this.permissionEmitter.fire(ro);
        return;
      }
      case 'wb':
        if (this.board && typeof m.update === 'string') Y.applyUpdate(this.board, fromB64(m.update), 'remote');
        return;
      case 'pic':
        if (typeof m.id === 'string' && typeof m.data === 'string') this.picEmitter.fire({ id: m.id, mime: String(m.mime), data: m.data });
        return;
      case 'wb-sim':
        this.lastSimSnap = m.sim;
        this.simEmitter.fire(m.sim);
        return;
      case 'wb-reset':
        void this.reloadBoard();
        return;
      case 'wb-ptr':
        this.boardPointer.fire({ id: m.id, name: String(m.name), color: String(m.color), x: Number(m.x), y: Number(m.y) });
        return;
      case 'wb-open':
        this.boardOpened.fire(String(m.name));
        return;
      case 'peer-update': {
        const info = m.peer as PeerInfo;
        if (!info) return;
        if (info.id === this.welcome.id) {
          // The host changed my color.
          if (info.color && info.color !== this.welcome.color) {
            this.welcome.color = info.color;
            if (this.boardConn) this.boardConn.me.color = info.color;
            this.selfEmitter.fire();
            void vscode.window.setStatusBarMessage(`${this.hostName} changed your color`, 4000);
          }
          return;
        }
        this.presence.updateInfo(info);
        return;
      }
      case 'peer-join':
        this.presence.addPeer(m.peer as PeerInfo);
        this.peersEmitter.fire();
        void vscode.window.setStatusBarMessage(`${m.peer?.name} joined the session`, 4000);
        return;
      case 'peer-leave': {
        const name = this.presence.get(m.id)?.name;
        this.presence.removePeer(m.id);
        this.peersEmitter.fire();
        if (name) void vscode.window.setStatusBarMessage(`${name} left the session`, 4000);
        return;
      }
      case 'bye':
        this.end(true, String(m.reason ?? 'The host ended the session.'));
        return;
    }
  }

  // ---------------------------------------------------------------- co-editing

  private async attach(doc: vscode.TextDocument, preferLocal = false): Promise<void> {
    const path = this.toPath(doc.uri);
    if (path === undefined || path === '' || this.docs.has(path) || this.ended) return;
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const entry: GuestDoc = { path, doc, ydoc };
    this.docs.set(path, entry);
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') this.conn.send({ t: 'yupdate', path, update: toB64(update) });
    });
    try {
      const state = await this.conn.request<string | null>('sync', { path });
      if (this.docs.get(path) !== entry || !state) return;
      Y.applyUpdate(ydoc, fromB64(state), 'remote');
      entry.binding = new DocBinding(doc, ytext, this.readOnly, preferLocal);
    } catch (e: any) {
      if (this.docs.get(path) === entry) {
        this.docs.delete(path);
        ydoc.destroy();
      }
      if (!this.ended) console.warn(`[collab] could not sync ${path}: ${e?.message ?? e}`);
    }
  }

  private detach(path: string, notifyHost: boolean): void {
    const entry = this.docs.get(path);
    if (!entry) return;
    this.docs.delete(path);
    entry.binding?.dispose();
    entry.ydoc.destroy();
    if (!this.ended) this.diagnostics.delete(this.toUri(path));
    if (notifyHost) this.conn.send({ t: 'unsub', path });
  }
}

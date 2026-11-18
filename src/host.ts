import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Connection } from './connection';
import { DocBinding } from './binding';
import { Presence, trackLocalCursor } from './presence';
import { codeError, colorFor, COLORS, EXT_VERSION, fromB64, Msg, normalizeRel, PeerInfo, PeerSnapshot, PROTOCOL_VERSION, Sel, toB64, validGithubLogin } from './protocol';
import { handleLangRequest, serializeDiagnostics } from './lang';
import { BoardConnection } from './whiteboard';
import { BoardLogic } from './boardLogic';

interface Client {
  info: PeerInfo;
  conn: Connection;
  subs: Set<string>;
  path: string | null;
  sel: Sel;
}

interface HostDoc {
  path: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  textDoc: vscode.TextDocument;
  binding: DocBinding;
  subs: Set<Client>;
}

const IS_WIN = process.platform === 'win32';
const HOST_ID = 0;

/**
 * The host runs a WebSocket server inside VS Code. Guests read the folder through RPC calls
 * and co-edit open files through one Yjs document per file, relayed by the host.
 */
export class HostSession implements vscode.Disposable {
  readonly presence: Presence;
  private readonly clients = new Map<number, Client>();
  private readonly docs = new Map<string, HostDoc>();
  private readonly creating = new Map<string, Promise<HostDoc>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly peersChanged = new vscode.EventEmitter<void>();
  readonly onDidChangePeers = this.peersChanged.event;
  /** Shared whiteboard (shapes in the "shapes" map). */
  readonly board = new Y.Doc();
  private readonly boardSubs = new Set<Client>();
  private readonly boardLogic: BoardLogic;
  private readonly boardPointer = new vscode.EventEmitter<{ id: number; name: string; color: string; x: number; y: number }>();
  private readonly boardOpened = new vscode.EventEmitter<string>();
  /** Fires with a guest's name when they open the whiteboard. */
  readonly onDidOpenBoard = this.boardOpened.event;
  private boardConn: BoardConnection | undefined;
  private readonly pingTimer: NodeJS.Timeout;
  private fsQueue: { type: vscode.FileChangeType; path: string }[] = [];
  private fsTimer: NodeJS.Timeout | undefined;
  private myPath: string | null = null;
  private mySel: Sel = [];
  private nextId = 1;
  private disposed = false;

  static start(root: vscode.Uri, port: number, hostName: string, readOnly = false): Promise<HostSession> {
    const token = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 * 1024 });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.removeListener('error', reject);
        wss.on('error', (e) => console.error('[collab] server error', e));
        resolve(new HostSession(wss, token, root, port, hostName, readOnly));
      });
    });
  }

  private constructor(
    private readonly wss: WebSocketServer,
    readonly token: string,
    readonly root: vscode.Uri,
    readonly port: number,
    readonly hostName: string,
    readonly readOnly: boolean,
  ) {
    this.presence = new Presence(
      (uri) => this.relPath(uri),
      (p) => this.resolve(p),
    );
    wss.on('connection', (ws, req) => this.onConnection(ws, req));

    // Whiteboard: relay every change to the guests who have it open, and run circuit memory.
    this.board.on('update', (update: Uint8Array, origin: unknown) => {
      const msg = { t: 'wb', update: toB64(update) };
      for (const c of this.boardSubs) if (c !== origin) c.conn.send(msg);
    });
    this.boardLogic = new BoardLogic(this.board);
    // Stream circuit results to every guest who has the whiteboard open.
    this.boardLogic.onSnapshot((snap) => {
      for (const c of this.boardSubs) c.conn.send({ t: 'wb-sim', sim: snap });
    });

    // Keep connections alive through tunnels/proxies that drop idle sockets.
    this.pingTimer = setInterval(() => {
      for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25000);

    this.disposables.push(
      trackLocalCursor(
        (uri) => this.relPath(uri),
        (p, sel) => {
          this.myPath = p;
          this.mySel = sel;
          this.broadcast({ t: 'cursor', id: HOST_ID, path: p, sel });
        },
      ),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        for (const d of this.docs.values()) if (d.textDoc === doc) this.dropDoc(d, true);
      }),
      vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
          const p = this.relPath(uri);
          if (p !== undefined && this.docs.has(p)) this.queueDiagnostics(p);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const p = this.relPath(doc.uri);
        const d = p !== undefined ? this.docs.get(p) : undefined;
        if (d) for (const c of d.subs) c.conn.send({ t: 'saved', path: d.path });
      }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const onFs = (type: vscode.FileChangeType) => (uri: vscode.Uri) => {
      const p = this.relPath(uri);
      if (p === undefined || p === '.git' || p.startsWith('.git/')) return;
      // Content of co-edited files flows through Yjs; don't make guests reload them.
      if (type === vscode.FileChangeType.Changed && this.docs.has(p)) return;
      this.queueFs(type, p);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(onFs(vscode.FileChangeType.Created)),
      watcher.onDidChange(onFs(vscode.FileChangeType.Changed)),
      watcher.onDidDelete(onFs(vscode.FileChangeType.Deleted)),
    );
  }

  get workspaceName(): string {
    return path.posix.basename(this.root.path) || 'workspace';
  }

  get guestCount(): number {
    return this.clients.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.fsTimer);
    for (const c of this.clients.values()) {
      c.conn.send({ t: 'bye', reason: `${this.hostName} ended the session.` });
      c.conn.close(1000, 'Session ended');
    }
    this.clients.clear();
    for (const d of [...this.docs.values()]) this.dropDoc(d, false);
    this.wss.close();
    for (const d of this.disposables) d.dispose();
    this.presence.dispose();
    this.boardLogic.dispose();
    this.board.destroy();
    this.boardPointer.dispose();
    this.boardOpened.dispose();
    this.picEmitter.dispose();
    this.peersChanged.dispose();
  }

  // ---------------------------------------------------------------- connections

  /** Host's GitHub login, if they chose to show their picture. */
  github: string | undefined;

  /** Default permission for guests who join from now on. */
  get defaultReadOnly(): boolean {
    return this.readOnly;
  }

  setGithub(login: string | undefined): void {
    this.github = login;
    this.broadcast({ t: 'peer-update', peer: this.hostInfo() });
  }

  /** Live circuit state (tests). */
  get circuit(): BoardLogic {
    return this.boardLogic;
  }

  /** The whiteboard as seen by the host. */
  boardConnection(): BoardConnection {
    if (!this.boardConn) {
      this.boardConn = {
        doc: this.board,
        me: { id: HOST_ID, name: this.hostName, color: this.hostColor },
        readOnly: () => false,
        sendPointer: (x, y) => {
          const p = { t: 'wb-ptr', id: HOST_ID, name: this.hostName, color: this.hostColor, x, y };
          for (const c of this.boardSubs) c.conn.send(p);
        },
        onPointer: this.boardPointer.event,
        onReadOnlyChange: new vscode.EventEmitter<boolean>().event,
        onSim: this.boardLogic.onSnapshot,
        lastSim: () => this.boardLogic.current(),
      };
    }
    return this.boardConn;
  }

  /** Tells guests the host opened the whiteboard. */
  announceBoard(): void {
    this.broadcast({ t: 'wb-open', name: this.hostName });
  }

  /** Custom pictures by id, sent once to everyone who joins. */
  private readonly pics = new Map<string, { mime: string; data: string }>();
  private hostPic: string | undefined;
  private readonly picEmitter = new vscode.EventEmitter<{ id: string; mime: string; data: string }>();
  /** Fires when a participant shares a custom picture. */
  readonly onDidReceivePicture = this.picEmitter.event;

  /** Stores a picture and sends it to everyone. Returns its id. */
  private addPicture(mime: string, data: string, except?: Client): string | undefined {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) || typeof data !== 'string' || data.length > 700_000) return undefined;
    const id = createHash('sha1').update(data).digest('hex').slice(0, 16);
    if (!this.pics.has(id)) {
      this.pics.set(id, { mime, data });
      this.broadcast({ t: 'pic', id, mime, data }, except);
      this.picEmitter.fire({ id, mime, data });
    }
    return id;
  }

  /** The host's own custom picture (undefined = none). */
  setPicture(pic: { mime: string; data: string } | undefined): void {
    this.hostPic = pic ? this.addPicture(pic.mime, pic.data) : undefined;
    this.broadcast({ t: 'peer-update', peer: this.hostInfo() });
  }

  /** The host's own color (the host can change it like anyone else's). */
  hostColor = colorFor(HOST_ID);

  hostInfo(): PeerInfo {
    return { id: HOST_ID, name: this.hostName, color: this.hostColor, isHost: true, github: this.github, pic: this.hostPic };
  }

  /** Name/color of any participant, including the host (id 0). */
  infoOf(id: number): PeerInfo | undefined {
    return id === HOST_ID ? this.hostInfo() : this.clients.get(id)?.info;
  }

  /** The host changes someone's color (their cursor, pin, file highlights, whiteboard pointer). */
  setColor(id: number, color: string): void {
    if (!COLORS.includes(color)) return;
    if (id === HOST_ID) {
      this.hostColor = color;
      if (this.boardConn) this.boardConn.me.color = color;
      this.broadcast({ t: 'peer-update', peer: this.hostInfo() });
      return;
    }
    const c = this.clients.get(id);
    if (!c) return;
    c.info.color = color;
    // Everyone, including that guest, learns the new color.
    this.broadcast({ t: 'peer-update', peer: c.info });
    this.presence.updateInfo(c.info);
  }

  /** Lets the host switch one guest between read-only and read/write. */
  setPermission(id: number, readOnly: boolean): void {
    const c = this.clients.get(id);
    if (!c || !!c.info.readOnly === readOnly) return;
    c.info.readOnly = readOnly;
    c.conn.send({ t: 'permission', readOnly });
    this.broadcast({ t: 'peer-update', peer: c.info }, c);
    this.presence.updateInfo(c.info);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (token !== this.token) {
      ws.close(4001, 'Invalid or expired invite link. Ask the host for a new one.');
      return;
    }
    const conn = new Connection(ws);
    let client: Client | undefined;
    const helloTimer = setTimeout(() => {
      if (!client) conn.close(4002, 'Handshake timeout');
    }, 10000);

    conn.onClose(() => {
      clearTimeout(helloTimer);
      if (client) this.removeClient(client);
    });

    conn.start((m) => {
      if (client) {
        this.handleMessage(client, m);
        return;
      }
      if (m.t !== 'hello') return;
      clearTimeout(helloTimer);
      if (m.v !== PROTOCOL_VERSION || (m.ext && m.ext !== EXT_VERSION)) {
        // Close reasons are limited to 123 bytes, so send the full explanation as a message first.
        conn.send({
          t: 'rejected',
          reason:
            `Version mismatch: the host has Collab Share ${EXT_VERSION}, you have ${m.ext ?? 'an older version'}. ` +
            'Install the same .vsix on both computers and restart VS Code.',
        });
        setTimeout(() => conn.close(4003, 'Version mismatch'), 200);
        return;
      }
      const welcomeBase = {
        t: 'welcome',
        hostName: this.hostName,
        workspaceName: this.workspaceName,
        readOnly: this.defaultReadOnly,
      };
      if (m.probe) {
        // The guest is just checking the link before opening a window.
        conn.send({ ...welcomeBase, id: -1, color: '', peers: [], probe: true });
        setTimeout(() => conn.close(1000, 'probe'), 200);
        return;
      }
      const id = this.nextId++;
      const name = String(m.name || `Guest ${id}`).slice(0, 40);
      const c: Client = {
        info: { id, name, color: colorFor(id), readOnly: this.defaultReadOnly, github: validGithubLogin(m.github) },
        conn,
        subs: new Set(),
        path: null,
        sel: [],
      };
      client = c;
      this.clients.set(id, c);
      conn.onRequest = (op, args) => this.handleRequest(c, op, args);
      for (const [pid, p] of this.pics) conn.send({ t: 'pic', id: pid, ...p });
      conn.send({ ...welcomeBase, id, color: c.info.color, peers: this.snapshot(id) });
      this.broadcast({ t: 'peer-join', peer: c.info }, c);
      this.presence.addPeer(c.info);
      this.peersChanged.fire();
      void vscode.window.showInformationMessage(`${name} joined your session.`);
    });
  }

  private removeClient(c: Client): void {
    if (!this.clients.delete(c.info.id)) return;
    this.boardSubs.delete(c);
    for (const p of c.subs) this.unsubscribe(c, p);
    this.broadcast({ t: 'peer-leave', id: c.info.id });
    this.presence.removePeer(c.info.id);
    this.peersChanged.fire();
    if (!this.disposed) void vscode.window.showInformationMessage(`${c.info.name} left your session.`);
  }

  private snapshot(excludeId: number): PeerSnapshot[] {
    const list: PeerSnapshot[] = [
      { ...this.hostInfo(), path: this.myPath, sel: this.mySel },
    ];
    for (const c of this.clients.values()) {
      if (c.info.id !== excludeId) list.push({ ...c.info, path: c.path, sel: c.sel });
    }
    return list;
  }

  private broadcast(m: Msg, except?: Client): void {
    for (const c of this.clients.values()) if (c !== except) c.conn.send(m);
  }

  private handleMessage(c: Client, m: Msg): void {
    switch (m.t) {
      case 'yupdate': {
        if (typeof m.update !== 'string') return;
        if (c.info.readOnly) {
          // Dropped: make the guest reload this file so its copy matches the host again.
          if (this.docs.get(m.path)?.subs.has(c)) c.conn.send({ t: 'reset', path: m.path });
          return;
        }
        const d = this.docs.get(m.path);
        if (!d || !d.subs.has(c)) return;
        try {
          d.binding.applyRemote(fromB64(m.update), c);
        } catch (e) {
          console.error('[collab] bad update from', c.info.name, e);
        }
        return;
      }
      case 'wb':
        if (c.info.readOnly) {
          // Dropped: tell the guest to reload the board so its copy matches again.
          c.conn.send({ t: 'wb-reset' });
          return;
        }
        if (this.boardSubs.has(c) && typeof m.update === 'string') {
          try {
            Y.applyUpdate(this.board, fromB64(m.update), c);
          } catch {
            // ignore malformed update
          }
        }
        return;
      case 'wb-ptr': {
        if (!this.boardSubs.has(c)) return;
        const p = { id: c.info.id, name: c.info.name, color: c.info.color, x: Number(m.x) || 0, y: Number(m.y) || 0 };
        for (const o of this.boardSubs) if (o !== c) o.conn.send({ t: 'wb-ptr', ...p });
        this.boardPointer.fire(p);
        return;
      }
      case 'profile': {
        c.info.github = validGithubLogin(m.github);
        c.info.pic = m.pic && typeof m.pic === 'object' ? this.addPicture(String(m.pic.mime), m.pic.data, c) : undefined;
        this.broadcast({ t: 'peer-update', peer: c.info }, c);
        this.presence.updateInfo(c.info);
        return;
      }
      case 'unsub':
        this.unsubscribe(c, String(m.path));
        return;
      case 'cursor': {
        c.path = typeof m.path === 'string' ? m.path : null;
        c.sel = Array.isArray(m.sel) ? m.sel.slice(0, 50) : [];
        this.broadcast({ t: 'cursor', id: c.info.id, path: c.path, sel: c.sel }, c);
        this.presence.update(c.info.id, c.path, c.sel);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- file system RPC

  private async handleRequest(c: Client, op: string, a: any): Promise<unknown> {
    const fs = vscode.workspace.fs;
    switch (op) {
      case 'stat': {
        const s = await fs.stat(this.resolve(a.path));
        return { type: s.type, ctime: s.ctime, mtime: s.mtime, size: s.size };
      }
      case 'readDir':
        return await fs.readDirectory(this.resolve(a.path));
      case 'readFile': {
        const uri = this.resolve(a.path);
        const open = this.findOpenDoc(uri);
        // Serve unsaved changes so guests see what the host sees.
        if (open?.isDirty) return toB64(Buffer.from(open.getText(), 'utf8'));
        return toB64(await fs.readFile(uri));
      }
      case 'writeFile': {
        this.assertWritable(c);
        const rel = normalizeRel(a.path);
        const uri = this.resolve(rel);
        const d = this.docs.get(rel);
        if (d && !d.textDoc.isClosed) {
          // Co-edited file: the content already arrived via Yjs. Save the host's copy.
          await d.binding.settle();
          if (d.textDoc.isDirty) await d.textDoc.save();
          return null;
        }
        const exists = await this.exists(uri);
        if (exists && !a.overwrite) throw codeError('File exists', 'FileExists');
        if (!exists && !a.create) throw codeError('File not found', 'FileNotFound');
        await fs.writeFile(uri, fromB64(String(a.data ?? '')));
        return null;
      }
      case 'createDir':
        this.assertWritable(c);
        await fs.createDirectory(this.resolve(a.path));
        return null;
      case 'delete': {
        this.assertWritable(c);
        const uri = this.resolve(a.path);
        if (uri.toString() === this.root.toString()) throw codeError('Cannot delete the shared folder', 'NoPermissions');
        try {
          await fs.delete(uri, { recursive: !!a.recursive, useTrash: true });
        } catch (e: any) {
          if (e?.code === 'FileNotFound') throw e;
          await fs.delete(uri, { recursive: !!a.recursive, useTrash: false });
        }
        return null;
      }
      case 'rename':
        this.assertWritable(c);
        await fs.rename(this.resolve(a.path), this.resolve(a.to), { overwrite: !!a.overwrite });
        return null;
      case 'wbSync': {
        if (!this.boardSubs.has(c)) {
          this.boardSubs.add(c);
          this.broadcast({ t: 'wb-open', name: c.info.name }, c);
          this.boardOpened.fire(c.info.name);
        }
        setTimeout(() => c.conn.send({ t: 'wb-sim', sim: this.boardLogic.current() }), 0);
        return toB64(Y.encodeStateAsUpdate(this.board));
      }
      case 'listFiles': {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(this.root, '**/*'),
          '**/{node_modules,.git}/**',
          20000,
        );
        return files.map((u) => this.relPath(u)).filter((p): p is string => !!p).sort();
      }
      case 'sync': {
        const rel = normalizeRel(a.path);
        const d = await this.ensureDoc(rel);
        if (!this.clients.has(c.info.id)) return null;
        d.subs.add(c);
        c.subs.add(rel);
        this.queueDiagnostics(rel);
        return toB64(Y.encodeStateAsUpdate(d.ydoc));
      }
      case 'lang':
        return handleLangRequest(
          {
            uriFor: async (p) => {
              const rel = normalizeRel(p);
              const d = this.docs.get(rel);
              if (d && !d.textDoc.isClosed) {
                await d.binding.settle();
                return d.textDoc.uri;
              }
              return (await vscode.workspace.openTextDocument(this.resolve(rel))).uri;
            },
            relPath: (u) => this.relPath(u),
          },
          a,
        );
      default:
        throw codeError(`Unknown request ${op}`, 'Unavailable');
    }
  }

  private assertWritable(c: Client): void {
    if (c.info.readOnly) throw codeError('The host has made you read-only', 'NoPermissions');
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- shared documents

  private ensureDoc(rel: string): Promise<HostDoc> {
    const existing = this.docs.get(rel);
    if (existing && !existing.textDoc.isClosed) return Promise.resolve(existing);
    let p = this.creating.get(rel);
    if (!p) {
      p = (async () => {
        const textDoc = await vscode.workspace.openTextDocument(this.resolve(rel));
        const again = this.docs.get(rel);
        if (again && !again.textDoc.isClosed) return again;
        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('content');
        ydoc.transact(() => ytext.insert(0, textDoc.getText()), 'init');
        const d: HostDoc = { path: rel, ydoc, ytext, textDoc, subs: new Set(), binding: new DocBinding(textDoc, ytext, false) };
        ydoc.on('update', (update: Uint8Array, origin: unknown) => {
          if (origin === 'init') return;
          const msg = { t: 'yupdate', path: rel, update: toB64(update) };
          for (const c of d.subs) if (c !== origin) c.conn.send(msg);
        });
        this.docs.set(rel, d);
        return d;
      })().finally(() => this.creating.delete(rel));
      this.creating.set(rel, p);
    }
    return p;
  }

  private unsubscribe(c: Client, rel: string): void {
    c.subs.delete(rel);
    const d = this.docs.get(rel);
    if (!d) return;
    d.subs.delete(c);
    if (d.subs.size === 0) this.dropDoc(d, false);
  }

  /** Stops co-editing a file. With notify, guests re-sync (used when the host's document was unloaded). */
  private dropDoc(d: HostDoc, notify: boolean): void {
    if (this.docs.get(d.path) !== d) return;
    this.docs.delete(d.path);
    d.binding.dispose();
    d.ydoc.destroy();
    for (const c of d.subs) {
      c.subs.delete(d.path);
      if (notify) c.conn.send({ t: 'reset', path: d.path });
    }
    d.subs.clear();
  }

  /** The co-editing binding for a host document, if guests have it open. */
  bindingFor(doc: vscode.TextDocument): DocBinding | undefined {
    for (const d of this.docs.values()) if (d.textDoc === doc) return d.binding;
    return undefined;
  }

  private diagTimers = new Map<string, NodeJS.Timeout>();

  /** Sends the host's errors/warnings for a shared file to the guests that have it open. */
  private queueDiagnostics(rel: string): void {
    if (this.diagTimers.has(rel)) return;
    this.diagTimers.set(
      rel,
      setTimeout(() => {
        this.diagTimers.delete(rel);
        const d = this.docs.get(rel);
        if (!d || this.disposed) return;
        const items = serializeDiagnostics(vscode.languages.getDiagnostics(d.textDoc.uri));
        for (const c of d.subs) c.conn.send({ t: 'diag', path: rel, items });
      }, 250),
    );
  }

  private queueFs(type: vscode.FileChangeType, p: string): void {
    this.fsQueue.push({ type, path: p });
    if (!this.fsTimer) {
      this.fsTimer = setTimeout(() => {
        this.fsTimer = undefined;
        const changes = this.fsQueue.splice(0, 500);
        this.fsQueue = [];
        this.broadcast({ t: 'fs', changes });
      }, 100);
    }
  }

  // ---------------------------------------------------------------- paths

  resolve(rel: unknown): vscode.Uri {
    const clean = normalizeRel(rel);
    return clean ? vscode.Uri.joinPath(this.root, ...clean.split('/')) : this.root;
  }

  /** Workspace-relative path for a URI inside the shared folder, else undefined. */
  relPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.root.scheme) return undefined;
    const rootPath = this.root.path.replace(/\/+$/, '');
    const a = IS_WIN ? uri.path.toLowerCase() : uri.path;
    const b = IS_WIN ? rootPath.toLowerCase() : rootPath;
    if (a === b) return '';
    if (!a.startsWith(b + '/')) return undefined;
    return uri.path.slice(rootPath.length + 1);
  }

  private findOpenDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = IS_WIN ? uri.fsPath.toLowerCase() : uri.fsPath;
    return vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === uri.scheme && (IS_WIN ? d.uri.fsPath.toLowerCase() : d.uri.fsPath) === key,
    );
  }
}

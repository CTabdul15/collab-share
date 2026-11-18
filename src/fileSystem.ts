import * as vscode from 'vscode';
import { GuestSession } from './guest';
import { toB64, fromB64 } from './protocol';

const FS_CODES = ['FileNotFound', 'FileExists', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'Unavailable'] as const;
type FsCode = (typeof FS_CODES)[number];

/**
 * The guest-side file system for collab:// URIs. Every operation is forwarded to the host.
 * Paths look like /<workspace name>/<relative path>; the first segment is just a display name.
 */
export class CollabFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private session: GuestSession | undefined;
  private sessionSub: vscode.Disposable | undefined;
  private failure: Error | undefined;
  private waiters: { resolve: (s: GuestSession) => void; reject: (e: Error) => void }[] = [];

  setSession(s: GuestSession): void {
    this.session = s;
    this.failure = undefined;
    this.sessionSub?.dispose();
    this.sessionSub = s.onDidChangeFiles((e) => this.emitter.fire(e));
    for (const w of this.waiters.splice(0)) w.resolve(s);
  }

  /** Marks the session as unavailable; pending and future calls fail until reset() or setSession(). */
  setFailed(err: Error): void {
    this.session = undefined;
    this.sessionSub?.dispose();
    this.sessionSub = undefined;
    this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** Calls made after this wait for the next setSession(). */
  reset(): void {
    this.failure = undefined;
  }

  fireChanged(uri: vscode.Uri): void {
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  // ---------------------------------------------------------------- FileSystemProvider

  watch(): vscode.Disposable {
    // The host pushes change events for the whole workspace.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const s = await this.session_(uri);
    const rel = this.rel(uri);
    const r = await this.call(s, uri, 'stat', {});
    // Co-edited files are synced live, so report a constant mtime to avoid
    // "file is newer" save conflicts when the host saves first.
    return { type: r.type, ctime: r.ctime, mtime: s.isTracked(rel) ? 0 : r.mtime, size: r.size };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const s = await this.session_(uri);
    return this.call(s, uri, 'readDir', {});
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const s = await this.session_(uri);
    return fromB64(await this.call(s, uri, 'readFile', {}));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const s = await this.session_(uri);
    await this.call(s, uri, 'writeFile', { data: toB64(content), create: options.create, overwrite: options.overwrite });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const s = await this.session_(uri);
    await this.call(s, uri, 'createDir', {});
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const s = await this.session_(uri);
    await this.call(s, uri, 'delete', { recursive: options.recursive });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const s = await this.session_(oldUri);
    await this.call(s, oldUri, 'rename', { to: this.rel(newUri), overwrite: options.overwrite });
  }

  // ---------------------------------------------------------------- helpers

  private rel(uri: vscode.Uri): string {
    return uri.path.split('/').filter(Boolean).slice(1).join('/');
  }

  private session_(uri: vscode.Uri): Promise<GuestSession> {
    if (this.session) return Promise.resolve(this.session);
    if (this.failure) return Promise.reject(vscode.FileSystemError.Unavailable(uri));
    return new Promise<GuestSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(vscode.FileSystemError.Unavailable(uri));
      }, 30000);
      const waiter = {
        resolve: (s: GuestSession) => (clearTimeout(timer), resolve(s)),
        reject: () => (clearTimeout(timer), reject(vscode.FileSystemError.Unavailable(uri))),
      };
      this.waiters.push(waiter);
    });
  }

  private async call(s: GuestSession, uri: vscode.Uri, op: string, args: Record<string, unknown>): Promise<any> {
    try {
      return await s.request(op, { path: this.rel(uri), ...args });
    } catch (e: any) {
      const code = e?.code as FsCode;
      if (FS_CODES.includes(code)) throw vscode.FileSystemError[code](uri);
      throw vscode.FileSystemError.Unavailable(`${uri.path}: ${e?.message ?? e}`);
    }
  }
}

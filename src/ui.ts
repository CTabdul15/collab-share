import * as vscode from 'vscode';
import { Presence } from './presence';
import { PeerInfo, themeColorFor } from './protocol';

/** Snapshot of the session, provided by extension.ts. */
export interface UiState {
  role: 'host' | 'guest' | undefined;
  host?: {
    folderName: string;
    readOnly: boolean;
    guestCount: number;
    internet: 'active' | 'starting' | 'off';
    internetUrl?: string;
  };
  guest?: {
    hostName: string;
    readOnly: boolean;
    state: 'connecting' | 'connected' | 'disconnected';
  };
  presence?: Presence;
  /** Whether this user shows their GitHub picture. */
  hasPicture: boolean;
}

function item(
  label: string,
  icon: string,
  opts: { description?: string; tooltip?: string; command?: string; args?: unknown[]; color?: string } = {},
): vscode.TreeItem {
  const t = new vscode.TreeItem(label);
  t.iconPath = new vscode.ThemeIcon(icon, opts.color ? new vscode.ThemeColor(opts.color) : undefined);
  t.description = opts.description;
  t.tooltip = opts.tooltip;
  if (opts.command) t.command = { command: opts.command, title: label, arguments: opts.args };
  return t;
}

/** "Session Details" view. Empty when idle, so the Share/Join welcome buttons show. */
export class SessionTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: () => UiState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  getChildren(): vscode.TreeItem[] {
    const s = this.state();
    const items: vscode.TreeItem[] = [];
    if (s.host) {
      const h = s.host;
      items.push(
        item(`Sharing "${h.folderName}"`, h.readOnly ? 'lock' : 'broadcast', {
          description: h.readOnly ? 'Read-Only' : 'Read/Write',
          tooltip: h.readOnly ? 'Guests can look but not edit.' : 'Guests can edit files.',
        }),
        item(`${h.guestCount} participant${h.guestCount === 1 ? '' : 's'}`, 'organization'),
      );
      if (h.internet === 'active') {
        items.push(
          item('Internet link active', 'globe', {
            description: h.internetUrl?.replace(/^https:\/\//, ''),
            tooltip: 'Friends anywhere can join with the invite link. Click to copy it.',
            command: 'collab.copyInvite',
            color: 'charts.green',
          }),
        );
      } else if (h.internet === 'starting') {
        items.push(item('Creating Internet link…', 'sync~spin'));
      } else {
        items.push(
          item('Local network only', 'home', {
            description: 'click to go online',
            tooltip: 'Only people on your network can join. Click to create an Internet link.',
            command: 'collab.restartTunnel',
            color: 'charts.yellow',
          }),
        );
      }
      items.push(item('Copy Invite Link', 'copy', { command: 'collab.copyInvite' }));
      items.push(item('Sandbox', 'symbol-color', { description: 'blueprint', command: 'collab.whiteboard' }));
    } else if (s.guest) {
      const g = s.guest;
      if (g.state === 'connected') {
        items.push(
          item(`Joined ${g.hostName}'s session`, 'plug', {
            description: g.readOnly ? 'Read-Only' : 'Read/Write',
            color: 'charts.green',
          }),
          item('Find File…', 'search', { description: 'Ctrl+Alt+P', command: 'collab.findFile' }),
          item('Sandbox', 'symbol-color', { description: 'blueprint', command: 'collab.whiteboard' }),
        );
      } else if (g.state === 'connecting') {
        items.push(item('Connecting…', 'sync~spin'));
      } else {
        items.push(item('Disconnected', 'debug-disconnect', { color: 'charts.red', command: 'collab.menu', description: 'click for options' }));
      }
    } else {
      return [];
    }

    if (s.host || s.guest?.state === 'connected') {
      items.push(
        s.hasPicture
          ? item('Change my picture', 'account', { command: 'collab.setPicture' })
          : item('Set my picture', 'account', { description: 'no login needed', command: 'collab.setPicture' }),
      );
    }
    const p = s.presence;
    if (p?.following !== undefined) {
      const name = p.get(p.following)?.name ?? 'participant';
      items.push(
        item(`Following ${name}`, 'pinned', {
          description: 'click to stop',
          command: 'collab.unfollow',
          color: themeColorFor(p.get(p.following)?.color ?? ''),
        }),
      );
    }
    items.push(
      s.host
        ? item('Stop Sharing', 'debug-stop', { command: 'collab.stop' })
        : item('Leave Session', 'sign-out', { command: 'collab.stop' }),
    );
    return items;
  }
}

/** Tree element key for a participant. Strings, because VS Code treats the element `0` (the host) as "no element". */
export const peerKey = (id: number) => `peer:${id}`;
export const peerIdFrom = (x: unknown): number | undefined =>
  typeof x === 'number' ? x : typeof x === 'string' && x.startsWith('peer:') ? Number(x.slice(5)) : undefined;

/** "Participants" view: who is here, which file they're in, follow (pin) and, for the host, permissions. */
export class ParticipantsTree implements vscode.TreeDataProvider<string> {
  private presence: Presence | undefined;
  private sub: vscode.Disposable | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly avatars: Avatars,
    private readonly isHost: () => boolean,
    /** This user's own info, shown first as "(you)". */
    private readonly self: () => PeerInfo | undefined,
  ) {
    avatars.onDidChange(() => this.refresh());
  }

  setPresence(p: Presence | undefined): void {
    this.sub?.dispose();
    this.presence = p;
    this.sub = p?.onDidChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(): string[] {
    if (!this.presence) return [];
    return [...(this.self() ? ['self'] : []), ...this.presence.list().map((p) => peerKey(p.info.id))];
  }

  getTreeItem(key: string): vscode.TreeItem {
    if (key === 'self') {
      const me = this.self();
      const t = new vscode.TreeItem(`${me?.name ?? 'You'} (you)`);
      if (!me) return t;
      t.description = me.isHost ? 'host' : me.readOnly ? 'read-only' : 'can edit';
      t.tooltip = me.github ? `You · github.com/${me.github}` : 'You. Use "Set my picture" in Session Details to add a photo.';
      t.iconPath = this.avatars.forInfo(me) ?? new vscode.ThemeIcon(me.isHost ? 'star-full' : 'account', new vscode.ThemeColor(themeColorFor(me.color)));
      t.contextValue = this.isHost() ? 'self recolor' : 'self';
      return t;
    }
    const id = peerIdFrom(key);
    const p = this.presence?.list().find((x) => x.info.id === id);
    if (!p || id === undefined) return new vscode.TreeItem('?');
    const following = this.presence?.following === id;
    const role = p.info.isHost ? 'host' : p.info.readOnly ? 'read-only' : this.isHost() ? 'can edit' : '';
    const t = new vscode.TreeItem(p.info.name);
    const where = p.path ? `${p.path}${p.line !== undefined ? ':' + (p.line + 1) : ''}` : 'idle';
    t.description = [role, following ? 'following' : '', where].filter(Boolean).join(' · ');
    t.tooltip = new vscode.MarkdownString(
      `**${p.info.name}**${p.info.isHost ? ' (host)' : ''}${p.info.github ? ` · github.com/${p.info.github}` : ''}\n\n` +
        (p.info.isHost ? '' : p.info.readOnly ? 'Can only look (read-only)\n\n' : 'Can edit\n\n') +
        (p.path ? `In \`${where}\`` : 'Not in a file') +
        `\n\nClick to jump to them. Use 📌 to follow them.`,
    );
    const avatar = this.avatars.forInfo(p.info);
    t.iconPath = following
      ? new vscode.ThemeIcon('pinned', new vscode.ThemeColor(themeColorFor(p.info.color)))
      : (avatar ?? new vscode.ThemeIcon(p.info.isHost ? 'star-full' : 'account', new vscode.ThemeColor(themeColorFor(p.info.color))));
    // Space-separated flags matched by package.json menus.
    const flags = [following ? 'following' : 'notfollowing'];
    if (this.isHost() && !p.info.isHost) flags.push(p.info.readOnly ? 'guest-ro' : 'guest-rw');
    if (this.isHost()) flags.push('recolor');
    t.contextValue = flags.join(' ');
    t.command = { command: 'collab.goToPeer', title: 'Go to Participant', arguments: [id] };
    return t;
  }
}

/**
 * Downloads GitHub profile pictures once (cached on disk for a day) and hands them to VS Code as
 * data: URLs. VS Code does not display images from the extension's storage folder.
 */
export class Avatars {
  private readonly data = new Map<string, string | null>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private readonly images = new Map<string, { mime: string; b64: string }>();

  constructor(private readonly dir: vscode.Uri) {}

  /** A custom picture someone shared (by id). */
  setImage(id: string, mime: string, b64: string): void {
    if (this.images.has(id)) return;
    this.images.set(id, { mime, b64 });
    this.emitter.fire();
  }

  /** Picture for a participant: their custom image, else their GitHub picture. */
  forInfo(info: PeerInfo | undefined): vscode.Uri | undefined {
    const d = this.dataForInfo(info);
    return d ? vscode.Uri.parse(`data:${d.mime};base64,${d.b64}`) : undefined;
  }

  dataForInfo(info: PeerInfo | undefined): { mime: string; b64: string } | undefined {
    if (!info) return undefined;
    const custom = info.pic ? this.images.get(info.pic) : undefined;
    if (custom) return custom;
    const gh = this.base64(info.github);
    return gh ? { mime: 'image/png', b64: gh } : undefined;
  }

  /** Picture as an image URI, or undefined while loading / if unavailable. */
  get(login: string | undefined): vscode.Uri | undefined {
    const b64 = this.base64(login);
    return b64 ? vscode.Uri.parse(`data:image/png;base64,${b64}`) : undefined;
  }

  /** Picture as base64 PNG, or undefined while loading / if unavailable. */
  base64(login: string | undefined): string | undefined {
    if (!login) return undefined;
    if (this.data.has(login)) return this.data.get(login) ?? undefined;
    this.data.set(login, null);
    void this.load(login);
    return undefined;
  }

  private async load(login: string): Promise<void> {
    const file = vscode.Uri.joinPath(this.dir, `${login.toLowerCase()}.png`);
    try {
      const stat = await vscode.workspace.fs.stat(file).then(
        (st) => st,
        () => undefined,
      );
      let bytes: Uint8Array | undefined;
      if (stat && Date.now() - stat.mtime < 24 * 3600 * 1000) {
        bytes = await vscode.workspace.fs.readFile(file);
      } else {
        const res = await fetch(`https://github.com/${encodeURIComponent(login)}.png?size=64`, {
          signal: AbortSignal.timeout(10000),
        });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.startsWith('image/')) return;
        bytes = new Uint8Array(await res.arrayBuffer());
        await vscode.workspace.fs.createDirectory(this.dir);
        await vscode.workspace.fs.writeFile(file, bytes);
      }
      this.data.set(login, Buffer.from(bytes).toString('base64'));
      this.emitter.fire();
    } catch {
      // Offline or blocked: keep the colored icon.
    }
  }
}

/** Colors files (Explorer + editor tabs) that other participants have open, with their initials. */
export class PeerFileDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private byUri = new Map<string, PeerInfo[]>();
  private shown: vscode.Uri[] = [];
  private presence: Presence | undefined;
  private sub: vscode.Disposable | undefined;

  setPresence(p: Presence | undefined): void {
    this.sub?.dispose();
    this.presence = p;
    this.sub = p?.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const old = this.shown;
    this.byUri = new Map();
    this.shown = [];
    for (const peer of this.presence?.list() ?? []) {
      if (!peer.path) continue;
      const uri = this.presence!.uriFor(peer.path);
      const key = uri.toString();
      const list = this.byUri.get(key);
      if (list) list.push(peer.info);
      else {
        this.byUri.set(key, [peer.info]);
        this.shown.push(uri);
      }
    }
    this.emitter.fire([...old, ...this.shown]);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const peers = this.byUri.get(uri.toString());
    if (!peers?.length) return undefined;
    const first = peers[0];
    return {
      badge: peers.length > 1 ? `${Math.min(peers.length, 9)}+` : initials(first.name),
      tooltip: `${peers.map((p) => p.name).join(', ')} ${peers.length > 1 ? 'are' : 'is'} here`,
      color: new vscode.ThemeColor(themeColorFor(first.color)),
      propagate: true,
    };
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return (s || '?').toUpperCase().slice(0, 2);
}

/** Status bar item shown while following someone; click to stop. */
export class FollowStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private sub: vscode.Disposable | undefined;

  constructor() {
    this.item.command = 'collab.unfollow';
  }

  setPresence(p: Presence | undefined): void {
    this.sub?.dispose();
    this.sub = p?.onDidChange(() => this.update(p));
    this.update(p);
  }

  private update(p: Presence | undefined): void {
    const id = p?.following;
    const name = id !== undefined ? p?.get(id)?.name : undefined;
    if (!name) {
      this.item.hide();
      return;
    }
    this.item.text = `$(pinned) Following ${name}`;
    this.item.tooltip = 'Click to stop following';
    this.item.color = new vscode.ThemeColor(themeColorFor(p?.get(id!)?.color ?? ''));
    this.item.show();
  }

  dispose(): void {
    this.sub?.dispose();
    this.item.dispose();
  }
}

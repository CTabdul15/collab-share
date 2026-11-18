import * as vscode from 'vscode';
import * as os from 'os';
import { createHash } from 'crypto';
import { HostSession } from './host';
import { GuestSession } from './guest';
import { CollabFileSystem } from './fileSystem';
import { openConnection } from './connection';
import { Presence } from './presence';
import { trace } from './binding';
import { findCloudflared, Tunnel } from './tunnel';
import { ensureCloudflared, downloadCloudflared, CLOUDFLARED_VERSION, assetFor, extractFromTar } from './cloudflaredInstall';
import { Avatars, FollowStatus, ParticipantsTree, peerIdFrom, PeerFileDecorations, SessionTree, UiState } from './ui';
import { decodeAuthority, EXT_VERSION, normalizeInvite, PROTOCOL_VERSION, SCHEME, validGithubLogin, COLORS, COLOR_NAMES, normalizeHexColor } from './protocol';
import { registerGuestLanguageFeatures } from './lang';
import { Pins } from './pins';
import * as boardFile from './boardFile';
import { WhiteboardPanel } from './whiteboard';

// ------------------------------------------------------------------ colors

/** Host only: pick a new color for a participant (or yourself). */
async function changeColor(x: unknown): Promise<void> {
  if (!host) {
    void vscode.window.showInformationMessage('Only the host can change colors.');
    return;
  }
  const id = x === 'self' ? 0 : peerIdFrom(x);
  const info = id === undefined ? undefined : host.infoOf(id);
  if (!info || id === undefined) return;
  const who = id === 0 ? 'you' : info.name;
  const current = info.color.toLowerCase();
  type Item = vscode.QuickPickItem & { color?: string };
  const item = (name: string, c: string): Item => ({
    label: name,
    description: c + (c === current ? '  (current)' : ''),
    iconPath: swatch(c, c === current),
    color: c,
  });
  const items: Item[] = [];
  if (!COLORS.includes(current)) items.push(item('Custom', current));
  items.push(...COLORS.map((c, i) => item(COLOR_NAMES[i], c)));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(edit) Custom color…', description: 'type a hex code like #ff8800' });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `New color for ${who}`,
    matchOnDescription: true,
  });
  if (!pick) return;
  let color = pick.color;
  if (!color) {
    const typed = await vscode.window.showInputBox({
      title: `Custom color for ${who}`,
      prompt: 'Hex color, for example #ff8800 or #f80',
      value: current,
      validateInput: (v) => (normalizeHexColor(v) ? undefined : 'Use a hex color like #ff8800'),
    });
    color = typed === undefined ? undefined : normalizeHexColor(typed);
    if (!color) return;
  }
  host.setColor(id, color);
  updateUi();
}

/** A filled circle in the given color for the color picker (ring around the current one). */
function swatch(color: string, current: boolean): vscode.Uri {
  const ring = current ? '<circle cx="8" cy="8" r="7.2" fill="none" stroke="#ffffff" stroke-width="1.6"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${current ? 5 : 6.5}" fill="${color}" stroke="#808080" stroke-opacity="0.5" stroke-width="0.8"/>${ring}</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

// ------------------------------------------------------------------ whiteboard

async function openWhiteboard(): Promise<void> {
  try {
    if (host) {
      WhiteboardPanel.show(host.boardConnection(), extCtx.extensionUri);
      host.announceBoard();
    } else if (guest) {
      WhiteboardPanel.show(await guest.boardConnection(), extCtx.extensionUri);
    } else {
      void vscode.window.showInformationMessage("Start or join a Collab session to use the shared whiteboard.");
    }
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Could not open the whiteboard: ${e?.message ?? e}`);
  }
}

const boardOffered = new Set<string>();
function offerBoard(name: string): void {
  if (boardOffered.has(name)) return;
  boardOffered.add(name);
  void vscode.window.showInformationMessage(`${name} opened the whiteboard.`, "Open Whiteboard").then((pick) => pick && openWhiteboard());
}

/** Runs fn with a participant id from a tree element ("peer:3") or a number. */
function withPeer(x: unknown, fn: (id: number) => unknown): unknown {
  const id = peerIdFrom(x);
  return id === undefined || Number.isNaN(id) ? undefined : fn(id);
}

// ------------------------------------------------------------------ profile pictures

/** What this user chose to show as their picture (kept in global storage). */
type PictureChoice =
  | { kind: 'github'; login: string }
  | { kind: 'file'; mime: string; data: string }
  | { kind: 'vscode' }
  | { kind: 'none' };
const PICTURE_KEY = 'collab.picture';

interface Profile {
  github?: string;
  pic?: { mime: string; data: string; id: string };
}

/** Never shows a prompt: uses the saved choice, or a GitHub account already allowed in VS Code. */
async function currentProfile(): Promise<Profile> {
  const choice = extCtx.globalState.get<PictureChoice>(PICTURE_KEY);
  if (choice?.kind === 'none') return {};
  if (choice?.kind === 'github') return { github: validGithubLogin(choice.login) };
  if (choice?.kind === 'file') {
    const id = createHash('sha1').update(choice.data).digest('hex').slice(0, 16);
    return { pic: { mime: choice.mime, data: choice.data, id } };
  }
  try {
    const s = await vscode.authentication.getSession('github', ['read:user'], { silent: true });
    if (s) return { github: validGithubLogin(s.account.label) };
  } catch {
    // GitHub sign-in not available
  }
  return {};
}

/** Sends this user's picture to the session. */
async function applyProfile(): Promise<void> {
  const p = await currentProfile();
  if (p.pic) tree.avatars.setImage(p.pic.id, p.pic.mime, p.pic.data);
  if (host) {
    host.setGithub(p.github);
    host.setPicture(p.pic);
  }
  guest?.setProfile(p.github, p.pic);
  updateUi();
}

async function setPicture(): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string };
  const pick = await vscode.window.showQuickPick<Item>(
    [
      { id: 'username', label: '$(github) Use my GitHub username', detail: 'Shows your public GitHub picture. No login.' },
      { id: 'file', label: '$(file-media) Choose an image file…', detail: 'Any PNG, JPG, GIF or WebP up to 500 KB. No login.' },
      {
        id: 'vscode',
        label: "$(account) Use the GitHub account I'm signed in with in VS Code",
        detail: 'VS Code asks once to let Collab Share see your username (one click, no password).',
      },
      { id: 'none', label: '$(circle-slash) No picture', detail: 'Show initials instead.' },
    ],
    { placeHolder: 'Choose the picture others see next to your name and on your cursor' },
  );
  if (!pick) return;
  let choice: PictureChoice;
  if (pick.id === 'username') {
    const login = await vscode.window.showInputBox({
      prompt: 'Your GitHub username',
      placeHolder: 'e.g. octocat',
      validateInput: (v) => (validGithubLogin(v.trim()) ? undefined : 'Not a valid GitHub username'),
    });
    if (!login) return;
    choice = { kind: 'github', login: login.trim() };
  } else if (pick.id === 'file') {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      title: 'Choose your picture',
    });
    if (!files?.[0]) return;
    const bytes = await vscode.workspace.fs.readFile(files[0]);
    if (bytes.byteLength > 500 * 1024) {
      void vscode.window.showErrorMessage('That image is larger than 500 KB. Pick a smaller one.');
      return;
    }
    const ext = files[0].path.split('.').pop()!.toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    choice = { kind: 'file', mime, data: Buffer.from(bytes).toString('base64') };
  } else if (pick.id === 'vscode') {
    try {
      await vscode.authentication.getSession('github', ['read:user'], { createIfNone: true });
      choice = { kind: 'vscode' };
    } catch {
      return;
    }
  } else {
    choice = { kind: 'none' };
  }
  await extCtx.globalState.update(PICTURE_KEY, choice);
  await applyProfile();
}

/** Ctrl+Z / Ctrl+Y in a shared file: undo/redo only your own changes. */
async function undoRedo(redo: boolean): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const binding = ed && (host?.bindingFor(ed.document) ?? guest?.bindingFor(ed.document));
  if (!ed || !binding) {
    await vscode.commands.executeCommand(redo ? 'redo' : 'undo');
    return;
  }
  const offset = await binding.undo(redo);
  if (offset === undefined) return;
  const pos = ed.document.positionAt(offset);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

let host: HostSession | undefined;
let tunnel: Tunnel | undefined;
let tunnelStarting = false;
let guest: GuestSession | undefined;
let guestState: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
let fsProvider: CollabFileSystem;
let extCtx: vscode.ExtensionContext;

/**
 * Guest windows open collab://<short id>/<name>. The invite link behind the id is kept in global
 * storage, so VS Code shows a short id (and the label "Collab Share") instead of the whole link.
 */
const SESSIONS_KEY = "collab.sessions";
async function rememberSession(url: string): Promise<string> {
  const all = extCtx.globalState.get<Record<string, { url: string; at: number }>>(SESSIONS_KEY, {});
  const existing = Object.entries(all).find(([, v]) => v.url === url)?.[0];
  const id = existing ?? "s" + Math.random().toString(16).slice(2, 10);
  all[id] = { url, at: Date.now() };
  // Keep the 30 most recent.
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 30);
  await extCtx.globalState.update(SESSIONS_KEY, Object.fromEntries(keep));
  return id;
}
function sessionUrl(authority: string): string {
  const saved = extCtx.globalState.get<Record<string, { url: string }>>(SESSIONS_KEY, {})[authority];
  if (saved) return saved.url;
  if (/^s[0-9a-f]{8}$/.test(authority)) throw new Error("This session link is no longer known on this computer. Use Collab: Join Session again.");
  return decodeAuthority(authority); // links from older versions
}
let status: vscode.StatusBarItem;
let tree: Views;

export function activate(ctx: vscode.ExtensionContext) {
  extCtx = ctx;
  fsProvider = new CollabFileSystem();
  tree = new Views(new Avatars(vscode.Uri.joinPath(ctx.globalStorageUri, 'avatars')));
  const pins = new Pins(tree.avatars);
  Presence.pinIcon = (info, side) => pins.get(info, side);
  pins.onDidChange(() => Presence.refreshAll());
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'collab.menu';

  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  // Register UI pieces one by one: if VS Code still has an older version's manifest loaded
  // (extension updated without restarting), a missing view must not break everything else.
  const safe = (what: string, fn: () => vscode.Disposable) => {
    try {
      ctx.subscriptions.push(fn());
    } catch (e: any) {
      console.error(`[collab] could not register ${what}:`, e);
      void vscode.window.showWarningMessage(
        `Collab Share was updated. Restart VS Code (close all windows) to finish the update. (${e?.message ?? e})`,
      );
    }
  };
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    tree,
    status,
    registerGuestLanguageFeatures(() =>
      guest
        ? {
            pathOf: (u) => guest?.toPath(u),
            uriOf: (p) => guest!.toUri(p),
            request: (args) => guest!.request('lang', args),
            settle: (u) => guest!.settle(u),
          }
        : undefined,
    ),
    cmd('collab.undo', () => undoRedo(false)),
    cmd('collab.redo', () => undoRedo(true)),
    cmd('collab.host', () => startHosting(false)),
    cmd('collab.hostReadWrite', () => startHosting(false)),
    cmd('collab.hostReadOnly', () => startHosting(true)),
    cmd('collab.join', joinSession),
    cmd('collab.stop', stopSession),
    cmd('collab.copyInvite', copyInvite),
    cmd('collab.findFile', findFile),
    cmd('collab.menu', showMenu),
    cmd('collab.goToPeer', (x: unknown) => withPeer(x, (id) => currentPresence()?.goTo(id))),
    cmd('collab.follow', (x: unknown) => withPeer(x, (id) => currentPresence()?.follow(id))),
    cmd('collab.changeColor', (x: unknown) => changeColor(x)),
    cmd('collab.setReadOnly', (x: unknown) => withPeer(x, (id) => host?.setPermission(id, true))),
    cmd('collab.setReadWrite', (x: unknown) => withPeer(x, (id) => host?.setPermission(id, false))),
    cmd('collab.whiteboard', openWhiteboard),
    cmd('collab.setPicture', setPicture),
    cmd('collab.unfollow', () => currentPresence()?.follow(undefined)),
    cmd('collab.restartTunnel', () => startTunnel(true)),
    new vscode.Disposable(() => {
      tunnel?.dispose();
      host?.dispose();
      guest?.dispose();
    }),
  );
  safe('Participants view', () => vscode.window.registerTreeDataProvider('collab.participants', tree.participants));
  safe('Session view', () => vscode.window.registerTreeDataProvider('collab.session', tree.session));
  safe('file highlights', () => vscode.window.registerFileDecorationProvider(tree.decorations));

  updateUi();
  status.show();

  // Opened as a guest window: connect to the host encoded in the folder URI.
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === SCHEME);
  if (folder) void connectGuest(folder.uri, false);

  // Used by the integration tests only.
  return {
    testApi: {
      HostSession,
      GuestSession,
      openConnection,
      fsProvider,
      trace,
      Tunnel,
      findCloudflared,
      cloudflared: { ensure: ensureCloudflared, download: downloadCloudflared, version: CLOUDFLARED_VERSION, assetFor, extractFromTar },
      currentHost: () => host,
      views: () => tree,
      boardFile,
      /** Make commands (undo, IntelliSense) use a session created by a test. */
      useSessions: (h?: HostSession, g?: GuestSession) => {
        host = h;
        guest = g;
      },
    },
  };
}

export function deactivate(): void {
  tunnel?.dispose();
  tunnel = undefined;
  host?.dispose();
  guest?.dispose();
  host = undefined;
  guest = undefined;
}

// ------------------------------------------------------------------ hosting

async function startHosting(readOnly: boolean): Promise<void> {
  if (guestState !== 'idle') {
    void vscode.window.showWarningMessage('This window is a guest in a session. Host from a window with your own folder open.');
    return;
  }
  if (host) {
    await copyInvite();
    return;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (folders.length === 0) {
    const pick = await vscode.window.showWarningMessage('Open the folder you want to share first.', 'Open Folder');
    if (pick) void vscode.commands.executeCommand('workbench.action.files.openFolder');
    return;
  }
  let folder = folders[0];
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
      { placeHolder: 'Which folder do you want to share?' },
    );
    if (!pick) return;
    folder = pick.folder;
  }
  const name = await ensureDisplayName();
  if (!name) return;
  const port = vscode.workspace.getConfiguration('collab').get<number>('port', 7171);

  try {
    host = await HostSession.start(folder.uri, port, name, readOnly);
  } catch (e: any) {
    const msg =
      e?.code === 'EADDRINUSE'
        ? `Port ${port} is already in use (maybe another window is hosting). Change the "collab.port" setting and try again.`
        : `Could not start hosting: ${e?.message ?? e}`;
    void vscode.window.showErrorMessage(msg);
    return;
  }
  host.onDidChangePeers(updateUi);
  host.onDidOpenBoard((name) => offerBoard(name));
  tree.setPresence(host.presence);
  host.onDidReceivePicture((p) => tree.avatars.setImage(p.id, p.mime, p.data));
  void applyProfile();
  updateUi();

  const overInternet = vscode.workspace.getConfiguration('collab').get<boolean>('shareOverInternet', true);
  const hasPublicUrl = !!vscode.workspace.getConfiguration('collab').get<string>('publicUrl', '').trim();
  if (overInternet && !hasPublicUrl) {
    if (await startTunnel(false)) return;
  }
  await announceLink(folder.name);
}

/** Copies the best invite link and tells the host. */
async function announceLink(folderName: string): Promise<void> {
  if (!host) return;
  const links = inviteLinks(host);
  await vscode.env.clipboard.writeText(links[0].link);
  const where = links[0].label.startsWith('local network')
    ? 'It works for people on your Wi‑Fi/network.'
    : links[0].label === 'this computer only'
      ? 'It only works on this computer.'
      : 'It works for friends anywhere on the Internet.';
  const pick = await vscode.window.showInformationMessage(
    `Sharing "${folderName}". Invite link copied to clipboard. ${where} Send it to your collaborators.`,
    'Copy Again',
    'Other Links…',
  );
  if (pick === 'Copy Again') await vscode.env.clipboard.writeText(links[0].link);
  else if (pick === 'Other Links…') await copyInvite();
}

/**
 * Starts a Cloudflare quick tunnel for the running host so friends on other networks can join.
 * Returns true if it started and the link was announced.
 */
async function startTunnel(userRequested: boolean): Promise<boolean> {
  if (!host || tunnelStarting) return false;
  if (tunnel) {
    if (!userRequested) return true;
    tunnel.dispose();
    tunnel = undefined;
  }
  const config = vscode.workspace.getConfiguration('collab');
  // Uses cloudflared if it's already on the computer; otherwise offers a one-click, verified download.
  const exe = await ensureCloudflared(extCtx.globalStorageUri, config.get<string>('cloudflaredPath', ''));
  if (!exe) {
    void vscode.window.setStatusBarMessage(
      'Collab: sharing on your local network only. Use "Start Internet Link" any time to go online.',
      6000,
    );
    return false;
  }

  tunnelStarting = true;
  updateUi();
  const h = host;
  try {
    const t = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating an Internet link for your session…' },
      () => Tunnel.start(exe, h.port),
    );
    if (host !== h) {
      // Hosting was stopped while the tunnel was starting.
      t.dispose();
      return true;
    }
    tunnel = t;
    t.onDidExit((reason) => {
      if (tunnel !== t) return;
      tunnel = undefined;
      updateUi();
      if (!host) return;
      void vscode.window
        .showWarningMessage(`The Internet link stopped working (${reason}). Guests outside your network can't join.`, 'Restart Internet Link')
        .then((pick) => pick && startTunnel(true));
    });
  } catch (e: any) {
    void vscode.window
      .showErrorMessage(`Could not create the Internet link: ${e?.message ?? e}`, 'Try Again')
      .then((pick) => pick && startTunnel(true));
    return false;
  } finally {
    tunnelStarting = false;
    updateUi();
  }
  await announceLink(h.workspaceName);
  return true;
}

function inviteLinks(h: HostSession): { label: string; link: string }[] {
  const links: { label: string; link: string }[] = [];
  if (tunnel) {
    const u = new URL(tunnel.url.replace(/^https:/, 'wss:') + '/');
    u.searchParams.set('token', h.token);
    links.push({ label: 'Internet (anyone with the link)', link: u.toString() });
  }
  const pub =vscode.workspace.getConfiguration('collab').get<string>('publicUrl', '').trim();
  if (pub) {
    try {
      const base = new URL(normalizeInvite(pub.replace(/\/+$/, '') + '/?token=x'));
      base.searchParams.set('token', h.token);
      links.push({ label: 'public URL', link: base.toString() });
    } catch {
      void vscode.window.showWarningMessage(`The "collab.publicUrl" setting is not a valid URL: ${pub}`);
    }
  }
  for (const ip of lanAddresses()) {
    links.push({ label: `local network ${ip}`, link: `ws://${ip}:${h.port}/?token=${h.token}` });
  }
  links.push({ label: 'this computer only', link: `ws://localhost:${h.port}/?token=${h.token}` });
  return links;
}

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Put likely-real adapters first; virtual ones (WSL, Docker, VPN) last.
      const virtual = /vEthernet|WSL|docker|VirtualBox|VMware|Hyper-V|tailscale|zerotier/i.test(name);
      if (virtual) result.push(a.address);
      else result.unshift(a.address);
    }
  }
  return result;
}

async function copyInvite(): Promise<void> {
  if (!host) {
    void vscode.window.showInformationMessage('You are not hosting a session.');
    return;
  }
  const links = inviteLinks(host);
  const pick =
    links.length === 1
      ? links[0]
      : await vscode.window.showQuickPick(
          links.map((l) => ({ label: l.label, description: l.link, link: l.link })),
          { placeHolder: 'Which invite link? Use "local network" for people on your Wi‑Fi, "public URL" for a tunnel.' },
        );
  if (!pick) return;
  await vscode.env.clipboard.writeText(pick.link);
  void vscode.window.setStatusBarMessage('Collab invite link copied', 3000);
}

function showInternetHelp(): void {
  const port = host?.port ?? vscode.workspace.getConfiguration('collab').get<number>('port', 7171);
  void vscode.window
    .showInformationMessage(
      'Share over the Internet',
      {
        modal: true,
        detail:
          `By default Collab creates a free Cloudflare link (…trycloudflare.com) when you start hosting, so friends anywhere can join. ` +
          `The first time, it offers a one-click download of Cloudflare's "cloudflared" tool (host only; guests need nothing extra).\n\n` +
          `If the link stops working, use "Collab: Restart Internet Link". Each link is new and random, and it stops working when you stop sharing.\n\n` +
          `Prefer your own tunnel (ngrok, VS Code Ports panel, …)? Forward port ${port}, put its URL in the "collab.publicUrl" setting, and turn off "collab.shareOverInternet".\n\n` +
          `Anyone with the link can join while you host, so only share it with people you trust.`,
      },
      'Open Settings',
    )
    .then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'collab.publicUrl');
    });
}

// ------------------------------------------------------------------ joining

async function joinSession(): Promise<void> {
  if (host) {
    void vscode.window.showWarningMessage('Stop hosting before joining another session.');
    return;
  }
  if (guestState !== 'idle') {
    void vscode.window.showWarningMessage('This window is already part of a session.');
    return;
  }
  let fromClipboard = '';
  try {
    const clip = (await vscode.env.clipboard.readText()).trim();
    if (/^wss?:\/\/\S+token=/i.test(clip)) fromClipboard = clip;
  } catch {
    // ignore
  }
  const raw = await vscode.window.showInputBox({
    title: 'Join Collab Session',
    prompt: 'Paste the invite link you got from the host',
    placeHolder: 'ws://192.168.1.20:7171/?token=…',
    value: fromClipboard,
    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        normalizeInvite(v);
        return undefined;
      } catch (e: any) {
        return e.message;
      }
    },
  });
  if (!raw) return;
  const url = normalizeInvite(raw);
  const name = await ensureDisplayName();
  if (!name) return;

  let workspaceName: string;
  let hostName: string;
  try {
    const { conn, welcome } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting to host…' },
      () => openConnection(url, { name, v: PROTOCOL_VERSION, ext: EXT_VERSION, probe: true }),
    );
    conn.close();
    workspaceName = welcome.workspaceName;
    hostName = welcome.hostName;
  } catch (e: any) {
    void vscode.window.showErrorMessage(`Could not join: ${e?.message ?? e}`);
    return;
  }

  const safeName = workspaceName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'workspace';
  const folderUri = vscode.Uri.from({ scheme: SCHEME, authority: await rememberSession(url), path: '/' + safeName });
  const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  void vscode.window.setStatusBarMessage(`Opening ${hostName}'s workspace…`, 5000);
  await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: hasFolder });
}

/** Connects this window to the host. With quiet, failures are returned instead of shown. */
async function connectGuest(folderUri: vscode.Uri, isReconnect: boolean, quiet = false): Promise<boolean> {
  let url: string;
  try {
    url = sessionUrl(folderUri.authority);
  } catch (e: any) {
    fsProvider.setFailed(e);
    void vscode.window.showErrorMessage(`This folder is not a valid Collab session: ${e.message}`);
    return false;
  }
  guestState = 'connecting';
  updateUi();
  try {
    const { conn, welcome } = await openConnection(url, { name: displayName(), v: PROTOCOL_VERSION, ext: EXT_VERSION });
    const g = new GuestSession(conn, welcome, folderUri, displayName());
    g.onDidOpenBoard((name) => offerBoard(name));
    g.onDidChangeSelf(() => updateUi());
    guest = g;
    guestState = 'connected';
    fsProvider.setSession(g);
    tree.setPresence(g.presence);
    g.onDidChangePeers(updateUi);
    g.onDidEnd(({ byHost, reason }) => onGuestEnded(g, folderUri, byHost, reason));
    g.onDidChangePermission((readOnly) => {
      updateUi();
      void vscode.window.showInformationMessage(
        readOnly
          ? `${g.hostName} made you read-only. You can still look around and follow others.`
          : `${g.hostName} gave you permission to edit.`,
      );
    });
    g.onDidReceivePicture((p) => tree.avatars.setImage(p.id, p.mime, p.data));
    void applyProfile();
    g.attachOpenDocuments(isReconnect);
    if (isReconnect) fsProvider.fireChanged(folderUri);
    updateUi();
    void vscode.window.setStatusBarMessage(
      `Joined ${welcome.hostName}'s session${welcome.readOnly ? ' (read-only)' : ''}`,
      5000,
    );
  } catch (e: any) {
    guestState = 'disconnected';
    fsProvider.setFailed(e);
    updateUi();
    if (quiet) return false;
    const pick = await vscode.window.showErrorMessage(
      `Could not connect to the session: ${e?.message ?? e}`,
      'Retry',
      'Close Folder',
    );
    if (pick === 'Retry') {
      fsProvider.reset();
      await connectGuest(folderUri, true);
    } else if (pick === 'Close Folder') {
      void vscode.commands.executeCommand('workbench.action.closeFolder');
    }
    return false;
  }
  return true;
}

async function onGuestEnded(g: GuestSession, folderUri: vscode.Uri, byHost: boolean, reason: string): Promise<void> {
  if (guest !== g) return;
  WhiteboardPanel.close();
  g.dispose();
  guest = undefined;
  guestState = 'disconnected';
  fsProvider.setFailed(new Error(reason));
  tree.setPresence(undefined);
  updateUi();
  if (byHost) {
    // The session is over for everyone: close the shared folder in this window.
    void vscode.window.showInformationMessage(
      `${reason} The shared folder was closed. (If VS Code asks to save, choose "Don't Save": your edits are already in the host's copy.)`,
    );
    await vscode.commands.executeCommand('workbench.action.closeFolder');
    return;
  }
  // Connection lost (network blip, or the host closed VS Code without saying goodbye).
  // Retry quietly for a few seconds; if the host is really gone, the session is over.
  const hostName = g.hostName;
  for (let attempt = 0; attempt < 4; attempt++) {
    guestState = 'connecting';
    updateUi();
    await new Promise((r) => setTimeout(r, 2500));
    fsProvider.reset();
    if (await connectGuest(folderUri, true, true)) {
      void vscode.window.setStatusBarMessage(`Reconnected to ${hostName}'s session`, 4000);
      return;
    }
  }
  WhiteboardPanel.close();
  void vscode.window.showInformationMessage(
    `${hostName}'s session has ended (the host closed it or went offline). The shared folder was closed.`,
  );
  await vscode.commands.executeCommand('workbench.action.closeFolder');
}

// ------------------------------------------------------------------ common commands

async function stopSession(): Promise<void> {
  if (host) {
    const pick = await vscode.window.showWarningMessage(
      host.guestCount > 0 ? `Stop sharing? ${host.guestCount} participant(s) will be disconnected.` : 'Stop sharing?',
      { modal: true },
      'Stop Sharing',
    );
    if (pick !== 'Stop Sharing' || !host) return;
    WhiteboardPanel.close();
    tunnel?.dispose();
    tunnel = undefined;
    host.dispose();
    host = undefined;
    tree.setPresence(undefined);
    updateUi();
    void vscode.window.setStatusBarMessage('Collab session ended', 3000);
    return;
  }
  if (guestState !== 'idle') {
    guest?.dispose();
    guest = undefined;
    guestState = 'idle';
    fsProvider.setFailed(new Error('Left the session'));
    tree.setPresence(undefined);
    updateUi();
    await vscode.commands.executeCommand('workbench.action.closeFolder');
    return;
  }
  void vscode.window.showInformationMessage('No active Collab session.');
}

async function findFile(): Promise<void> {
  if (!guest) {
    await vscode.commands.executeCommand('workbench.action.quickOpen');
    return;
  }
  const g = guest;
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { path: string }>();
  qp.placeholder = 'Search files in the shared workspace';
  qp.matchOnDescription = true;
  qp.busy = true;
  qp.show();
  try {
    const files = await g.request<string[]>('listFiles', {});
    qp.items = files.map((p) => {
      const i = p.lastIndexOf('/');
      return { label: p.slice(i + 1), description: i > 0 ? p.slice(0, i) : '', path: p };
    });
  } catch (e: any) {
    qp.hide();
    void vscode.window.showErrorMessage(`Could not list files: ${e?.message ?? e}`);
    return;
  } finally {
    qp.busy = false;
  }
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (item) await vscode.window.showTextDocument(g.toUri(item.path));
  });
  qp.onDidHide(() => qp.dispose());
}

async function showMenu(): Promise<void> {
  type Item = vscode.QuickPickItem & { run: () => unknown };
  const items: Item[] = [];
  if (host) {
    items.push(
      { label: '$(copy) Copy Invite Link', run: copyInvite },
      tunnel
        ? { label: '$(globe) Internet link active', description: tunnel.url, run: copyInvite }
        : { label: '$(globe) Start Internet Link', description: 'Let friends on other networks join', run: () => startTunnel(true) },
      { label: '$(question) Internet sharing help', run: showInternetHelp },
      { label: '$(debug-stop) Stop Sharing', run: stopSession },
    );
  } else if (guestState !== 'idle') {
    items.push(
      { label: '$(search) Find File in Shared Workspace', run: findFile },
      { label: '$(sign-out) Leave Session', run: stopSession },
    );
  } else {
    items.push(
      { label: '$(broadcast) Share (Read/Write)', description: 'Friends can edit', run: () => startHosting(false) },
      { label: '$(lock) Share (Read-Only)', description: 'Friends can only watch', run: () => startHosting(true) },
      { label: '$(plug) Join Session', description: 'Paste an invite link', run: joinSession },
    );
  }
  const presence = currentPresence();
  if (presence) {
    for (const p of presence.list()) {
      items.push({
        label: `$(account) Go to ${p.info.name}`,
        description: p.path ?? '',
        run: () => presence.goTo(p.info.id),
      });
    }
  }
  items.push({ label: '$(gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'collab.') });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Collab Share' });
  if (pick) await pick.run();
}

// ------------------------------------------------------------------ helpers

function currentPresence(): Presence | undefined {
  return host?.presence ?? guest?.presence;
}

function displayName(): string {
  const configured = vscode.workspace.getConfiguration('collab').get<string>('displayName', '').trim();
  if (configured) return configured;
  try {
    return os.userInfo().username || 'Anonymous';
  } catch {
    return 'Anonymous';
  }
}

async function ensureDisplayName(): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration('collab');
  const configured = config.get<string>('displayName', '').trim();
  if (configured) return configured;
  const name = await vscode.window.showInputBox({
    title: 'Collab Share',
    prompt: 'Your name, as other participants will see it',
    value: displayName(),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name?.trim()) return undefined;
  await config.update('displayName', name.trim(), vscode.ConfigurationTarget.Global);
  return name.trim();
}

function updateUi(): void {
  let role: string | undefined;
  if (host) {
    role = 'host';
    const n = host.guestCount;
    const reach = tunnel ? '$(globe)' : tunnelStarting ? '$(sync~spin)' : '$(home)';
    status.text = `$(broadcast) Sharing ${reach} · ${n}`;
    status.tooltip =
      `Sharing "${host.workspaceName}" with ${n} participant(s). ` +
      (tunnel ? 'Internet link active.' : tunnelStarting ? 'Creating Internet link…' : 'Local network only.') +
      ' Click for options.';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (guestState === 'connected' && guest) {
    role = 'guest';
    status.text = `$(plug) ${guest.hostName}${guest.readOnly ? ' (read-only)' : ''}`;
    status.tooltip = `Connected to ${guest.hostName}'s session. Click for options.`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (guestState === 'connecting') {
    role = 'guest';
    status.text = '$(sync~spin) Collab: connecting…';
    status.tooltip = 'Connecting to the host';
    status.backgroundColor = undefined;
  } else if (guestState === 'disconnected') {
    role = 'guest';
    status.text = '$(debug-disconnect) Collab: disconnected';
    status.tooltip = 'Lost connection to the host. Click for options.';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    status.text = '$(broadcast) Collab';
    status.tooltip = 'Start or join a collaboration session';
    status.backgroundColor = undefined;
  }
  void vscode.commands.executeCommand('setContext', 'collab.role', role);
  tree.refresh();
}

function uiState(): UiState {
  return {
    role: host ? 'host' : guestState !== 'idle' ? 'guest' : undefined,
    host: host && {
      folderName: host.workspaceName,
      readOnly: host.readOnly,
      guestCount: host.guestCount,
      internet: tunnel ? 'active' : tunnelStarting ? 'starting' : 'off',
      internetUrl: tunnel?.url,
    },
    guest:
      !host && guestState !== 'idle'
        ? { hostName: guest?.hostName ?? 'host', readOnly: guest?.readOnly ?? false, state: guestState }
        : undefined,
    presence: currentPresence(),
    hasPicture: !!(host?.hostInfo().github || host?.hostInfo().pic || guest?.github || guest?.pic),
  };
}

/** All session-driven UI: sidebar views, file highlights and the follow indicator. */
class Views implements vscode.Disposable {
  readonly participants: ParticipantsTree;
  constructor(readonly avatars: Avatars) {
    this.participants = new ParticipantsTree(
      avatars,
      () => !!host,
      () => (host ? host.hostInfo() : guest ? guest.selfInfo() : undefined),
    );
  }
  readonly session = new SessionTree(uiState);
  readonly decorations = new PeerFileDecorations();
  readonly follow = new FollowStatus();
  private sub: vscode.Disposable | undefined;

  setPresence(p: Presence | undefined): void {
    this.participants.setPresence(p);
    this.decorations.setPresence(p);
    this.follow.setPresence(p);
    this.sub?.dispose();
    this.sub = p?.onDidChange(() => this.session.refresh());
    this.session.refresh();
  }

  refresh(): void {
    this.participants.refresh();
    this.session.refresh();
  }

  dispose(): void {
    this.sub?.dispose();
    this.follow.dispose();
  }
}

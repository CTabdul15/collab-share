// Shared wire-protocol definitions. Messages are JSON objects with a `t` (type) field.
//
// Guest -> host:   hello, yupdate, unsub, cursor, req (RPC)
// Host -> guest:   welcome, peer-join, peer-leave, cursor, yupdate, reset, saved, fs, bye, res (RPC)

export const PROTOCOL_VERSION = 2;
/** Extension version, injected at build time (see esbuild.mjs). Host and guests must match. */
declare const __EXT_VERSION__: string;
export const EXT_VERSION: string = typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : 'dev';
export const SCHEME = 'collab';

export type Msg = { t: string; [key: string]: any };

/** Selections as [anchorLine, anchorChar, activeLine, activeChar] tuples. */
export type Sel = [number, number, number, number][];

export interface PeerInfo {
  id: number;
  name: string;
  color: string;
  isHost?: boolean;
  /** Guest may only look (set per guest by the host). */
  readOnly?: boolean;
  /** GitHub username, if the person chose to show their profile picture. */
  github?: string;
  /** Id of a custom picture (sent once with a 'pic' message). */
  pic?: string;
}

export function validGithubLogin(s: unknown): string | undefined {
  return typeof s === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(s) ? s : undefined;
}

export interface PeerSnapshot extends PeerInfo {
  path: string | null;
  sel: Sel;
}

export interface Welcome {
  t: 'welcome';
  id: number;
  color: string;
  hostName: string;
  workspaceName: string;
  readOnly: boolean;
  peers: PeerSnapshot[];
  probe?: boolean;
}

export const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000',
  '#808000', '#000075', '#bfef45', '#fabed4', '#dcbeff',
];

export function colorFor(id: number): string {
  return COLORS[id % COLORS.length];
}

/** Theme color id contributed in package.json for a participant color (used by file highlights and icons). */
export function themeColorFor(color: string): string {
  const i = COLORS.indexOf(color.toLowerCase());
  return `collab.participant${i < 0 ? 0 : i}`;
}

export const COLOR_NAMES = [
  "Red", "Green", "Blue", "Orange", "Purple", "Cyan", "Magenta", "Brown", "Teal", "Maroon",
  "Olive", "Navy", "Lime", "Pink", "Lavender",
];

export function toB64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * Normalizes a workspace-relative path coming from the network.
 * Rejects absolute paths, `..` traversal and Windows drive/stream syntax.
 */
export function normalizeRel(rel: unknown): string {
  if (typeof rel !== 'string') throw codeError('Invalid path', 'NoPermissions');
  const parts = rel.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..' || p.includes(':') || p.includes('\0')) {
      throw codeError(`Path not allowed: ${rel}`, 'NoPermissions');
    }
  }
  return parts.join('/');
}

export function codeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Invite links are stored in the guest's folder URI authority as hex so any URL survives URI parsing. */
export function encodeAuthority(url: string): string {
  return Buffer.from(url, 'utf8').toString('hex');
}

export function decodeAuthority(authority: string): string {
  if (!/^[0-9a-f]+$/i.test(authority)) throw new Error('Not a Collab session address');
  return Buffer.from(authority, 'hex').toString('utf8');
}

/** Accepts ws://, wss://, http(s):// or bare host:port and returns a ws(s) URL, or throws. */
export function normalizeInvite(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error('Paste the invite link from the host.');
  if (/^https:\/\//i.test(s)) s = 'wss://' + s.slice(8);
  else if (/^http:\/\//i.test(s)) s = 'ws://' + s.slice(7);
  else if (!/^wss?:\/\//i.test(s)) s = 'ws://' + s;
  const url = new URL(s);
  if (!url.searchParams.get('token')) {
    throw new Error('The invite link is missing its "?token=…" part. Copy the full link from the host.');
  }
  return url.toString();
}

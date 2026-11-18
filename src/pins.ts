import * as vscode from 'vscode';
import { PeerInfo } from './protocol';
import { Avatars } from './ui';

export const PIN_W = 26;
export const PIN_H = 34;

/**
 * Builds the map-pin images shown at other people's cursors: a pin in their color with their
 * GitHub picture (or initials) in the circle, as data: URL images.
 */
export class Pins {
  private readonly cache = new Map<string, vscode.Uri>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly avatars: Avatars,
  ) {
    avatars.onDidChange(() => this.emitter.fire());
  }

  /** Pin image for a participant (a data: URL, since VS Code won't show images from storage). */
  get(info: PeerInfo, side: 'center' | 'left' = 'center'): vscode.Uri | undefined {
    const avatar = this.avatars.dataForInfo(info);
    const key = `${side}|${info.color}|${info.name}|${info.pic ?? ''}|${info.github ?? ''}|${avatar ? 1 : 0}`;
    let uri = this.cache.get(key);
    if (!uri) {
      uri = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(pinSvg(info, avatar, side), 'utf8').toString('base64')}`);
      this.cache.set(key, uri);
    }
    return uri;
  }
}

/** A map pin in the person's color with their picture (or initials) in the circle. */
export function pinSvg(info: PeerInfo, avatar: { mime: string; b64: string } | undefined, side: 'center' | 'left' = 'center'): string {
  const image = avatar
    ? `<image href="data:${avatar.mime};base64,${avatar.b64}" x="4" y="4" width="18" height="18" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<text x="13" y="16.6" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9.5" font-weight="700" fill="${info.color}">${escapeXml(initials(info.name))}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PIN_W}" height="${PIN_H}" viewBox="0 0 26 34">` +
    `<defs><clipPath id="c"><circle cx="13" cy="13" r="9"/></clipPath>` +
    `<filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity=".45"/></filter></defs>` +
    // Teardrop: circle (r=11.5) with its tip at the bottom centre.
    // Centered tip for most positions; tip at the left edge when the cursor is at the start of a line
    // (a centered pin would be cut off by the editor's left edge there).
    (side === 'center'
      ? `<path filter="url(#s)" d="M13 33 L4.2 20.2 A11.5 11.5 0 1 1 21.8 20.2 Z" fill="${info.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>`
      : `<path filter="url(#s)" d="M1.5 33 L3 18.8 A11.5 11.5 0 1 1 11 24.3 Z" fill="${info.color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>`) +
    `<circle cx="13" cy="13" r="9.6" fill="#ffffff"/>` +
    image +
    `</svg>`
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
  return (s || '?').toUpperCase().slice(0, 2);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

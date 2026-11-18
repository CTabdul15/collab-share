import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { gunzipSync } from 'zlib';
import { findCloudflared } from './tunnel';

/**
 * One-click download of Cloudflare's tunnel tool (cloudflared), used only by the host to share over
 * the Internet. It is the official file from Cloudflare's GitHub releases, pinned to one version and
 * checked against its SHA-256 fingerprint before it is ever run. It is stored in the extension's
 * own storage folder: no admin rights, nothing installed system-wide, removed with the extension.
 */
export const CLOUDFLARED_VERSION = '2026.10.7';

interface Asset {
  file: string;
  sha256: string;
  size: number;
  /** macOS builds are .tgz archives containing the program. */
  tgz?: boolean;
}

// Fingerprints from https://github.com/cloudflare/cloudflared/releases/tag/2026.10.7
const ASSETS: Record<string, Asset> = {
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', size: 55390512, sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343' },
  // Windows on ARM runs the x64 build through emulation.
  'win32-arm64': { file: 'cloudflared-windows-amd64.exe', size: 55390512, sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343' },
  'win32-ia32': { file: 'cloudflared-windows-386.exe', size: 38097032, sha256: '88c6b972b410db0e26745f593510d772c825a13c5a2374819e3f13a05b333082' },
  'linux-x64': { file: 'cloudflared-linux-amd64', size: 40274445, sha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', size: 37667293, sha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', size: 21834416, sha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848', tgz: true },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', size: 19847161, sha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd', tgz: true },
};

const platformKey = (platform: string = process.platform, arch: string = process.arch) => `${platform}-${arch}`;
export const assetFor = (platform?: string, arch?: string): Asset | undefined => ASSETS[platformKey(platform, arch)];

function target(storage: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storage, 'cloudflared', CLOUDFLARED_VERSION, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Pulls one file out of a .tar archive (enough for Cloudflare's macOS packages). */
export function extractFromTar(tar: Uint8Array, name: string): Uint8Array | undefined {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const entry = Buffer.from(header.subarray(0, 100)).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(Buffer.from(header.subarray(124, 136)).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const body = off + 512;
    if (entry.replace(/^\.\//, '') === name) return tar.slice(body, body + size);
    off = body + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/**
 * Returns a usable cloudflared: one already installed on the computer, the copy downloaded earlier,
 * or (after asking, unless `ask` is false) a fresh verified download. Undefined if not available.
 */
export async function ensureCloudflared(storage: vscode.Uri, configuredPath: string, ask = true): Promise<string | undefined> {
  const installed = findCloudflared(configuredPath);
  if (installed) return installed;

  const asset = assetFor();
  if (!asset) {
    void vscode.window.showWarningMessage(
      `Collab Share can't download Cloudflare's tunnel tool for this system (${platformKey()}). Install "cloudflared" yourself to share over the Internet.`,
    );
    return undefined;
  }
  const exe = target(storage);
  if (await exists(exe)) return exe.fsPath;

  if (ask) {
    const mb = Math.round(asset.size / 1e6);
    const pick = await vscode.window.showInformationMessage(
      `To share with friends over the Internet, Collab Share uses Cloudflare's free tunnel tool (cloudflared, about ${mb} MB). ` +
        'Download it now? It is the official file from Cloudflare, checked before use, and kept inside the extension (no admin rights needed).',
      'Download',
      'Not now',
    );
    if (pick !== 'Download') return undefined;
  }

  return downloadCloudflared(storage, asset, exe);
}

/** Downloads one release asset, verifies its fingerprint, unpacks it if needed and saves it as `exe`. */
export async function downloadCloudflared(storage: vscode.Uri, asset: Asset, exe = target(storage)): Promise<string | undefined> {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`;
  try {
    const bytes = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Downloading Cloudflare tunnel tool', cancellable: true },
      async (progress, token) => {
        const ctrl = new AbortController();
        token.onCancellationRequested(() => ctrl.abort());
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
        const total = Number(res.headers.get('content-length')) || asset.size;
        const parts: Uint8Array[] = [];
        let got = 0, lastPct = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.byteLength;
          const pct = Math.floor((got / total) * 100);
          if (pct > lastPct) {
            progress.report({ increment: pct - lastPct, message: `${Math.round(got / 1e6)} / ${Math.round(total / 1e6)} MB` });
            lastPct = pct;
          }
        }
        return Buffer.concat(parts);
      },
    );
    // Never run anything that isn't exactly the file Cloudflare published.
    if (sha256(bytes) !== asset.sha256) throw new Error('The downloaded file did not match Cloudflare\'s published fingerprint, so it was not used.');
    let program: Uint8Array = bytes;
    if (asset.tgz) {
      const found = extractFromTar(gunzipSync(bytes), 'cloudflared');
      if (!found) throw new Error('cloudflared was not found in the downloaded archive.');
      program = found;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(exe, '..'));
    await vscode.workspace.fs.writeFile(exe, program);
    if (process.platform !== 'win32') {
      const fs = await import('fs');
      fs.chmodSync(exe.fsPath, 0o755);
    }
    return exe.fsPath;
  } catch (e: any) {
    if (e?.name === 'AbortError') return undefined;
    void vscode.window.showErrorMessage(`Could not download Cloudflare's tunnel tool: ${e?.message ?? e}`);
    return undefined;
  }
}

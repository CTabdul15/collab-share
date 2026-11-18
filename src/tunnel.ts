import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Runs a free Cloudflare "quick tunnel" (no account needed) that forwards a public
 * https://<random>.trycloudflare.com address to the local host port.
 */
export class Tunnel {
  private exited = false;
  private exitListeners: ((reason: string) => void)[] = [];

  private constructor(
    private readonly proc: ChildProcess,
    /** Public base URL, e.g. https://abc-def.trycloudflare.com */
    readonly url: string,
  ) {
    proc.on('exit', (code) => {
      this.exited = true;
      for (const l of this.exitListeners) l(`cloudflared exited (code ${code})`);
    });
  }

  onDidExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener);
  }

  dispose(): void {
    if (this.exited) return;
    this.exited = true;
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }

  static async start(exe: string, port: number, timeoutMs = 45000): Promise<Tunnel> {
    const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise<Tunnel>((resolve, reject) => {
      let url: string | undefined;
      let output = '';
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        if (err) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          reject(err);
        } else {
          resolve(new Tunnel(proc, url!));
        }
      };
      const timer = setTimeout(
        () => finish(new Error(`Cloudflare tunnel did not start in time.${tail(output)}`)),
        timeoutMs,
      );
      let graceTimer: NodeJS.Timeout | undefined;

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        output = (output + text).slice(-4000);
        if (!url) {
          const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(output);
          if (m) {
            url = m[0];
            // Wait until the tunnel is actually connected (or give it a few seconds).
            graceTimer = setTimeout(() => finish(), 8000);
          }
        }
        if (url && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(output)) finish();
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      proc.once('error', (e) => finish(new Error(`Could not run cloudflared: ${e.message}`)));
      proc.once('exit', (code) => finish(new Error(`cloudflared stopped (code ${code}).${tail(output)}`)));
    });
  }
}

function tail(output: string): string {
  const lines = output.trim().split(/\r?\n/).slice(-3).join('\n');
  return lines ? `\n\n${lines}` : '';
}

/** Finds the cloudflared executable: setting, PATH, or common install locations. */
export function findCloudflared(configured: string): string | undefined {
  const candidates: string[] = [];
  if (configured.trim()) candidates.push(configured.trim());
  candidates.push('cloudflared');
  if (process.platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const local = process.env['LOCALAPPDATA'] ?? '';
    candidates.push(
      path.join(pf86, 'cloudflared', 'cloudflared.exe'),
      path.join(pf, 'cloudflared', 'cloudflared.exe'),
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    );
  } else {
    candidates.push('/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared');
  }
  for (const c of candidates) {
    if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
    try {
      const r = spawnSync(c, ['--version'], { windowsHide: true, timeout: 5000 });
      if (r.status === 0) return c;
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Shell command that installs cloudflared on this platform. */
export function installCommand(): string {
  switch (process.platform) {
    case 'win32':
      return 'winget install --id Cloudflare.cloudflared -e';
    case 'darwin':
      return 'brew install cloudflared';
    default:
      return 'echo "Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"';
  }
}

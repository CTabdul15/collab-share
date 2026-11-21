import * as os from 'os';
import { execFile } from 'child_process';

/** One measurement for the Sandbox performance overlay. */
export interface PerfSample {
  /** VS Code's extension host process (this extension runs in it; VS Code can't split it per extension). */
  ext: { cpu: number; rssMb: number };
  /** The whole device. */
  sys: { cpu: number; usedGb: number; totalGb: number };
  /** Device GPU load in %, if the system can tell (Windows performance counters, or nvidia-smi). */
  gpu?: number;
}

/**
 * Samples CPU / RAM (extension host + device) and, where available, GPU load, about every 1.5 s.
 * GPU queries run in a separate process at most every few seconds so they never block VS Code.
 */
export class PerfSampler {
  private timer: NodeJS.Timeout | undefined;
  private lastCpu = process.cpuUsage();
  private lastWall = process.hrtime.bigint();
  private lastSys = sysTimes();
  private gpu: number | undefined;
  private gpuBusy = false;
  private gpuTick = 0;
  private gpuDisabled = false;

  constructor(private readonly onSample: (s: PerfSample) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), 1500);
    this.sample();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private sample(): void {
    const cores = Math.max(1, os.cpus().length);
    const cpu = process.cpuUsage(this.lastCpu);
    const wall = process.hrtime.bigint();
    const wallUs = Number(wall - this.lastWall) / 1000;
    this.lastCpu = process.cpuUsage();
    this.lastWall = wall;
    const extCpu = wallUs > 0 ? ((cpu.user + cpu.system) / wallUs / cores) * 100 : 0;
    const sys = sysTimes();
    const dTotal = sys.total - this.lastSys.total, dIdle = sys.idle - this.lastSys.idle;
    this.lastSys = sys;
    const sysCpu = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    const gb = 1024 ** 3;
    if (this.gpuTick++ % 3 === 0) this.queryGpu();
    this.onSample({
      ext: { cpu: round(extCpu), rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
      sys: { cpu: round(sysCpu), usedGb: round((os.totalmem() - os.freemem()) / gb), totalGb: round(os.totalmem() / gb) },
      gpu: this.gpu,
    });
  }

  private queryGpu(): void {
    if (this.gpuBusy || this.gpuDisabled) return;
    this.gpuBusy = true;
    const done = (v: number | undefined) => { this.gpuBusy = false; if (v === undefined) return; this.gpu = Math.max(0, Math.min(100, round(v))); };
    if (process.platform === 'win32') {
      const ps = "(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum | ForEach-Object { $_.Sum }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 6000 }, (err, out) => {
        const v = Number(String(out).trim().replace(',', '.'));
        if (err && !Number.isFinite(v)) { this.gpuDisabled = true; done(undefined); return; }
        done(Number.isFinite(v) ? v : undefined);
      });
    } else {
      execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000 }, (err, out) => {
        if (err) { this.gpuDisabled = true; done(undefined); return; }
        const v = Number(String(out).split('\n')[0].trim());
        done(Number.isFinite(v) ? v : undefined);
      });
    }
  }
}

function sysTimes(): { total: number; idle: number } {
  let total = 0, idle = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}
const round = (v: number) => Math.round(v * 10) / 10;

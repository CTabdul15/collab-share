import WebSocket from 'ws';
import { codeError, Msg, Welcome } from './protocol';

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_PAYLOAD = 64 * 1024 * 1024;
const TEST_LATENCY = Number(process.env.COLLAB_TEST_LATENCY ?? 0);

/**
 * Thin JSON message layer over a WebSocket with request/response RPC.
 * Incoming non-RPC messages are buffered until a handler is attached with start().
 */
export class Connection {
  private handler: ((m: Msg) => void) | undefined;
  private buffer: Msg[] = [];
  private pending = new Map<number, Pending>();
  private nextReqId = 1;
  private closeListeners: ((code: number, reason: string) => void)[] = [];
  private _closed = false;

  onRequest: (op: string, args: any) => Promise<unknown> = async (op) => {
    throw codeError(`Unsupported request: ${op}`, 'Unavailable');
  };

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      let m: Msg;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m.t !== 'string') return;
      this.dispatch(m);
    });
    ws.on('close', (code, reason) => {
      this._closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(codeError('Connection to the session was lost', 'Unavailable'));
      }
      this.pending.clear();
      const r = reason.toString();
      for (const l of this.closeListeners) l(code, r);
    });
    // Errors are always followed by 'close'; swallow here so they never crash the extension host.
    ws.on('error', () => undefined);
  }

  get closed(): boolean {
    return this._closed;
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListeners.push(listener);
  }

  /** Attach (or replace) the message handler and flush any buffered messages. */
  start(handler: (m: Msg) => void): void {
    this.handler = handler;
    const queued = this.buffer;
    this.buffer = [];
    for (const m of queued) {
      if (this.handler !== handler) {
        this.buffer.push(m);
        continue;
      }
      handler(m);
    }
  }

  /** Detach the handler; messages are buffered until start() is called again. */
  pause(): void {
    this.handler = undefined;
  }

  send(m: Msg): void {
    const data = JSON.stringify(m);
    if (TEST_LATENCY > 0) {
      // Tests only: simulate an Internet connection (order is preserved).
      setTimeout(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(data), TEST_LATENCY);
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  request<T = any>(op: string, args: unknown, timeoutMs = 30000): Promise<T> {
    if (this._closed) return Promise.reject(codeError('Not connected to the session', 'Unavailable'));
    const id = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codeError(`Request "${op}" timed out`, 'Unavailable'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'req', id, op, args });
    });
  }

  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  private dispatch(m: Msg): void {
    if (m.t === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(codeError(String(m.error ?? 'Request failed'), String(m.code ?? 'Unknown')));
      return;
    }
    if (m.t === 'req') {
      Promise.resolve()
        .then(() => this.onRequest(String(m.op), m.args ?? {}))
        .then(
          (result) => this.send({ t: 'res', id: m.id, ok: true, result: result ?? null }),
          (err: any) =>
            this.send({ t: 'res', id: m.id, ok: false, error: String(err?.message ?? err), code: err?.code }),
        );
      return;
    }
    if (this.handler) this.handler(m);
    else this.buffer.push(m);
  }
}

/**
 * Connects to a host, sends `hello`, and resolves once the host replies with `welcome`.
 * The returned connection is paused; call conn.start(handler) to receive further messages.
 */
export function openConnection(
  url: string,
  hello: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ conn: Connection; welcome: Welcome }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: MAX_PAYLOAD });
    } catch (e: any) {
      reject(new Error(`Invalid invite link: ${e?.message ?? e}`));
      return;
    }
    const conn = new Connection(ws);
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('Timed out waiting for the host to respond.')), timeoutMs);

    ws.once('error', (e: any) => fail(new Error(friendlyNetError(e))));
    ws.once('unexpected-response', (_req, res) =>
      fail(new Error(`The address answered with HTTP ${res.statusCode}; it does not look like a Collab host.`)),
    );
    conn.onClose((code, reason) => fail(new Error(reason || `Connection closed by host (code ${code}).`)));
    ws.once('open', () => conn.send({ t: 'hello', ...hello }));
    conn.start((m) => {
      if (m.t === 'rejected') {
        fail(new Error(String(m.reason ?? 'The host refused the connection.')));
        return;
      }
      if (done || m.t !== 'welcome') return;
      done = true;
      clearTimeout(timer);
      conn.pause();
      resolve({ conn, welcome: m as Welcome });
    });
  });
}

function friendlyNetError(e: any): string {
  switch (e?.code) {
    case 'ECONNREFUSED':
      return 'Connection refused. Check the address, and that the host has started sharing.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Could not reach the host. Are you on the same network (or using a tunnel link)? A firewall may be blocking the port.';
    case 'ENOTFOUND':
      return 'Host name not found. Check the invite link.';
    default:
      return e?.message ?? String(e);
  }
}

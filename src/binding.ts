import * as vscode from 'vscode';
import * as Y from 'yjs';
import { diff, TextReplace } from './diff';

interface PendingEdit {
  start: number;
  end: number;
  text: string;
  /** Set once the document change event for this edit has been seen. */
  matched: boolean;
}

const normEol = (s: string) => s.replace(/\r\n/g, '\n');

/** Debug trace, enabled only by the integration tests. */
export const trace: string[] = [];
const tracing = !!process.env.COLLAB_TEST_OUT;
function t(b: DocBinding, msg: string): void {
  if (tracing) trace.push(`${b.doc.uri.scheme}@v${b.doc.version} ${msg}`);
}

/**
 * Keeps one VS Code TextDocument and one Y.Text (CRDT) identical.
 *
 * - Local edits (typing) are applied to the Y.Text and reach other participants through Yjs updates.
 * - Remote changes to the Y.Text are written into the document by diffing it against the Y.Text,
 *   which also makes the binding self-healing: whenever the two drift apart, the document is
 *   brought back to the shared state.
 */
export class DocBinding implements vscode.Disposable {
  private pending: PendingEdit | null = null;
  private flushing: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private verifyTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private warnedReadOnly = false;
  /** Remote updates held back while an edit is in flight, so the shared text is never more than one edit ahead. */
  private queued: { update: Uint8Array; origin: unknown }[] = [];
  private draining = false;
  /** What the document contains, updated from change events (lets us know the text before a change). */
  private shadow: string;
  private readonly undoManager: Y.UndoManager;
  /** Origin for changes that mirror the document but are not user edits (not undoable). */
  private readonly housekeeping = {};
  private readonly subs: vscode.Disposable[] = [];
  private readonly observer = (_e: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.origin !== this && tr.origin !== this.housekeeping) this.scheduleFlush();
  };

  /**
   * @param preferLocal when the document and the shared text differ at bind time, push the
   *   document's content into the shared text (used after a reconnect) instead of overwriting it.
   */
  constructor(
    readonly doc: vscode.TextDocument,
    private readonly ytext: Y.Text,
    private readOnly: boolean,
    preferLocal = false,
  ) {
    this.shadow = doc.getText();
    // Tracks only changes this user made through this binding.
    this.undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([this]), captureTimeout: 600 });
    ytext.observe(this.observer);
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.doc) this.onLocalChange(e);
      }),
    );

    const local = doc.getText();
    const shared = ytext.toString();
    if (local !== shared) {
      if (preferLocal && !readOnly) {
        const d = diff(shared, local);
        this.ytext.doc!.transact(() => this.replaceInY(d.start, d.end, d.text), this.housekeeping);
      } else {
        this.scheduleFlush();
      }
    }
  }

  /** The host changed this guest's permission. */
  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.warnedReadOnly = false;
  }

  /** Applies an update received from another participant. */
  applyRemote(update: Uint8Array, origin: unknown): void {
    if (this.disposed) return;
    if (this.flushing) {
      this.queued.push({ update, origin });
      return;
    }
    Y.applyUpdate(this.ytext.doc!, update, origin);
  }

  /**
   * Undo/redo only this user's own changes (like Live Share), even when collaborators edited
   * in between. Returns the offset where the change happened, or undefined if nothing to undo.
   */
  async undo(redo = false): Promise<number | undefined> {
    if (this.readOnly) return undefined;
    const um = this.undoManager;
    if (redo ? um.redoStack.length === 0 : um.undoStack.length === 0) return undefined;
    const beforeText = this.ytext.toString();
    if (redo) um.redo();
    else um.undo();
    const d = diff(beforeText, this.ytext.toString());
    await this.settle();
    return d.start + d.text.length;
  }

  /** Resolves once all pending remote changes have been written into the document. */
  async settle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ytext.unobserve(this.observer);
    this.undoManager.destroy();
    clearTimeout(this.retryTimer);
    clearTimeout(this.verifyTimer);
    for (const s of this.subs) s.dispose();
  }

  // ---------------------------------------------------------------- local -> shared

  private onLocalChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.disposed || e.contentChanges.length === 0) return;
    const p = this.pending;
    // Exact text of the document before this change (shadow copy kept in step with every event).
    const before = this.shadow;
    let after = before;
    for (const c of e.contentChanges) {
      after = after.slice(0, c.rangeOffset) + c.text + after.slice(c.rangeOffset + c.rangeLength);
    }
    this.shadow = after;

    // Is this the change event produced by our own applyEdit()? VS Code may split one replacement
    // into many small edits and normalize line endings, so compare the resulting text, not the
    // shape of the event.
    if (p && !p.matched) {
      const expected = before.slice(0, p.start) + p.text + before.slice(p.end);
      if (after === expected || normEol(after) === normEol(expected)) {
        t(this, `own-edit matched (${e.contentChanges.length} change(s))`);
        p.matched = true;
        const shared = this.ytext.toString();
        if (after !== shared && normEol(after) === normEol(shared)) {
          // The editor normalized line endings; record what the document actually contains.
          const d = diff(shared, after);
          this.ytext.doc!.transact(() => this.replaceInY(d.start, d.end, d.text), this.housekeeping);
        }
        return;
      }
    }

    if (this.readOnly) {
      if (!this.warnedReadOnly) {
        this.warnedReadOnly = true;
        void vscode.window.showWarningMessage('The host has made this session read-only. Your edits will be reverted.');
      }
      this.scheduleFlush();
      return;
    }

    // While remote changes are still being written into the editor, the shared text is ahead of
    // the document. Map the user's offsets through the exact difference so their typing lands
    // in the same place in the shared text.
    let transform: TextReplace | null = null;
    if (this.flushing || this.retryTimer) {
      const shared = this.ytext.toString();
      if (shared !== before) transform = diff(before, shared);
    }
    t(
      this,
      `local ${e.contentChanges.map((c) => `@${c.rangeOffset}-${c.rangeLength} ${JSON.stringify(c.text)}`).join(' ')}` +
        (transform ? ` transform-through ${JSON.stringify(transform)}` : '') +
        (this.queued.length ? ` queued=${this.queued.length}` : ''),
    );
    this.transact(() => {
      // VS Code applies multiple changes of one event sequentially, in the given order.
      for (const c of e.contentChanges) {
        let start = c.rangeOffset;
        let end = c.rangeOffset + c.rangeLength;
        if (transform) {
          start = mapOffset(start, transform);
          end = Math.max(start, mapOffset(end, transform));
        }
        this.replaceInY(start, end, c.text);
      }
    });

    // Safety net: if anything ever drifts, re-sync shortly after typing stops.
    clearTimeout(this.verifyTimer);
    this.verifyTimer = setTimeout(() => {
      if (this.disposed || this.flushing || this.doc.isClosed) return;
      const text = this.doc.getText();
      this.shadow = text;
      if (text !== this.ytext.toString()) this.scheduleFlush();
    }, 1000);
  }

  private transact(fn: () => void): void {
    this.ytext.doc!.transact(fn, this);
  }

  private replaceInY(start: number, end: number, text: string): void {
    const len = this.ytext.length;
    start = Math.min(Math.max(0, start), len);
    end = Math.min(Math.max(start, end), len);
    if (end > start) this.ytext.delete(start, end - start);
    if (text) this.ytext.insert(start, text);
  }

  // ---------------------------------------------------------------- shared -> local

  private scheduleFlush(): void {
    if (this.disposed) return;
    if (this.flushing || this.draining) {
      this.rerun = true;
      return;
    }
    this.flushing = this.flush().finally(() => {
      this.flushing = null;
      if (this.disposed) return;
      if (this.queued.length) {
        this.draining = true;
        try {
          for (const q of this.queued.splice(0)) Y.applyUpdate(this.ytext.doc!, q.update, q.origin);
        } finally {
          this.draining = false;
        }
      }
      if (this.rerun) {
        this.rerun = false;
        this.scheduleFlush();
      }
    });
  }

  private async flush(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.disposed || this.doc.isClosed) return;
      this.rerun = false;
      const current = this.doc.getText();
      this.shadow = current;
      const target = this.ytext.toString();
      if (current === target) {
        this.failures = 0;
        return;
      }
      const d = diff(current, target);
      this.pending = { ...d, matched: false };
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.doc.uri, new vscode.Range(this.doc.positionAt(d.start), this.doc.positionAt(d.end)), d.text);
      let ok = false;
      try {
        ok = await vscode.workspace.applyEdit(edit);
      } catch {
        ok = false;
      }
      t(this, `flush ${JSON.stringify(d)} ok=${ok} matched=${this.pending.matched}`);
      this.pending = null;
      if (!ok) {
        // Usually the user typed at the same moment; their change has been merged, so just retry.
        if (++this.failures > 25) {
          this.failures = 0;
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.scheduleFlush(); }, 1000);
          return;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    // Still not converged (heavy concurrent typing); try again shortly instead of spinning.
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.scheduleFlush(); }, 250);
  }
}

/** Maps an offset in the document (before `p` is applied) to the shared text (after `p`). */
function mapOffset(pos: number, p: TextReplace): number {
  if (pos <= p.start) return pos;
  if (pos >= p.end) return pos + p.text.length - (p.end - p.start);
  return p.start + p.text.length;
}

import * as vscode from 'vscode';

// Forwards language features (IntelliSense) from the host to guests. The host runs the real
// language servers (TypeScript, Python, ...) against its files, which include node_modules, and
// guests ask it for completions, hovers, definitions, references, signature help and diagnostics.
// Positions are shared because both sides hold identical text.

export type R = [number, number, number, number];

const toR = (r: vscode.Range): R => [r.start.line, r.start.character, r.end.line, r.end.character];
const fromR = (r: R): vscode.Range => new vscode.Range(r[0], r[1], r[2], r[3]);

function md(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (v instanceof vscode.MarkdownString) return v.value;
  const o = v as { language?: string; value?: string };
  if (typeof o.value === 'string') return o.language ? '```' + o.language + '\n' + o.value + '\n```' : o.value;
  return undefined;
}

// ------------------------------------------------------------------ host side

export interface HostLangContext {
  /** URI of the host's (settled) document for a shared path. */
  uriFor(path: string): Promise<vscode.Uri>;
  /** Shared path for a host URI, or undefined if outside the shared folder. */
  relPath(uri: vscode.Uri): string | undefined;
}

export async function handleLangRequest(ctx: HostLangContext, a: any): Promise<unknown> {
  const uri = await ctx.uriFor(String(a.path));
  const pos = new vscode.Position(Number(a.line) || 0, Number(a.ch) || 0);
  switch (a.kind) {
    case 'complete': {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        uri,
        pos,
        a.trigger || undefined,
        25,
      );
      if (!list) return { incomplete: false, items: [] };
      return { incomplete: !!list.isIncomplete, items: list.items.slice(0, 600).map(serializeCompletion) };
    }
    case 'hover': {
      const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos)) ?? [];
      const contents = hovers.flatMap((h) => h.contents.map(md)).filter((s): s is string => !!s);
      const range = hovers.find((h) => h.range)?.range;
      return contents.length ? { contents, range: range ? toR(range) : undefined } : null;
    }
    case 'definition':
    case 'typeDefinition':
    case 'implementation':
    case 'references': {
      const cmd = {
        definition: 'vscode.executeDefinitionProvider',
        typeDefinition: 'vscode.executeTypeDefinitionProvider',
        implementation: 'vscode.executeImplementationProvider',
        references: 'vscode.executeReferenceProvider',
      }[a.kind as string]!;
      const res = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(cmd, uri, pos)) ?? [];
      const out: { path: string; range: R }[] = [];
      for (const l of res) {
        const target = 'targetUri' in l ? l.targetUri : l.uri;
        const range = 'targetUri' in l ? (l.targetSelectionRange ?? l.targetRange) : l.range;
        const p = ctx.relPath(target);
        if (p !== undefined) out.push({ path: p, range: toR(range) });
      }
      return out;
    }
    case 'signature': {
      const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        uri,
        pos,
        a.trigger || undefined,
      );
      if (!help || help.signatures.length === 0) return null;
      return {
        activeSignature: help.activeSignature,
        activeParameter: help.activeParameter,
        signatures: help.signatures.map((s) => ({
          label: s.label,
          documentation: md(s.documentation),
          activeParameter: s.activeParameter,
          parameters: s.parameters.map((p) => ({ label: p.label, documentation: md(p.documentation) })),
        })),
      };
    }
    default:
      throw new Error(`Unknown language request ${a.kind}`);
  }
}

function serializeCompletion(it: vscode.CompletionItem): unknown {
  let range: unknown;
  if (it.range instanceof vscode.Range) range = toR(it.range);
  else if (it.range) range = { inserting: toR(it.range.inserting), replacing: toR(it.range.replacing) };
  return {
    label: it.label,
    kind: it.kind,
    detail: it.detail,
    documentation: md(it.documentation),
    insertText: it.insertText instanceof vscode.SnippetString ? { snippet: it.insertText.value } : it.insertText,
    filterText: it.filterText,
    sortText: it.sortText,
    preselect: it.preselect,
    commitCharacters: it.commitCharacters,
    tags: it.tags,
    range,
    additionalTextEdits: it.additionalTextEdits?.map((e) => ({ range: toR(e.range), newText: e.newText })),
  };
}

export function serializeDiagnostics(diags: readonly vscode.Diagnostic[]): unknown[] {
  return diags.map((d) => ({
    range: toR(d.range),
    message: d.message,
    severity: d.severity,
    source: d.source,
    code: typeof d.code === 'object' ? d.code.value : d.code,
    tags: d.tags,
  }));
}

// ------------------------------------------------------------------ guest side

export interface GuestLangContext {
  /** Shared path for a guest document, or undefined if not part of the session. */
  pathOf(uri: vscode.Uri): string | undefined;
  uriOf(path: string): vscode.Uri;
  request<T>(args: Record<string, unknown>): Promise<T>;
  /** Waits until pending remote edits are written into this document. */
  settle(uri: vscode.Uri): Promise<void>;
}

/** Registers guest-side providers for collab:// documents. They call `ctx()` for the live session. */
export function registerGuestLanguageFeatures(ctx: () => GuestLangContext | undefined): vscode.Disposable {
  const selector: vscode.DocumentSelector = { scheme: 'collab' };

  async function ask<T>(doc: vscode.TextDocument, pos: vscode.Position, kind: string, extra: object = {}) {
    const c = ctx();
    const path = c?.pathOf(doc.uri);
    if (!c || path === undefined) return undefined;
    await c.settle(doc.uri);
    try {
      return await c.request<T>({ kind, path, line: pos.line, ch: pos.character, ...extra });
    } catch {
      return undefined;
    }
  }

  const locations = async (doc: vscode.TextDocument, pos: vscode.Position, kind: string) => {
    const res = await ask<{ path: string; range: R }[]>(doc, pos, kind);
    const c = ctx();
    return res && c ? res.map((l) => new vscode.Location(c.uriOf(l.path), fromR(l.range))) : undefined;
  };

  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(doc, pos, _token, context) {
          const res = await ask<{ incomplete: boolean; items: any[] }>(doc, pos, 'complete', {
            trigger: context.triggerCharacter,
          });
          if (!res) return undefined;
          return new vscode.CompletionList(res.items.map(deserializeCompletion), res.incomplete);
        },
      },
      '.', '"', "'", '`', '/', '@', '<', '#',
    ),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(doc, pos) {
        const res = await ask<{ contents: string[]; range?: R }>(doc, pos, 'hover');
        if (!res) return undefined;
        return new vscode.Hover(
          res.contents.map((s) => new vscode.MarkdownString(s)),
          res.range ? fromR(res.range) : undefined,
        );
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, { provideDefinition: (d, p) => locations(d, p, 'definition') }),
    vscode.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: (d, p) => locations(d, p, 'typeDefinition') }),
    vscode.languages.registerImplementationProvider(selector, { provideImplementation: (d, p) => locations(d, p, 'implementation') }),
    vscode.languages.registerReferenceProvider(selector, { provideReferences: (d, p) => locations(d, p, 'references') }),
    vscode.languages.registerSignatureHelpProvider(
      selector,
      {
        async provideSignatureHelp(doc, pos, _token, context) {
          const res = await ask<any>(doc, pos, 'signature', { trigger: context.triggerCharacter });
          if (!res) return undefined;
          const help = new vscode.SignatureHelp();
          help.activeSignature = res.activeSignature ?? 0;
          help.activeParameter = res.activeParameter ?? 0;
          help.signatures = res.signatures.map((s: any) => {
            const sig = new vscode.SignatureInformation(s.label, s.documentation ? new vscode.MarkdownString(s.documentation) : undefined);
            sig.activeParameter = s.activeParameter;
            sig.parameters = s.parameters.map(
              (p: any) => new vscode.ParameterInformation(p.label, p.documentation ? new vscode.MarkdownString(p.documentation) : undefined),
            );
            return sig;
          });
          return help;
        },
      },
      { triggerCharacters: ['(', ','], retriggerCharacters: [')'] },
    ),
  );
}

function deserializeCompletion(s: any): vscode.CompletionItem {
  const it = new vscode.CompletionItem(s.label, s.kind);
  it.detail = s.detail;
  if (s.documentation) it.documentation = new vscode.MarkdownString(s.documentation);
  if (s.insertText && typeof s.insertText === 'object') it.insertText = new vscode.SnippetString(s.insertText.snippet);
  else if (typeof s.insertText === 'string') it.insertText = s.insertText;
  it.filterText = s.filterText;
  it.sortText = s.sortText;
  it.preselect = s.preselect;
  it.commitCharacters = s.commitCharacters;
  it.tags = s.tags;
  if (Array.isArray(s.range)) it.range = fromR(s.range);
  else if (s.range) it.range = { inserting: fromR(s.range.inserting), replacing: fromR(s.range.replacing) };
  if (s.additionalTextEdits) {
    it.additionalTextEdits = s.additionalTextEdits.map((e: any) => vscode.TextEdit.replace(fromR(e.range), e.newText));
  }
  return it;
}

export function deserializeDiagnostics(items: any[]): vscode.Diagnostic[] {
  return items.map((d) => {
    const diag = new vscode.Diagnostic(fromR(d.range), d.message, d.severity);
    diag.source = d.source ? `${d.source} (host)` : 'host';
    if (d.code !== undefined) diag.code = d.code;
    diag.tags = d.tags;
    return diag;
  });
}

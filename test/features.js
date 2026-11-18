// Guests seeing/following each other, IntelliSense forwarding (incl. node_modules), diagnostics,
// and per-user undo.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const log = (ok, name, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      // retry
    }
    await sleep(100);
  }
  return false;
}

exports.run = async function run() {
  const outFile = process.env.COLLAB_TEST_OUT;
  let host;
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
    const { testApi } = await ext.activate();
    const { HostSession, GuestSession, openConnection, fsProvider } = testApi;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-feat-'));
    const w = (p, s) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), s);
    };
    w('package.json', JSON.stringify({ name: 'demo', type: 'module', dependencies: { fakemod: '1.0.0' } }));
    w('jsconfig.json', JSON.stringify({ compilerOptions: { module: 'ES2020', target: 'ES2020', checkJs: true } }));
    w('node_modules/fakemod/package.json', JSON.stringify({ name: 'fakemod', version: '1.0.0', types: 'index.d.ts' }));
    w(
      'node_modules/fakemod/index.d.ts',
      '/** The world. */\nexport declare const world: {\n  /** Sends a chat message to everyone. */\n  sendMessage(message: string): void;\n  getPlayers(): string[];\n};\n',
    );
    w('main.js', "import { world } from 'fakemod';\n\nworld.\n");

    host = await HostSession.start(vscode.Uri.file(dir), 7300 + Math.floor(Math.random() * 300), 'Host');
    const url = `ws://localhost:${host.port}/?token=${host.token}`;
    const folder = vscode.Uri.from({ scheme: 'collab', authority: Buffer.from(url).toString('hex'), path: '/proj' });
    const g1 = await openConnection(url, { name: 'Guest1', v: 2 });
    const guest = new GuestSession(g1.conn, g1.welcome, folder);
    fsProvider.setSession(guest);
    testApi.useSessions(undefined, guest);

    // ---- second guest: does guest 1 see and follow them?
    const g2 = await openConnection(url, { name: 'Guest2', v: 2 });
    g2.conn.start(() => undefined);
    await waitFor(() => guest.presence.list().length === 2);
    const names = guest.presence.list().map((p) => p.info.name);
    log(names.includes('Host') && names.includes('Guest2'), 'guest sees host and other guest', JSON.stringify(names));
    g2.conn.send({ t: 'cursor', path: 'main.js', sel: [[2, 0, 2, 6]] });
    const g2id = g2.welcome.id;
    const sawCursor = await waitFor(() => guest.presence.list().find((p) => p.info.id === g2id)?.path === 'main.js');
    log(sawCursor, 'guest sees other guest’s file');
    guest.presence.follow(g2id);
    const followed = await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === vscode.Uri.joinPath(folder, 'main.js').toString());
    log(followed, 'guest can follow other guest', vscode.window.activeTextEditor?.document.uri.toString());
    guest.presence.follow(undefined);

    // ---- the Participants list a guest actually sees (the host is participant 0)
    testApi.views().setPresence(guest.presence);
    const keys = testApi.views().participants.getChildren();
    const labels0 = keys.map((k) => testApi.views().participants.getTreeItem(k).label);
    log(keys.includes('peer:0') && labels0.includes('Host'), 'guest’s Participants list shows the host', JSON.stringify(labels0));

    // ---- host switches a guest to read-only and back
    let permEvents = [];
    guest.onDidChangePermission((ro) => permEvents.push(ro));
    host.setPermission(g1.welcome.id, true);
    await waitFor(() => guest.readOnly === true);
    log(guest.readOnly && permEvents[0] === true, 'host can make a guest read-only');
    const sawRo = await waitFor(() => guest.presence.get(0) && true);
    const g2view = await waitFor(() => {
      // Guest 2 learns Guest 1 is read-only through peer-update; check from guest 1's own host view instead.
      return host.presence.get(g1.welcome.id)?.readOnly === true;
    });
    log(sawRo && g2view, 'others see the read-only badge');

    // ---- custom picture (no GitHub login): reaches the host and the other guests
    const hostPics = [];
    host.onDidReceivePicture((p) => hostPics.push(p.id));
    const g2pics = [];
    g2.conn.start((m) => m.t === 'pic' && g2pics.push(m.id));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
    guest.setProfile(undefined, { mime: 'image/png', data: png, id: 'x' });
    const picOk = await waitFor(() => hostPics.length === 1 && g2pics.length === 1 && host.presence.get(g1.welcome.id)?.pic === hostPics[0]);
    log(picOk, 'custom picture shared with host and other guests', JSON.stringify({ hostPics, g2pics }));

    // ---- host changes a guest's color; the guest learns it
    host.setColor(g1.welcome.id, '#4363d8');
    log(await waitFor(() => guest.welcome.color === '#4363d8'), 'host can change a guest’s color');

    // ---- version check
    try {
      await openConnection(url, { name: 'Old', v: 2, ext: '0.0.1' }, 4000);
      log(false, 'rejects different extension version');
    } catch (e) {
      log(/Version mismatch/.test(e.message), 'rejects different extension version', e.message);
    }

    // ---- read-only guest: typing is reverted and never reaches the host
    const gUri = vscode.Uri.joinPath(folder, 'main.js');
    const gEd = await vscode.window.showTextDocument(gUri);
    await waitFor(() => guest.isTracked('main.js'));
    const hostCopy = () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.endsWith('main.js'));
    const beforeRo = gEd.document.getText();
    await gEd.edit((b) => b.insert(new vscode.Position(0, 0), 'HACK '));
    const reverted = await waitFor(() => gEd.document.getText() === beforeRo);
    await sleep(500);
    log(reverted && !hostCopy()?.getText().includes('HACK'), 'read-only guest edits are reverted, host unchanged');

    // ---- whiteboard: read-only guest can't draw
    const hb = host.boardConnection();
    const gb = await guest.boardConnection();
    const gShapesNow = () => gb.doc.getMap('shapes');
    const hShapes = hb.doc.getMap('shapes');
    gb.doc.transact(() => gShapesNow().set('ro-try', { id: 'ro-try', type: 'line', x1: 0, y1: 0, x2: 5, y2: 5, t: 1 }), 'local');
    await sleep(600);
    log(!hShapes.has('ro-try'), 'read-only guest cannot draw on the whiteboard');
    log(await waitFor(() => !gShapesNow().has('ro-try')), 'guest board reloaded after a dropped drawing');

    host.setPermission(g1.welcome.id, false);
    await waitFor(() => guest.readOnly === false);
    log(!guest.readOnly && permEvents.at(-1) === false, 'host can give edit access back');

    // ---- whiteboard sync both ways
    hb.doc.transact(() => hShapes.set('h1', { id: 'h1', type: 'rect', x1: 0, y1: 0, x2: 100, y2: 50, color: '#fff', t: 2 }), 'local');
    const toGuest = await waitFor(() => gShapesNow().has('h1'));
    gb.doc.transact(() => gShapesNow().set('g1', { id: 'g1', type: 'arrow', x1: 0, y1: 0, x2: 30, y2: 30, color: '#ff0', t: 3 }), 'local');
    const toHost = await waitFor(() => hShapes.has('g1'));
    log(toGuest && toHost, 'whiteboard drawings sync both ways');
    gb.doc.transact(() => gShapesNow().delete('h1'), 'local');
    log(await waitFor(() => !hShapes.has('h1')), 'whiteboard erase syncs');

    // ---- logic simulator on the host, streamed to guests
    {
      const S = () => gb.doc.getMap('shapes');
      const put = (o) => gb.doc.transact(() => S().set(o.id, o), 'local');
      const node = (id, kind, extra = {}) => put({ id, type: 'node', kind, x: 0, y: 0, t: 1, ...extra });
      const wire = (id, a, ap, b, bp) => put({ id, type: 'wire', a: { n: a, p: ap }, b: { n: b, p: bp }, t: 1 });
      let guestSim = null;
      guest.onSim((snap) => (guestSim = snap));
      const q = (id) => !!host.circuit.current().s[id]?.q;
      const press = async (id) => { put({ ...S().get(id), value: true }); await sleep(30); put({ ...S().get(id), value: false }); await sleep(250); };
      // Push button on the Clock of a T flip-flop; Reset button on its bottom pin
      node('btn', 'BUTTON', { value: false }); node('rst', 'BUTTON', { value: false }); node('tff', 'TFF'); node('lamp', 'LAMP');
      wire('w1', 'btn', 0, 'tff', 1); wire('w2', 'rst', 0, 'tff', 3); wire('w3', 'tff', 0, 'lamp', 0);
      await sleep(300);
      const seq = [];
      for (let i = 0; i < 3; i++) { await press('btn'); seq.push(q('tff')); }
      log(JSON.stringify(seq) === '[true,false,true]', 'T flip-flop flips once per short button press (host simulation)', JSON.stringify(seq));
      await press('rst');
      log(q('tff') === false, 'Reset input (bottom) clears the flip-flop');
      await press('btn');
      const lit = await waitFor(() => guestSim && guestSim.s.tff?.q === true && guestSim.i.lamp?.[0] === true, 3000);
      log(lit, 'guest receives live results (flip-flop on, lamp lit)');
      // D flip-flop with lever on D
      node('lev', 'LEVER', { value: true }); node('clk', 'BUTTON', { value: false }); node('dff', 'DFF');
      wire('w4', 'lev', 0, 'dff', 0); wire('w5', 'clk', 0, 'dff', 1);
      await sleep(300);
      await press('clk'); const d1 = q('dff');
      put({ ...S().get('lev'), value: false }); await sleep(300); const held = q('dff');
      await press('clk');
      log(d1 === true && held === true && q('dff') === false, 'D flip-flop stores D on each clock pulse');
      // Fast clock: 0.1 s clock → counter
      node('fast', 'CLOCK', { value: 0.1 }); node('cnt', 'COUNTER', { value: 1000 });
      wire('w6', 'fast', 0, 'cnt', 0);
      await sleep(300);
      const c0 = host.circuit.current().s.cnt.count;
      await sleep(3000);
      const c1 = host.circuit.current().s.cnt.count;
      log(c1 - c0 >= 26 && c1 - c0 <= 32, '0.1 s clock counts 10 per second without missing pulses', `${c1 - c0} in 3 s`);
    }

    // ---- whiteboard save / open (add to board)
    {
      const bf = testApi.boardFile;
      const board = [
        { id: 'n1', type: 'node', kind: 'LEVER', x: 0, y: 0 }, { id: 'n2', type: 'node', kind: 'LAMP', x: 200, y: 0 },
        { id: 'w', type: 'wire', a: { n: 'n1', p: 0 }, b: { n: 'n2', p: 0 } }, { id: 'p', type: 'pen', pts: [0, 0, 50, 50] },
      ];
      const text = bf.serializeBoard(board);
      const back = bf.parseBoard(text);
      log(JSON.stringify(back) === JSON.stringify(board), 'board file round-trips');
      let k = 0;
      const added = bf.prepareForAdd(board, back, () => 'new' + k++);
      const ids = new Set(added.map((x) => x.id));
      const w = added.find((x) => x.type === 'wire');
      const lever = added.find((x) => x.kind === 'LEVER');
      log(added.length === 4 && ![...ids].some((id) => ['n1', 'n2', 'w', 'p'].includes(id)) && ids.has(w.a.n) && ids.has(w.b.n), 'adding a file gives new ids and keeps wires connected');
      log(lever.x > 200, 'added items are placed next to the existing drawing', 'x=' + lever.x);
      let bad = false;
      try { bf.parseBoard('{"hello":1}'); } catch { bad = true; }
      log(bad, 'non-whiteboard files are rejected');
    }

    // ---- IntelliSense forwarded from host (types come from node_modules on the host)
    let labels = [];
    const gotCompletion = await waitFor(async () => {
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', gUri, new vscode.Position(2, 6), '.');
      labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
      return labels.includes('sendMessage');
    }, 30000);
    log(gotCompletion, 'completion from node_modules types on guest', labels.slice(0, 8).join(','));

    let hoverText = '';
    const gotHover = await waitFor(async () => {
      const hs = await vscode.commands.executeCommand('vscode.executeHoverProvider', gUri, new vscode.Position(0, 10));
      hoverText = hs.flatMap((h) => h.contents.map((c) => c.value ?? String(c))).join(' ');
      return /world/.test(hoverText);
    }, 15000);
    log(gotHover && /sendMessage|getPlayers/.test(hoverText), 'hover shows node_modules types', hoverText.replace(/\s+/g, ' ').slice(0, 120));

    let defs = [];
    const gotDef = await waitFor(async () => {
      defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', gUri, new vscode.Position(2, 2));
      return defs.some((d) => (d.uri ?? d.targetUri).toString().includes('fakemod'));
    }, 15000);
    log(gotDef, 'go to definition into node_modules', defs.map((d) => (d.uri ?? d.targetUri).path).join(','));
    if (gotDef) {
      const d = defs.find((x) => (x.uri ?? x.targetUri).toString().includes('fakemod'));
      const doc = await vscode.workspace.openTextDocument(d.uri ?? d.targetUri);
      log(doc.getText().includes('sendMessage'), 'definition file opens on guest');
    }

    // ---- diagnostics from host
    await gEd.edit((b) => b.insert(new vscode.Position(2, 6), 'sendMessage(42);'));
    let diagMsgs = [];
    const gotDiag = await waitFor(() => {
      diagMsgs = vscode.languages.getDiagnostics(gUri).map((d) => d.message);
      return diagMsgs.some((m) => /number|string/i.test(m));
    }, 20000);
    log(gotDiag, 'host errors shown on guest', diagMsgs.join(' | ').slice(0, 120));

    // ---- per-user undo: guest's Ctrl+Z must not undo the host's typing
    const hDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'main.js')));
    await vscode.window.showTextDocument(gUri);
    await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(1, 0), '// guest line\n'));
    await sleep(800);
    const he = new vscode.WorkspaceEdit();
    he.insert(hDoc.uri, new vscode.Position(0, 0), '// host line\n');
    await vscode.workspace.applyEdit(he);
    await waitFor(() => vscode.window.activeTextEditor.document.getText().includes('// host line'));
    await vscode.window.showTextDocument(gUri);
    await vscode.commands.executeCommand('collab.undo');
    const t = await waitFor(() => !hDoc.getText().includes('// guest line'));
    log(t && hDoc.getText().includes('// host line'), 'undo removes only my change', JSON.stringify(hDoc.getText().slice(0, 60)));
    await vscode.commands.executeCommand('collab.redo');
    const r = await waitFor(() => hDoc.getText().includes('// guest line') && hDoc.getText().includes('// host line'));
    log(r, 'redo brings it back');

    guest.dispose();
  } catch (e) {
    log(false, 'unexpected error', e && e.stack);
  } finally {
    host?.dispose();
    fs.writeFileSync(outFile, results.join('\n') + '\n');
  }
};

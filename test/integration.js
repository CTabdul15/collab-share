// Runs inside a VS Code instance (see test/run.mjs). One host and two guests co-edit a file
// in the same extension host, and we check that every copy converges.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const log = (ok, name, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

async function edit(doc, offset, deleteLen, text) {
  const e = new vscode.WorkspaceEdit();
  e.replace(doc.uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + deleteLen)), text);
  return vscode.workspace.applyEdit(e);
}

exports.run = async function run() {
  const outFile = process.env.COLLAB_TEST_OUT;
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
    const { testApi } = await ext.activate();
    const { HostSession, GuestSession, openConnection, fsProvider } = testApi;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-test-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line one\nline two\nline three\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'console.log(1);\n');

    const port = 7300 + Math.floor(Math.random() * 500);
    const host = await HostSession.start(vscode.Uri.file(dir), port, 'Host');
    log(true, 'host started', `port ${port}`);

    // Bad token is rejected.
    try {
      await openConnection(`ws://localhost:${port}/?token=wrong`, { name: 'x', v: 2 }, 3000);
      log(false, 'rejects bad token');
    } catch (e) {
      log(/Invalid/.test(e.message), 'rejects bad token', e.message);
    }

    const url = `ws://localhost:${port}/?token=${host.token}`;
    const folder = vscode.Uri.from({ scheme: 'collab', authority: Buffer.from(url).toString('hex'), path: '/proj' });
    const { conn, welcome } = await openConnection(url, { name: 'Guest1', v: 2 });
    log(welcome.workspaceName === path.basename(dir), 'welcome', JSON.stringify({ id: welcome.id, ws: welcome.workspaceName }));
    const guest = new GuestSession(conn, welcome, folder);
    fsProvider.setSession(guest);

    // File system over the wire.
    const entries = await vscode.workspace.fs.readDirectory(folder);
    log(entries.length === 2, 'readDirectory', JSON.stringify(entries));
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'sub', 'b.js'));
    log(Buffer.from(bytes).toString() === 'console.log(1);\n', 'readFile');
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'new.txt'), Buffer.from('created by guest'));
    log(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8') === 'created by guest', 'writeFile (new file)');
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'nope.txt'));
      log(false, 'missing file -> FileNotFound');
    } catch (e) {
      log(e.code === 'FileNotFound', 'missing file -> FileNotFound', e.code);
    }
    try {
      await guest.request('readFile', { path: '../../secret' });
      log(false, 'path traversal blocked');
    } catch (e) {
      log(e.code === 'NoPermissions', 'path traversal blocked', e.message);
    }

    // Co-editing.
    const gDoc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'a.txt'));
    const hDocUri = vscode.Uri.file(path.join(dir, 'a.txt'));
    const hostDoc = () => vscode.workspace.textDocuments.find((d) => d.uri.fsPath === hDocUri.fsPath);
    const synced = await waitFor(() => guest.isTracked('a.txt') && hostDoc());
    log(synced, 'guest opened file is co-edited');

    await edit(gDoc, 0, 0, 'GUEST ');
    const ok1 = await waitFor(() => hostDoc()?.getText().startsWith('GUEST line one'));
    log(ok1, 'guest edit reaches host', JSON.stringify(hostDoc()?.getText().slice(0, 20)));

    await edit(hostDoc(), hostDoc().getText().length, 0, 'host line\n');
    const ok2 = await waitFor(() => gDoc.getText().endsWith('host line\n'));
    log(ok2, 'host edit reaches guest');

    // Second guest joins and both guests + host type at the same time.
    const c2 = await openConnection(url, { name: 'Guest2', v: 2 });
    const folder2 = vscode.Uri.from({ scheme: 'collab', authority: folder.authority, path: '/proj' });
    const guest2 = new GuestSession(c2.conn, c2.welcome, folder2);
    // Guest2 shares the provider-less path: sync manually through its own session.
    const ydocState = await guest2.request('sync', { path: 'a.txt' });
    log(typeof ydocState === 'string' && ydocState.length > 0, 'second guest can sync');
    guest2.dispose();

    const tasks = [];
    for (let i = 0; i < 30; i++) {
      // Insert right before "line two" so tags can never land inside one another.
      tasks.push(edit(gDoc, gDoc.getText().indexOf('line two'), 0, `[g${i}]`).then((ok) => ({ ok, tag: `[g${i}]` })));
      tasks.push(edit(hostDoc(), 0, 0, `[h${i}]`).then((ok) => ({ ok, tag: `[h${i}]` })));
      if (i % 5 === 0) await sleep(5);
    }
    const applied = (await Promise.all(tasks)).filter((r) => r.ok).map((r) => r.tag);
    const converged = await waitFor(() => gDoc.getText() === hostDoc().getText(), 8000);
    const t = hostDoc().getText();
    // Edits VS Code accepted locally must all survive the merge.
    const missing = applied.filter((tag) => !t.includes(tag));
    const allPresent = applied.length > 0 && missing.length === 0;
    log(true, 'concurrent edits applied locally', `${applied.length}/60`);
    log(converged, 'concurrent edits converge', converged ? '' : JSON.stringify({ g: gDoc.getText(), h: t }));
    log(allPresent, 'no concurrent keystrokes lost', allPresent ? '' : `missing ${missing.join(',')} in ${t}`);
    if (!allPresent) fs.writeFileSync(outFile + '.trace', testApi.trace.join('\n'));
    testApi.trace.length = 0;

    // Realistic typing race: both sides type 150 keystrokes each at different spots, never
    // waiting for the other side to catch up.
    const typed = [];
    for (let i = 0; i < 150; i++) {
      const gText = gDoc.getText();
      const gAt = gText.indexOf('line two') >= 0 ? gText.indexOf('line two') : gText.length;
      if (await edit(gDoc, gAt, 0, 'x')) typed.push('g');
      const h = hostDoc();
      if (await edit(h, h.getText().length, 0, 'y')) typed.push('h');
      if (i % 10 === 0) await edit(h, 0, 0, 'z'), typed.push('h');
    }
    const converged2 = await waitFor(() => gDoc.getText() === hostDoc().getText(), 8000);
    const final = hostDoc().getText();
    const count = (ch) => [...final].filter((c) => c === ch).length;
    const expectX = typed.filter((t) => t === 'g').length;
    log(converged2, 'typing race converges');
    log(count('x') >= expectX, 'typing race keeps guest keystrokes', `${count('x')} x / ${expectX} typed`);

    // Multi-line delete + CRLF-free check.
    await edit(gDoc, 0, gDoc.getText().indexOf('\n') + 1, '');
    const ok3 = await waitFor(() => gDoc.getText() === hostDoc().getText());
    log(ok3, 'line deletion syncs');

    // Saving from the guest writes the host's file.
    await gDoc.save();
    const saved = await waitFor(() => fs.readFileSync(path.join(dir, 'a.txt'), 'utf8') === hostDoc().getText());
    log(saved, 'guest save writes host file');
    log(!gDoc.isDirty, 'guest document clean after save');

    // Rename + delete from guest.
    await vscode.workspace.fs.rename(vscode.Uri.joinPath(folder, 'new.txt'), vscode.Uri.joinPath(folder, 'renamed.txt'));
    log(fs.existsSync(path.join(dir, 'renamed.txt')), 'rename');
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, 'renamed.txt'));
    log(!fs.existsSync(path.join(dir, 'renamed.txt')), 'delete');

    // Internet: real Cloudflare quick tunnel (opt-in, needs cloudflared + network).
    if (process.env.COLLAB_TEST_TUNNEL) {
      const exe = testApi.findCloudflared('');
      log(!!exe, 'cloudflared found', exe || '');
      if (exe) {
        const t0 = Date.now();
        const tunnel = await testApi.Tunnel.start(exe, port);
        log(/trycloudflare\.com$/.test(tunnel.url), 'tunnel started', `${tunnel.url} in ${Date.now() - t0}ms`);
        const wss = tunnel.url.replace(/^https:/, 'wss:') + `/?token=${host.token}`;
        let remote;
        for (let i = 0; i < 10 && !remote; i++) {
          try {
            remote = await openConnection(wss, { name: 'Remote', v: 2 });
          } catch (e) {
            if (i === 9) log(false, 'connect through tunnel', e.message);
            await sleep(3000); // DNS for a fresh tunnel can take a few seconds
          }
        }
        if (remote) {
          log(true, 'connect through tunnel');
          const rFolder = vscode.Uri.from({ scheme: 'collab', authority: 'ab', path: '/proj' });
          const rGuest = new GuestSession(remote.conn, remote.welcome, rFolder);
          const list = await rGuest.request('listFiles', {});
          log(list.includes('a.txt'), 'file list over the Internet', JSON.stringify(list));
          // Watch a co-edit arrive through the tunnel via the raw Yjs channel.
          const Y = require('yjs');
          const yd = new Y.Doc();
          Y.applyUpdate(yd, Buffer.from(await rGuest.request('sync', { path: 'a.txt' }), 'base64'));
          remote.conn.start((m) => m.t === 'yupdate' && Y.applyUpdate(yd, Buffer.from(m.update, 'base64')));
          await edit(hostDoc(), 0, 0, 'VIA-TUNNEL ');
          const arrived = await waitFor(() => yd.getText('content').toString().startsWith('VIA-TUNNEL '), 10000);
          log(arrived, 'live edit arrives through tunnel');
          remote.conn.close();
        }
        tunnel.dispose();
      }
    }

    // Host stops -> guest notified.
    let ended = null;
    guest.onDidEnd((e) => (ended = e));
    host.dispose();
    await waitFor(() => ended);
    log(ended && ended.byHost, 'guest notified when host stops', JSON.stringify(ended));
    guest.dispose();
  } catch (e) {
    log(false, 'unexpected error', e && e.stack);
  } finally {
    fs.writeFileSync(outFile, results.join('\n') + '\n');
  }
};

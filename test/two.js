// Two separate VS Code instances: COLLAB_ROLE=host or guest. They coordinate through files in
// COLLAB_SHARED_DIR and take turns doing editor actions on the same file.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shared = process.env.COLLAB_SHARED_DIR;
const role = process.env.COLLAB_ROLE;
const out = process.env.COLLAB_TEST_OUT;
const notes = [];
const note = (s) => notes.push(`[${role}] ${s}`);

async function waitFile(name, ms = 60000) {
  const p = path.join(shared, name);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${name}`);
}
const signal = (name, data = '') => fs.writeFileSync(path.join(shared, name), data);
const snap = (name, doc) => signal(name, doc.getText().replace(/\r\n/g, '\n'));

async function actions(prefix, ed) {
  const doc = ed.document;
  const show = () => vscode.window.showTextDocument(doc, { preview: false });
  await show();
  vscode.window.activeTextEditor.selection = new vscode.Selection(2, 0, 50, 0);
  await vscode.commands.executeCommand('editor.action.formatSelection');
  await sleep(1500);
  snap(`${prefix}-1-format`, doc);
  await show();
  await vscode.commands.executeCommand('collab.undo');
  await sleep(1500);
  snap(`${prefix}-2-undo`, doc);
  await show();
  await vscode.commands.executeCommand('collab.redo');
  await sleep(1500);
  snap(`${prefix}-3-redo`, doc);
  await show();
  await vscode.commands.executeCommand('collab.undo');
  await sleep(1500);
  snap(`${prefix}-4-undo`, doc);
  // Paste a block, then undo it.
  await show();
  const block = Array.from({ length: 60 }, (_, i) => `world.sendMessage("pasted ${i}");`).join('\n') + '\n';
  await vscode.env.clipboard.writeText(block);
  vscode.window.activeTextEditor.selection = new vscode.Selection(10, 0, 10, 0);
  await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
  await sleep(1500);
  snap(`${prefix}-5-paste`, doc);
  await show();
  await vscode.commands.executeCommand('collab.undo');
  await sleep(1500);
  snap(`${prefix}-6-undo`, doc);
  // Type quickly.
  await show();
  vscode.window.activeTextEditor.selection = new vscode.Selection(3, 0, 3, 0);
  for (const ch of `// typed by ${role}\n`) await vscode.commands.executeCommand('type', { text: ch });
  await sleep(1500);
  snap(`${prefix}-7-type`, doc);
}

exports.run = async function run() {
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
    const { testApi } = await ext.activate();
    if (role === 'host') {
      const root = vscode.workspace.workspaceFolders[0].uri;
      const host = await testApi.HostSession.start(root, 7900, 'Host');
      testApi.useSessions(host, undefined);
      const ed = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'main.js'));
      signal('host-ready', JSON.stringify({ port: host.port, token: host.token }));
      await waitFile('guest-done-actions', 120000);
      await sleep(1000);
      snap('G-final-on-host', ed.document);
      signal('host-start-actions');
      await actions('H', ed);
      signal('host-done-actions');
      await waitFile('guest-finished', 60000);
      host.dispose();
    } else {
      const { port, token } = JSON.parse(await waitFile('host-ready'));
      const url = `ws://localhost:${port}/?token=${token}`;
      const folder = vscode.Uri.from({ scheme: 'collab', authority: Buffer.from(url).toString('hex'), path: '/proj' });
      const { conn, welcome } = await testApi.openConnection(url, { name: 'Guest', v: 2 });
      const guest = new testApi.GuestSession(conn, welcome, folder);
      testApi.fsProvider.setSession(guest);
      testApi.useSessions(undefined, guest);
      const ed = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder, 'main.js'));
      await sleep(1500);
      await actions('G', ed);
      await sleep(1000);
      snap('G-final-on-guest', ed.document);
      signal('guest-done-actions');
      await waitFile('host-done-actions', 120000);
      await sleep(2000);
      snap('H-final-on-guest', ed.document);
      signal('guest-finished');
      await sleep(500);
      guest.dispose();
    }
    note('ok');
  } catch (e) {
    note('error ' + (e && e.stack));
  } finally {
    fs.writeFileSync(out, notes.join('\n') + '\n');
    try {
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
      fs.writeFileSync(path.join(shared, `${role}-trace.txt`), (await ext.activate()).testApi.trace.join('\n'));
    } catch {
      // ignore
    }
  }
};

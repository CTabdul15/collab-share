// Reproduces "format a long selection, then undo" on a Windows-style (CRLF) file,
// on both the host and the guest, and checks the copies converge and stay stable.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];
const log = (ok, name, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

// Deliberately badly formatted code, Windows line endings.
const UGLY = [
  "import { world, system } from '@minecraft/server';",
  '',
  'function  getScore( player,objective ){',
  'const obj=world.scoreboard.getObjective(objective)',
  '        if(!obj){return 0}',
  'try{ return obj.getScore(player)??0 }catch(e){return 0}',
  '}',
  '',
  'async   function showShop(player,callback){',
  '  const ui=new ActionFormData().title("SHOP").body("pick").button("Return","textures/ui/cancel")',
  'try{',
  'const res=await ui.show(player)',
  '      if(!res.canceled&&callback){ system.runTimeout(()=>{callback(player)},5) }',
  '}catch(e){}',
  '}',
  ...Array.from({ length: 40 }, (_, i) => `const   value${i}={a:${i},b:"x${i}",c:[1,2,3]}`),
  '',
].join('\r\n');

exports.run = async function run() {
  const outFile = process.env.COLLAB_TEST_OUT;
  let host;
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
    const { testApi } = await ext.activate();
    const { HostSession, GuestSession, openConnection, fsProvider } = testApi;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-fmt-'));
    fs.writeFileSync(path.join(dir, 'main.js'), UGLY);
    host = await HostSession.start(vscode.Uri.file(dir), 7600 + Math.floor(Math.random() * 300), 'Host');
    const url = `ws://localhost:${host.port}/?token=${host.token}`;
    const folder = vscode.Uri.from({ scheme: 'collab', authority: Buffer.from(url).toString('hex'), path: '/proj' });
    const { conn, welcome } = await openConnection(url, { name: 'Guest', v: 2 });
    const guest = new GuestSession(conn, welcome, folder);
    fsProvider.setSession(guest);

    const hUri = vscode.Uri.file(path.join(dir, 'main.js'));
    const gUri = vscode.Uri.joinPath(folder, 'main.js');
    const hEd = await vscode.window.showTextDocument(hUri, { viewColumn: vscode.ViewColumn.One });
    const gEd = await vscode.window.showTextDocument(gUri, { viewColumn: vscode.ViewColumn.Two });
    await waitFor(() => guest.isTracked('main.js'));
    const hDoc = hEd.document;
    const gDoc = gEd.document;
    log(hDoc.eol === vscode.EndOfLine.CRLF && gDoc.eol === vscode.EndOfLine.CRLF, 'both docs are CRLF');
    const same = () => hDoc.getText() === gDoc.getText();

    async function stable(label) {
      const ok = await waitFor(same, 8000);
      const len1 = hDoc.getText().length;
      await sleep(2500);
      const len2 = hDoc.getText().length;
      log(ok && same(), `${label}: copies identical`, ok ? '' : `host ${hDoc.getText().length} vs guest ${gDoc.getText().length}`);
      log(len1 === len2, `${label}: no runaway changes`, `${len1} -> ${len2}`);
      return hDoc.getText();
    }

    async function formatAndUndo(who, ed) {
      const original = ed.document.getText();
      await vscode.window.showTextDocument(ed.document, ed.viewColumn);
      ed.selection = new vscode.Selection(2, 0, 50, 0);
      await vscode.commands.executeCommand('editor.action.formatSelection');
      const changed = await waitFor(() => ed.document.getText() !== original, 8000);
      log(changed, `${who}: formatter changed the code`);
      const formatted = await stable(`${who} format`);
      log(!formatted.includes('function  getScore'), `${who}: formatting kept`, '');
      await vscode.window.showTextDocument(ed.document, ed.viewColumn);
      await vscode.commands.executeCommand('undo');
      await stable(`${who} undo`);
      log(hDoc.getText() === original, `${who}: undo restored the original`, hDoc.getText() === original ? '' : `len ${hDoc.getText().length} vs ${original.length}`);
      await vscode.commands.executeCommand('redo');
      await stable(`${who} redo`);
      await vscode.commands.executeCommand('undo');
      await stable(`${who} undo again`);
    }

    await formatAndUndo('host', hEd);
    await formatAndUndo('guest', gEd);

    // A formatter-style edit (many replacements at once) from the guest, then undo.
    const before = gDoc.getText();
    const we = new vscode.WorkspaceEdit();
    for (let line = 15; line < 55; line += 2) {
      we.replace(gUri, new vscode.Range(line, 0, line, 7), 'let');
    }
    await vscode.workspace.applyEdit(we);
    await stable('guest multi-edit');
    await vscode.window.showTextDocument(gDoc, gEd.viewColumn);
    await vscode.commands.executeCommand('undo');
    await stable('guest multi-edit undo');
    log(hDoc.getText() === before, 'guest multi-edit undo restored');

    // Paste a big block into the guest, then undo.
    const big = Array.from({ length: 200 }, (_, i) => `// pasted line ${i}`).join('\r\n') + '\r\n';
    await vscode.window.showTextDocument(gDoc, gEd.viewColumn);
    const ge = vscode.window.activeTextEditor;
    await ge.edit((b) => b.insert(new vscode.Position(3, 0), big));
    await stable('guest paste');
    await vscode.commands.executeCommand('undo');
    await stable('guest paste undo');
    log(!hDoc.getText().includes('pasted line'), 'guest paste undo removed it');

    // Format-on-save on both sides, guest saves while host is typing.
    await vscode.workspace.getConfiguration('editor').update('formatOnSave', true, vscode.ConfigurationTarget.Global);
    await vscode.window.showTextDocument(gDoc, gEd.viewColumn);
    await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(0, 0), 'const   x=1\r\n'));
    await waitFor(same);
    const typing = (async () => {
      for (let i = 0; i < 20; i++) {
        const e = new vscode.WorkspaceEdit();
        e.insert(hUri, hDoc.lineAt(hDoc.lineCount - 1).range.end, `/*h${i}*/`);
        await vscode.workspace.applyEdit(e);
        await sleep(30);
      }
    })();
    await gDoc.save();
    await typing;
    const t0 = Date.now();
    await stable('format-on-save');
    let saves = 0;
    const sub = vscode.workspace.onDidSaveTextDocument(() => saves++);
    await sleep(3000);
    sub.dispose();
    log(saves === 0, 'no save ping-pong afterwards', `${saves} saves in 3s`);
    log(hDoc.getText().includes('const x = 1'), 'format-on-save applied', `${Date.now() - t0}ms`);
    await vscode.workspace.getConfiguration('editor').update('formatOnSave', undefined, vscode.ConfigurationTarget.Global);

    // Different line endings on each side (e.g. one has files.eol = \n or an .editorconfig).
    fs.writeFileSync(path.join(dir, 'eol.js'), '');
    const hE = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'eol.js')));
    const hEEd = await vscode.window.showTextDocument(hE, vscode.ViewColumn.One);
    await hEEd.edit((b) => b.setEndOfLine(vscode.EndOfLine.CRLF));
    const gEEd = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder, 'eol.js'), vscode.ViewColumn.Two);
    const gE = gEEd.document;
    await gEEd.edit((b) => b.setEndOfLine(vscode.EndOfLine.LF));
    await waitFor(() => guest.isTracked('eol.js'));
    log(hE.eol !== gE.eol, 'eol: host CRLF, guest LF');
    await gEEd.edit((b) => b.insert(new vscode.Position(0, 0), 'line a\nline b\n'));
    await sleep(300);
    await vscode.window.showTextDocument(hE, vscode.ViewColumn.One);
    await vscode.window.activeTextEditor.edit((b) => b.insert(new vscode.Position(1, 0), 'host 1\r\nhost 2\r\n'));
    const lfEq = () => hE.getText().replace(/\r\n/g, '\n') === gE.getText().replace(/\r\n/g, '\n');
    const eolOk = await waitFor(lfEq, 6000);
    const l1 = hE.getText().length;
    await sleep(2500);
    const l2 = hE.getText().length;
    log(eolOk, 'eol: same content on both sides', JSON.stringify({ h: hE.getText().slice(0, 80), g: gE.getText().slice(0, 80) }));
    log(l1 === l2 && l2 < 200, 'eol: no runaway duplication', `${l1} -> ${l2}`);
    guest.dispose();
  } catch (e) {
    log(false, 'unexpected error', e && e.stack);
  } finally {
    host?.dispose();
    fs.writeFileSync(outFile, results.join('\n') + '\n');
  }
};

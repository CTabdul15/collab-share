// Downloads the pinned cloudflared for real, checks it, runs it, and opens a session through it.
// (Separate from the main suite because it downloads ~75 MB and needs the Internet.)
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');

const results = [];
const log = (ok, name, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  let host;
  try {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'collab-share');
    const { testApi } = await ext.activate();
    const cf = testApi.cloudflared;
    const storage = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cf-')));

    // 1. This computer's build: download, verify, run.
    const t0 = Date.now();
    const exe = await cf.download(storage, cf.assetFor());
    log(!!exe && fs.existsSync(exe), 'downloaded cloudflared ' + cf.version, `${exe} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const hash = createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
    log(hash === cf.assetFor().sha256, 'file matches Cloudflare\'s published fingerprint');
    const ver = execFileSync(exe, ['--version']).toString();
    log(ver.includes(cf.version), 'downloaded program runs', ver.trim().slice(0, 60));

    // 2. A tampered file is refused (fingerprint mismatch).
    const fake = { ...cf.assetFor(), sha256: '0'.repeat(64) };
    const bad = await cf.download(vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cf-bad-'))), fake);
    log(bad === undefined, 'a file that does not match the fingerprint is not used');

    // 3. macOS package: the .tgz is unpacked correctly (checked on this machine by its Mach-O header).
    const mac = cf.assetFor('darwin', 'arm64');
    const macExe = vscode.Uri.file(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collab-cf-mac-')), 'cloudflared'));
    const macPath = await cf.download(storage, mac, macExe);
    const head = macPath ? fs.readFileSync(macPath).subarray(0, 4).toString('hex') : '';
    log(head === 'cffaedfe', 'macOS download unpacks to the real program', 'header ' + head);

    // 4. Host a session through a tunnel made with the downloaded program and connect to it.
    host = await testApi.HostSession.start(vscode.Uri.file(os.tmpdir()), 7900 + Math.floor(Math.random() * 90), 'Host');
    const tunnel = await testApi.Tunnel.start(exe, host.port);
    log(/trycloudflare\.com$/.test(tunnel.url), 'Internet link created with the downloaded tool', tunnel.url);
    const wss = tunnel.url.replace(/^https:/, 'wss:') + `/?token=${host.token}`;
    let joined = false;
    for (let i = 0; i < 10 && !joined; i++) {
      try {
        const c = await testApi.openConnection(wss, { name: 'Remote', v: 2, ext: ext.packageJSON.version });
        joined = !!c.welcome;
        c.conn.close();
      } catch {
        await sleep(3000);
      }
    }
    log(joined, 'a guest can join over the Internet link');
    tunnel.dispose();
  } catch (e) {
    log(false, 'unexpected error', e && e.stack);
  } finally {
    host?.dispose();
    fs.writeFileSync(process.env.COLLAB_TEST_OUT, results.join('\n') + '\n');
  }
};

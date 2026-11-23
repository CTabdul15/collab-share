// Renders the real Sandbox page (src/whiteboard.ts) into test/sandbox-page.html with the test-page VS Code stand-in.
// Usage: node test/make-sandbox-page.cjs .   then open http://localhost:5178/test/sandbox-page.html (node test/serve.mjs)
const path = require('path'), fs = require('fs'), Module = require('module');
const root = path.resolve(process.argv[2] || '.');
require(path.join(root, 'node_modules', 'esbuild')).buildSync({ entryPoints: [path.join(root, 'src/whiteboard.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(process.env.TEMP, 'wbpage.js'), logLevel: 'error' });
const orig = Module._load;
Module._load = function (r, ...a) { if (r === 'vscode') return { Uri: { joinPath: (u, ...p) => ({ p: p.join('/') }) }, EventEmitter: class {}, Disposable: class {}, workspace: {}, window: {} }; return orig.call(this, r, ...a); };
const { html } = require(path.join(process.env.TEMP, 'wbpage.js'));
let page = html({ cspSource: '', asWebviewUri: (u) => '../' + u.p }, {});
page = page.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/ nonce="[^"]*"/g, '');
const harness = fs.readFileSync(path.join(root, 'test/board-harness.html'), 'utf8');
const stub = harness.match(/<script>[\s\S]*?<\/script>/)[0];
page = page.replace('<body>', '<body>\n' + stub);
fs.writeFileSync(path.join(root, 'test/sandbox-page.html'), page);
console.log('wrote test/sandbox-page.html');

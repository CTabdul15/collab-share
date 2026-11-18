// Runs test/two.js in two separate VS Code instances (host + guest) and compares what each saw.
// Usage: npm run build && node test/run2.mjs   (COLLAB_TEST_LATENCY=120 for Internet-like delay)
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-two-'));
const shared = path.join(tmp, 'shared');
const project = path.join(tmp, 'project');
fs.mkdirSync(shared);
fs.mkdirSync(project);
const UGLY = [
  "import { world, system } from '@minecraft/server';",
  '',
  'function  getScore( player,objective ){',
  'const obj=world.scoreboard.getObjective(objective)',
  '        if(!obj){return 0}',
  'try{ return obj.getScore(player)??0 }catch(e){return 0}',
  '}',
  ...Array.from({ length: 50 }, (_, i) => `const   value${i}={a:${i},b:"x${i}",c:[1,2,3]}`),
  '',
].join('\r\n');
fs.writeFileSync(path.join(project, 'main.js'), UGLY);

function launch(role) {
  const dir = path.join(tmp, role);
  fs.mkdirSync(path.join(dir, 'user', 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'user', 'User', 'settings.json'),
    JSON.stringify({ 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'window.restoreWindows': 'none' }),
  );
  const args = [
    '--new-window',
    '--wait',
    `--user-data-dir=${path.join(dir, 'user')}`,
    `--extensions-dir=${path.join(dir, 'ext')}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'test', 'two.js')}`,
  ];
  if (role === 'host') args.push(project);
  return new Promise((resolve) => {
    const p = spawn('code', args, {
      env: { ...process.env, COLLAB_ROLE: role, COLLAB_SHARED_DIR: shared, COLLAB_TEST_OUT: path.join(dir, 'out.txt') },
      shell: process.platform === 'win32',
      stdio: 'ignore',
    });
    p.on('exit', () => resolve(fs.existsSync(path.join(dir, 'out.txt')) ? fs.readFileSync(path.join(dir, 'out.txt'), 'utf8') : `[${role}] no output`));
  });
}

const [h, g] = await Promise.all([launch('host'), launch('guest')]);
console.log(h.trim());
console.log(g.trim());

const read = (n) => (fs.existsSync(path.join(shared, n)) ? fs.readFileSync(path.join(shared, n), 'utf8') : null);
let ok = true;
const steps = fs.readdirSync(shared).filter((f) => /^[GH]-\d/.test(f)).sort();
for (const s of steps) {
  const t = read(s);
  const lines = t.split('\n').length;
  const pasted = (t.match(/pasted \d+/g) || []).length;
  console.log(`${s.padEnd(14)} ${String(t.length).padStart(5)} chars ${String(lines).padStart(4)} lines  pasted=${pasted}`);
}
const pairs = [
  ['G-final-on-guest', 'G-final-on-host'],
  ['H-7-type', 'H-final-on-guest'],
];
for (const [a, b] of pairs) {
  const same = read(a) !== null && read(a) === read(b);
  if (!same) ok = false;
  console.log(`${same ? 'PASS' : 'FAIL'} ${a} == ${b}`);
}
// Undo only reverts your own change: guest undo -> original file; host undo -> state the guest
// left (the guest's typed line must survive).
const orig = UGLY.replace(/\r\n/g, '\n');
const expect = { 'G-2-undo': orig, 'G-4-undo': orig, 'G-6-undo': orig, 'H-2-undo': read('G-7-type'), 'H-4-undo': read('G-7-type'), 'H-6-undo': read('G-7-type') };
for (const [s, want] of Object.entries(expect)) {
  const good = read(s) === want;
  if (!good) ok = false;
  console.log(`${good ? 'PASS' : 'FAIL'} ${s} restored the right text`);
}
console.log('artifacts:', shared);
process.exit(ok ? 0 : 1);

// Launches an isolated VS Code instance (installed `code` CLI) with this extension loaded and
// runs test/integration.js inside it. Usage: npm run build && node test/run.mjs
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-run-'));
const out = path.join(tmp, 'results.txt');
console.log('results file:', out);

const res = spawnSync(
  'code',
  [
    '--new-window',
    '--wait',
    `--user-data-dir=${path.join(tmp, 'user')}`,
    `--extensions-dir=${path.join(tmp, 'ext')}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'test', process.argv[2] || 'integration.js')}`,
  ],
  { env: { ...process.env, COLLAB_TEST_OUT: out }, shell: process.platform === 'win32', stdio: 'inherit', timeout: 120000 },
);

if (!fs.existsSync(out)) {
  console.error('No results written (VS Code exit status', res.status, ')');
  process.exit(1);
}
const text = fs.readFileSync(out, 'utf8');
console.log(text);
process.exit(text.includes('FAIL') ? 1 : 0);

// Tiny static file server for test/board-harness.html (whiteboard interaction testing).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 5178);

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Dev helper: save a rendered PNG (icon / screenshot) into resources/ or images/.
    if (req.method === 'POST' && url.pathname === '/save') {
      const name = url.searchParams.get('name') || '';
      if (!/^(resources|images)\/[a-z0-9-]+\.png$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const b64 = Buffer.concat(chunks).toString('utf8').replace(/^data:image\/png;base64,/, '');
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), Buffer.from(b64, 'base64'));
        res.writeHead(200); res.end('saved ' + name);
      });
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/test/board-harness.html' });
      res.end();
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`serving on http://localhost:${port}`));

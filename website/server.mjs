import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const decoded = decodeURIComponent(pathname);
  const relativePath = normalize(decoded).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  const requestedFile = join(root, relativePath || 'index.html');

  try {
    const details = await stat(requestedFile);
    const file = details.isDirectory() ? join(requestedFile, 'index.html') : requestedFile;
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`Abralo site listening on ${port}`);
});

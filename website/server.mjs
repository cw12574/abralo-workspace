import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set([
  'index.html',
  'start.html',
  'site.css',
  'site.js',
  'mark.svg',
  'social-card.svg',
  'social-card.png',
]);
const demoFiles = new Set([
  'brief.webp',
  'findings.webp',
  'decision.webp',
  'review.mp4',
  'captions.vtt',
  'responses.json',
  'transcript.txt',
  'result.webp',
  'build.mp4',
  'full-build.mp4',
  'build.vtt',
  'build-transcript.txt',
  'validation.txt',
]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const server = createServer(async (request, response) => {
  const fail = (status, message, extra = {}) => {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  if (!['GET', 'HEAD'].includes(request.method))
    return fail(405, 'Method not allowed', { allow: 'GET, HEAD' });
  try {
    const path = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    if (path === '/health') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : 'ok');
      return;
    }
    const relative = path === '/' ? 'index.html' : path.slice(1);
    const font = /^assets\/fonts\/[a-zA-Z0-9_-]+\.woff2$/.test(relative);
    const demo =
      relative.startsWith('assets/demo/') && demoFiles.has(relative.slice('assets/demo/'.length));
    if (!publicFiles.has(relative) && !font && !demo) return fail(404, 'Not found');
    const file = join(root, relative);
    const info = await stat(file);
    if (!info.isFile()) return fail(404, 'Not found');
    const headers = {
      'content-type': types[extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'cache-control': 'public, max-age=0, must-revalidate',
      'accept-ranges': 'bytes',
    };
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2]))
        return fail(416, 'Range not satisfiable', { 'content-range': 'bytes */' + info.size });
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= info.size
      )
        return fail(416, 'Range not satisfiable', { 'content-range': 'bytes */' + info.size });
      status = 206;
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + info.size;
    }
    headers['content-length'] = String(end - start + 1);
    response.writeHead(status, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    if (!response.headersSent) fail(404, 'Not found');
    else response.destroy();
  }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () =>
  console.log('Abralo website ready'),
);

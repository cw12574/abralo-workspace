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
  'goals-site.css',
  'legacy-site.css',
  'site.js',
  'mark.svg',
  'favicon-v2.svg',
  'social-card.svg',
  'social-card.png',
  'beacon.html',
  'beacon.css',
  'beacon.js',
  'replay.html',
  'replay.css',
  'replay.js',
  'demo.html',
  'demo.css',
  'demo.js',
  'city.js',
  'crossing.html',
  'crossing.css',
  'crossing.js',
]);
const cityFiles = new Set([
  'city-engine.mjs',
  'city-view.mjs',
  'experiment.mjs',
  'journal.json',
  'brief.txt',
  'review.txt',
  'validation.txt',
  'poster.webp',
  'room.webp',
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
const showcaseFiles = new Set([
  'workspace.png',
  'workspace.webp',
  'usage.webp',
  'connections.webp',
  'tour.gif',
  'experiment.webp',
  'tour.mp4',
  'provenance.txt',
]);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json') return JSON.parse(raw);
  if (contentType === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  throw Object.assign(new Error('Unsupported content type'), { statusCode: 415 });
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const fail = (status, message, extra = {}) => {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  try {
    const path = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
    if (path === '/start.html' && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(302, { location: '/#try', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (path === '/api/early-access') {
      if (request.method !== 'POST') return fail(405, 'Method not allowed', { allow: 'POST' });
      if (request.headers.origin) {
        let originHost;
        try {
          originHost = new URL(request.headers.origin).host;
        } catch {
          return fail(403, 'Cross-origin requests are not allowed');
        }
        if (originHost !== request.headers.host) return fail(403, 'Cross-origin requests are not allowed');
      }
      if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
        return json(response, 503, { error: 'Email delivery is not configured yet' });

      try {
        const body = await readRequestBody(request);
        const email = String(body?.email || '').trim();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return json(response, 400, { error: 'Enter a valid email address' });
        const delivery = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: ['chris@abralo.com'],
            reply_to: email,
            subject: 'New Abralo early-access request',
            text: `A visitor requested early access to Abralo.\n\nEmail: ${email}`,
          }),
        });
        if (!delivery.ok) throw new Error(`Resend returned HTTP ${delivery.status}`);
        return json(response, 200, { ok: true });
      } catch (error) {
        if (error.statusCode) return json(response, error.statusCode, { error: error.message });
        if (error instanceof SyntaxError) return json(response, 400, { error: 'Invalid request body' });
        console.error('Early-access email delivery failed:', error.code || error.name || 'unknown error');
        return json(response, 502, { error: 'We could not send your email just now. Please try again.' });
      }
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return fail(405, 'Method not allowed', { allow: 'GET, HEAD' });
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
    const city =
      relative.startsWith('assets/city/') && cityFiles.has(relative.slice('assets/city/'.length));
    const showcase =
      relative.startsWith('assets/showcase/') &&
      showcaseFiles.has(relative.slice('assets/showcase/'.length));
    if (!publicFiles.has(relative) && !font && !demo && !city && !showcase)
      return fail(404, 'Not found');
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

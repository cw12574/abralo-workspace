import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('evidence', { recursive: true });
await build({
  entryPoints: ['scripts/conversation-craft-browser.tsx'],
  bundle: true,
  preserveSymlinks: true,
  outfile: 'evidence/craft-preview.js',
  platform: 'browser',
  format: 'esm',
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
});
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/result' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const label = url.searchParams.get('layout')?.replace(/[^a-z0-9-]/gi, '');
      writeFileSync(label ? `evidence/layout-${label}.json` : 'evidence/browser-checks.json', body);
      res.end('ok');
    });
    return;
  }
  if (url.pathname === '/craft-preview.js' || url.pathname === '/craft-preview.css') {
    res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(readFileSync('evidence' + url.pathname));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/frame') {
    res.end(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/craft-preview.css"></head><body><div id="root"></div><script type="module" src="/craft-preview.js"></script></body></html>',
    );
    return;
  }
  const width = Math.min(1600, Math.max(320, Number(url.searchParams.get('width') || 1280)));
  const height = Math.min(1000, Math.max(400, Number(url.searchParams.get('height') || 640)));
  const params = new URLSearchParams(url.searchParams);
  params.delete('width');
  params.delete('height');
  res.end(
    `<!doctype html><html><head><title>Abralo conversation design verification</title></head><body style="margin:0;background:#d8d8d8"><iframe title="Abralo preview" src="/frame?${params}" style="display:block;border:0;width:${width}px;height:${height}px"></iframe></body></html>`,
  );
});
server.listen(0, '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${(server.address() as any).port}`),
);

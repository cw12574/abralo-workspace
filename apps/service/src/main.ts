import { dataDirectory, openBrowser } from '../../../packages/host/src/index.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';
const store = new Store(dataDirectory());
let exiting = false;
const shutdown = async (): Promise<void> => {
  if (exiting) return;
  exiting = true;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  app.server.closeAllConnections();
  try { await app.close(); process.exit(0); }
  catch (error) { console.error('Workspace shutdown failed:', error); process.exit(1); }
};
const { app, supervisor } = await createApp(store, {
  maintenance: process.env.WORKSPACE_INSTALL_ROOT ? {
    root: process.cwd(), installRoot: process.env.WORKSPACE_INSTALL_ROOT, shutdown,
  } : undefined,
});
const host = process.env.WORKSPACE_HOST || '127.0.0.1';
if (
  host !== '127.0.0.1' &&
  host !== 'localhost' &&
  !process.env.WORKSPACE_PUBLIC_URL?.startsWith('https://')
)
  throw new Error(
    'Remote binding requires an authenticated HTTPS reverse proxy and WORKSPACE_PUBLIC_URL.',
  );
const port = Number(process.env.WORKSPACE_PORT || 4317);
const address = await app.listen({ host, port });
supervisor.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
writeFileSync(
  join(store.dir, 'runtime.json'),
  JSON.stringify({ pid: process.pid, port: (app.server.address() as any).port, version: '0.1.0' }),
  { mode: 0o600 },
);
console.log(`Workspace is listening at ${address}`);
void supervisor.dispatch();
if (process.argv.includes('--open')) openBrowser(`${address}/#setup=${store.bootstrapToken}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void shutdown();
  });

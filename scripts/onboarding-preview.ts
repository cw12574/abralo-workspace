import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'workspace-onboarding-preview-')));
const { app, supervisor } = await createApp(store);
supervisor.infos = async () => [
  {
    harness: 'codex',
    installed: true,
    authenticated: true,
    version: 'fixture',
    detail: 'Connected · preview account',
  },
];
supervisor.adapters.codex.run = async (input) => {
  input.emit({ type: 'text', text: 'Welcome. Let’s shape your workforce.' });
  input.emit({ type: 'complete' });
};
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
writeFileSync(
  'evidence/onboarding-preview.json',
  JSON.stringify({ url: origin, inviteUrl: origin + '/#invite=preview-invitation' }),
);
console.log(origin);
process.on('SIGINT', () => void app.close());

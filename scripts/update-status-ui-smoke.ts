import { chromium } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';
import { checkUpdatePreparationStatus } from './update-status-ui-checks.js';

delete process.env.WORKSPACE_MAINTENANCE_JOB;
const store = new Store(mkdtempSync(join(tmpdir(), 'update-settings-')));
const owner = store.createOwner('Fixture owner');
store.set('workspace.onboarded', true);
const employee = store.createEmployee(owner.id, {
  name: 'Fixture agent',
  harness: 'codex',
  model: '',
  role: '',
  cwd: '',
  instructions: '',
});
const { app } = await createApp(store, {
  staticRoot: resolve(process.env.WORKSPACE_TEST_WEB || 'dist/web'),
});
await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/providers*', (route) => route.fulfill({ json: [] }));
mkdirSync('evidence', { recursive: true });
try {
  await page.goto(
    `http://127.0.0.1:${(app.server.address() as any).port}/?conversation=${employee.dmId}#setup=${store.bootstrapToken}`,
  );
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await checkUpdatePreparationStatus(page);
  if (errors.length) throw new Error(errors.join('\n'));
  const result = {
    status: 'passed',
    checks: [
      'waiting, verifying, prepared and error states',
      '1280x640 and 390x640 in both themes',
      'reachable save/close controls, no overflow',
      'no page errors',
    ],
    liveWorkspaceTouched: false,
  };
  writeFileSync('evidence/update-status-ui.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await app.close();
}

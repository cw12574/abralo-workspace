// Browser fault injection against the real service and built UI. No provider credentials or model calls.
import { chromium, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/service/src/store.js';
import { createApp } from '../apps/service/src/app.js';

const store = new Store(mkdtempSync(join(tmpdir(), 'abralo-onboarding-ui-')));
store.createOwner('Tester');
const { app } = await createApp(store, {
  staticRoot: resolve(process.env.ABRALO_TEST_WEB_ROOT || 'dist/web'),
});
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CI ? {} : { channel: 'chrome' }),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
let offline = true,
  signedIn = false,
  loginCalls = 0,
  lastType = '';
const checks: string[] = [];
await page.route('**/api/providers**', async (route) => {
  const url = new URL(route.request().url());
  if (offline) {
    await route.abort('connectionrefused');
    return;
  }
  if (url.pathname.endsWith('/cancel')) {
    await route.fulfill({ json: { ok: true } });
    return;
  }
  if (url.pathname.endsWith('/login')) {
    loginCalls++;
    lastType = url.pathname.split('/').at(-2) || '';
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      json: {
        loginId: 'fixture-' + loginCalls,
        userCode: 'FIXTURE-' + loginCalls,
        verificationUrl: 'https://example.com/device',
      },
    });
    return;
  }
  await route.fulfill({
    json: ['codex', 'claude', 'opencode'].map((harness) => ({
      harness,
      installed: true,
      authenticated: harness === 'opencode' || (harness === 'codex' && signedIn),
      version: 'fixture',
      detail: signedIn && harness === 'codex' ? 'Connected' : 'Sign in to continue',
      models: harness === 'opencode' ? [{ id: 'fixture/model', name: 'Fixture model' }] : [],
    })),
  });
});
try {
  await page.goto(origin + '/#setup=' + store.bootstrapToken);
  await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Morgan');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText(/Cannot reach Abralo/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Cannot reach Abralo/)).toBeVisible();
  checks.push('service failure is actionable; unsuccessful sign-in unlocks controls');
  offline = false;
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByText(/Cannot reach Abralo/)).toHaveCount(0);
  checks.push('a successful check clears the earlier service error');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open Codex sign-in', exact: true })).toBeVisible();
  await expect(page.getByText('FIXTURE-1', { exact: true })).toBeVisible();
  await expect(page.getByText(/Waiting for you to finish in the browser/)).toBeVisible();
  expect(loginCalls).toBe(1);
  expect(lastType).toBe('codex');
  checks.push('device-code sign-in shows the code and link and waits for completion');
  await page.getByRole('button', { name: 'Start again', exact: true }).click();
  await expect(page.getByText('FIXTURE-2', { exact: true })).toBeVisible();
  await expect(page.getByText('FIXTURE-1', { exact: true })).toHaveCount(0);
  expect(loginCalls).toBe(2);
  checks.push('starting again replaces the stale code instead of stacking sign-ins');
  signedIn = true;
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
    timeout: 10000,
  });
  await expect(page.getByRole('link', { name: 'Open Codex sign-in', exact: true })).toHaveCount(0);
  await expect(page.getByText('FIXTURE-2', { exact: true })).toHaveCount(0);
  checks.push('automatic sign-in completion clears stale login controls');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Connect Chief of Staff.' })).toBeVisible();
  checks.push('page reload retains setup identity and rechecks connection');
  await page.getByRole('button', { name: /OpenCode.*Choose provider/ }).click();
  await expect(page.getByText('OpenCode account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  checks.push('a connected OpenCode provider can lead with its default model');
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ status: 'passed', checks, liveProviderCalls: false }, null, 2));
} finally {
  await browser.close();
  await app.close();
}

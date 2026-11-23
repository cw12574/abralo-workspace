import { expect, type Page } from '@playwright/test';
import type { Supervisor } from '../apps/service/src/supervisor.js';
import type { Store } from '../apps/service/src/store.js';
export async function checkModelUpdates(page: Page, store: Store, supervisor: Supervisor, employee: any) {
  const notice = page.locator('.model-notice');
  await expect(notice).toHaveCount(0);
  const prior = supervisor.catalogue.snapshot().find(p => p.harness === 'codex')!;
  supervisor.catalogue.accept('codex', { ...prior, models: [...prior.models!, { id: 'fixture-new', name: 'New fixture model', isDefault: true }] });
  await expect(notice).toBeVisible();
  await page.screenshot({ path: 'evidence/model-notice-desktop.png' });
  const second = await page.context().newPage();
  await second.goto(page.url());
  await expect(second.locator('.model-notice')).toBeVisible();
  await notice.getByRole('button', { name: 'New models available', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const section = dialog.getByRole('region', { name: 'Model updates' });
  await expect(section).toContainText('New fixture model');
  async function capture(state: string) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 640 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
        if (state === 'error') await section.getByRole('alert').scrollIntoViewIfNeeded();
        else await section.getByRole('heading', { name: 'Model updates', exact: true }).scrollIntoViewIfNeeded();
        expect(await dialog.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
        expect(await section.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(false);
        for (const checkbox of await section.getByRole('checkbox').all()) {
          const box = await checkbox.boundingBox();
          expect(box?.width).toBeLessThanOrEqual(20);
          expect(box?.height).toBeLessThanOrEqual(20);
        }
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
        await expect(dialog.locator('footer')).toBeInViewport();
        await page.screenshot({ path: `evidence/model-settings-${state}-${width}-${theme}.png` });
      }
    }
  }
  await capture('new');
  await section.getByRole('button', { name: 'Mark as seen', exact: true }).click();
  await expect(second.locator('.model-notice')).toHaveCount(0);
  await second.close();
  await section.getByLabel('Tell me when new models are available').uncheck();
  const owner = store.one("SELECT id FROM humans WHERE role='owner' LIMIT 1");
  await expect.poll(() => store.setting('models.notifications.' + owner.id)).toBe(false);
  await section.getByLabel('Keep provider software up to date').uncheck();
  await expect.poll(() => store.setting('models.autoUpdate')).toBe(false);
  await section.getByLabel('Keep provider software up to date').check();
  await page.route('**/api/models/check', route => route.fulfill({ status: 503, json: { error: 'Check unavailable. Please try again.' } }));
  await section.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(section.getByRole('alert')).toContainText('Check unavailable');
  await capture('error');
  await page.unroute('**/api/models/check');
  await section.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(section.getByRole('status')).toContainText('Check finished');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await section.getByLabel('Tell me when new models are available').check();
  await capture('current');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await expect(notice).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByRole('button', { name: employee.name + ' settings', exact: true }).click();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue(employee.model);
  await dialog.getByLabel('Model', { exact: true }).selectOption('@recommended');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(store.employee(employee.id)?.model).toBe('@recommended');
  await page.getByRole('button', { name: employee.name + ' settings', exact: true }).click();
  await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('@recommended');
  await dialog.getByLabel('Model', { exact: true }).selectOption('@custom');
  await dialog.getByLabel('Custom model ID', { exact: true }).fill('custom-provider-model');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(store.employee(employee.id)?.model).toBe('custom-provider-model');
}

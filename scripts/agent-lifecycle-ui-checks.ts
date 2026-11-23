import { expect, type Page } from '@playwright/test';
import type { Store } from '../apps/service/src/store.js';

export async function checkAgentLifecycle(page: Page, store: Store) {
  const dialog = page.getByRole('dialog');
  async function capture(state: string) {
    for (const viewport of [
      { width: 1280, height: 640 },
      { width: 390, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      for (const theme of ['dark', 'light']) {
        await page.mouse.move(5, 5);
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        await expect(dialog.locator('footer .secondary')).toHaveCSS(
          'background-color',
          theme === 'dark' ? 'rgb(37, 40, 48)' : 'rgb(255, 255, 255)',
        );
        await expect(dialog).toBeVisible();
        if (state === 'populated' || state.startsWith('delegation-edit')) {
          const field = dialog
            .locator('.ui-field')
            .filter({ has: page.locator('input[name="canDelegate"]') });
          await field.scrollIntoViewIfNeeded();
          const label = (await field.locator('label').boundingBox())!;
          const hint = (await field.locator('.caption').boundingBox())!;
          expect(hint.y - label.y - label.height).toBeGreaterThanOrEqual(7);
          const footerTop = (await dialog.locator('footer').boundingBox())!.y;
          expect(hint.y + hint.height).toBeLessThanOrEqual(footerTop);
        }
        if (await dialog.getByRole('alert').count())
          await expect(dialog.getByRole('alert')).toBeInViewport();
        const footer = dialog.locator('footer');
        const bounds = (await footer.boundingBox())!;
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
        await page.screenshot({ path: `evidence/agent-${state}-${viewport.width}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 640 });
  }

  await page.getByRole('button', { name: 'Add employee', exact: true }).click();
  const delegation = dialog.getByRole('checkbox', {
    name: 'Delegate work and create employees',
    exact: true,
  });
  await expect(delegation).not.toBeChecked();
  await capture('initial');
  await dialog.getByLabel('Name', { exact: true }).fill('Mira');
  await dialog.getByLabel('Role', { exact: true }).fill('Product design');
  await dialog.getByLabel('Model', { exact: true }).selectOption('@recommended');
  await delegation.check();
  await delegation.scrollIntoViewIfNeeded();
  await capture('populated');
  let posts = 0;
  await page.route('**/api/employees', async (route) => {
    posts++;
    await route.fulfill({
      status: 503,
      json: { error: 'Could not create your agent. Please try again.' },
    });
  });
  await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Please try again');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Mira');
  await expect(delegation).toBeChecked();
  await capture('error');
  await page.unroute('**/api/employees');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/employees', async (route) => {
    posts++;
    await gate;
    await route.continue();
  });
  await dialog.locator('form').evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(dialog.getByRole('status')).toContainText('Creating Mira');
  await expect(dialog.getByRole('button', { name: 'Creating agent…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await capture('creating');
  await expect(dialog.getByRole('status')).toContainText('Taking a little longer', {
    timeout: 10000,
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page.locator('.agent-creation-mark').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(posts).toBe(2);
  // Creation succeeds, but opening the conversation fails. Retrying must only refresh.
  await page.route('**/api/workspace', (route) =>
    route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }),
  );
  release();
  await expect(dialog.getByRole('alert')).toContainText('Your agent was created');
  expect(
    store.all('SELECT data FROM employees').filter((row) => JSON.parse(row.data).name === 'Mira'),
  ).toHaveLength(1);
  await capture('opening-error');
  await page.unroute('**/api/workspace');
  await dialog.getByRole('button', { name: 'Open conversation', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(/Mira/);
  expect(posts).toBe(2);
  await page.unroute('**/api/employees');

  const mira = store
    .all('SELECT data FROM employees')
    .map((row) => JSON.parse(row.data))
    .find((e) => e.name === 'Mira');
  expect(mira.canDelegate).toBe(true);
  expect(mira.model).toBe('@recommended');
  await page.getByRole('button', { name: 'Mira settings', exact: true }).click();
  await expect(delegation).toBeChecked();
  await delegation.uncheck();
  await delegation.scrollIntoViewIfNeeded();
  await capture('delegation-edit');
  await page.route('**/api/employees/' + mira.id, async (route) => {
    if (route.request().method() === 'PATCH')
      await route.fulfill({ status: 503, json: { error: 'Could not save. Please try again.' } });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save');
  await expect(delegation).not.toBeChecked();
  await capture('delegation-edit-error');
  await page.unroute('**/api/employees/' + mira.id);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(store.employee(mira.id)?.canDelegate).toBe(false);
  await page.getByRole('button', { name: 'Mira settings', exact: true }).click();
  await expect(delegation).not.toBeChecked();
  await dialog
    .getByRole('button', { name: 'Deactivate agent', exact: true })
    .scrollIntoViewIfNeeded();
  await capture('management');
  await dialog.getByRole('button', { name: 'Deactivate agent', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Deactivate agent', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const endpoint = new URL('/api/employees/' + mira.id, page.url()).href;
  expect(
    (
      await page.request.post(endpoint + '/deactivate', { headers: { 'x-workspace-request': '1' } })
    ).ok(),
  ).toBe(true);
  await expect(page.locator('.inactive-nav-title')).toHaveText('Inactive');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 640 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expect(page.locator('.conversation-inactive-notice')).toContainText(
        'This agent is deactivated',
      );
      await page.screenshot({ path: `evidence/inactive-agent-${width}-${theme}.png` });
    }
  }
  expect(
    (
      await page.request.post(endpoint + '/reactivate', { headers: { 'x-workspace-request': '1' } })
    ).ok(),
  ).toBe(true);
  await expect(page.locator('.inactive-nav-title')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.getByRole('button', { name: 'Mira settings', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete agent…', exact: true }).click();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  const confirm = dialog.getByRole('button', { name: 'Delete agent', exact: true });
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(dialog).toContainText('This cannot be undone.');
  await capture('delete');
  await page.route('**/api/employees/*', (route) =>
    route.fulfill({ status: 503, json: { error: 'Please try again.' } }),
  );
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText('Please try again.');
  await capture('delete-error');
  await page.unroute('**/api/employees/*');
  let releaseDelete!: () => void;
  let deletes = 0;
  const deleteGate = new Promise<void>((resolve) => (releaseDelete = resolve));
  await page.route('**/api/employees/*', async (route) => {
    deletes++;
    await deleteGate;
    await route.continue();
  });
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByRole('button', { name: 'Working…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
  await capture('deleting');
  expect(deletes).toBe(1);
  releaseDelete();
  await expect(dialog).toHaveCount(0);
  expect(
    store.all('SELECT data FROM employees').filter((row) => JSON.parse(row.data).name === 'Mira'),
  ).toHaveLength(0);
  await page.unroute('**/api/employees/*');
}

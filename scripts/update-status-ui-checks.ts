import { expect, type Page } from '@playwright/test';

export async function checkUpdatePreparationStatus(page: Page) {
  let current: any = null;
  await page.route('**/api/maintenance', (route) =>
    route.fulfill({ json: { supported: true, job: current } }),
  );
  const states = [
    {
      phase: 'waiting-memory',
      message: 'Update queued: waiting for memory. Agents can keep working.',
    },
    { phase: 'verifying', message: 'Verifying the prepared release in a background helper.' },
    {
      phase: 'prepared',
      message: 'Update prepared and verified. Ready for installation approval.',
    },
    {
      phase: 'failed',
      error: 'Preparation could not finish. Your current app and active work are still available.',
    },
  ];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 640 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const state of states) {
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        current = { id: 'fixture-update', ...state };
        const navigation = page.getByRole('button', { name: 'Open navigation', exact: true });
        if ((await navigation.isVisible()) && !(await page.locator('.sidebar.open').count()))
          await navigation.click();
        await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
        const section = page.getByRole('region', { name: 'Update status' });
        await expect(section).toContainText(state.message || 'Update needs attention.');
        if (state.error) await expect(section).toContainText(state.error);
        await section.scrollIntoViewIfNeeded();
        await expect(section).toBeInViewport();
        await expect(
          page.getByRole('button', { name: 'Save changes', exact: true }),
        ).toBeInViewport();
        expect(
          await page.getByRole('dialog').evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(false);
        await page.screenshot({
          path: `evidence/update-status-${state.phase}-${width}-${theme}.png`,
        });
      }
    }
  }
  await page.unroute('**/api/maintenance');
  await page.setViewportSize({ width: 1280, height: 640 });
}

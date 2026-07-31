import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const response = await request.post('/__wake-e2e/reset');
  expect(response.ok()).toBeTruthy();
});

test('operates Wake through the real HTTP Surface and packaged application', async ({
  page,
}, testInfo) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
  await expect(page.getByText('Dispatch active')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Demo Wake' })).toHaveAttribute(
    'href',
    /^\/work\/wk_/,
  );

  await page.getByRole('link', { name: 'Demo Wake' }).click();
  if (testInfo.project.name === 'desktop')
    await expect(page.getByRole('dialog', { name: 'Work item detail' })).toBeVisible();
  else await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Demo Wake' })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/work\/wk_/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Demo Wake' })).toBeVisible();
  await page.getByRole('link', { name: 'Board' }).click();

  const advance = page.getByRole('button', { name: 'Advance' });
  await advance.click();
  await expect(page.getByText(/Command pending/)).toBeVisible();
  await expect(advance).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Demo Wake advanced' })).toBeVisible();
  await advance.click();
  await expect(page.getByText('Conflict: Conflict')).toBeVisible();

  await page.getByRole('link', { name: 'Events' }).click();
  await expect(page.getByText('event-1')).toBeVisible();
  await page.getByRole('button', { name: 'Pause live view' }).click();
  await expect(page.getByRole('button', { name: /new event/ })).toBeVisible({ timeout: 7_000 });
  await page.getByRole('button', { name: 'Resume live view' }).click();
  await expect(page.getByText('event-3')).toBeVisible();

  await page.getByRole('link', { name: 'Health' }).click();
  await expect(page.getByRole('table', { name: 'Runner availability' })).toContainText(
    'refreshing',
  );
  await page.getByRole('button', { name: 'Refresh health' }).click();
  await expect(page.getByRole('table', { name: 'Runner availability' })).toContainText('available');

  await page.getByRole('link', { name: 'Board' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Work' })).toBeFocused();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
});

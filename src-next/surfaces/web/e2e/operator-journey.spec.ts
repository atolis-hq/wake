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
  const firstEvent = page.getByText('event-1');
  if (testInfo.project.name === 'desktop') await expect(firstEvent).toBeVisible();
  else await expect(firstEvent).toBeAttached();
  await page.getByRole('button', { name: 'Pause live view' }).click();
  await expect(page.getByRole('button', { name: /new event/ })).toBeVisible({ timeout: 7_000 });
  await page.getByRole('button', { name: 'Resume live view' }).click();
  const thirdEvent = page.getByText('event-3');
  if (testInfo.project.name === 'desktop') await expect(thirdEvent).toBeVisible();
  else await expect(thirdEvent).toBeAttached();

  await page.getByRole('link', { name: 'Health' }).click();
  await expect(page.getByRole('table', { name: 'Runner availability' })).toContainText(
    'refreshing',
  );
  await page.getByRole('button', { name: 'Refresh health' }).click();
  await expect(page.getByRole('table', { name: 'Runner availability' })).toContainText('available');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('table', { name: 'Runner availability' })).toContainText('paused');
  await page.getByRole('button', { name: 'Unpause' }).click();
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

test('keeps the restyled board operable and free of serious accessibility faults', async ({
  page,
}) => {
  await page.goto('/board');
  await expect(page.getByRole('heading', { name: /^Open \(\d+\)$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Cancelled \(\d+\)$/ })).toBeVisible();

  const collapse = page.getByRole('button', { name: 'Collapse Open' });
  await collapse.click();
  await expect(page.getByRole('button', { name: 'Expand Open' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand Open' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
});

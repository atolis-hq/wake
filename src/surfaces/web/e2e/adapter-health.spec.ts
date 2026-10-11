import { expect, test, type APIRequestContext } from '@playwright/test';

let cookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'];

test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/v1/auth/login', {
    data: { accessKey: 'e2e-access-key' },
  });
  expect(response.ok()).toBe(true);
  cookies = (await request.storageState()).cookies;
});

test.beforeEach(async ({ context }) => {
  await context.addCookies(cookies);
});

for (const width of [360, 390, 1280]) {
  for (const count of [1, 3]) {
    test(`adapter health uses readable fields at ${width}px with ${count} checks`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const adapters = Array.from({ length: count }, (_, index) => ({
        adapter: `github-pull-requests-with-a-long-adapter-name-${index}`,
        provider: 'github',
        scope: `organisation-with-a-long-name/repository-with-a-long-name-${index}`,
        channel: index === 0 ? 'poll' : 'deliver',
        status: index === 0 ? 'ok' : 'degraded',
        successCount: 12 + index,
        failureCount: index,
        detail: index === 0 ? undefined : `Delivery failed: ${'long-unbroken-message'.repeat(8)}`,
      }));
      await page.route('**/api/v1/system/health', async (route) => {
        await route.fulfill({
          json: {
            data: { status: 'ok', version: 'test', checkedAt: '2026-10-11T00:00:00Z', adapters },
            meta: { asOf: '2026-10-11T00:00:00Z' },
          },
        });
      });
      await page.goto('/health');
      await page.getByRole('tab', { name: 'Adapter health' }).click();
      const table = page.getByRole('table', { name: 'Adapter health' });
      const rows = table.locator('tbody tr');
      await expect(rows).toHaveCount(count);
      for (const [index, adapter] of adapters.entries()) {
        const row = rows.nth(index);
        const values = [
          adapter.adapter,
          adapter.scope,
          adapter.channel,
          adapter.status,
          String(adapter.successCount),
          String(adapter.failureCount),
          adapter.detail ?? '—',
        ];
        await expect(row.locator('td')).toHaveText(values);
        for (const cell of await row.locator('td').all()) {
          const bounds = await cell.boundingBox();
          const rowBounds = await row.boundingBox();
          expect(bounds).not.toBeNull();
          expect(rowBounds).not.toBeNull();
          if (width < 768) {
            expect(bounds!.width).toBeGreaterThan(rowBounds!.width * 0.9);
            expect(await cell.evaluate((element) => getComputedStyle(element).display)).toBe(
              'grid',
            );
            expect(
              await cell.evaluate((element) => getComputedStyle(element, '::before').content),
            ).toBe(`"${await cell.getAttribute('data-label')}"`);
          } else {
            expect(await cell.evaluate((element) => getComputedStyle(element).display)).toBe(
              'table-cell',
            );
          }
          expect(
            await cell.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          ).toBe(true);
        }
      }
      expect(
        await table.evaluate((element) => {
          const container = element.parentElement!;
          return container.scrollWidth <= container.clientWidth + 1;
        }),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}

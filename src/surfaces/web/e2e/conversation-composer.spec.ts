import { expect, test } from '@playwright/test';
import { ApiCommandStatus, toWorkItemKey } from '../../api/contracts/index.js';

test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/api/v1/auth/login', {
    data: { accessKey: 'e2e-access-key' },
  });
  expect(login.ok()).toBeTruthy();
  const reset = await page.request.post('/__wake-e2e/reset');
  expect(reset.ok()).toBeTruthy();
});

test('conversation Return inserts newlines and only Send submits', async ({ page }) => {
  let sentBody: string | undefined;
  await page.route('**/api/v1/work-items/*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.conversation.canCreateEntries = true;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/work-items/*/commands/message', async (route) => {
    sentBody = route.request().postDataJSON().body;
    await route.fulfill({
      status: 202,
      json: {
        data: {
          commandId: 'message-1',
          idempotencyKey: 'message-1',
          acceptedAt: '2026-07-31T10:00:00.000Z',
          status: ApiCommandStatus.Accepted,
        },
        meta: { asOf: '2026-07-31T10:00:00.000Z' },
      },
    });
  });
  await page.goto(`/work/${toWorkItemKey('work-demo')}`);
  await page.getByRole('tab', { name: 'Conversation' }).click();
  const input = page.getByRole('textbox', { name: 'Message' });
  const send = page.getByRole('button', { name: 'Send message' });
  await expect(send).toBeDisabled();
  await input.fill('   ');
  await expect(send).toBeDisabled();
  await input.fill('  First line');
  await input.press('Enter');
  await expect(input).toHaveValue('  First line\n');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('  First line\n\n');
  expect(sentBody).toBeUndefined();
  await input.pressSequentially('Second line  ');
  await send.click();
  await expect.poll(() => sentBody).toBe('First line\n\nSecond line');
  await expect(input).toHaveValue('');
});

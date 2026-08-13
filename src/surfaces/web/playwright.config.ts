import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/surface-fixture.ts',
  fullyParallel: false,
  workers: 1,
  outputDir: '../../../tmp/playwright',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: { baseURL: 'http://127.0.0.1:4319', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npx tsx e2e/surface-fixture.ts',
    url: 'http://127.0.0.1:4319/api/v1/system/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});

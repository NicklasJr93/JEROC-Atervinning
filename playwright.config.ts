import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// One marker is shared by this runner and its own child server. Existing dev
// servers are never reused, even outside CI.
process.env.SCRAPPLANNER_TEST_RUN_ID = randomUUID();

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  // Older real-server fixtures share demo accounts. Keep the default serial;
  // explicitly isolated fixture groups may opt into more workers on the CLI.
  workers: 1,
  fullyParallel: true,
  globalSetup: './tests/global-setup.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'mobile-chromium',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
            (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
        },
      },
    },
  ],
  webServer: {
    command: 'node scripts/start-test.mjs',
    url: 'http://127.0.0.1:5173/__scrapplanner_test__/marker',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
    timeout: 45_000,
  },
});

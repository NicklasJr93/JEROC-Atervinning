import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig({
  testDir: `${root}/tests`, testMatch: 'bokforing-*.spec.ts',
  timeout: 90000, workers: 1, reporter: 'list',
  outputDir: `${root}/test-results/bokforing`,
  use: {
    baseURL: 'http://127.0.0.1:4179', locale: 'sv-SE', trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] },
    } : {}),
  },
  webServer: {
    command: 'node scripts/start-bokforing-test-server.mjs', cwd: root,
    url: 'http://127.0.0.1:4179/readyz', reuseExistingServer: false, timeout: 45000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});

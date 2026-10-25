/**
 * End-to-end: the whole app on the emulators, driven through the browser
 * (e2e/ui) and over HTTP (e2e/api).
 *
 *   pnpm e2e                       from the root: takes the emulators lock, boots the
 *                                  stack (scripts/dev.mjs --no-seed) unless it is already
 *                                  up, runs everything, stops what it started
 *   pnpm --filter @tm/qaqc e2e --project api      only the API suites
 *
 * Every test makes its own people and boards (unique emails / keys), so the
 * suites never depend on the demo seed and can run against a live `pnpm dev`.
 */
import { defineConfig, devices } from '@playwright/test';
// @ts-expect-error — plain .mjs shared with the root scripts
import { URLS } from '../scripts/ports.mjs';

// TM_E2E_PLATFORM=vm: the VM server runs inside each worker (seed/vm.ts) on one port.
const VM = process.env.TM_E2E_PLATFORM === 'vm' || process.env.TM_E2E_PLATFORM === 'icebase';
const WEB = VM
  ? `http://127.0.0.1:${process.env.TM_E2E_VM_PORT || 5280}`
  : (process.env.TM_WEB_URL ?? (URLS as { web: string }).web);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: process.env.CI || VM ? 1 : 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'api', testMatch: /api\/.*\.spec\.ts$/ },
    {
      name: 'ui',
      testMatch: /ui\/.*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
    },
    // §U: the same app on a phone — a real touch device profile, not a narrow desktop window.
    { name: 'phone', testMatch: /phone\/.*\.spec\.ts$/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: VM ? undefined : {
    // The same stack a developer runs, empty (tests seed what they need).
    command: 'node ../scripts/dev.mjs --no-seed',
    url: WEB,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGINT', timeout: 25_000 },
  },
});

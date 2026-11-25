import { defineConfig } from '@playwright/test';

/** Drives the real web app, API, Postgres and GoTrue, with the provider emulators behind them. */
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    permissions: ['camera'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  webServer: [
    { command: 'pnpm --filter @paysplit/emulators start', port: 4010, reuseExistingServer: true, cwd: '..' },
    {
      // .env may hold real sandbox keys, so these tests never read it or adopt a server that did.
      command: 'pnpm --filter @paysplit/api start:emulated',
      url: 'http://localhost:4000/readyz',
      reuseExistingServer: false,
      cwd: '..',
    },
    { command: 'pnpm --filter @paysplit/web dev', port: 5173, reuseExistingServer: true, cwd: '..' },
  ],
});

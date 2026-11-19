import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the WebXR game.
 *
 * Notes specific to this app:
 * - The dev server is HTTPS with a self-signed mkcert cert → `ignoreHTTPSErrors`.
 * - It's a WebGL app, so the headless browser needs a GL backend → swiftshader args.
 * - `reuseExistingServer` means if `npm run dev:runtime` is already up on 8081,
 *   Playwright reuses it; otherwise it starts it.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  reporter: 'list',
  use: {
    baseURL: 'https://localhost:8081',
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  webServer: {
    command: 'npm run dev:runtime',
    url: 'https://localhost:8081',
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

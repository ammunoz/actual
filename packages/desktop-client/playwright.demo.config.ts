import path from 'node:path';

import { defineConfig } from '@playwright/test';

/**
 * The config for the import review's demo recording.
 *
 * It is deliberately NOT the e2e config, and it must never become one.
 * The demo is a recording, not a test: it drives the review through a
 * scripted story with pauses long enough for a person to read what is
 * happening, and the pauses are the point. The e2e suite has its own
 * config with its own test directory, so `yarn e2e` never sees this file
 * and the demo never slows CI down.
 *
 * The demo has its own port so it cannot collide with a dev server
 * (3001) or with an e2e run (3002).
 */
const demoPort = Number(process.env.E2E_DEMO_PORT) || 3003;

export default defineConfig({
  // The recording waits for the app to load, for the file to be parsed,
  // and for every step to settle — and then it pauses on purpose. The
  // budget here is generous on purpose.
  timeout: 180_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  testDir: 'demo/',
  reporter: [['list']],
  use: {
    userAgent: 'playwright',
    browserName: 'chromium',
    baseURL: `http://localhost:${demoPort}`,
    screenshot: 'off',
    trace: 'off',
    // The recording is 16:9 and 720p: the size Playwright's encoder
    // wants, and the size the GIF is scaled down from.
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  webServer: {
    cwd: path.join(__dirname, '..', '..'),
    // The demo runs against the BUILT bundle, not the dev server: the
    // dev server transforms a thousand modules on demand, which makes
    // every pause in the recording a pause waiting for the bundler.
    command: `PORT=${demoPort} node packages/desktop-client/bin/serve-build.mjs`,
    url: `http://localhost:${demoPort}`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    ignoreHTTPSErrors: true,
    timeout: 120_000,
  },
});

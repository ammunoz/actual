import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * A short recording of the OFX account-detection flow.
 *
 * The full import review has its own longer recording. This one shows only
 * the new behaviour: opening the import page directly, picking a file whose
 * bank identity is already known, seeing the suggested account, confirming
 * with Continue, and — when the file is aimed at a different account — the
 * standing warning that keeps the mistake from being silent.
 *
 * It is a RECORDING, not a test: every step is asserted, and the pauses are
 * for the viewer, never for synchronisation.
 */

/** Where the raw video lands. The conversion script moves it on. */
const VIDEO_PATH =
  process.env.DEMO_VIDEO_PATH ??
  join(__dirname, 'recordings', 'account-detection.webm');

/**
 * Where the recording says the interesting part starts.
 *
 * The first seconds are the app booting and the demo budget being made.
 * The exact moment depends on the machine, so the spec MEASURES it and
 * writes it down here, and the conversion cuts the video there.
 */
const TRIM_PATH = join(dirname(VIDEO_PATH), 'trim.json');

/** The demo file the recording imports. */
const DEMO_FILE = join(__dirname, '..', 'e2e', 'data', 'demo-import.ofx');

const withoutAnimations = () => {
  const css = `*, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
  }`;
  const install = () => {
    const style = document.createElement('style');
    style.setAttribute('data-demo-disable-animations', 'true');
    style.textContent = css;
    document.head.appendChild(style);
  };
  if (document.head) {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install);
  }
};

test('records the OFX account suggestion and mismatch warning', async ({
  browser,
}) => {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: dirname(VIDEO_PATH),
      size: { width: 1280, height: 720 },
    },
  });
  await page.addInitScript(withoutAnimations);

  // The recording's clock starts with the page.
  const startedAt = Date.now();
  const beat = async (ms = 1100) => page.waitForTimeout(ms);

  try {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Try the demo', exact: true })
      .click();
    await expect(page.getByTestId('budget-table')).toBeVisible();

    // From here the recording is about the account detection.
    writeFileSync(
      TRIM_PATH,
      JSON.stringify({ start: (Date.now() - startedAt) / 1000 }),
    );
    await beat(1200);

    // Seed a dominant history so the file's bank identity suggests an
    // account. Raw IPC writes the DB but not Redux, so reload before the
    // page reads prefs.
    const rememberedId = await page.evaluate(async () => {
      const $send = (
        window as unknown as {
          $send: <T>(type: string, args?: unknown) => Promise<T>;
        }
      ).$send;
      const accounts =
        await $send<Array<{ id: string; name: string }>>('accounts-get');
      const remembered = accounts.find(acc =>
        /^Bank of America/.test(acc.name),
      );
      if (!remembered) {
        throw new Error('the demo budget has no Bank of America account');
      }
      await $send('preferences/save', {
        id: 'import-review.ofx-identity-map',
        value: JSON.stringify({
          'DEMOBANK|DEMO-CHECKING-001': {
            accountId: remembered.id,
            updatedAt: '2026-01-01T00:00:00.000Z',
            hits: 4,
            lastN: [],
          },
        }),
      });
      return remembered.id;
    });
    await page.reload();
    await expect(page.getByTestId('budget-table')).toBeVisible();
    await beat(900);

    // Turn the keyboard review on from the command bar.
    await page.keyboard.press('ControlOrMeta+k');
    const commandBar = page.getByRole('combobox', { name: 'Command Bar' });
    await expect(commandBar).toBeVisible();
    await commandBar.fill('Keyboard import review');
    await beat(900);
    const toggle = page.getByRole('option', {
      name: /Keyboard import review/,
    });
    await expect(toggle).toBeVisible();
    if ((await toggle.innerText()).includes(': off')) {
      await page.keyboard.press('Enter');
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(commandBar).not.toBeVisible();
    await beat(900);

    // Open the standalone import page directly from the sidebar.
    await page.getByTestId('sidebar-import').click();
    await expect(page.getByTestId('import-review-setup-account')).toBeVisible();
    await beat(1200);

    // Pick a demo OFX file. Its bank identity is DEMOBANK|DEMO-CHECKING-001.
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose a file' }).click();
    await (await chooserPromise).setFiles(DEMO_FILE);

    const picker = page.getByTestId('import-review-setup-account');
    await expect(picker).toBeVisible();
    await expect(
      page.getByTestId('import-review-setup-suggestion'),
    ).toBeVisible();
    // The suggestion is the account the file was last imported into, not
    // merely whichever account happens to be first.
    await expect(picker).toHaveValue(rememberedId);
    await beat(1800);

    // The user overrides the suggestion and picks another account. That is
    // allowed — and it is exactly the case the standing warning is for.
    const options = await picker.locator('option').allTextContents();
    const other = options.find(name => !/Bank of America/.test(name));
    if (!other) {
      throw new Error(
        `no second account to import into: ${options.join(', ')}`,
      );
    }
    await picker.selectOption({ label: other });
    await beat(1600);

    // Confirm with Continue — the choice survives the round trip.
    await page.getByTestId('import-review-setup-continue').click();
    await expect(page.getByTestId('import-review-shell')).toBeVisible();
    await beat(1200);

    // The standing warning: this file remembers a different account, and
    // the review says so before anything is imported.
    const warning = page.getByTestId('import-review-account-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('was last imported into');
    await beat(2400);
  } finally {
    const video = page.video();
    await page.close();
    if (video) await video.saveAs(VIDEO_PATH);
  }
});

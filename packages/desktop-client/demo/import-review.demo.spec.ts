import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The demo recording of the keyboard import review.
 *
 * This is not a test of the review — the e2e suite in `../e2e` is. It
 * is a RECORDING: the whole import flow, driven from the keyboard, with
 * pauses long enough for a person to follow. It is what the fork's
 * readme shows.
 *
 * Two rules keep it honest:
 *
 *   - Every step the recording depends on is ASSERTED. If the review
 *     breaks, the recording fails loudly instead of producing a GIF of a
 *     broken flow.
 *   - The pauses are for the VIEWER, never for synchronisation. A step
 *     waits for the thing it needs with an expectation, and then pauses
 *     so the viewer can read it. A pause that a step DEPENDS on would
 *     make the recording flaky.
 *
 * It is SELF-CONTAINED on purpose. The e2e helpers live in a directory
 * this one cannot import from — the repo rewrites parent imports into
 * package paths — and a recording that reaches into another directory
 * for its helpers breaks when that directory is refactored. The demo
 * drives the app the way a person does: it clicks the button and waits
 * for the thing it expects.
 */

/** Where the raw video lands. The conversion script moves it on. */
const VIDEO_PATH =
  process.env.DEMO_VIDEO_PATH ??
  join(__dirname, 'recordings', 'import-review.webm');

/**
 * Where the recording says the interesting part starts.
 *
 * The first seconds of a recording are the app booting and the demo
 * budget being made — real, but not what the recording is about. The
 * exact moment the budget is ready depends on the machine, so the spec
 * MEASURES it and writes it down here, and the conversion script cuts
 * the video there. A hard-coded cut would drift the moment the app got
 * faster or slower.
 */
const TRIM_PATH = join(dirname(VIDEO_PATH), 'trim.json');

/**
 * The app's own transitions are switched off.
 *
 * The modal fades in over 100ms, and Playwright's click-stability check
 * can see the node it is about to click get re-mounted underneath it.
 * A recording that retries a click looks like a stutter.
 */
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

test('records the keyboard import review, from the command bar to the budget', async ({
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

  /**
   * A beat: long enough for a person to read what just happened.
   *
   * This is pacing, never synchronisation. A step that WAITS for
   * something waits with an expectation.
   */
  const beat = async (ms = 1100) => {
    await page.waitForTimeout(ms);
  };

  try {
    // ------------------------------------------------------------------
    // The budget. The demo budget brings its own accounts, so the
    // recording opens on a real account rather than on a form.
    // ------------------------------------------------------------------
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Try the demo', exact: true })
      .click();
    await expect(page.getByTestId('budget-table')).toBeVisible();

    // From here the recording is about the review.
    writeFileSync(
      TRIM_PATH,
      JSON.stringify({ start: (Date.now() - startedAt) / 1000 }),
    );
    await beat(1200);

    // ------------------------------------------------------------------
    // The review is OPT-IN, and the command bar is how it is turned on.
    // ------------------------------------------------------------------
    await page.keyboard.press('ControlOrMeta+k');
    const commandBar = page.getByRole('combobox', { name: 'Command Bar' });
    await expect(commandBar).toBeVisible();
    await commandBar.fill('Keyboard import review');
    await beat(900);

    // The item says whether the review is on or off, so the recording
    // can TURN it on rather than flip it: a re-run against a budget
    // that already has it on would otherwise turn it off, and the
    // recording would show a different flow.
    //
    // The option is not inside the input, so it is looked up on the
    // page rather than inside the combobox.
    const toggle = page.getByRole('option', {
      name: /Keyboard import review/,
    });
    await expect(toggle).toBeVisible();
    if ((await toggle.innerText()).includes(': off')) {
      await page.keyboard.press('Enter');
      await expect(commandBar).not.toBeVisible();
    } else {
      await page.keyboard.press('Escape');
      await expect(commandBar).not.toBeVisible();
    }
    await beat(900);

    // ------------------------------------------------------------------
    // The account, and the file.
    // ------------------------------------------------------------------
    await page.getByRole('link', { name: /^Bank of America/ }).click();
    await expect(page.getByTestId('transaction-table')).toBeVisible();
    await beat(1200);

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(
      join(__dirname, '..', 'e2e', 'data', 'demo-import-blocked.ofx'),
    );

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The review holds a row back and skips another, and it says which
    // is which in the status column: this file has a row with no payee
    // at all, and a row that repeats an earlier one's bank id.
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');
    await expect(rows.nth(2)).toHaveAttribute('data-gate', 'skip');
    await beat(2400);

    // ------------------------------------------------------------------
    // The row that is held back, and WHY it is.
    // ------------------------------------------------------------------
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
    await expect(dialog.getByTestId('import-review-verdict')).toContainText(
      'trust level',
    );
    await beat(1900);

    // ------------------------------------------------------------------
    // `e` walks the row: the payee, then the category, then the notes.
    // The editor moves on by itself, and the last field moves the
    // cursor on, because the row is finished.
    // ------------------------------------------------------------------
    await page.keyboard.press('e');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');
    await beat(1300);

    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await beat(700);
    await page.keyboard.press('Enter');
    await expect(editor).toHaveAttribute('data-field', 'category');
    await beat(1200);

    await editor.getByTestId('import-review-editor-input').fill('Food');
    await beat(700);
    await page.keyboard.press('Enter');
    await expect(editor).toHaveAttribute('data-field', 'memo');
    await beat(1200);

    await editor.getByTestId('import-review-editor-input').fill('a note');
    await beat(700);
    await page.keyboard.press('Enter');

    // The chain is over: the editor closes and the cursor moves to the
    // next row, because this one is finished.
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(2)).toHaveAttribute('data-focused', 'true');

    // And the fix RELEASED the row: the trust level has nothing to hold
    // back now.
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'allow');
    await beat(1900);

    // ------------------------------------------------------------------
    // `Shift+E` opens the rules of the row: what touched it, and the
    // rule it could grow. This one is created only because it is asked
    // for — nothing in the review learns on its own.
    // ------------------------------------------------------------------
    await page.keyboard.press('k');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Shift+E');
    const picker = dialog.getByTestId('import-review-rule-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId('import-review-rule-new')).toContainText(
      'always this category for this payee',
    );
    await beat(2400);

    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );
    await beat(1800);

    // ------------------------------------------------------------------
    // The trust level, with its own keys: `3` is the trusted level, and
    // it lets the row the cautious level skipped through.
    // ------------------------------------------------------------------
    await page.keyboard.press('3');
    await expect(
      dialog.getByTestId('import-review-trust-trusted'),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(2)).toHaveAttribute('data-gate', 'warn');
    await beat(2000);

    // ------------------------------------------------------------------
    // `Shift+A` accepts every row, and the status column says so.
    // ------------------------------------------------------------------
    await page.keyboard.press('Shift+A');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'accept');
    await beat(1800);

    // ------------------------------------------------------------------
    // `Ctrl+S` applies the import. The dialog closes, and the rows that
    // land are MARKED — the same bold the app's own import gives a
    // transaction it has just brought in.
    // ------------------------------------------------------------------
    await page.keyboard.press('Control+s');
    await expect(dialog).not.toBeVisible();
    const landed = page
      .getByTestId('transaction-table')
      .getByTestId('row')
      .filter({ hasText: 'Kroger' })
      .first();
    await expect(landed).toBeVisible();
    await beat(2800);

    await expect(landed.getByText('Kroger', { exact: true }).first()).toHaveCSS(
      'font-weight',
      '600',
    );
    await beat(3200);
  } finally {
    // The video is only finished once the page is closed.
    await page.close();
    const video = page.video();
    if (video) {
      await video.saveAs(VIDEO_PATH);
    }
  }
});

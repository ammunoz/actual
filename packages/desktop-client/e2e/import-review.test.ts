import { join } from 'path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { AccountPage } from './page-models/account-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

test.describe('Keyboard import review', () => {
  let page: Page;
  let navigation: Navigation;
  let configurationPage: ConfigurationPage;
  let accountPage: AccountPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    navigation = new Navigation(page);
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    await configurationPage.createTestFile();
  });

  test.afterEach(async () => {
    await page?.close();
  });

  /**
   * Turn the keyboard review on through the command bar. The feature is
   * opt-in, and the command bar is how a user turns it on.
   */
  async function enableKeyboardReview() {
    await page.keyboard.press('ControlOrMeta+k');
    const commandBar = page.getByRole('combobox', { name: 'Command Bar' });
    await expect(commandBar).toBeVisible();
    await commandBar.fill('Keyboard import review');
    await page.keyboard.press('Enter');
    await expect(commandBar).not.toBeVisible();
  }

  async function importOfx() {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await accountPage.page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(join(__dirname, 'data/demo-import.ofx'));
  }

  /**
   * Import the fixture with two rows the trust level holds back.
   *
   * The second transaction has no payee name at all: a vendor string that
   * cannot be matched and cannot be canonicalised into anything is an
   * unknown payee, which the trust level holds back at `cautious` and only
   * warns about at `trusted`.
   *
   * The third one repeats the first one's FITID, so it is a duplicate: the
   * trust level skips it at `cautious` and only warns about it at
   * `trusted`.
   */
  async function importBlockedOfx() {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await accountPage.page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(join(__dirname, 'data/demo-import-blocked.ofx'));
  }

  test('opens the keyboard review for an OFX file when it is enabled', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The review's own header, not Actual's import modal.
    await expect(dialog.getByText('Review import')).toBeVisible();
  });

  test('falls back to Actual own import modal when the feature is off', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Off',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The feature is off by default.
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /Import \d+ transactions/ }),
    ).toBeVisible();
  });

  test('imports the transactions from the review', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Import',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    // The three rows from the fixture. Each name appears twice: once as
    // the raw vendor string and once as the resolved payee.
    await expect(dialog.getByText('POS PURCHASE 4251').first()).toBeVisible();
    await expect(dialog.getByText('Demo Grocery Store').first()).toBeVisible();
    await expect(
      dialog.getByText('Demo Payroll Deposit').first(),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();

    await expect(dialog).not.toBeVisible();

    // The transactions landed in the account. The payee is the RESOLVED
    // name: "POS PURCHASE 4251" is stripped down to "PURCHASE", while the
    // other two are already canonical.
    const rows = accountPage.transactionTableRow;
    await expect(rows.filter({ hasText: 'PURCHASE' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Demo Grocery Store' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Demo Payroll Deposit' })).toHaveCount(
      1,
    );
  });

  test('the keyboard drives the review', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Keys',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The first row is focused to begin with.
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'false');

    // `j` moves down.
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'false');

    // `k` moves back up.
    await page.keyboard.press('k');
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');

    // `a` accepts the focused row and advances.
    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');

    // `r` drops the focused row and advances.
    await page.keyboard.press('r');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'drop');
    await expect(rows.nth(2)).toHaveAttribute('data-focused', 'true');

    // `u` undoes the last decision.
    await page.keyboard.press('u');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'pending');
  });

  test('shift+a accepts every row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Accept All',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // `shift+a` is a DIFFERENT hotkey from `a`: the library lowercases the
    // key string, so without the explicit shift modifier the two would be
    // the same binding.
    await page.keyboard.press('Shift+a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'accept');
  });

  test('a dropped row is not imported', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Drop',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // Drop the first row, then import the rest.
    await page.keyboard.press('r');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'drop');

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    const imported = accountPage.transactionTableRow;
    await expect(imported.filter({ hasText: 'PURCHASE' })).toHaveCount(0);
    await expect(
      imported.filter({ hasText: 'Demo Grocery Store' }),
    ).toHaveCount(1);
  });

  test('ctrl+a confirms the focused row only', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Confirm',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // `ctrl+a` confirms the FOCUSED row. It is a different binding from
    // `shift+a` (accept every row), so it must not accept the whole file.
    await page.keyboard.press('Control+a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'pending');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'pending');
  });

  test('a row the trust level holds back is not imported', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Held Back',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The second transaction has no payee name at all, so it is an
    // unknown payee: held back at the default trust level.
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
    // The first one is only flagged: the budget has no payee for it yet,
    // so the import will create one.
    await expect(rows.nth(0)).toHaveAttribute('data-held', 'false');
    // The third one repeats the first one's FITID, so it is a duplicate:
    // skipped at the default trust level.
    await expect(rows.nth(2)).toHaveAttribute('data-gate', 'skip');
    await expect(rows.nth(2)).toHaveAttribute('data-held', 'true');
    await expect(dialog.getByText('Blocked: 1')).toBeVisible();
    await expect(dialog.getByText('Skipped: 1')).toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // Only the row that was not held back landed.
    const imported = accountPage.transactionTableRow;
    await expect(imported).toHaveCount(1);
    await expect(
      imported.filter({ hasText: 'Demo Grocery Store' }),
    ).toHaveCount(1);
  });

  test('a plain accept does not release a held-back row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Held Accept',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // `a` accepts the row, but the trust level still holds it back.
    await page.keyboard.press('j');
    await page.keyboard.press('a');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
    await expect(dialog.getByText('Blocked: 1')).toBeVisible();
  });

  test('ctrl+shift+a overrides the trust level', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Override',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    await page.keyboard.press('j');
    await page.keyboard.press('Control+Shift+a');
    await expect(rows.nth(1)).toHaveAttribute(
      'data-decision',
      'accept-override',
    );
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'false');
    await expect(dialog.getByText('Blocked: 0')).toBeVisible();
    await expect(dialog.getByText('Overridden: 1')).toBeVisible();

    // The overridden row lands. The duplicate is still skipped.
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(2);
  });

  test('the trusted trust level holds nothing back that it can', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Trusted',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');

    // `tab` cycles the trust level: cautious -> trusted. The unknown payee
    // and the duplicate are only warned about now, so they land.
    await page.keyboard.press('Tab');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'warn');
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'false');
    await expect(rows.nth(2)).toHaveAttribute('data-gate', 'warn');
    await expect(rows.nth(2)).toHaveAttribute('data-held', 'false');
    await expect(dialog.getByText('Blocked: 0')).toBeVisible();
    await expect(dialog.getByText('Skipped: 0')).toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // All three rows land. Actual's matching is against the budget, not
    // within the file, so a repeated FITID is a second transaction here -
    // which is exactly what the duplicate flag is there to warn about.
    await expect(accountPage.transactionTableRow).toHaveCount(3);
  });
});

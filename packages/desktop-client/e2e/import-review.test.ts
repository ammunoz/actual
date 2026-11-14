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

  test('e edits the payee, and the fix releases the row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Edit Payee',
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

    // The second row has no payee at all, so the trust level holds it
    // back.
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
    await expect(dialog.getByText('Blocked: 1')).toBeVisible();

    await page.keyboard.press('j');
    await page.keyboard.press('e');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    // The editor owns the keyboard: the field has the focus, so what is
    // typed goes into it.
    const input = editor.getByTestId('import-review-editor-input');
    await expect(input).toBeFocused();

    // A name the budget does not have: the import creates the payee.
    await page.keyboard.type('Demo Edited Vendor');
    await page.keyboard.press('Enter');

    await expect(editor).not.toBeVisible();
    await expect(rows.nth(1)).toHaveText(/Demo Edited Vendor/);

    // And the fix RELEASED the row: the gate has nothing to hold back
    // now, so the row lands.
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'false');
    await expect(dialog.getByText('Blocked: 0')).toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(2);
  });

  test('m edits the notes', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Edit Memo',
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

    await page.keyboard.press('m');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'memo');

    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('a note from the review');
    await page.keyboard.press('Enter');

    await expect(editor).not.toBeVisible();

    // The note is the row's notes now, and the review says so: an edit
    // the user cannot see is an edit the user cannot trust.
    await expect(dialog.getByTestId('import-review-notes')).toContainText(
      'a note from the review',
    );
  });

  test('shift+4 edits the amount', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Edit Amount',
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

    await page.keyboard.press('Shift+4');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'amount');

    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('-30');
    await page.keyboard.press('Enter');

    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveText(/-30/);
  });

  test('d edits the date', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Edit Date',
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

    await page.keyboard.press('d');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'date');

    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('2026-09-15');
    await page.keyboard.press('Enter');

    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveText(/2026-09-15/);
  });

  test('an impossible date is refused rather than committed', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Bad Date',
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

    await page.keyboard.press('d');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();

    // A date that is shaped like one but is not. The gate derives its
    // date flag from the value that would be sent, so committing this
    // would flag the row again a moment later.
    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('2026-02-31');
    await page.keyboard.press('Enter');

    // The editor stays open and says why.
    await expect(editor).toBeVisible();
    await expect(editor.getByText('That is not a date')).toBeVisible();
  });

  test('escape closes the editor without changing the row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Escape',
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

    await page.keyboard.press('e');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();

    await page.keyboard.type('Demo Abandoned Vendor');
    await page.keyboard.press('Escape');

    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).not.toHaveText(/Demo Abandoned Vendor/);
    // The review itself is still open: escape cancelled the edit, it did
    // not discard the review.
    await expect(dialog.getByText('Review import')).toBeVisible();
  });

  test('u undoes a decision', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Undo',
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

    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    await page.keyboard.press('u');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');
  });

  test('shift+a accepts every row, and one undo takes it all back', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Undo All',
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

    await page.keyboard.press('Shift+a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'accept');

    // One bulk action is one undo.
    await page.keyboard.press('u');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'pending');
  });

  test("the review owns the keyboard: the app's own keys do not fire", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Own Keys',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    // The account page binds `t` to "add transaction", and the review
    // binds the same key for the transfer editor. The review owns the
    // keyboard, so the app's binding must not fire.
    await page.keyboard.press('t');

    await expect(dialog.getByText('Review import')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText('Add transaction'),
    ).toHaveCount(0);
  });

  test('the help overlay lists the keys', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Help',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    await page.keyboard.press('Shift+Slash');

    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();
    await expect(help.getByText('Accept row despite its flags')).toBeVisible();
    await expect(help.getByText('Cycle trust level')).toBeVisible();

    // Escape closes the overlay, and the review with it.
    await page.keyboard.press('Escape');
    await expect(help).not.toBeVisible();
    await expect(dialog.getByText('Review import')).toBeVisible();
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

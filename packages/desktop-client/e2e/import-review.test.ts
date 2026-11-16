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

  /**
   * Import the fixture with two rows that repeat one FITID.
   *
   * The second transaction repeats the first one's FITID, so the trust
   * level SKIPS it at `cautious` — it is held back, and the override is
   * what releases it. There is nothing BLOCKED here, so the summary's
   * blocked count is zero.
   */
  async function importDuplicateOfx() {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await accountPage.page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(
      join(__dirname, 'data/demo-import-duplicate.ofx'),
    );
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
    // The heading says where the rows are going: the account the review
    // was opened for. It is the only place the destination is shown.
    await expect(dialog.getByTestId('import-review-destination')).toContainText(
      'Keyboard Review',
    );
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

  test('a re-import keeps the edit the user made to an imported transaction', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Reimport',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();

    // The first import puts the three transactions in the budget.
    await importOfx();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(3);

    // The second import is the SAME file. Actual's import UPDATE path keeps
    // the existing payee and category and throws the user's edit away, so
    // the review has to recognise the transactions that are already in the
    // budget and update them in place.
    await importOfx();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user gives the first row a DIFFERENT payee.
    //
    // This is the case the import cannot handle on its own: Actual's
    // import UPDATE path computes `payee: existing.payee || trans.payee`,
    // so the payee the transaction already has WINS and the user's choice
    // is thrown away. The review has to update the transaction in place.
    await page.keyboard.press('e');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    const input = editor.getByTestId('import-review-editor-input');
    await expect(input).toBeFocused();
    // The text is filled into the field rather than typed, so the
    // review's own bindings do not see the letters.
    await input.fill('Demo Payroll Deposit');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveText(/Demo Payroll Deposit/);

    await dialog.getByRole('button', { name: 'Import' }).click();

    // The old payee is not used by any transaction any more, so Actual
    // offers to merge it. The review closes ITSELF and leaves that
    // question alone: it is still the user's to answer.
    const mergeModal = page.getByTestId('merge-unused-payees-modal');
    await expect(mergeModal).toBeVisible();
    await expect(
      page.getByTestId('keyboard-import-transactions-modal'),
    ).not.toBeVisible();

    await mergeModal.getByRole('button', { name: 'Do nothing' }).click();
    await expect(mergeModal).not.toBeVisible();

    // The edit landed on the transaction that was already there: no
    // duplicate, and the payee the user chose.
    await expect(accountPage.transactionTableRow).toHaveCount(3);
    await expect(
      accountPage.transactionTableRow.filter({
        hasText: 'Demo Payroll Deposit',
      }),
    ).toHaveCount(2);
    await expect(
      accountPage.transactionTableRow.filter({ hasText: 'PURCHASE' }),
    ).toHaveCount(0);
  });

  test('an import with nothing to do says so', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Nothing To Do',
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

    // The user throws every row away, so there is nothing left to import.
    await page.keyboard.press('Shift+r');

    await dialog.getByRole('button', { name: 'Import' }).click();

    // The review says so rather than sitting there looking broken.
    await expect(dialog.getByText('There is nothing to import')).toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(0);
  });

  test('w puts the review aside, and the command bar picks it up again', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Session',
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

    // The user writes a note on the first row and puts the review aside.
    await page.keyboard.press('m');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('a note from the review');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    await page.keyboard.press('w');
    await expect(
      page.getByTestId('keyboard-import-transactions-modal'),
    ).not.toBeVisible();

    // Nothing was imported: the review was put aside, not applied.
    await expect(accountPage.transactionTableRow).toHaveCount(0);

    // The command bar brings the review back, with the work in it.
    await page.keyboard.press('ControlOrMeta+k');
    const commandBar = page.getByRole('combobox', { name: 'Command Bar' });
    await expect(commandBar).toBeVisible();
    await commandBar.fill('Resume the import review');
    await page.keyboard.press('Enter');
    await expect(commandBar).not.toBeVisible();

    await expect(dialog.getByText('Review import')).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(
      dialog.getByTestId('import-review-notes').first(),
    ).toContainText('a note from the review');
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

  test('the hint strip says the keys, and says the override when a row is held', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toBeVisible();

    // A row is held back — the second one has no payee name at all — so
    // the strip says the one key that releases it.
    await expect(dialog.getByText('Blocked: 1')).toBeVisible();
    await expect(hints).toContainText('Ctrl+Shift+A');
    await expect(hints).toContainText('accept anyway');

    // The strip is the only place these keys are: the help overlay is
    // behind `?`, and nothing else on screen says them.
    await page.keyboard.press('Shift+Slash');
    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();

    // While a pane is open the strip keeps quiet: the pane says its own
    // keys, where they matter.
    await expect(hints).not.toBeVisible();

    await page.keyboard.press('Escape');
    await expect(help).not.toBeVisible();
    await expect(hints).toBeVisible();
  });

  test('the hint strip says the override for a SKIPPED row too', async () => {
    // A duplicate FITID is SKIPPED at the cautious trust level, not
    // blocked. It is still held back, and the override is still what
    // releases it — so the strip has to say the override. The summary's
    // "blocked" count does not include skipped rows, so asking the
    // summary would miss this case entirely.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip Skipped',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importDuplicateOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The second row repeats the first one's FITID: skipped, and held.
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
    await expect(dialog.getByText('Skipped: 1')).toBeVisible();

    // And nothing is BLOCKED — which is exactly the case the summary's
    // blocked count would have missed.
    await expect(dialog.getByText('Blocked: 0')).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toContainText('Ctrl+Shift+A');
  });

  test('the hint strip omits the override when nothing is held back', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip Clean',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toBeVisible();

    // Nothing is held back, so the override is not mentioned: the strip
    // says the keys, and only the keys that apply.
    await expect(hints).not.toContainText('accept anyway');
    await expect(hints).toContainText('j/k move');
    await expect(hints).toContainText('a accept');
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

  test('the row carries the category group, and the cells do not wrap', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Category Group',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // A category name far too long for the column, so the cell has to
    // truncate rather than wrap. Without a name that long, the test
    // would pass even against the old, wrapping cell.
    const longName =
      'A Deliberately Very Long Category Name That Cannot Possibly Fit';
    await page.evaluate(async name => {
      const groupId = await window.$send('category-group-create', {
        name: 'Long Names',
      });
      await window.$send('category-create', { name, groupId });
    }, longName);

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The row has no category yet, so the group cell is empty.
    const group = rows.nth(0).getByTestId('import-review-row-category-group');
    await expect(group).toBeEmpty();

    // Give the row the long category.
    await page.keyboard.press('c');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'category');

    const input = editor.getByTestId('import-review-editor-input');
    await input.click();
    await input.pressSequentially('Deliberately Very Long');

    const option = editor.getByTestId('import-review-editor-option').first();
    await expect(option).toBeVisible();

    // The group the CHOSEN option belongs to. The header is a sibling of
    // the option inside their shared wrapper, so it is read from the
    // option's parent rather than from the list's first header.
    const pickerGroup = await option
      .locator('..')
      .getByTestId('import-review-editor-group')
      .innerText();
    expect(pickerGroup).toBe('Long Names');

    await option.click();
    await expect(editor).not.toBeVisible();

    // The row now carries the category AND the group it belongs to, so
    // two categories with the same name are distinguishable in the table.
    await expect(rows.nth(0)).toHaveText(/Deliberately Very Long/);
    await expect(
      rows.nth(0).getByTestId('import-review-row-category-group'),
    ).toHaveText('Long Names');

    // And the cell does not WRAP: it truncates on one line, so the row
    // stays the height of a single line. The computed style is the
    // assertion — a height comparison cannot tell the difference,
    // because a wrapped cell grows the row too.
    const cell = rows.nth(0).getByTestId('import-review-row-category');
    await expect(cell).toContainText('Deliberately Very Long');
    const whiteSpace = await cell.evaluate(
      element => getComputedStyle(element).whiteSpace,
    );
    expect(whiteSpace).toBe('nowrap');

    // The text is wider than the cell, so it really is truncating.
    const overflows = await cell.evaluate(
      element => element.scrollWidth > element.clientWidth,
    );
    expect(overflows).toBe(true);

    // And it truncates with an ellipsis, not a hard cut.
    const textOverflow = await cell.evaluate(
      element => getComputedStyle(element).textOverflow,
    );
    expect(textOverflow).toBe('ellipsis');
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

  test('escape closes a review the user has not touched', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Escape Clean',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Review import')).toBeVisible();

    // Nothing has been decided or edited, so there is nothing to lose and
    // nothing to ask about.
    await page.keyboard.press('Escape');

    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(0);
  });

  test('escape asks before it throws the work away', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Escape Dirty',
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

    // Accept a row: that is work, and escape must not throw it away.
    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    await page.keyboard.press('Escape');

    // The confirmation, and the review is still open underneath it.
    const confirm = dialog.getByTestId('import-review-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Rows decided: 1');
    await expect(dialog.getByText('Review import')).toBeVisible();

    // The work is still there: the confirmation did not decide anything.
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test('keeping the review brings back the work untouched', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Keep',
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

    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    await page.keyboard.press('Escape');
    const confirm = dialog.getByTestId('import-review-confirm');
    await expect(confirm).toBeVisible();

    // Escape goes back to the review rather than throwing it away.
    await page.keyboard.press('Escape');
    await expect(confirm).not.toBeVisible();
    await expect(dialog.getByText('Review import')).toBeVisible();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    // And the review still answers the keyboard: the button that had the
    // focus is gone, and the focus must not have gone with the keyboard.
    await page.keyboard.press('u');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');
  });

  test('the safe choice is the one that starts focused', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Focus',
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

    await page.keyboard.press('a');
    await page.keyboard.press('Escape');

    const confirm = dialog.getByTestId('import-review-confirm');
    await expect(confirm).toBeVisible();

    // Enter acts on whatever is focused, so the safe choice has to be the
    // one that starts focused: a user who reaches for the keyboard
    // without reading the pane keeps their work.
    await expect(
      confirm.getByRole('button', { name: 'Keep reviewing' }),
    ).toBeFocused();

    // So Enter keeps the work: the confirmation closes and the review is
    // still there, with the decision intact.
    await page.keyboard.press('Enter');
    await expect(confirm).not.toBeVisible();
    await expect(dialog.getByText('Review import')).toBeVisible();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test('discarding throws the review away and imports nothing', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Discard',
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

    await page.keyboard.press('a');
    await page.keyboard.press('Escape');

    const confirm = dialog.getByTestId('import-review-confirm');
    await expect(confirm).toBeVisible();

    // Move to the destructive choice and take it.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect(dialog).not.toBeVisible();

    // Nothing landed: the review was thrown away, not applied.
    await expect(accountPage.transactionTableRow).toHaveCount(0);
  });

  test('undoing the work makes the review safe to close again', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Undo Close',
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

    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    // Undoing puts the row back, so there is nothing left to lose.
    await page.keyboard.press('u');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');

    await page.keyboard.press('Escape');
    await expect(dialog.getByTestId('import-review-confirm')).toHaveCount(0);
    await expect(dialog).not.toBeVisible();
  });

  test('the X button asks before it throws the work away', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review X Button',
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

    await page.keyboard.press('a');

    await dialog.getByRole('button', { name: 'Close' }).click();

    const confirm = dialog.getByTestId('import-review-confirm');
    await expect(confirm).toBeVisible();
    await expect(dialog.getByText('Review import')).toBeVisible();

    // The confirmation takes the keyboard: the X button has the focus
    // after the click, and the confirmation takes it back.
    await expect(
      confirm.getByRole('button', { name: 'Keep reviewing' }),
    ).toBeFocused();
  });

  test('clicking outside does not throw the review away', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Outside Click',
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

    await page.keyboard.press('a');

    // A click outside the dialog used to dismiss it and throw the work
    // away with it. The click lands on the overlay behind the dialog, in
    // the corner the dialog does not cover.
    await page
      .getByTestId('keyboard-import-transactions-modal')
      .click({ position: { x: 5, y: 5 } });

    await expect(dialog.getByText('Review import')).toBeVisible();
    await expect(dialog.getByTestId('import-review-confirm')).toHaveCount(0);

    // The work is still there: the click did not throw it away either.
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test("the editor's escape cancels the edit without asking", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Editor Escape',
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

    // There IS work in the review, so a confirmation would be right — but
    // the escape in the editor cancels the EDIT, and there is nothing to
    // ask about: the edit was never committed.
    await page.keyboard.press('a');
    await page.keyboard.press('e');

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(editor).not.toBeVisible();
    await expect(dialog.getByTestId('import-review-confirm')).toHaveCount(0);
    await expect(dialog.getByText('Review import')).toBeVisible();
  });

  test('the split editor opens with two legs', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Open',
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

    await page.keyboard.press('s');

    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    // The split opens with two legs that already add up to the row, so
    // the only work left is giving each leg its own category.
    await expect(split.getByTestId('import-review-split-leg')).toHaveCount(2);
    await expect(
      split.getByTestId('import-review-split-leg-amount-0'),
    ).toHaveValue('-12.50');
    await expect(
      split.getByTestId('import-review-split-leg-amount-1'),
    ).toHaveValue('-12.50');
    await expect(
      split.getByTestId('import-review-split-residual'),
    ).toContainText('add up');
  });

  test('a split with no categories is refused', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Uncategorised',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    // The row has no category of its own, so the legs have none either,
    // and a leg without a category cannot be committed.
    await split.getByTestId('import-review-split-save').click();

    await expect(
      split.getByTestId('import-review-split-problem'),
    ).toContainText('category');
    // The pane is still open: the split was not saved.
    await expect(split).toBeVisible();
  });

  test('a split is saved and the row says so', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Save',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    // Give each leg its own category.
    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }

    await split.getByTestId('import-review-split-save').click();

    // The pane is closed and the row says it is a split, the way Actual's
    // own transactions table says it.
    await expect(split).not.toBeVisible();
    await expect(rows.nth(0)).toContainText('Split (2)');
  });

  test('a saved split imports as a split', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Import',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }
    await split.getByTestId('import-review-split-save').click();
    await expect(split).not.toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // The split landed as a split: the parent says "Split" and its two
    // legs carry the categories the user picked.
    // The rows are found by what they SAY rather than by their position:
    // the table is sorted newest first, and the demo budget the test
    // runs against has transactions and splits of its own.
    //
    // The imported rows are the ones with the resolved payee "Purchase".
    const landed = accountPage.transactionTableRow.filter({
      hasText: 'Purchase',
    });
    await expect(landed).toHaveCount(3);

    // The parent says "Split" and its two legs carry the categories the
    // user picked. The category cell is matched EXACTLY: a substring
    // match would find the demo budget's own "Food" and "General".
    const categories = landed.getByTestId('category');
    await expect(categories.filter({ hasText: /^Split$/ })).toHaveCount(1);
    await expect(categories.filter({ hasText: /^General$/ })).toHaveCount(1);
    await expect(categories.filter({ hasText: /^Food$/ })).toHaveCount(1);
  });

  test('distribute fills the empty leg, and the fields follow', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Distribute',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    // Empty the second leg, so there is something for "Distribute" to
    // fill.
    const second = split.getByTestId('import-review-split-leg-amount-1');
    await second.fill('0.00');
    await page.keyboard.press('Enter');
    await expect(second).toHaveValue('0.00');

    await split.getByTestId('import-review-split-distribute').click();

    // The FIELD follows the draft: the empty leg took the remainder, and
    // the field says so. A field that kept the old value would ask the
    // user to save an amount they cannot see.
    await expect(second).toHaveValue('-12.50');
    await expect(
      split.getByTestId('import-review-split-leg-amount-0'),
    ).toHaveValue('-12.50');
    await expect(
      split.getByTestId('import-review-split-residual'),
    ).toContainText('add up');
  });

  test('a leg with its category cleared cannot be saved', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Cleared',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    // Give both legs a category, so the split is otherwise sound.
    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }

    // The legs add up, so the category is the only thing that can stop
    // the split.
    await expect(
      split.getByTestId('import-review-split-residual'),
    ).toContainText('add up');

    // Now clear the first leg's category and confirm it.
    const field = split.getByTestId('import-review-split-leg-category-0');
    await field.click();
    await field.fill('');
    await page.keyboard.press('Enter');

    // A leg with no category cannot be committed: the split would land
    // a leg in no category at all, without saying so.
    await split.getByTestId('import-review-split-save').click();
    await expect(
      split.getByTestId('import-review-split-problem'),
    ).toContainText('category');
    await expect(split).toBeVisible();
  });

  test('ctrl+enter saves the split from inside a field', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Ctrl Enter',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }

    // The focus is in a field, where the plain Enter belongs to the
    // field: the split is saved with Ctrl+Enter.
    await page.keyboard.press('Control+Enter');

    await expect(split).not.toBeVisible();
    await expect(rows.nth(0)).toContainText('Split (2)');
  });

  test("a split row's amount cannot be changed", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Split Amount',
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

    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }
    await split.getByTestId('import-review-split-save').click();
    await expect(split).not.toBeVisible();

    // Changing the amount of a split row would unbalance the split, so
    // the edit is refused and the editor stays open.
    await page.keyboard.press('Shift+4');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();

    await editor.getByTestId('import-review-editor-input').fill('-30.00');
    await page.keyboard.press('Enter');

    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'split',
    );
    await expect(editor).toBeVisible();
  });

  test('the transfer editor lists the accounts it can transfer to', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Open',
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

    await page.keyboard.press('t');

    const transfer = dialog.getByTestId('import-review-transfer');
    await expect(transfer).toBeVisible();

    // The budget's accounts are offered as transfer targets.
    const options = transfer.getByTestId('import-review-editor-option');
    await expect(options.first()).toBeVisible();
    await expect(options.filter({ hasText: 'Ally Savings' })).toHaveCount(1);

    // The account the import is going into is not: a transfer to itself
    // is not a transfer.
    await expect(
      options.filter({ hasText: 'Keyboard Review Transfer Open' }),
    ).toHaveCount(0);
  });

  test('a transfer shows in the row and imports as a transfer', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Import',
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

    await page.keyboard.press('t');
    const transfer = dialog.getByTestId('import-review-transfer');
    await expect(transfer).toBeVisible();

    const field = transfer.getByTestId('import-review-transfer-target');
    await field.click();
    await field.pressSequentially('Ally Savings');
    await page.keyboard.press('Enter');

    await transfer.getByTestId('import-review-transfer-save').click();
    await expect(transfer).not.toBeVisible();

    // The row says where the money goes: the account in the payee
    // column, and "Transfer" in the category column.
    await expect(rows.nth(0)).toContainText('Ally Savings');
    await expect(rows.nth(0)).toContainText('Transfer');

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // The row landed in the source account as a transfer: its payee is
    // the target account, and the money left.
    const landed = accountPage.transactionTableRow.filter({
      hasText: 'Ally Savings',
    });
    await expect(landed.first()).toBeVisible();
    await expect(landed.first().getByTestId('debit')).toHaveText('25.00');

    // And the mirror landed in the target account, with the amount
    // flipped: the money arrived there.
    const targetPage = await navigation.goToAccountPage('Ally Savings');
    const mirror = targetPage.transactionTableRow.filter({
      hasText: 'Keyboard Review Transfer Import',
    });
    await expect(mirror.first()).toBeVisible();
    await expect(mirror.first().getByTestId('credit')).toHaveText('25.00');
  });

  test('a split row cannot be turned into a transfer', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Split',
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

    // Split the row first.
    await page.keyboard.press('s');
    const split = dialog.getByTestId('import-review-split');
    await expect(split).toBeVisible();

    for (const [index, category] of [
      [0, 'General'],
      [1, 'Food'],
    ]) {
      const field = split.getByTestId(
        `import-review-split-leg-category-${index}`,
      );
      await field.click();
      await field.pressSequentially(category);
      await page.keyboard.press('Enter');
    }
    await split.getByTestId('import-review-split-save').click();
    await expect(split).not.toBeVisible();

    // A row is EITHER a transfer OR a split. Turning a split into a
    // transfer would throw the split away without saying so.
    await page.keyboard.press('t');

    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'split',
    );
    await expect(dialog.getByTestId('import-review-transfer')).toHaveCount(0);
  });

  test('remove transfer takes the transfer away', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Remove',
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

    await page.keyboard.press('t');
    const transfer = dialog.getByTestId('import-review-transfer');
    await expect(transfer).toBeVisible();

    const field = transfer.getByTestId('import-review-transfer-target');
    await field.click();
    await field.pressSequentially('Ally Savings');
    await page.keyboard.press('Enter');
    await transfer.getByTestId('import-review-transfer-save').click();
    await expect(transfer).not.toBeVisible();

    await expect(rows.nth(0)).toContainText('Transfer');

    // Open it again and take the transfer away.
    await page.keyboard.press('t');
    await expect(transfer).toBeVisible();
    await transfer.getByTestId('import-review-transfer-remove').click();
    await expect(transfer).not.toBeVisible();

    // The row is an ordinary transaction again: the category cell says
    // it needs a category, and the payee cell is the vendor's own name
    // again.
    await expect(rows.nth(0)).not.toContainText('Transfer');
    await expect(rows.nth(0)).toContainText('Categorize');
    await expect(rows.nth(0)).toContainText('PURCHASE');
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

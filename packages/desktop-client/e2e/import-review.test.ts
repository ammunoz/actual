import { writeFileSync } from 'fs';
import { join } from 'path';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { AccountPage } from './page-models/account-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { EditRuleModal } from './page-models/edit-rule-modal';
import { Navigation } from './page-models/navigation';

/**
 * The WCAG contrast ratio between two colours.
 *
 * The colours are the ones the browser computed at runtime, so the
 * assertion holds in every theme and whatever the theme's tokens happen
 * to be. AA for normal text is 4.5:1.
 */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g);
    if (!channels || channels.length < 3) {
      throw new Error(
        `Cannot read the colour "${color}" — the computed style was not a colour.`,
      );
    }
    const [r, g, b] = channels
      .slice(0, 3)
      .map(Number)
      .map(value => {
        const channel = value / 255;
        return channel <= 0.03928
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const high = Math.max(foregroundLuminance, backgroundLuminance);
  const low = Math.min(foregroundLuminance, backgroundLuminance);
  return (high + 0.05) / (low + 0.05);
}

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

  test('a focused button does not fire a row key', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Focused Button',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The trust chips are buttons. With one focused, `a` used to accept
    // the focused row: the hotkey handler only ignored inputs and text
    // areas, and a button is not either of those.
    const chip = dialog.getByTestId('import-review-trust-paranoid');
    await chip.focus();
    await page.keyboard.press('a');
    await expect(rows.first()).not.toHaveAttribute('data-decision', 'accept');
    await expect(dialog.getByText('0 of 3 reviewed')).toBeVisible();

    // The button's OWN keys still work. The bail is about the review's
    // row keys, not about disabling the control.
    await page.keyboard.press('Enter');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // The control hands the keyboard back to the grid once it has done
    // its job, so the row keys work again straight away.
    await expect(dialog.getByTestId('import-review-grid')).toBeFocused();

    // Escape is a GLOBAL key, not a row key. The dialog is told not to
    // dismiss itself on Escape, so if the focus bail swallowed it here
    // there would be no way out of a review with a button focused.
    const importButton = dialog.getByTestId('import-review-import');
    await importButton.focus();
    await expect(importButton).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('tab moves focus, and escape hands it back to the grid', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Tab',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-row')).toHaveCount(3);

    // `tab` used to be the cycle binding, so it was prevented and NO
    // control in the review could be reached with the keyboard. Now it
    // moves focus, and the Import button is reachable.
    const importButton = dialog.getByTestId('import-review-import');
    let reached = false;
    // Twelve is a budget, not a fact: the header has a handful of
    // controls and the dialog traps the focus, so the walk gets there
    // well inside this. A bigger header would need a bigger number.
    for (let press = 0; press < 12; press++) {
      if (await importButton.evaluate(el => el === document.activeElement)) {
        reached = true;
        break;
      }
      await page.keyboard.press('Tab');
    }
    expect(reached).toBe(true);

    // A pane takes the focus when it opens and gives it back to the rows
    // when it closes, so the next key after Escape still drives the list.
    await dialog.getByTestId('import-review-grid').focus();
    await page.keyboard.press('p');
    await expect(dialog.getByTestId('import-review-editor')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog.getByTestId('import-review-editor')).not.toBeVisible();
    await expect(dialog.getByTestId('import-review-grid')).toBeFocused();

    // Ctrl+S is global too. The Import button is focused after the Tab
    // walk; applying must not depend on where the focus happens to be.
    await importButton.focus();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(3);
  });

  test('1, 2 and 3 select the trust level directly', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Trust Keys',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const paranoid = dialog.getByTestId('import-review-trust-paranoid');
    const cautious = dialog.getByTestId('import-review-trust-cautious');
    const trusted = dialog.getByTestId('import-review-trust-trusted');
    await expect(cautious).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');

    await page.keyboard.press('3');
    await expect(trusted).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'warn');

    await page.keyboard.press('1');
    await expect(paranoid).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('2');
    await expect(cautious).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');

    // The chips do what the keys do: a mouse user is choosing the same
    // control, not a different one.
    await trusted.click();
    await expect(trusted).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'warn');

    // A key pressed while a CONTROL has the focus hands the keyboard
    // back to the grid. Otherwise the focus stays on the chip and the
    // row keys — which a focused control swallows — stay swallowed.
    await paranoid.focus();
    await page.keyboard.press('3');
    await expect(dialog.getByTestId('import-review-grid')).toBeFocused();
    await page.keyboard.press('a');
    await expect(rows.first()).toHaveAttribute('data-decision', 'accept');
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

  /**
   * Hand a file to the import button.
   *
   * The chooser dance is the same for every file, so it lives here: a
   * change to the button's name is edited in one place.
   */
  async function chooseFile(file: string) {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await accountPage.page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(file);
  }

  async function importOfx() {
    await chooseFile(join(__dirname, 'data/demo-import.ofx'));
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

  /**
   * Import the fixture with two rows that share a vendor string.
   *
   * The two rows have different FITIDs, so neither is a duplicate — but
   * they carry the SAME vendor string, so a rule made for one of them
   * applies to the other.
   */
  async function importSameVendorOfx() {
    const fileChooserPromise = page.waitForEvent('filechooser');
    await accountPage.page.getByRole('button', { name: 'Import' }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(
      join(__dirname, 'data/demo-import-same-vendor.ofx'),
    );
  }

  /**
   * Import a file with `count` rows.
   *
   * The review squashed its rows into an unreadable smear once there were
   * more than a screenful of them, so the tests need a file big enough to
   * trigger it. The rows are generated rather than committed: sixty copies
   * of the same transaction would be sixty lines of noise in the
   * repository, and the point of the test is the COUNT, not the content.
   */
  async function importOfxWithRows(count: number) {
    const transactions = Array.from({ length: count }, (_, index) => {
      const n = String(index + 1).padStart(4, '0');
      const day = String((index % 28) + 1).padStart(2, '0');
      return `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>202609${day}000000
<TRNAMT>-${index + 1}.00
<FITID>BULKFITID${n}
<NAME>Vendor ${n}
</STMTTRN>`;
    }).join('\n');

    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260907120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>DEMOBANK
<ACCTID>DEMO-CHECKING-001
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901000000
<DTEND>20260930000000
${transactions}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>0.00
<DTSERVER>20260930000000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

    // The file goes in the test's own output directory, which Playwright
    // creates and cleans up. A temp directory of our own would be left
    // behind on every run.
    const file = test.info().outputPath('bulk.ofx');
    writeFileSync(file, ofx);

    await chooseFile(file);
  }

  /**
   * Import a one-row OFX with a chosen NAME. Used by the transfer tests:
   * detection is driven entirely by the vendor string the bank supplied.
   */
  async function importOfxWithPayee(name: string, fitid = 'TRANSFERFITID1') {
    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260907120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>DEMOBANK
<ACCTID>DEMO-CHECKING-001
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260901000000
<DTEND>20260930000000
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260907000000
<TRNAMT>-25.00
<FITID>${fitid}
<NAME>${name}
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>0.00
<DTSERVER>20260930000000
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
    const file = test.info().outputPath('transfer.ofx');
    writeFileSync(file, ofx);
    await chooseFile(file);
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog).toBeVisible();
    // The review's own header, not Actual's import modal.
    await expect(dialog.getByText('Review import')).toBeVisible();
    // The heading says where the rows are going: the account the review
    // was opened for. It is the only place the destination is shown.
    const destination = dialog.getByTestId('import-review-destination');
    await expect(destination).toContainText('Keyboard Review');

    // The caption is the table's frost band, not the white column header
    // beneath it: the mockup gives it the row-header token so the caption
    // reads as a caption. It also opens with the bank glyph.
    const [captionBg, headerBg] = await Promise.all([
      destination.evaluate(
        element => getComputedStyle(element).backgroundColor,
      ),
      dialog
        .getByTestId('import-review-header')
        .evaluate(element => getComputedStyle(element).backgroundColor),
    ]);
    expect(captionBg).not.toBe(headerBg);
    await expect(destination.locator('svg')).toHaveCount(1);
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

    const dialog = page.getByTestId('import-review-shell');
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
    let dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(3);

    // The second import is the SAME file. Actual's import UPDATE path keeps
    // the existing payee and category and throws the user's edit away, so
    // the review has to recognise the transactions that are already in the
    // budget and update them in place.
    await importOfx();
    dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user gives the first row a DIFFERENT payee.
    //
    // This is the case the import cannot handle on its own: Actual's
    // import UPDATE path computes `payee: existing.payee || trans.payee`,
    // so the payee the transaction already has WINS and the user's choice
    // is thrown away. The review has to update the transaction in place.
    await page.keyboard.press('p');
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
    await expect(page.getByTestId('import-review-shell')).toHaveCount(0);

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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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
    await expect(page.getByTestId('import-review-shell')).toHaveCount(0);

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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The first row is focused to begin with.
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'false');

    // `j` moves down.
    await page.keyboard.press('j');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

  test('the hint strip keeps quiet while a pane is open', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toBeVisible();

    // A row is held back — the second one has no payee name at all — but
    // the strip stays the same: the override is on the Actions button.
    await expect(
      dialog.getByTestId('import-review-row').nth(1),
    ).toHaveAttribute('data-gate', 'block');
    await expect(hints).toContainText('j/k move');
    await expect(hints).toContainText('? help');

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

  test('the hint strip stays on one line', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Keys',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    // Row commands are on their own buttons; the strip only names the
    // keys that are not on a button.
    await expect(hints).not.toContainText('Shift+E rules');
    await expect(hints).toContainText('j/k move');
    await expect(hints).toContainText('? help');

    // A hint that wraps onto a second line is a hint that is read less.
    // The comparison is between the text's measured height and its own
    // line height, so it holds at any zoom.
    const hintText = hints.getByTestId('import-review-hint-text');
    await expect(hintText).toBeVisible();
    const box = await hintText.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight:
          parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
      };
    });
    expect(box.height).toBeLessThan(box.lineHeight * 1.6);
  });

  test('the hint strip stays the same for a SKIPPED row', async () => {
    // A duplicate FITID is SKIPPED at the cautious trust level, not
    // blocked. It is still held back, but the strip does not change with
    // the rows: the override lives on the Actions button.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip Skipped',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importDuplicateOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The second row repeats the first one's FITID: skipped, and held.
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'skip');

    // And nothing is BLOCKED — which is exactly the case a blocked
    // counter in the strip would have missed. Read the rows' gates.
    const gates = await rows.evaluateAll(elements =>
      elements.map(element => element.getAttribute('data-gate')),
    );
    expect(gates).not.toContain('block');

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toContainText('j/k move');
    await expect(hints).toContainText('? help');
  });

  test('the hint strip stays the same whatever the rows are doing', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Hint Strip Clean',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toBeVisible();

    // The strip says the two keys that have no button. Row commands are
    // on the buttons themselves, so they are not repeated here.
    await expect(hints).not.toContainText('accept anyway');
    await expect(hints).not.toContainText('a accept');
    await expect(hints).toContainText('j/k move');
    await expect(hints).toContainText('? help');
  });

  test('picking a payee does NOT create a rule', async () => {
    // THE FLAGSHIP TEST of the rules-as-vendor-map architecture.
    //
    // The rules architecture INVERTS the vendor map's behaviour. The map
    // learned wholesale: pick a payee once and every future import of
    // that vendor was resolved with it. The rules architecture does not:
    // a rule is created ONLY when the user asks for one.
    //
    // So this asserts the inversion, and it asserts it against the whole
    // budget rather than against one account: no rule is created, and
    // the review does not remember the choice.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Learns Nothing',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user picks a payee for the first row.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('Demo Edited Vendor');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveText(/Demo Edited Vendor/);

    // The import goes through.
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // THE ASSERTION: no rule mentions this vendor. Choosing a payee
    // changed this transaction and nothing else.
    //
    // The demo budget has rules of its own — four of them, linked to
    // schedules — so a count is not the assertion. The vendor string is:
    // no rule says anything about it.
    const rulesPage = await navigation.goToRulesPage();
    // The rules page HAS rendered: the demo budget has rules of its
    // own. Without this anchor the assertion below would pass
    // vacuously on a page that had not loaded yet.
    await expect(
      rulesPage.page.getByTestId('conditions').first(),
    ).toBeVisible();
    await expect(rulesPage.page.getByText('POS PURCHASE 4251')).toHaveCount(0);
  });

  test('creating a rule writes it to the budget', async () => {
    // The rules architecture's ONE creating path. Nothing learns on its
    // own — the test above proves that — so this is the only way a rule
    // comes into being, and the user has to ask for it.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Creates A Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user picks a payee for the first row. "Kroger" is a payee the
    // demo budget already has, so the rule can name it by id.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    const input = editor.getByTestId('import-review-editor-input');
    await input.fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // The details pane offers to make it a rule, and says what a rule
    // does BEFORE the user asks for one.
    await expect(dialog.getByTestId('import-review-rules-note')).toContainText(
      'applies to every transaction',
    );
    const ruleButton = dialog.getByTestId('import-review-rule-vendor-to-payee');
    await expect(ruleButton).toBeVisible();
    // It is a click-only action. `Shift+E` opens the rules PICKER; it does
    // not write this rule, so the button must not advertise that key.
    await expect(ruleButton.locator('[data-testid="key-cap"]')).toHaveCount(0);
    await ruleButton.click();

    // The notice says what was created.
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    // The review is closed without importing: the rule is about the
    // future, and the import is a separate question.
    await page.keyboard.press('Escape');
    await dialog.getByTestId('import-review-confirm-discard').click();
    await expect(dialog).not.toBeVisible();

    // THE ASSERTION: the rule is in the budget.
    const rulesPage = await navigation.goToRulesPage();
    // The rule is in the budget: it says what the vendor is, and what
    // the vendor becomes.
    //
    // The demo budget already has rules of its own — four of them,
    // linked to schedules — so a count is not the assertion. The
    // CONDITION is: exactly one rule says this.
    await expect(
      rulesPage.page.getByText('imported payee is POS PURCHASE 4251'),
    ).toHaveCount(1);
    await expect(rulesPage.page.getByText('set payee to Kroger')).toBeVisible();
  });

  test('a rule for a payee the budget does not have names it', async () => {
    // The user types a payee the budget does not have yet. There is no
    // id for it, so the rule NAMES it: upstream creates the payee the
    // first time the rule fires.
    //
    // The name is NOT trimmed: the payload builder sends the name the
    // user typed as it is, so the rule must name exactly that, or the
    // rule would name a payee the import does not make.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Creates A Named Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor
      .getByTestId('import-review-editor-input')
      .fill('Demo New Payee');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    await dialog.getByTestId('import-review-rule-vendor-to-payee').click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    await page.keyboard.press('Escape');
    await dialog.getByTestId('import-review-confirm-discard').click();
    await expect(dialog).not.toBeVisible();

    const rulesPage = await navigation.goToRulesPage();
    await expect(
      rulesPage.page.getByText('imported payee is POS PURCHASE 4251'),
    ).toHaveCount(1);
    await expect(
      rulesPage.page.getByText('set payee (name) to Demo New Payee'),
    ).toBeVisible();
  });

  test('creating a category rule writes it to the budget', async () => {
    // The other rule the review can write: this payee is always this
    // category. Its condition is on the PAYEE, not on the vendor
    // string, so it applies however the file spelled the vendor.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Creates A Category Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user picks a payee for the first row.
    await page.keyboard.press('p');
    let editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // And a category for it.
    await page.keyboard.press('c');
    editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toHaveAttribute('data-field', 'category');
    await editor.getByTestId('import-review-editor-input').fill('Food');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // The details pane offers the category rule.
    const ruleButton = dialog.getByTestId(
      'import-review-rule-payee-to-category',
    );
    await expect(ruleButton).toBeVisible();
    // Like the vendor button, this writes the rule on click. Its old
    // `Shift+E` keycap advertised the picker instead, so it is gone.
    await expect(ruleButton.locator('[data-testid="key-cap"]')).toHaveCount(0);
    await ruleButton.click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    await page.keyboard.press('Escape');
    await dialog.getByTestId('import-review-confirm-discard').click();
    await expect(dialog).not.toBeVisible();

    const rulesPage = await navigation.goToRulesPage();
    // The condition is on the PAYEE.
    await expect(rulesPage.page.getByText('payee is Kroger')).toHaveCount(1);
    await expect(
      rulesPage.page.getByText('set category to Food'),
    ).toBeVisible();
  });

  test('a rule the review wrote LOCKS the field it controls', async () => {
    // The rule lock, end to end.
    //
    // A rule's `set` is unconditional on the import path, so a rule that
    // sets a row's category discards whatever the user chose. The review
    // therefore has to say that the field is not the user's to change —
    // and refuse the edit, rather than accept it and drop it later
    // without a word.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Locks A Ruled Field',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user picks a payee for the first row.
    await page.keyboard.press('p');
    let editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // And a category for it.
    await page.keyboard.press('c');
    editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Food');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // The details pane offers the category rule.
    const ruleButton = dialog.getByTestId(
      'import-review-rule-payee-to-category',
    );
    await expect(ruleButton).toBeVisible();
    // Like the vendor button, this writes the rule on click. Its old
    // `Shift+E` keycap advertised the picker instead, so it is gone.
    await expect(ruleButton.locator('[data-testid="key-cap"]')).toHaveCount(0);
    await ruleButton.click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    // THE ASSERTION, in three parts.
    //
    // ONE: the row says WHICH field the rule controls.
    //
    // The provenance is on the FIELD, not on the row: the cell's own tag
    // glyph and the ruled field say it, and a row-level badge was the
    // weaker signal for the same fact.
    const firstRow = rows.first();
    await expect(
      firstRow.getByTestId('import-review-row-category'),
    ).toHaveAttribute('data-ruled', 'true');

    // And it is THIS row and not the others: the rule's condition is on
    // the payee, and only the first row has one. A mark on every row
    // would say the mark means nothing.
    await expect(
      rows.nth(1).getByTestId('import-review-row-category'),
    ).not.toHaveAttribute('data-ruled', 'true');

    // TWO: the details panel says WHICH field, and what the rule sets it
    // to. The value matters as much as the field: the user has to see
    // what the rule will do.
    await expect(
      dialog.getByTestId('import-review-ruled-field').first(),
    ).toContainText('category');
    await expect(
      dialog.getByTestId('import-review-ruled-field').first(),
    ).toContainText('Food');

    // THREE: the editor refuses an edit to the locked field, and says
    // why. The refusal is the point: the edit is not accepted and
    // dropped later.
    await page.keyboard.press('c');
    editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toBeVisible();
    // The editor says so BEFORE the user types: the value is not theirs.
    await expect(
      editor.getByTestId('import-review-editor-locked'),
    ).toContainText('A rule sets this');
    // A category the demo budget HAS, so the picker has something to
    // pick: a name it does not have would be refused by the picker, and
    // the review would never hear about the edit at all.
    await editor.getByTestId('import-review-editor-input').fill('Restaurants');
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'set by a rule',
    );
    // The editor is still open: the edit was refused, not applied.
    await expect(editor).toBeVisible();
  });

  test('a ruled field is a read-only field, in a colour you can read', async () => {
    // The ruled cell used to be a DIMMED value with a purple underline.
    //
    // Dimming it failed WCAG AA on the real background in every theme
    // (2.05:1 in the light theme, and 2.02:1 on the focused row in the
    // dark one), and a value the user has to read keeps its contrast: the
    // AFFORDANCE is removed, not the information.
    //
    // The cell is now the app's own read-only field, with the value in
    // the rule lock's colour.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Ruled Cell',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The user picks a payee for the first row, and a category for it.
    await page.keyboard.press('p');
    let editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    await page.keyboard.press('c');
    editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Food');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // And a rule, so the category is the rule's.
    await dialog.getByTestId('import-review-rule-payee-to-category').click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    // ONE: the cell is a field, not a dimmed string. The rule's value is
    // in it, and the tag glyph says a rule owns it.
    const cell = rows.first().getByTestId('import-review-row-category');
    await expect(cell).toHaveAttribute('data-ruled', 'true');
    await expect(cell).toContainText('Food');

    // TWO: the value's colour clears AA against the field it sits in.
    //
    // The ratio is computed from the RUNTIME colours, so it holds in
    // every theme and whatever the theme's tokens are. The old treatment
    // was 2.05:1 in the light theme, so this is the assertion that would
    // have caught it.
    const colours = await cell.evaluate(element => {
      const field = element.querySelector('[data-ruled-field="true"]');
      const text = field.querySelector('span');
      // The token itself, resolved in the theme the app is running: a
      // probe that wears the token, so the browser does the resolving.
      const probe = document.createElement('span');
      document.body.appendChild(probe);
      probe.style.color = 'var(--color-ruleLockText)';
      const token = getComputedStyle(probe).color;
      probe.style.color = 'var(--color-pageTextSubdued)';
      const dimmed = getComputedStyle(probe).color;
      probe.remove();
      return {
        color: getComputedStyle(text).color,
        background: getComputedStyle(field).backgroundColor,
        token,
        dimmed,
      };
    });
    expect(
      contrastRatio(colours.color, colours.background),
    ).toBeGreaterThanOrEqual(4.5);

    // And the value wears the rule lock's OWN colour, not the dimmed
    // ink the rest of the review uses for labels. The dimmed ink is the
    // treatment that failed AA, so this says the same thing in the
    // review's own words — and in whatever theme the app is running.
    //
    // The second assertion is for the failure message: it names the
    // treatment that is wrong, not just the token that is missing.
    expect(colours.color).toBe(colours.token);
    expect(colours.color).not.toBe(colours.dimmed);

    // THREE: the field hugs its text. It does not stretch the row, and it
    // does not spill into the next column.
    const geometry = await rows.first().evaluate(row => {
      const ruled = row.querySelector(
        '[data-testid="import-review-row-category"]',
      );
      const field = ruled.querySelector('[data-ruled-field="true"]');
      const sibling = row.querySelector(
        '[data-testid="import-review-row-payee"]',
      );
      const range = document.createRange();
      range.selectNodeContents(field.querySelector('span'));
      return {
        cell: ruled.getBoundingClientRect().height,
        sibling: sibling.getBoundingClientRect().height,
        field: field.getBoundingClientRect().height,
        text: range.getBoundingClientRect().height,
        fieldWidth: field.getBoundingClientRect().width,
        cellWidth: ruled.getBoundingClientRect().width,
      };
    });
    // The ruled cell is the same height as its sibling: the field does
    // not make the row grow, and it does not collapse it either.
    expect(geometry.cell).toBe(geometry.sibling);
    // The field holds its text…
    expect(geometry.field).toBeGreaterThanOrEqual(geometry.text);
    // …and stays inside the cell.
    expect(geometry.field).toBeLessThanOrEqual(geometry.cell);
    expect(geometry.fieldWidth).toBeLessThanOrEqual(geometry.cellWidth);
  });

  test('a rule created in the review applies to a later import', async () => {
    // THE POINT OF THE WHOLE FEATURE.
    //
    // The review does NOT evaluate rules — upstream's engine already
    // runs during the import — so the review's own resolution of the
    // vendor is a guess, and the rule is what settles it. This proves
    // the rule the review wrote actually fires.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Rule Applies',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The strictest trust level: a vendor the budget does not know is
    // held back, so what settles the row is the rule the review writes.
    //
    // (This used to be two presses of the cycle key, which walked
    // cautious -> trusted -> paranoid.)
    await page.keyboard.press('1');

    // The user picks a payee for the first row, whose vendor string is
    // "POS PURCHASE 4251" — something the budget has no payee for.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // And a rule, so the next import of this vendor is settled the
    // same way.
    await dialog.getByTestId('import-review-rule-vendor-to-payee').click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    // The review is put aside: the rule is about the future.
    await page.keyboard.press('Escape');
    await dialog.getByTestId('import-review-confirm-discard').click();
    await expect(dialog).not.toBeVisible();

    // The SAME file, imported again. The review knows no more than it
    // did before — it does not evaluate rules — so the row is resolved
    // by its guess.
    await importOfx();
    await expect(dialog.getByText('Review import')).toBeVisible();
    await page.keyboard.press('1');

    // The import goes through.
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // THE ASSERTION: the row landed under the payee the RULE says, not
    // under the name the review guessed.
    await expect(accountPage.transactionTableRow).toHaveCount(3);
    await expect(
      accountPage.transactionTableRow.filter({ hasText: 'Kroger' }),
    ).toHaveCount(1);
  });

  test('a rule with the same conditions is amended, not added beside', async () => {
    // Two rules with the same conditions are a tie, and upstream breaks
    // the tie on the rule id — a random UUID. So the winner would be
    // decided at random, and the review could not say which rule
    // applied. A rule with the same conditions therefore AMENDS the one
    // that is there.
    //
    // The budget already has a rule for this vendor, and it sets the
    // CATEGORY. The review's rule sets the PAYEE, and the conditions are
    // the same, so the amendment keeps the category action and adds the
    // payee one.
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Amends A Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The rule the budget already has. It says the same thing about the
    // vendor as the rule the review is about to write.
    //
    // It is made BEFORE the import: the rule is in the budget when the
    // preview runs, which is when the engine applies it.
    const rulesPage = await navigation.goToRulesPage();
    const editRuleModal = await rulesPage.createNewRule();
    await editRuleModal.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'Demo Grocery Store' },
      ],
      actions: [{ field: 'category', value: 'Food' }],
    });
    await editRuleModal.save();

    // Back to the account the rows are imported into.
    await navigation.goToAccountPage('Keyboard Review Amends A Rule');

    await enableKeyboardReview();
    await importSameVendorOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The rule owns the category, so the category cell is ruled. The
    // provenance is on the FIELD, not on the row.
    await expect(
      rows.first().getByTestId('import-review-row-category'),
    ).toHaveAttribute('data-ruled', 'true');

    // The payee is NOT owned by the rule, so the user picks one.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // And the rule the review writes has the SAME conditions as the one
    // the budget has, so it amends it.
    const ruleButton = dialog.getByTestId('import-review-rule-vendor-to-payee');
    await expect(ruleButton).toBeVisible();
    await ruleButton.click();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );

    await page.keyboard.press('Escape');
    await dialog.getByTestId('import-review-confirm-discard').click();
    await expect(dialog).not.toBeVisible();

    const after = await navigation.goToRulesPage();
    // ONE rule, not two.
    await expect(
      after.page.getByText('imported payee is Demo Grocery Store'),
    ).toHaveCount(1);
    // And it says BOTH things: the action the budget's rule had is kept,
    // and the one the review wrote is on it. Two rules with the same
    // conditions would be a tie decided at random.
    await expect(after.page.getByText('set category to Food')).toBeVisible();
    await expect(after.page.getByText('set payee to Kroger')).toBeVisible();
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // `a` accepts the row, but the trust level still holds it back.
    await page.keyboard.press('j');
    await page.keyboard.press('a');
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');
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

    const dialog = page.getByTestId('import-review-shell');
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
    // The summary no longer counts overrides, so the row's badge is the
    // only place that says what happened to it.
    await expect(
      rows.nth(1).getByTestId('import-review-row-status'),
    ).toContainText('Overridden');

    // The overridden row lands. The duplicate is still skipped.
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(2);
  });

  test('p edits the payee, and the fix releases the row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Edit Payee',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The second row has no payee at all, so the trust level holds it
    // back.
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'true');

    await page.keyboard.press('j');
    await page.keyboard.press('p');

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

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(accountPage.transactionTableRow).toHaveCount(2);
  });

  test('e walks the row field by field, and the last one moves on', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const editor = dialog.getByTestId('import-review-editor');
    await expect(editor).toHaveCount(0);

    // `e` opens the CHAIN, and the chain starts at the payee.
    await page.keyboard.press('e');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    // Committing a field does not close the editor: it moves on to the
    // next one. That is the whole point of the chain.
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'category');

    // And the next field is a FRESH one: it starts empty, and it does
    // not inherit the payee field's suggestion list or its refusal.
    await expect(editor.getByTestId('import-review-editor-input')).toHaveValue(
      '',
    );

    await editor.getByTestId('import-review-editor-input').fill('Food');
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'memo');

    // The LAST field's commit closes the editor AND moves the cursor on:
    // the row is finished, and the next one is the user's next business.
    await editor.getByTestId('import-review-editor-input').fill('a note');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');

    // Finishing the chain also accepts the row, the same way `a` does.
    // (The cursor is already on row 1, so check the row we just left.)
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    // And the edits are in the row: the notes the user typed. The list
    // has no notes column, so the detail section is where they show —
    // and the cursor has moved on, so the detail is showing the NEXT
    // row until the user goes back.
    // The Notes field is always in the Evidence zone — the mockup shows a
    // dash when there are none — so "no notes" reads as a dash, not an
    // absent row that would make the whole zone shift.
    await expect(dialog.getByTestId('import-review-notes')).toContainText('—');
    await page.keyboard.press('k');
    await expect(dialog.getByTestId('import-review-notes')).toContainText(
      'a note',
    );
  });

  test('undo after the chain puts the cursor back on the accepted row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Undo',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);
    const editor = dialog.getByTestId('import-review-editor');

    await page.keyboard.press('e');
    for (const [field, value] of [
      ['payee', 'Kroger'],
      ['category', 'Food'],
      ['memo', 'a note'],
    ] as const) {
      await expect(editor).toHaveAttribute('data-field', field);
      await editor.getByTestId('import-review-editor-input').fill(value);
      await page.keyboard.press('Enter');
    }
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');

    // `decide` captured the cursor BEFORE `moveFocus`, so one undo takes
    // back the accept AND returns to the row that was accepted — not the
    // one the chain left the cursor on. The edits survive that undo, so
    // the notes are still there.
    await page.keyboard.press('u');
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');
    await expect(dialog.getByTestId('import-review-notes')).toContainText(
      'a note',
    );
  });

  test('finishing the chain on a dropped row accepts it, like a', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Drop',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);
    const editor = dialog.getByTestId('import-review-editor');

    await page.keyboard.press('r');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'drop');
    // Dropping advances the cursor; go back to the row we just dropped.
    await page.keyboard.press('k');
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');

    // Fixing a dropped row is a reason to keep it: the terminal commit
    // accepts it, exactly as pressing `a` on a dropped row does.
    await page.keyboard.press('e');
    for (const [field, value] of [
      ['payee', 'Kroger'],
      ['category', 'Food'],
      ['memo', 'a note'],
    ] as const) {
      await expect(editor).toHaveAttribute('data-field', field);
      await editor.getByTestId('import-review-editor-input').fill(value);
      await page.keyboard.press('Enter');
    }
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test('p opens the payee alone, and its commit leaves the cursor', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Payee Only',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const editor = dialog.getByTestId('import-review-editor');

    // `p` is the payee ALONE: it opens the payee and nothing else.
    await page.keyboard.press('p');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // The cursor stayed: a single-field editor does not move on.
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
  });

  test('the chain skips the category on a split row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Split',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The row is split first: a split's legs carry their own categories,
    // so the parent has none to set.
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
    await expect(rows.nth(0)).toContainText('Split (2)');

    const editor = dialog.getByTestId('import-review-editor');
    await page.keyboard.press('e');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    // The category is skipped: the notes come next.
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'memo');
  });

  test('the chain follows the row: a transfer that gets a payee needs a category', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Transfer',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The row becomes a transfer first: a transfer has no category of
    // its own.
    await page.keyboard.press('t');
    const transfer = dialog.getByTestId('import-review-transfer');
    await expect(transfer).toBeVisible();
    const target = transfer.getByTestId('import-review-transfer-target');
    await target.click();
    await target.pressSequentially('Ally Savings');
    await page.keyboard.press('Enter');
    await transfer.getByTestId('import-review-transfer-save').click();
    await expect(transfer).not.toBeVisible();

    const editor = dialog.getByTestId('import-review-editor');
    await page.keyboard.press('e');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'payee');

    // Giving the row a payee takes the transfer away — the review says
    // so — and an ordinary transaction needs a category. The chain
    // follows the row, so the category comes next.
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('data-field', 'category');
  });

  test('the chain starts past a payee a rule owns', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Ruled',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The budget has a rule for this vendor, made BEFORE the import: the
    // rule owns the row's payee, so the chain cannot start there.
    const rulesPage = await navigation.goToRulesPage();
    const editRuleModal = await rulesPage.createNewRule();
    await editRuleModal.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'POS PURCHASE 4251' },
      ],
      actions: [{ field: 'payee', value: 'Demo Grocery Store' }],
    });
    await editRuleModal.save();
    await navigation.goToAccountPage('Keyboard Review Chain Ruled');

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const editor = dialog.getByTestId('import-review-editor');
    await page.keyboard.press('e');
    await expect(editor).toBeVisible();

    // The payee is the rule's, so the chain starts at the category.
    await expect(editor).toHaveAttribute('data-field', 'category');
  });

  test('escape in the middle of the chain keeps what was committed', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Chain Escape',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const editor = dialog.getByTestId('import-review-editor');
    await page.keyboard.press('e');
    await expect(editor).toHaveAttribute('data-field', 'payee');

    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveAttribute('data-field', 'category');

    // Escape ends the chain. The field that was committed stays.
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();
    await expect(rows.nth(0)).toContainText('Kroger');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

  test('the detail carries the category group, and the cells do not wrap', async () => {
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The row has no category yet, so the group is not known.
    await expect(
      dialog.getByTestId('import-review-category-group'),
    ).toHaveCount(0);

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

    // The row now carries the category, and the DETAIL carries the group
    // it belongs to, so two categories with the same name are
    // distinguishable. The group is evidence, not a thing to scan: it
    // belongs to the row the user is on, and the list has five columns
    // and no room for a sixth.
    await expect(rows.nth(0)).toHaveText(/Deliberately Very Long/);
    await expect(
      dialog.getByTestId('import-review-category-group'),
    ).toContainText('Long Names');

    // And the cell does not WRAP: it truncates on one line, so the row
    // stays the height of a single line. The computed style is the
    // assertion — a height comparison cannot tell the difference,
    // because a wrapped cell grows the row too.
    //
    // The cell is the COLUMN, and the text is inside it: the column owns
    // the width, and the text does the truncating.
    const cell = rows.nth(0).getByTestId('import-review-row-category');
    await expect(cell).toContainText('Deliberately Very Long');
    const text = cell.locator('span');
    const whiteSpace = await text.evaluate(
      element => getComputedStyle(element).whiteSpace,
    );
    expect(whiteSpace).toBe('nowrap');

    // The text is wider than the cell, so it really is truncating.
    const overflows = await text.evaluate(
      element => element.scrollWidth > element.clientWidth,
    );
    expect(overflows).toBe(true);

    // And it truncates with an ellipsis, not a hard cut.
    const textOverflow = await text.evaluate(
      element => getComputedStyle(element).textOverflow,
    );
    expect(textOverflow).toBe('ellipsis');
  });

  test('the status column says what the gate is doing with the row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Status',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The status column carries an ICON and a WORD. The icon is the state
    // at a glance — a shape the user can see without reading — and the
    // word says it exactly.
    const blocked = rows.nth(1).getByTestId('import-review-row-status');
    await expect(blocked).toContainText('Blocked');
    await expect(blocked.locator('svg')).toHaveCount(1);

    // The skipped row says so too, with its own icon: a pause, not the
    // cross the blocked row wears.
    const skipped = rows.nth(2).getByTestId('import-review-row-status');
    await expect(skipped).toContainText('Skipped');
    await expect(skipped.locator('svg')).toHaveCount(1);

    // And the GATE's word comes first: a row the user accepted and the
    // trust level flagged is still flagged, because the flag is the
    // safety fact and the decision is the user's.
    await page.keyboard.press('a');
    await expect(
      rows.nth(0).getByTestId('import-review-row-status'),
    ).toContainText('Flagged');
  });

  test("the user's own decision is a state the status column carries", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Status Decision',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The gate has nothing to say about this row once its payee is
    // settled — the user picks one the budget already has, so the row is
    // no longer an unknown payee the import would create.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // Until the user decides, the row the gate has nothing to say about
    // carries NO badge and NO icon: the column is empty, not empty with
    // a picture in it.
    const quiet = rows.nth(0).getByTestId('import-review-row-status');
    await expect(quiet).toBeEmpty();
    await expect(quiet.locator('svg')).toHaveCount(0);

    // So the badge is the user's decision.
    await page.keyboard.press('a');
    const accepted = rows.nth(0).getByTestId('import-review-row-status');
    await expect(accepted).toContainText('Accepted');
    await expect(accepted.locator('svg')).toHaveCount(1);

    // And a dropped row says so — and is struck through, so the word says
    // it and the strike says it without needing a colour to say it with.
    await page.keyboard.press('j');
    await page.keyboard.press('r');
    const dropped = rows.nth(2).getByTestId('import-review-row-status');
    await expect(dropped).toContainText('Dropped');
    await expect(dropped.getByText('Dropped')).toHaveCSS(
      'text-decoration-line',
      'line-through',
    );
  });

  test('the payee cell says when the payee is not settled', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Payee States',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The first row's vendor is "POS PURCHASE 4251" — something the
    // budget has no payee for. There is no payee BEHIND the cell, so the
    // cell shows the file's own string, and it is MUTED: in normal ink it
    // looks like a fact, and it is not one.
    const unresolved = rows
      .nth(0)
      .getByTestId('import-review-row-payee')
      .getByText('POS PURCHASE 4251');
    await expect(unresolved).toBeVisible();
    await expect(unresolved).toHaveCSS('font-style', 'italic');

    // The user picks a payee the budget HAS. Now it is settled, and it
    // says so in the normal ink.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    const settled = rows
      .nth(0)
      .getByTestId('import-review-row-payee')
      .getByText('Kroger');
    await expect(settled).toBeVisible();
    await expect(settled).not.toHaveCSS('font-style', 'italic');

    // And the settled payee is a DIFFERENT colour from the unresolved one
    // on the row below it — measured at runtime, so it holds whatever the
    // theme's tokens are.
    const payeeColour = async (index: number, text: string) =>
      rows
        .nth(index)
        .getByTestId('import-review-row-payee')
        .getByText(text)
        .evaluate(element => getComputedStyle(element).color);
    expect(await payeeColour(0, 'Kroger')).not.toBe(
      await payeeColour(1, 'Demo Grocery Store'),
    );
  });

  test('the footer carries the bulk actions, and their keys', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Footer',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The bulk actions used to exist only as keys. They are BUTTONS now,
    // and each one says the key that does it — a button that says what
    // it does, with the key that does it, is the difference between a
    // feature and a secret.
    const acceptAll = dialog.getByTestId('import-review-accept-all');
    await expect(acceptAll).toContainText('Accept all');
    await expect(acceptAll).toContainText('Shift+A');
    const dropAll = dialog.getByTestId('import-review-drop-all');
    await expect(dropAll).toContainText('Drop all');
    await expect(dropAll).toContainText('Shift+R');

    // And they do what they say.
    await acceptAll.click();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'accept');

    // And one undo takes the whole bulk action back.
    await dialog.getByTestId('import-review-undo').click();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'pending');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'pending');
  });

  test("the detail section has its zones, and the row's own actions", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Detail',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // The detail section has ZONES: the facts, the reason, the
    // ownership and the actions.
    await expect(dialog.getByTestId('import-review-transaction')).toBeVisible();
    await expect(dialog.getByTestId('import-review-verdict')).toBeVisible();

    // The mockup's Evidence zone is six fields, each name in a fixed-width
    // column. A `Label: value` line has no column at all, so the test reads
    // the six labels' widths and requires them to be EQUAL — a comparison
    // between measured elements, not an assertion about a pixel.
    const transaction = dialog.getByTestId('import-review-transaction');
    const fieldIds = [
      'import-review-vendor',
      'import-review-date',
      'import-review-amount',
      'import-review-payee',
      'import-review-category',
      'import-review-notes',
    ];
    const labelWidths: number[] = [];
    for (const id of fieldIds) {
      const field = transaction.getByTestId(id);
      await expect(field).toBeVisible();
      const label = transaction.getByTestId(`${id}-label`);
      await expect(label).toBeVisible();
      labelWidths.push(
        await label.evaluate(node => node.getBoundingClientRect().width),
      );
    }
    expect(new Set(labelWidths).size).toBe(1);
    expect(labelWidths[0]).toBeGreaterThan(0);

    // A flex child of this column can collapse to nothing and let the
    // next line paint over it. Each field must sit BELOW the one before
    // it — a comparison of measured boxes, not a pixel assertion.
    const rowBoxes = await transaction.evaluate(
      (root, ids) =>
        ids.map(id => {
          const rect = root
            .querySelector(`[data-testid="${id}"]`)!
            .getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        }),
      fieldIds,
    );
    for (let index = 0; index < rowBoxes.length; index++) {
      // A collapsed field has top === bottom: it would pass the ordering
      // check while its children painted over the next row.
      expect(rowBoxes[index].bottom - rowBoxes[index].top).toBeGreaterThan(0);
      if (index > 0) {
        expect(rowBoxes[index].top).toBeGreaterThanOrEqual(
          rowBoxes[index - 1].bottom - 1,
        );
      }
    }

    // Both detail columns are real boxes. A column that has collapsed to
    // nothing would still be in the DOM, so measure each one rather than
    // trusting `toBeAttached`. A row with more to say scrolls inside its
    // column instead of growing the region.
    for (const id of ['import-review-zone-left', 'import-review-zone-right']) {
      const column = dialog.getByTestId(id);
      await expect(column).toBeAttached();
      const box = await column.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(100);
    }

    // The evidence zone carries what the LIST does not: the file's own
    // vendor string, in full.
    await expect(dialog.getByTestId('import-review-vendor')).toContainText(
      'POS PURCHASE 4251',
    );

    // The amount is the money format, and it says the same thing in
    // both places: the list's column can truncate it, so the detail
    // section carries it in full.
    await expect(dialog.getByTestId('import-review-amount')).toContainText(
      '-25.00',
    );
    await expect(
      rows.nth(0).getByTestId('import-review-row-amount'),
    ).toContainText('-25.00');

    // And the reason zone carries the machine code, as a small chip — it
    // is useful when something goes wrong and it is not a headline.
    await expect(dialog.getByTestId('import-review-flag-codes')).toContainText(
      'PAYEE-NEW-001',
    );

    // The ACTIONS are the row's own commands, each with the key that
    // does it.
    const actions = dialog.getByTestId('import-review-actions');
    await expect(actions.getByTestId('import-review-edit-row')).toContainText(
      'e',
    );
    await expect(actions.getByTestId('import-review-accept')).toContainText(
      'a',
    );
    await expect(actions.getByTestId('import-review-drop')).toContainText('r');
    await expect(
      actions.getByTestId('import-review-edit-transfer'),
    ).toContainText('t');

    // The mockup's actions are framed chips, not bare text. Read the
    // buttons' own computed borders and surfaces: a border that exists
    // and a surface that is not transparent, with no pixel asserted.
    const surfaces = await actions
      .locator('button[data-testid]')
      .evaluateAll(elements =>
        elements.map(element => {
          const style = getComputedStyle(element);
          return {
            borderWidth: parseFloat(style.borderTopWidth),
            background: style.backgroundColor,
          };
        }),
      );
    // This file has no held row, so the five always-present commands are
    // the whole set: the override is the only conditional one.
    expect(surfaces).toHaveLength(5);
    for (const button of surfaces) {
      expect(button.borderWidth).toBeGreaterThan(0);
      expect(button.background).not.toBe('rgba(0, 0, 0, 0)');
    }

    // And they do what they say.
    await actions.getByTestId('import-review-accept').click();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test("the row's actions offer the override only when the row is HELD", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Override Button',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importDuplicateOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The first row is clean: the gate has nothing to say about it, so
    // there is nothing to override. A second accept button here would be
    // a control that means nothing.
    const actions = dialog.getByTestId('import-review-actions');
    await expect(
      actions.getByTestId('import-review-accept-anyway'),
    ).toHaveCount(0);

    // The second row repeats the first one's FITID, so the trust level
    // SKIPS it: it is held back, and the override is what releases it.
    await page.keyboard.press('j');
    await expect(
      actions.getByTestId('import-review-accept-anyway'),
    ).toBeVisible();

    // And it is the same button the key drives.
    await expect(
      actions.getByTestId('import-review-accept-anyway'),
    ).toContainText('Ctrl+Shift+A');

    // A double-click on it overrides the row ONCE: the second press of a
    // pair is swallowed, so it cannot reach the row the cursor moved to.
    await actions.getByTestId('import-review-accept-anyway').dblclick();
    await expect(rows.nth(1)).toHaveAttribute(
      'data-decision',
      'accept-override',
    );
    // The override does not move the cursor — there is no "next row" for
    // it to move to.
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
  });

  test('the ownership zone says which field a rule owns', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Ownership',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The budget has a rule for this vendor, made BEFORE the import: the
    // rule is in the budget when the preview runs, which is when the
    // engine applies it.
    const rulesPage = await navigation.goToRulesPage();
    const editRuleModal = await rulesPage.createNewRule();
    await editRuleModal.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'Demo Grocery Store' },
      ],
      actions: [{ field: 'category', value: 'Food' }],
    });
    await editRuleModal.save();
    await navigation.goToAccountPage('Keyboard Review Ownership');

    await enableKeyboardReview();
    await importSameVendorOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The budget's rule owns the row's category, and the zone says so.
    const owned = dialog.getByTestId('import-review-rules-zone');
    await expect(owned).toBeVisible();

    // The label names the group and counts the rules that give it content.
    await expect(owned).toContainText('1 rule');

    // The field name sits in the SAME column the Transaction zone uses.
    // Compare the two measured widths rather than asserting a pixel.
    const nameWidth = await owned
      .getByTestId('import-review-ruled-field-name')
      .evaluate(node => node.getBoundingClientRect().width);
    const evidenceWidth = await dialog
      .getByTestId('import-review-vendor-label')
      .evaluate(node => node.getBoundingClientRect().width);
    expect(nameWidth).toBe(evidenceWidth);

    // It says WHICH field the rule owns, and quotes the rule itself: the
    // field is the rule's identity on this row, and the quoted match → set
    // pair says what the rule does.
    const field = owned.getByTestId('import-review-ruled-field');
    await expect(field).toHaveAttribute('data-field', 'category');
    await expect(field).toContainText('category');
    await expect(field).toContainText('rule "Demo Grocery Store → Food"');

    // The line reads "set by" before the quoted rule: the quote names a
    // rule, not a statement about the transaction.
    await expect(field).toContainText('set by');
  });

  test('the Rules zone caps its lines and hands the keyboard back', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Show More',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // Rules that own three fields of the imported row. The zone shows two
    // lines and hides the third behind a disclosure.
    const rulesPage = await navigation.goToRulesPage();
    for (const [field, value] of [
      ['category', 'Food'],
      ['notes', 'weekly shop'],
      ['payee', 'Kroger'],
    ]) {
      const editRuleModal = await rulesPage.createNewRule();
      await editRuleModal.fill({
        conditions: [
          { field: 'imported payee', op: 'is', value: 'Demo Grocery Store' },
        ],
        actions: [{ field, op: 'set', value }],
      });
      await editRuleModal.save();
    }
    await navigation.goToAccountPage('Keyboard Review Show More');

    await enableKeyboardReview();
    await importSameVendorOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rules = dialog.getByTestId('import-review-rules-zone');
    await expect(rules).toBeVisible();
    const lines = rules.getByTestId('import-review-ruled-field');
    await expect(lines).toHaveCount(2);

    const more = rules.getByTestId('import-review-rules-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toContainText('Show 1 more');
    await expect(
      rules.getByTestId('import-review-rules-more-detail'),
    ).toHaveCount(0);

    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(lines).toHaveCount(3);
    await expect(more).toContainText('Show less');

    // Clicking a disclosure must give `j`/`k` back to the grid: a keyboard
    // review that strands the cursor on a button is stuck.
    await page.keyboard.press('j');
    await expect(
      dialog.getByTestId('import-review-row').nth(1),
    ).toHaveAttribute('data-focused', 'true');
    // The same vendor string shares the rules, so the button is still here
    // on the next row — but the disclosure belongs to the row under the
    // cursor and has collapsed again.
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toContainText('Show 1 more');
    await expect(lines).toHaveCount(2);
    await expect(
      dialog.getByTestId('import-review-row').nth(0),
    ).not.toHaveAttribute('data-focused', 'true');
  });

  test('the reason is one line, and Why? discloses the trust outcomes', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Reason',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const reason = dialog.getByTestId('import-review-verdict');
    await expect(reason).toBeVisible();

    // The mockup leads with the outcome AT THE CURRENT LEVEL, then says
    // what the gate saw. The three-level breakdown is not on the default
    // surface.
    await expect(reason).toContainText('Flagged at Cautious');

    // The flag is part of the verdict, not decoration: the mockup leads
    // with it and it carries the same outcome colour as the words.
    const verdictLine = reason.getByTestId('import-review-verdict-line');
    const flag = verdictLine.locator('svg');
    await expect(flag).toHaveCount(1);
    const [flagInk, verdictInk, labelInk] = await Promise.all([
      flag.evaluate(element => getComputedStyle(element).color),
      verdictLine
        .getByText('Flagged at Cautious', { exact: true })
        .evaluate(element => getComputedStyle(element).color),
      reason
        .getByText('Review status', { exact: true })
        .evaluate(element => getComputedStyle(element).color),
    ]);
    expect(flagInk).toBe(verdictInk);
    // Not merely matching by inheritance: the flag must actually be
    // tinted by the outcome, not left at the zone's default ink.
    expect(flagInk).not.toBe(labelInk);

    const why = reason.getByTestId('import-review-why');
    await expect(why).toHaveAttribute(
      'aria-label',
      'Why is this flagged? Why?',
    );
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await expect(reason.getByTestId('import-review-why-detail')).toHaveCount(0);

    await why.click();
    await expect(why).toHaveAttribute('aria-expanded', 'true');
    const detail = reason.getByTestId('import-review-why-detail');
    await expect(detail).toHaveCount(1);
    // The disclosure must have HEIGHT, not merely be in the DOM. A `View`
    // inside this scrolling column can collapse to 0px and still hold its
    // text; the flexShrink fix is what keeps the three levels on screen.
    const detailBox = await detail.boundingBox();
    expect(detailBox?.height ?? 0).toBeGreaterThan(0);
    await expect(detail).toContainText('Paranoid');
    await expect(detail).toContainText('Cautious');
    await expect(detail).toContainText('Trusted');

    // A disclosure about one row must not hang over the next one. `j`
    // must work straight after the click: a keyed control in a
    // keyboard-driven review has to hand the grid its keyboard back.
    await page.keyboard.press('j');
    await expect(
      dialog.getByTestId('import-review-row').nth(1),
    ).toHaveAttribute('data-focused', 'true');
    await expect(reason.getByTestId('import-review-why-detail')).toHaveCount(0);
  });

  test('the v13 detail reads as two columns inside one bounded region', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review V13 Detail',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const details = dialog.getByTestId('import-review-details');
    await expect(details).toBeVisible();

    // The four zones are grouped into two columns: the row's own facts on
    // the left, its review status and rules on the right. Both columns are
    // measurable boxes — a collapsed one would report zero height.
    const left = dialog.getByTestId('import-review-zone-left');
    const right = dialog.getByTestId('import-review-zone-right');
    for (const column of [left, right]) {
      const box = await column.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(100);
    }
    const leftBox = await left.boundingBox();
    const rightBox = await right.boundingBox();
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();
    expect(rightBox!.x).toBeGreaterThan(leftBox!.x);
    expect(leftBox!.y).toBeCloseTo(rightBox!.y, 0);

    // The Actions stay outside both columns, pinned below them. Compare
    // against the BOTTOM of each column: comparing tops would also pass if
    // Actions were rendered inside the left one.
    const actions = dialog.getByTestId('import-review-actions');
    const actionsBox = await actions.boundingBox();
    expect(actionsBox).not.toBeNull();
    const columnsBottom = Math.max(
      leftBox!.y + leftBox!.height,
      rightBox!.y + rightBox!.height,
    );
    expect(actionsBox!.y).toBeGreaterThanOrEqual(columnsBottom);

    // The zone names are the ones a person uses now, and the Transaction
    // zone is split by where its facts came from.
    await expect(dialog.getByTestId('import-review-transaction')).toContainText(
      'From the bank',
    );
    await expect(dialog.getByTestId('import-review-transaction')).toContainText(
      'In your budget',
    );
    await expect(dialog.getByTestId('import-review-verdict')).toContainText(
      'Review status',
    );
    await expect(dialog.getByTestId('import-review-rules-zone')).toContainText(
      'Rules',
    );

    // The detail spells the month out where the list stays compact.
    await expect(dialog.getByTestId('import-review-date')).toContainText(
      /[A-Z][a-z]+ \d{2}, \d{4}/,
    );
    // The list keeps the budget's default short format; the detail above
    // uses the locale's long one.
    await expect(
      dialog.getByTestId('import-review-row-date').first(),
    ).toContainText(/^\d{2}\/\d{2}\/\d{4}$/);

    // The destination is the table's caption: it is INSIDE the panel that
    // holds the grid, above the sticky column header.
    const insidePanel = await dialog.evaluate(root => {
      const caption = root.querySelector(
        '[data-testid="import-review-destination"]',
      );
      const grid = root.querySelector('[data-testid="import-review-grid"]');
      // The caption is the panel's first child and the grid follows it;
      // merely sharing a parent with the grid would not make it the
      // table's caption.
      return !!caption && !!grid && caption.nextElementSibling === grid;
    });
    expect(insidePanel).toBe(true);
  });

  test('the detail section never changes size as the rows change', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Fixed Detail',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    // The blocked file: the rows carry different amounts of evidence —
    // one has a flag, one is held back, one is skipped — and none of
    // them is ruled. The region must be the same size for all three.
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const details = dialog.getByTestId('import-review-details');
    const heights: number[] = [];

    for (let index = 0; index < 3; index++) {
      if (index > 0) {
        // The cursor is keyboard-driven; clicking a row does not move it.
        await page.keyboard.press('j');
      }
      await expect(rows.nth(index)).toHaveAttribute('data-focused', 'true');

      const box = await details.boundingBox();
      expect(box).not.toBeNull();
      heights.push(box!.height);

      // All four zones are ALWAYS here. A row that is clean says so in
      // the review status; a row no rule touched says so in the Rules zone;
      // no zone vanishes and leaves a gap.
      const zones = [
        ['Transaction', 'import-review-transaction'],
        ['Review status', 'import-review-verdict'],
        ['Rules', 'import-review-rules-zone'],
        ['Actions', 'import-review-actions'],
      ] as const;
      for (const [name, testId] of zones) {
        const zone = details.getByTestId(testId);
        await expect(zone).toBeVisible();
        await expect(zone).toContainText(name);
      }
    }

    // This is a comparison between measurements of the SAME element in
    // different states, not an assertion about a pixel value.
    expect(heights[1]).toBe(heights[0]);
    expect(heights[2]).toBe(heights[0]);
  });

  test('the zones scroll, and the actions stay reachable', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Zones Scroll',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithRows(40);

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(40);

    // The detail section is bounded, so a row with a lot to say does
    // not push the modal down the screen. Compare it to the dialog's own
    // height — a fixed pixel here would just restate the stylesheet.
    const details = dialog.getByTestId('import-review-details');
    const detailsBox = await details.boundingBox();
    const dialogBox = await dialog.boundingBox();
    expect(detailsBox?.height ?? 0).toBeLessThan(
      (dialogBox?.height ?? 0) * 0.6,
    );

    // And the LEFT column is a real box that SCROLLS — not one that
    // collapsed to nothing, which would also report `overflow-y: auto`.
    const left = dialog.getByTestId('import-review-zone-left');
    await expect
      .poll(() => left.evaluate(element => getComputedStyle(element).overflowY))
      .toBe('auto');
    const leftBox = await left.boundingBox();
    expect(leftBox?.height ?? 0).toBeGreaterThan(100);

    // And the ACTIONS are outside the scroll: they are what the user
    // came for, and they must never be the thing that scrolls away.
    const actions = dialog.getByTestId('import-review-actions');
    await expect(actions).toBeVisible();
    await actions.getByTestId('import-review-accept').click();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test('a double-click accepts one row, and not two', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Double Click',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // A single click accepts the row and moves the cursor on, the same
    // as the key: the mouse user is working through the queue too.
    await page.keyboard.press('a');
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');

    // A DOUBLE-click would accept the row the cursor moved to as well:
    // the first press accepts the row and the cursor moves on, and the
    // second press lands on the same button — which now acts on the
    // NEXT row. The second press of a pair is swallowed.
    await dialog
      .getByTestId('import-review-actions')
      .getByTestId('import-review-accept')
      .dblclick();
    await expect(rows.nth(1)).toHaveAttribute('data-decision', 'accept');
    await expect(rows.nth(2)).toHaveAttribute('data-decision', 'pending');
    await expect(rows.nth(2)).toHaveAttribute('data-focused', 'true');
  });

  test('the picker can open a new rule in the rule editor', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Blank Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-row')).toHaveCount(3);

    // No rule touched this row, and its payee is not settled, so the blank
    // rule is the picker's only item. It still opens: this is the escape
    // hatch for a rule the row cannot prefill.
    await page.keyboard.press('Shift+E');
    const picker = dialog.getByTestId('import-review-rule-picker');
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId('import-review-rule-item')).toHaveCount(0);
    const newRule = picker.getByTestId('import-review-rule-create-new');
    await expect(newRule).toHaveCount(1);
    await expect(newRule).toContainText('Add new rule');
    await expect(newRule).toBeFocused();

    // Enter opens upstream's editor on top of the review, seeded with a
    // single condition and action rather than an empty pane.
    await page.keyboard.press('Enter');
    await expect(picker).toHaveCount(0);
    const editor = new EditRuleModal(page.getByTestId('edit-rule-modal'));
    await expect(editor.conditionList).toBeVisible();
    await expect(await editor.getRow(editor.conditionList, 0)).toBeVisible();
    await expect(await editor.getRow(editor.actionList, 0)).toBeVisible();

    // A rule the two row-derived offers could never write.
    await editor.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'POS PURCHASE 4251' },
      ],
      actions: [{ field: 'category', value: 'Food' }],
    });
    await editor.save();

    await expect(page.getByTestId('edit-rule-modal')).toHaveCount(0);
    await expect(dialog.getByTestId('import-review-hints')).toBeVisible();
  });

  test('shift+e opens the picker over the rules on the row', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Rule Picker',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The budget has a rule for this vendor, made BEFORE the import: the
    // rule is in the budget when the preview runs, which is when the
    // engine applies it.
    const rulesPage = await navigation.goToRulesPage();
    const editRuleModal = await rulesPage.createNewRule();
    await editRuleModal.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'Demo Grocery Store' },
      ],
      actions: [{ field: 'category', value: 'Food' }],
    });
    await editRuleModal.save();
    await navigation.goToAccountPage('Keyboard Review Rule Picker');

    await enableKeyboardReview();
    await importSameVendorOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(2);

    // The row's payee is not settled, so the review cannot offer a rule
    // about it yet. The user picks one, and THEN there is something to
    // choose from.
    await page.keyboard.press('p');
    const editor = dialog.getByTestId('import-review-editor');
    await editor.getByTestId('import-review-editor-input').fill('Kroger');
    await page.keyboard.press('Enter');
    await expect(editor).not.toBeVisible();

    // `Shift+E` opens the picker: the rule that touched the row, and the
    // rule the row could grow.
    await page.keyboard.press('Shift+E');
    const picker = dialog.getByTestId('import-review-rule-picker');
    await expect(picker).toBeVisible();

    // The rule that touched the row is named by the field it owns and by
    // what it does.
    const ruleItem = picker.getByTestId('import-review-rule-item');
    await expect(ruleItem).toHaveCount(1);
    await expect(ruleItem).toHaveAttribute('data-field', 'category');
    await expect(ruleItem).toContainText('category');
    await expect(ruleItem).toContainText('Food');

    // The field name and the rule's description are two spans in one
    // flex row. They used to paint flush ("categoryFood"). Compare boxes,
    // not pixels, so this holds at any zoom and with any font.
    const [fieldBox, descriptionBox] = await Promise.all([
      ruleItem.getByTestId('import-review-rule-field').boundingBox(),
      ruleItem.getByTestId('import-review-rule-description').boundingBox(),
    ]);
    if (!fieldBox || !descriptionBox) {
      throw new Error('The rule field or its description was not on screen');
    }
    const gap = descriptionBox.x - (fieldBox.x + fieldBox.width);
    expect(
      gap,
      'the rule field and description must be separated',
    ).toBeGreaterThan(0);
    // An inline gap, not a line break or another column: compare it to
    // the rendered line height rather than to a hard-coded pixel count.
    expect(gap).toBeLessThan(fieldBox.height);
    expect(
      descriptionBox.y < fieldBox.y + fieldBox.height &&
        fieldBox.y < descriptionBox.y + descriptionBox.height,
      'the rule field and description must share a line',
    ).toBe(true);

    // And the rule the row could grow is offered below it.
    const newRule = picker.getByTestId('import-review-rule-new');
    await expect(newRule).toHaveCount(1);
    await expect(newRule).toContainText('always this payee for this vendor');

    // `j` moves to it, and Enter takes it.
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(picker).not.toBeVisible();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'Rule created',
    );
  });

  test('shift+e opens the only rule on the row directly', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review One Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    // The budget has a rule for this vendor, made BEFORE the import: the
    // rule is in the budget when the preview runs, which is when the
    // engine applies it.
    //
    // The vendor is one the budget has no payee for, so the row has a
    // rule and NOTHING else to choose: no rule can be made about a payee
    // that is not settled.
    const rulesPage = await navigation.goToRulesPage();
    const editRuleModal = await rulesPage.createNewRule();
    await editRuleModal.fill({
      conditions: [
        { field: 'imported payee', op: 'is', value: 'POS PURCHASE 4251' },
      ],
      actions: [{ field: 'category', value: 'Food' }],
    });
    await editRuleModal.save();
    await navigation.goToAccountPage('Keyboard Review One Rule');

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // ONE thing to choose, and it is a rule to EDIT: the review opens it,
    // rather than showing a picker with a single item in it.
    await page.keyboard.press('Shift+E');
    await expect(dialog.getByTestId('import-review-rule-picker')).toHaveCount(
      0,
    );
    // Upstream's own rule editor is open on top of the review.
    await expect(page.getByTestId('condition-list')).toBeVisible();
  });

  test('the header lines up with the rows', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Header',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const header = dialog.getByTestId('import-review-header');
    await expect(header).toBeVisible();

    // THE ASSERTION: each column of the header sits over its column of
    // the row.
    //
    // The header and the rows go through the SAME column template, so
    // they cannot drift apart — and this is what proves it. The
    // comparison is between two measured elements, so it holds at any
    // zoom and with any font.
    const headerLefts = await header.evaluate(element =>
      Array.from(element.children).map(
        child => child.getBoundingClientRect().left,
      ),
    );
    const rowLefts = await dialog
      .getByTestId('import-review-row')
      .first()
      .evaluate(element =>
        Array.from(element.children).map(
          child => child.getBoundingClientRect().left,
        ),
      );

    expect(headerLefts.length).toBe(rowLefts.length);
    expect(headerLefts.length).toBeGreaterThan(0);
    for (let index = 0; index < headerLefts.length; index++) {
      expect(
        Math.abs(headerLefts[index] - rowLefts[index]),
      ).toBeLessThanOrEqual(1);
    }
  });

  test('the header does not put the title under the trust level', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Header Overlap',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    // The heading, not the text: the review says "Importing into {the
    // account}", and an account called "…Review Import…" would match a
    // plain text search for the title as well.
    const title = dialog.getByRole('heading', { name: 'Review import' });
    await expect(title).toBeVisible();

    const trust = dialog.getByTestId('import-review-trust-paranoid');

    // THE ASSERTION: the title and the trust control do not overlap.
    //
    // The app's own `ModalHeader` centres its title in
    // `calc(100% - 60px)` and positions its `rightContent` absolutely at
    // `right: 0`, so a wide right side reaches the title and the two
    // paint over each other — the header read "Review impor-t-paranoid".
    // The review's own header is one flex row, so nothing can be
    // positioned over anything else.
    //
    // The comparison is between two measured elements, so it holds at any
    // zoom and with any font.
    const boxes = await Promise.all(
      [title, trust].map(element => element.boundingBox()),
    );
    const [titleBox, trustBox] = boxes;

    // A box that is not there cannot overlap anything, but it is also not
    // a passing measurement — so it is a failure, said plainly.
    if (!titleBox || !trustBox) {
      throw new Error('The title or the trust control was not on the screen');
    }

    const overlapsHorizontally =
      titleBox.x < trustBox.x + trustBox.width &&
      trustBox.x < titleBox.x + titleBox.width;
    const overlapsVertically =
      titleBox.y < trustBox.y + trustBox.height &&
      trustBox.y < titleBox.y + titleBox.height;

    expect(overlapsHorizontally && overlapsVertically).toBe(false);

    // The Import button belongs on that same row. A flat header with a
    // 16px gap between every item pushed it onto a second line at 900px,
    // leaving it vertically offset from the title. Compare measured boxes
    // so the assertion holds at any zoom.
    const importBox = await dialog
      .getByTestId('import-review-import')
      .boundingBox();
    if (!titleBox || !importBox) {
      throw new Error('The title or the Import button was not on the screen');
    }
    expect(
      importBox.y < titleBox.y + titleBox.height &&
        titleBox.y < importBox.y + importBox.height,
      "at the dialog's 900px width, Import must share the title row",
    ).toBe(true);

    // Narrow must wrap rather than push the header sideways: the middle
    // group holds the widest content and used to be a single unwrappable
    // flex item.
    await page.setViewportSize({ width: 600, height: 900 });
    const fits = await dialog
      .getByTestId('import-review-header-row')
      .evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    expect(fits, 'the wrapped header must not overflow sideways').toBe(true);
  });

  test('the trust level says which one it is', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Trust Says',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    // The segments' colours are in a class rather than in an inline
    // style, so the button's own hover and disabled rules still apply.
    // That only works if the segment's own rules win — and they are not
    // guaranteed to, because the cascade between two emotion classes
    // depends on which was written to the sheet first. So it is pinned:
    // the current level must LOOK different from the others.
    const current = dialog.getByTestId('import-review-trust-cautious');
    const other = dialog.getByTestId('import-review-trust-trusted');

    const styleOf = (locator: typeof current) =>
      locator.evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      });

    const currentStyle = await styleOf(current);
    const otherStyle = await styleOf(other);

    expect(currentStyle.color).not.toBe(otherStyle.color);
    expect(currentStyle.background).not.toBe(otherStyle.background);
  });

  test('the Import button says how much it will import', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Import Count',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    // The blocked file, so the number that will land is NOT the number of
    // rows: the trust level holds some of them back.
    await importBlockedOfx();

    const dialog = page.getByTestId('import-review-shell');
    // The heading, not the text: the review says "Importing into {the
    // account}", and an account called "…Review Import…" would match a
    // plain text search for the title as well.
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    // The count is the number of rows that will land: not dropped, and
    // not held back by the trust level.
    const rows = dialog.getByTestId('import-review-row');
    // The rows arrive after the title: the file is parsed first.
    await expect(rows).toHaveCount(3);
    const willImport = await rows.evaluateAll(
      elements =>
        elements.filter(
          element =>
            element.getAttribute('data-decision') !== 'drop' &&
            element.getAttribute('data-held') !== 'true',
        ).length,
    );
    // The trust level holds rows back, so the button must not be counting
    // the rows.
    expect(willImport).toBeGreaterThan(0);
    expect(willImport).toBeLessThan(3);

    const importButton = dialog.getByTestId('import-review-import');
    // The whole label, not "a digit somewhere in the button": the button
    // says how much it will import, and that is what it says.
    await expect(importButton).toHaveAccessibleName(
      `Import ${willImport} transaction${willImport === 1 ? '' : 's'}`,
    );
  });

  test('every key cap can be read', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Key Cap',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    // THE ASSERTION: every key cap's ink reads against its own fill.
    //
    // A key cap used to take its ink from whatever it sat in, which was
    // right on a white surface and wrong on the primary button: the
    // button's white text over the cap's own white fill made "Ctrl+S"
    // white on white, and unreadable.
    //
    // The colours are the ones the browser computed at runtime, so the
    // assertion holds in every theme and whatever the theme's tokens
    // happen to be. AA for normal text is 4.5:1.
    //
    // The three themes are all tried, because a cap that reads on white
    // does not necessarily read on midnight's near-black.
    for (const theme of ['auto', 'dark', 'midnight']) {
      await page.evaluate(name => window.Actual.setTheme(name), theme);
      await expect(page.locator('[data-theme]')).toHaveAttribute(
        'data-theme',
        theme,
      );

      const caps = await dialog.evaluate(element => {
        // A colour can be translucent, and two translucent colours cannot
        // be compared: they have to be put together first. So a
        // translucent fill is put over the nearest opaque thing behind
        // it, which is what the eye sees.
        const parse = (color: string) => {
          const parts = (color.match(/[\d.]+/g) ?? []).map(Number);
          return {
            r: parts[0] ?? 0,
            g: parts[1] ?? 0,
            b: parts[2] ?? 0,
            a: parts[3] ?? 1,
          };
        };
        const over = (
          top: { r: number; g: number; b: number; a: number },
          bottom: { r: number; g: number; b: number },
        ) => ({
          r: top.r * top.a + bottom.r * (1 - top.a),
          g: top.g * top.a + bottom.g * (1 - top.a),
          b: top.b * top.a + bottom.b * (1 - top.a),
        });
        const backdropOf = (node: Element) => {
          // The walk starts at the PARENT: the cap's own fill is the top
          // layer, and what is wanted is the surface BEHIND it. A
          // translucent fill composited onto itself would report its own
          // colour and read as perfect, whatever it really looks like.
          let current: Element | null = node.parentElement;
          while (current) {
            const background = parse(getComputedStyle(current).backgroundColor);
            if (background.a > 0) return background;
            current = current.parentElement;
          }
          return { r: 255, g: 255, b: 255 };
        };

        return Array.from(
          element.querySelectorAll('[data-testid="key-cap"]'),
        ).map(cap => {
          const style = getComputedStyle(cap);
          const rect = cap.getBoundingClientRect();
          const fill = parse(style.backgroundColor);
          const behind = over(fill, backdropOf(cap));
          return {
            text: cap.textContent,
            color: style.color,
            border: style.borderTopColor,
            background: `rgb(${Math.round(behind.r)}, ${Math.round(behind.g)}, ${Math.round(behind.b)})`,
            visible: rect.width > 0 && rect.height > 0,
          };
        });
      });

      // The header alone carries five: Escape, the three trust levels,
      // and the Import button's Ctrl+S. A smaller number means a cap is
      // missing, not that there are fewer of them.
      expect(caps.length).toBeGreaterThanOrEqual(5);
      for (const cap of caps) {
        expect(cap.visible).toBe(true);
        expect(contrastRatio(cap.color, cap.background)).toBeGreaterThanOrEqual(
          4.5,
        );
        // The edge is part of the affordance: WCAG 1.4.11 asks 3:1 for
        // non-text UI boundaries against the surface behind them.
        expect(
          contrastRatio(cap.border, cap.background),
        ).toBeGreaterThanOrEqual(3);
      }
    }

    // The app is put back the way it was found, so the suite does not
    // depend on the order its tests run in.
    await page.evaluate(() => window.Actual.setTheme('auto'));
    await expect(page.locator('[data-theme]')).toHaveAttribute(
      'data-theme',
      'auto',
    );
  });

  test('the status line groups its counts into chips', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Status Chips',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // A chip that reads in the light theme need not read in the others:
    // the rule chip's blue is only AA against the field's surface, and
    // the dark theme's table band is not that surface. All three are
    // tried.
    for (const theme of ['auto', 'dark', 'midnight']) {
      await page.evaluate(name => window.Actual.setTheme(name), theme);
      await expect(page.locator('[data-theme]')).toHaveAttribute(
        'data-theme',
        theme,
      );

      // THE ASSERTION: a count that matters is BOXED. Eleven bare numbers
      // in two lines of text were what the review used to show; a chip
      // gives a number hierarchy and says which ones to look at.
      const chips = dialog.getByTestId('import-review-status-chip');
      const count = await chips.count();
      expect(count).toBeGreaterThan(0);

      const backgrounds = await chips.evaluateAll(elements =>
        elements.map(element => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent ?? '',
            color: style.color,
            background: style.backgroundColor,
            radius: style.borderRadius,
          };
        }),
      );

      for (const chip of backgrounds) {
        expect(chip.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(chip.radius).not.toBe('0px');
        // A box counts for nothing if its words cannot be read in it.
        // The colours are measured at runtime, so this holds in whatever
        // theme the app is in. AA for normal text is 4.5:1.
        expect(
          contrastRatio(chip.color, chip.background),
        ).toBeGreaterThanOrEqual(4.5);
      }

      // The line is the mockup's six items. Skipped and blocked are not
      // counters here: each row's Status column badges its own outcome.
      const words = backgrounds.map(chip => chip.text).join(' ');
      expect(words).toContain('flagged');
      expect(words).toContain('will import');
      expect(words).not.toContain('skipped');
      expect(words).not.toContain('blocked');

      // The in/out split is the line's last item, and a plain Text
      // rather than a chip — so the chip loop above never sees it.
      await expect(dialog.getByTestId('import-review-status')).toContainText(
        /\d+ in · \d+ out/,
      );
      // The second pair is the money that will actually move: a signed
      // incoming and outgoing total, each in the budget's currency.
      await expect(dialog.getByTestId('import-review-status')).toContainText(
        /\+\S*[\d,]+\.\d{2}\s*·\s*-\S*[\d,]+\.\d{2}/,
      );
    }

    await page.evaluate(() => window.Actual.setTheme('auto'));
    await expect(page.locator('[data-theme]')).toHaveAttribute(
      'data-theme',
      'auto',
    );
  });

  test('money and secondary text read in every theme', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Theme Contrast',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const sumIn = dialog.getByTestId('import-review-sum-in');
    const sumOut = dialog.getByTestId('import-review-sum-out');
    const label = dialog.getByTestId('import-review-amount-label');
    await expect(sumIn).toBeVisible();
    await expect(sumOut).toBeVisible();
    await expect(label).toBeVisible();
    await expect(sumIn).not.toHaveText('');
    await expect(sumOut).not.toHaveText('');

    for (const theme of ['light', 'dark', 'midnight']) {
      await page.evaluate(name => window.Actual.setTheme(name), theme);
      await expect(page.locator('[data-theme]')).toHaveAttribute(
        'data-theme',
        theme,
      );

      // Locators auto-wait for any remount a theme switch causes. Reading
      // the COMPUTED colour also covers custom themes that override the
      // token, not just the three shipped palettes.
      const inColor = await sumIn.evaluate(
        node => getComputedStyle(node).color,
      );
      const outColor = await sumOut.evaluate(
        node => getComputedStyle(node).color,
      );
      const labelColor = await label.evaluate(
        node => getComputedStyle(node).color,
      );

      // The `role="dialog"` node is an unstyled wrapper; the painted
      // surface is its child, the modal content container. Reading the
      // wrapper would report transparent black and quietly compare every
      // colour against black instead of against the modal.
      const modalBackground = await dialog.evaluate(node => {
        const surface = node.firstElementChild;
        if (!surface) throw new Error('the dialog has no content container');
        return getComputedStyle(surface).backgroundColor;
      });

      for (const color of [inColor, outColor, labelColor]) {
        expect(contrastRatio(color, modalBackground)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }

    await page.evaluate(() => window.Actual.setTheme('auto'));
    await expect(page.locator('[data-theme]')).toHaveAttribute(
      'data-theme',
      'auto',
    );
  });

  test('the progress bar says how far through the file the user is', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Progress',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    const measure = () =>
      dialog.evaluate(element => {
        const track = element.querySelector(
          '[data-testid="import-review-progress"]',
        )!;
        const fill = element.querySelector(
          '[data-testid="import-review-progress-fill"]',
        )!;
        const reviewed = element.querySelector(
          '[data-testid="import-review-status-chip"]',
        )!.textContent!;
        const match = reviewed.match(/(\d+) of (\d+) reviewed/);
        return {
          fraction:
            fill.getBoundingClientRect().width /
            track.getBoundingClientRect().width,
          reviewed: match ? Number(match[1]) : -1,
          total: match ? Number(match[2]) : -1,
        };
      });

    // At the start, nothing has been decided.
    const atStart = await measure();
    expect(atStart.total).toBe(3);
    expect(atStart.fraction).toBeCloseTo(atStart.reviewed / atStart.total, 2);

    // Accept a row: the bar grows by exactly one row's worth. This is a
    // comparison between two measured elements, not a pixel assertion.
    await page.keyboard.press('a');
    const afterOne = await measure();
    expect(afterOne.reviewed).toBe(atStart.reviewed + 1);
    expect(afterOne.fraction).toBeCloseTo(
      afterOne.reviewed / afterOne.total,
      2,
    );
    expect(afterOne.fraction).toBeGreaterThan(atStart.fraction);
  });

  test('the list has five columns, and the payee is the wide one', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Five Columns',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    // The header's cells, in order. The list carries what you scan:
    // when, who, what, how much, and where it stands. The category's
    // GROUP is evidence, and evidence is in the detail section.
    const headers = await dialog
      .getByTestId('import-review-header')
      .evaluate(element =>
        Array.from(element.children).map(
          child => child.textContent?.trim() ?? '',
        ),
      );

    expect(headers).toEqual(['Date', 'Payee', 'Category', 'Amount', 'Status']);

    // The payee is the only flexible column, and it has to be wide
    // enough that a payee name is never truncated. The comparison is
    // against the other columns, so it holds at any zoom.
    const widths = await dialog
      .getByTestId('import-review-row')
      .first()
      .evaluate(element =>
        Array.from(element.children).map(
          child => child.getBoundingClientRect().width,
        ),
      );

    expect(widths.length).toBe(5);
    const payeeWidth = widths[1];
    const categoryWidth = widths[2];
    const otherWidths = widths.filter((_, index) => index !== 1);
    for (const width of otherWidths) {
      expect(payeeWidth).toBeGreaterThan(width);
    }
    // And the payee is wide enough for a payee name — more than twice the
    // category, which is what the column budget gives it. The comparison
    // is between two measured elements, so it holds at any zoom, and it
    // fails if the payee is squeezed to its floor.
    expect(payeeWidth).toBeGreaterThan(categoryWidth * 2);
  });

  test('the rows are separated, and they light up on hover', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Row Chrome',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // THE ASSERTION: every row is separated from the next by a hairline.
    //
    // The rows used to run together with nothing between them, which
    // made a list of transactions hard to read down a column.
    const borders = await rows.evaluateAll(elements =>
      elements.map(element => {
        const style = getComputedStyle(element);
        return {
          width: style.borderBottomWidth,
          style: style.borderBottomStyle,
        };
      }),
    );
    borders.forEach((border, index) => {
      if (index === borders.length - 1) {
        // The list is a bordered box; its own bottom edge is the last
        // row's separator. A second one here would make a 2px seam.
        expect(border.width).toBe('0px');
      } else {
        expect(border.width).toBe('1px');
        expect(border.style).toBe('solid');
      }
    });

    // And a row the mouse is over says so, the way every other table in
    // the app does.
    const backgroundOf = (index: number) =>
      rows
        .nth(index)
        .evaluate(element => getComputedStyle(element).backgroundColor);

    // A row that is not the focused one, and one that is not hovered:
    // they look the same.
    const resting = await backgroundOf(1);
    expect(await backgroundOf(2)).toBe(resting);

    await rows.nth(1).hover();
    await page.waitForTimeout(150);
    const hovered = await backgroundOf(1);

    expect(hovered).not.toBe(resting);

    // The focused row is told apart from a hovered one by an accent down
    // its leading edge. The wash alone is not enough: in this theme the
    // hover colour and the focused row's colour are the same navy50.
    const shadows = await rows.evaluateAll(elements =>
      elements.map(element => ({
        focused: element.getAttribute('data-focused') === 'true',
        boxShadow: getComputedStyle(element).boxShadow,
      })),
    );
    const focusedShadow = shadows.find(row => row.focused)?.boxShadow;
    const others = shadows.filter(row => !row.focused);

    expect(focusedShadow).toBeTruthy();
    expect(focusedShadow).not.toBe('none');
    for (const row of others) {
      expect(row.boxShadow).toBe('none');
    }
  });

  test('the list is as tall as its content, and the list is what scrolls', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review List Height',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();
    const grid = dialog.getByTestId('import-review-grid');

    // The rows are there: a list with no rows would satisfy every
    // measurement below.
    await expect(grid.getByTestId('import-review-row')).toHaveCount(3);

    // A SHORT list is exactly as tall as its rows: the list is not a box
    // with a void under the content, and it is not a box that clips them.
    const short = await grid.evaluate(element => {
      const header = element.querySelector(
        '[data-testid="import-review-header"]',
      );
      if (!header) throw new Error('the list has no header row');
      const rows = Array.from(
        element.querySelectorAll('[data-testid="import-review-row"]'),
      );
      const content =
        header.getBoundingClientRect().height +
        rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
      return {
        list: element.getBoundingClientRect().height,
        content,
        scrolls: element.scrollHeight > element.clientHeight,
      };
    });
    expect(short.list).toBeGreaterThanOrEqual(short.content - 1);
    expect(short.list).toBeLessThanOrEqual(short.content + 1);
    expect(short.scrolls).toBe(false);

    // And a LONG list stops at its cap instead of growing: its content
    // is taller than the box, and the box scrolls.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await importOfxWithRows(60);
    await expect(dialog.getByTestId('import-review-row')).toHaveCount(60);

    const long = await grid.evaluate(element => {
      const header = element.querySelector(
        '[data-testid="import-review-header"]',
      );
      if (!header) throw new Error('the list has no header row');
      const rows = Array.from(
        element.querySelectorAll('[data-testid="import-review-row"]'),
      );
      return {
        list: element.getBoundingClientRect().height,
        content:
          header.getBoundingClientRect().height +
          rows.reduce(
            (sum, row) => sum + row.getBoundingClientRect().height,
            0,
          ),
        scrolls: element.scrollHeight > element.clientHeight,
      };
    });
    expect(long.content).toBeGreaterThan(long.list);
    expect(long.scrolls).toBe(true);

    // The DIALOG is not the thing that scrolls: the list is. The dialog
    // has its own cap, so measuring the dialog's height would say
    // nothing about the review — what matters is that the list inside it
    // does the scrolling and the rest of the review stays whole.
    const dialogScrolls = await dialog.evaluate(
      element => element.scrollHeight > element.clientHeight,
    );
    expect(dialogScrolls).toBe(false);
  });

  test('the rows keep their height when there are many of them', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Many Rows',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    // Sixty rows, so the list is far taller than its `maxHeight` of 420px
    // — which is the point: the rows have to keep their height and the
    // LIST has to scroll. A file small enough to fit would prove nothing.
    await importOfxWithRows(60);

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(60);

    // THE ASSERTION: no row is shorter than the text it holds.
    //
    // The text's own height is measured with a Range, because the cell is
    // a flex item and flex items STRETCH: the cell's box is the row's
    // height, so comparing the row with the cell would compare a thing
    // with itself. A Range over the text node gives the line box the text
    // actually takes, whatever the box around it does.
    //
    // Nothing here is a pixel count. The row is only required to be as
    // tall as its own text, which is what "the row is not squashed" means.
    const heights = await rows.evaluateAll(elements =>
      elements.map(element => {
        const cell = element.querySelector(
          '[data-testid="import-review-row-date"]',
        );
        const range = document.createRange();
        range.selectNodeContents(cell);
        return {
          row: element.getBoundingClientRect().height,
          text: range.getBoundingClientRect().height,
        };
      }),
    );

    expect(heights.length).toBeGreaterThan(0);
    for (const { row, text } of heights) {
      expect(row).toBeGreaterThanOrEqual(text);
    }

    // And the LIST scrolls, rather than the rows being squashed to fit:
    // the content is taller than the box it sits in.
    const scrolls = await rows.first().evaluate(element => {
      const list = element.parentElement;
      return list.scrollHeight > list.clientHeight;
    });
    expect(scrolls).toBe(true);

    // AND THE HEADER SURVIVES.
    //
    // It is the only item in the list's column that could shrink — every
    // row says `flexShrink: 0` — so without its own `flexShrink: 0` it
    // would take ALL the negative free space and disappear the moment the
    // list was full. A header that vanishes when the list is long is a
    // header nobody has.
    const header = dialog.getByTestId('import-review-header');
    const headerHeight = await header.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector('span'));
      return {
        header: element.getBoundingClientRect().height,
        text: range.getBoundingClientRect().height,
      };
    });
    expect(headerHeight.header).toBeGreaterThanOrEqual(headerHeight.text);
  });

  test('a short screen shrinks the list before it scrolls the dialog', async () => {
    // Short enough that 40 rows cannot fit, but with room left for the
    // fixed detail and at least three list rows.
    await page.setViewportSize({ width: 900, height: 800 });
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Short Screen',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithRows(40);

    const dialog = page.getByTestId('import-review-shell');
    const grid = dialog.getByTestId('import-review-grid');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(40);

    const [headerHeight, rowHeight, listHeight] = await Promise.all([
      dialog
        .getByTestId('import-review-header')
        .evaluate(element => element.getBoundingClientRect().height),
      rows.first().evaluate(element => element.getBoundingClientRect().height),
      grid.evaluate(element => element.getBoundingClientRect().height),
    ]);
    // The floor is the measured header plus three measured rows — no
    // pixel literal, so it holds at any zoom and with any font.
    expect(listHeight).toBeGreaterThanOrEqual(headerHeight + 3 * rowHeight - 1);
    // And it actually SHRANK: without the measured floor the list would
    // sit at its old 50vh cap, which this viewport has room for. Compare
    // against the viewport rather than a pixel count.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(listHeight).toBeLessThan((viewport?.height ?? 0) * 0.5);

    // The list is what scrolls; the dialog itself does not have to.
    const listScrolls = await grid.evaluate(
      element => element.scrollHeight > element.clientHeight,
    );
    expect(listScrolls).toBe(true);
    const dialogScroll = await dialog.evaluate(element => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(dialogScroll.scrollHeight).toBeLessThanOrEqual(
      dialogScroll.clientHeight + 1,
    );

    // The detail keeps its fixed height while the cursor walks the rows.
    const details = dialog.getByTestId('import-review-details');
    const before = await details.evaluate(
      element => element.getBoundingClientRect().height,
    );
    for (let index = 0; index < 4; index++) {
      await page.keyboard.press('j');
    }
    const after = await details.evaluate(
      element => element.getBoundingClientRect().height,
    );
    expect(after).toBe(before);
  });

  test('the actions strip stays reachable on a short screen', async () => {
    // Short enough that WITHOUT a pinned footer even a three-row review
    // pushes the strip below the fold and forces a dialog scroll. The
    // small overflow is intentional: that is the regression being guarded.
    await page.setViewportSize({ width: 900, height: 620 });
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Short Footer',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);
    const hints = dialog.getByTestId('import-review-hints');
    await expect(hints).toBeVisible();

    // The strip is inside the dialog's visible area without any scrolling.
    const [dialogBox, hintsBox] = await Promise.all([
      dialog.boundingBox(),
      hints.boundingBox(),
    ]);
    expect(
      dialogBox &&
        hintsBox &&
        hintsBox.y + hintsBox.height <= dialogBox.y + dialogBox.height + 1,
      'the actions strip must sit inside the dialog without scrolling',
    ).toBe(true);
    // The shell, not the dialog, owns the clipping — check the element
    // that actually decides whether the dialog has to scroll.
    const shellScroll = await dialog
      .getByTestId('import-review-shell')
      .evaluate(element => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    expect(shellScroll.scrollHeight).toBeLessThanOrEqual(
      shellScroll.clientHeight + 1,
    );

    // Pinning the footer must not cost the list: it still shows three
    // rows, and the detail must not be painted over them.
    const [headerHeight, rowHeight, gridBox, detailsBox] = await Promise.all([
      dialog
        .getByTestId('import-review-header')
        .evaluate(element => element.getBoundingClientRect().height),
      rows.first().evaluate(element => element.getBoundingClientRect().height),
      dialog.getByTestId('import-review-grid').boundingBox(),
      dialog.getByTestId('import-review-details').boundingBox(),
    ]);
    expect(gridBox?.height ?? 0).toBeGreaterThanOrEqual(
      headerHeight + 3 * rowHeight - 1,
    );
    expect(
      gridBox && detailsBox && gridBox.y + gridBox.height <= detailsBox.y + 1,
      'the detail must not overlap the visible list',
    ).toBe(true);

    // And the actions still work: no dialog scroll first, then a click.
    await dialog.getByTestId('import-review-accept-all').click();
    await expect(rows.nth(0)).toHaveAttribute('data-decision', 'accept');
  });

  test('the list scrolls to the row the cursor moves to', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Scroll To Focus',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithRows(40);

    const dialog = page.getByTestId('import-review-shell');
    const grid = dialog.getByTestId('import-review-grid');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(40);

    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
    expect(await grid.evaluate(element => element.scrollTop)).toBe(0);

    // Jumping to the last row has to bring it into the list's viewport,
    // below the sticky header — not just mark it with `data-focused`.
    await page.keyboard.press('Shift+G');
    await expect(rows.nth(39)).toHaveAttribute('data-focused', 'true');
    const atEnd = await grid.evaluate(element => {
      const list = element.getBoundingClientRect();
      const focused = element.querySelector<HTMLElement>(
        '[data-focused="true"]',
      );
      const header = element.querySelector<HTMLElement>(
        '[data-testid="import-review-header"]',
      );
      if (!focused || !header) {
        throw new Error('The focused row or the sticky header was missing');
      }
      const row = focused.getBoundingClientRect();
      const head = header.getBoundingClientRect();
      return {
        scrollTop: element.scrollTop,
        inside:
          row.top >= list.top + head.height - 1 &&
          row.bottom <= list.bottom + 2,
      };
    });
    expect(atEnd.scrollTop).toBeGreaterThan(0);
    expect(atEnd.inside).toBe(true);

    // And back to the top.
    await page.keyboard.press('g');
    await expect(rows.nth(0)).toHaveAttribute('data-focused', 'true');
    await expect
      .poll(() => grid.evaluate(element => element.scrollTop))
      .toBe(0);

    // With 40 rows the review body itself scrolls. Moving the cursor
    // after the user scrolled it down must bring the row back into view.
    const body = dialog.getByTestId('import-review-body');
    const scrolledBody = await body.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrolledBody).toBeGreaterThan(0);
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveAttribute('data-focused', 'true');
    const revealed = await body.evaluate(element => {
      const box = element.getBoundingClientRect();
      const focused = element.querySelector<HTMLElement>(
        '[data-focused="true"]',
      );
      if (!focused) throw new Error('No row was focused after j');
      const row = focused.getBoundingClientRect();
      return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
    });
    expect(revealed).toBe(true);
  });

  test("the help overlay's rows are readable", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Help Rows',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();
    // The hint strip only appears once the review has parsed and rendered
    // its rows, so waiting for it is how the test knows the modal's own
    // hotkey scope is live.
    await expect(dialog.getByTestId('import-review-hints')).toBeVisible();

    await page.keyboard.press('Shift+Slash');

    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();

    // Every key/description row is at least as tall as the text in it.
    // The overlay is the only place the review's keys are written down,
    // so a row that is squashed to nothing is a key that does not exist.
    //
    // The text's own height is measured with a Range: the text is a flex
    // item, and flex items stretch, so the element's box would be the
    // row's height and comparing the two would compare a thing with
    // itself. A Range over the text node gives the line box the text
    // actually takes.
    const heights = await help
      .getByTestId('import-review-help-row')
      .evaluateAll(elements =>
        elements.map(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            row: element.getBoundingClientRect().height,
            text: range.getBoundingClientRect().height,
          };
        }),
      );

    expect(heights.length).toBeGreaterThan(0);
    for (const { row, text } of heights) {
      expect(row).toBeGreaterThanOrEqual(text);
    }
  });

  test('the help overlay never overlaps its close hint with Limitations', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Help Hint',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-hints')).toBeVisible();

    await page.keyboard.press('Shift+Slash');
    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();

    const heading = help.getByTestId('import-review-help-limitations-heading');
    const hint = help.getByTestId('import-review-help-close-hint');
    // The heading may be scrolled out of view inside the body; it must
    // still exist. The hint is pinned and must always be visible.
    await expect(heading).toBeAttached();
    await expect(hint).toBeVisible();

    const [headingBox, hintBox] = await Promise.all([
      heading.boundingBox(),
      hint.boundingBox(),
    ]);
    if (!headingBox || !hintBox) {
      throw new Error('The Limitations heading or the close hint was missing');
    }

    // Separate vertical bands, not pixels: this fails exactly when a
    // collapsed block lets the border paint across the heading and the
    // hint spill into the same few rows.
    const separateBands =
      hintBox.y + hintBox.height <= headingBox.y ||
      headingBox.y + headingBox.height <= hintBox.y;
    expect(separateBands, 'the close hint must not overlap Limitations').toBe(
      true,
    );

    // The hint is pinned OUTSIDE the body: scrolling the body to the very
    // bottom must leave the hint's box exactly where it was. Reading the
    // scrollback also proves the body really is the scroll region, without
    // depending on how many keys the keymap happens to have.
    const body = help.getByTestId('import-review-help-body');
    const scrolledTo = await body.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
    expect(scrolledTo).toBeGreaterThan(0);
    expect(await hint.boundingBox()).toEqual(hintBox);
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

    const dialog = page.getByTestId('import-review-shell');
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
    // The row shows the date the way the APP shows it — the file's ISO
    // date is the engine's business, not the user's.
    const dateCell = rows.nth(0).getByTestId('import-review-row-date');
    await expect(dateCell).toContainText('2026');
    await expect(dateCell).toContainText('15');
    await expect(dateCell).not.toHaveText('2026-09-15');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    await page.keyboard.press('p');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    await page.keyboard.press('a');

    // A click outside the review used to dismiss the modal and throw the
    // work away with it. The page has no overlay, but a click on the page
    // outside the review must still leave the review and its work alone.
    await page.locator('body').click({ position: { x: 5, y: 5 } });

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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);

    // There IS work in the review, so a confirmation would be right — but
    // the escape in the editor cancels the EDIT, and there is nothing to
    // ask about: the edit was never committed.
    await page.keyboard.press('a');
    await page.keyboard.press('p');

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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

    const dialog = page.getByTestId('import-review-shell');
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

  test('a transfer-prefixed vendor string auto-detects an account match', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Detect',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithPayee('TRANSFER TO Ally Savings');

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(1);
    // The prefix is stripped and the residual names an account, so the row
    // is auto-detected as a transfer — no `t` keypress needed.
    await expect(rows.nth(0)).toContainText('Ally Savings');
    await expect(rows.nth(0)).toContainText('Transfer');
  });

  test('a transfer keyword with no account match is only SUSPECTED', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Suspect',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithPayee('ONLINE TRANSFER TO SOMEWHERE UNKNOWN');

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(1);
    // The warning is shown but NOTHING is prefilled: a false positive must
    // not create a mirror in another account.
    // The flag is shown as a machine code, and the row stays ordinary.
    await expect(dialog.getByTestId('import-review-flag-codes')).toContainText(
      'PAYEE-TRANSFER-002',
    );
    // The row is an ordinary categorizable transaction: it says
    // "Categorize", not "Transfer".
    await expect(rows.nth(0)).toContainText('Categorize');
  });

  test('a transfer rule is offered and taught from the picker', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Transfer Rule',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfxWithPayee('ONLINE TRANSFER TO Ally Savings');

    const dialog = page.getByTestId('import-review-shell');
    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText('Ally Savings');

    await page.keyboard.press('Shift+E');
    const picker = dialog.getByTestId('import-review-rule-picker');
    await expect(picker).toBeVisible();
    const transferOffer = picker
      .getByTestId('import-review-rule-new')
      .filter({ hasText: 'always transfer' });
    await expect(transferOffer).toHaveCount(1);
    // The picker auto-focuses its FIRST item, which for a transfer row is
    // this offer (the only other item is "Add new rule"). Enter writes it.
    await page.keyboard.press('Enter');
    await expect(picker).not.toBeVisible();
    await expect(dialog.getByTestId('import-review-notice')).toContainText(
      'This vendor will be a transfer from now on',
    );
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    await page.keyboard.press('Shift+Slash');

    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();
    await expect(help.getByText('Accept row despite its flags')).toBeVisible();
    await expect(help.getByText('Use the trusted trust level')).toBeVisible();

    // Escape closes the overlay, and the review with it.
    await page.keyboard.press('Escape');
    await expect(help).not.toBeVisible();
    await expect(dialog.getByText('Review import')).toBeVisible();
  });

  test("the question mark opens the review's keys, not the app's help", async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Question Mark',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(
      dialog.getByRole('heading', { name: 'Review import' }),
    ).toBeVisible();

    // The APP's `?` does not open the app's help menu over the review.
    //
    // It used to: the app's binding had no scope, so it was always live
    // — and the review's `?` and the app's `?` both fired.
    //
    // The app's binding matches the CHARACTER, so this is the press that
    // reaches it: the app's `?` is the character without the shift
    // modifier. A real `?` is Shift+Slash, and the app's binding rejects
    // that on its own.
    await page.keyboard.press('?');
    await expect(page.getByText('Community support (Discord)')).toHaveCount(0);
    await expect(dialog.getByTestId('import-review-help')).toHaveCount(0);

    // And the review's own `?` opens the review's keys.
    //
    // It is pressed as Shift+Slash, because that is what a `?` IS: the
    // key only produces `?` with the shift held down.
    await page.keyboard.press('Shift+Slash');

    const help = dialog.getByTestId('import-review-help');
    await expect(help).toBeVisible();
    await expect(page.getByText('Community support (Discord)')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(help).not.toBeVisible();
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

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByText('Review import')).toBeVisible();

    const rows = dialog.getByTestId('import-review-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'block');

    // `3` selects the trusted level directly. The unknown payee and the
    // duplicate are only warned about now, so they land.
    await page.keyboard.press('3');
    await expect(rows.nth(1)).toHaveAttribute('data-gate', 'warn');
    await expect(rows.nth(1)).toHaveAttribute('data-held', 'false');
    await expect(rows.nth(2)).toHaveAttribute('data-gate', 'warn');
    await expect(rows.nth(2)).toHaveAttribute('data-held', 'false');

    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog).not.toBeVisible();

    // All three rows land. Actual's matching is against the budget, not
    // within the file, so a repeated FITID is a second transaction here -
    // which is exactly what the duplicate flag is there to warn about.
    await expect(accountPage.transactionTableRow).toHaveCount(3);

    // And they are MARKED: upstream renders a transaction the import
    // just brought in in bold, and the review's rows are marked the same
    // way. Without the mark, a keyboard import lands rows that look
    // exactly like the ones that were always there.
    const landed = accountPage.transactionTableRow.filter({
      hasText: 'Demo Grocery Store',
    });
    await expect(landed.first()).toBeVisible();
    await expect(
      landed.first().getByText('Demo Grocery Store', { exact: true }).first(),
    ).toHaveCSS('font-weight', '600');
  });

  test('the detail reads as four distinct typographic tiers', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Typography',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-details')).toBeVisible();

    const transaction = dialog.getByTestId('import-review-transaction');
    const zoneLabel = transaction.getByText('Transaction', { exact: true });
    const subhead = transaction.getByText('From the bank', { exact: true });

    // The overline is a CSS transform, not a rewritten string: the DOM
    // text is still the translated sentence-case key.
    expect(await zoneLabel.textContent()).toBe('Transaction');
    await expect(zoneLabel).toHaveCSS('text-transform', 'uppercase');
    await expect(zoneLabel).toHaveCSS('font-weight', '700');
    await expect(subhead).toHaveCSS('text-transform', 'none');
    await expect(subhead).toHaveCSS('font-weight', '600');

    // Tracking is declared in em, so compare the ratio rather than a
    // frozen pixel value that would break if the font size changed.
    const emTracking = await zoneLabel.evaluate(element => {
      const style = getComputedStyle(element);
      return parseFloat(style.letterSpacing) / parseFloat(style.fontSize);
    });
    expect(emTracking).toBeCloseTo(0.09, 2);

    // The label/value weight jump is what separates a fact from its name.
    const label = dialog.getByTestId('import-review-vendor-label');
    const value = dialog
      .getByTestId('import-review-vendor')
      .locator(':scope > span')
      .last();
    await expect(label).toHaveCSS('font-weight', '400');
    await expect(value).toHaveCSS('font-weight', '500');

    // A base weight must not replace the money token with primary ink.
    const amount = dialog
      .getByTestId('import-review-amount')
      .locator(':scope > span')
      .last();
    // The guard only means something on a signed row; an uncleared or
    // zero amount has no token colour to preserve.
    expect(await amount.textContent()).toContain('-');
    const [plainColor, moneyColor] = await Promise.all([
      value.evaluate(element => getComputedStyle(element).color),
      amount.evaluate(element => getComputedStyle(element).color),
    ]);
    expect(moneyColor).not.toBe(plainColor);
  });

  test('the extra zone spacing does not clip the detail fields', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review Detail Fit',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-details')).toBeVisible();

    // At desktop widths each column owns its scroll. On the default rows
    // the last line must sit inside its column: a clipped final row looks
    // identical to a visible one, because `toBeVisible` ignores overflow.
    // Geometry is the signal — `scrollHeight` over-reports on these flex
    // columns because child margins inflate it.
    const notes = await dialog.getByTestId('import-review-notes').boundingBox();
    const left = await dialog
      .getByTestId('import-review-zone-left')
      .boundingBox();
    expect(
      notes && left && notes.y + notes.height <= left.y + left.height,
      'the last Transaction field must not be clipped',
    ).toBe(true);

    const right = await dialog
      .getByTestId('import-review-zone-right')
      .boundingBox();
    const lastRight = await dialog
      .getByText('No rule touched this row.')
      .boundingBox();
    expect(
      lastRight &&
        right &&
        lastRight.y + lastRight.height <= right.y + right.height,
      'the last Rules line must not be clipped',
    ).toBe(true);

    // Narrow stacks the zones and the shared container takes the single
    // scrollbar — scrolling is the design there, not a failure. What must
    // remain true is that the overflow is REACHABLE. The Actions row is a
    // sibling outside the scroll box, so checking it would prove nothing.
    await page.setViewportSize({ width: 600, height: 900 });
    const zones = dialog.getByTestId('import-review-zones');
    await expect
      .poll(() =>
        zones.evaluate(element => getComputedStyle(element).overflowY),
      )
      .toBe('auto');
    const scroll = await zones.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return {
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      };
    });
    expect(scroll.max).toBeGreaterThan(0);
    expect(scroll.top).toBe(scroll.max);

    const zonesBox = await zones.boundingBox();
    const lastZone = await dialog
      .getByTestId('import-review-zone-right')
      .boundingBox();
    expect(
      zonesBox &&
        lastZone &&
        lastZone.y + lastZone.height <= zonesBox.y + zonesBox.height + 1,
      'the stacked zones must be scrollable into view',
    ).toBe(true);
  });

  test('the refined review surface in every theme', async () => {
    accountPage = await navigation.createAccount({
      name: 'Keyboard Review VRT',
      offBudget: false,
      balance: 0,
    });
    await accountPage.waitFor();

    await enableKeyboardReview();
    await importOfx();

    const dialog = page.getByTestId('import-review-shell');
    await expect(dialog.getByTestId('import-review-details')).toBeVisible();

    // Two tight targets, not the whole page: the detail region carries the
    // refined zones and the status line carries the styled money. Each
    // call captures the three themes, so any token that drifts in one
    // palette but not the others is caught.
    await expect(
      dialog.getByTestId('import-review-status'),
    ).toMatchThemeScreenshots();
    await expect(
      dialog.getByTestId('import-review-details'),
    ).toMatchThemeScreenshots();
  });
});

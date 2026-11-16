# Importing Transactions

There are various ways to get transactions into Actual.

## Linked Bank Import

Actual Budget supports [linking your bank accounts](../advanced/bank-sync.md) to sync using SimpleFIN, GoCardless or Pluggy.ai.

There are also [community projects](../community-repos.md) that implement bank syncing.

## Import Financial Files

A quick way to import transactions is to login to your bank's website and download a file.

Actual supports importing CSV, QIF, OFX, QFX and CAMT files. Your bank probably allows you to download one of these formats (OFX/QFX is recommended).

1. Open the account you want to import transactions into.
2. Press the **Import** button and select the file.

## Keyboard Import Review (Optional)

Actual has an optional review for OFX and QFX imports that you drive from the keyboard. It is off by default, and turning it on does not change how anything else works.

To turn it on, open the command bar with <Key mod="ctrl" fixed k="k" /> (or <Key mod="cmd" fixed k="k" /> on macOS), search for **Keyboard import review**, and choose it. To turn it off, do the same thing again.

When it is on, importing an OFX or QFX file opens the review instead of the usual import dialog. The review shows every row the file contains, and what Actual would do with it.

| Key                          | What it does                                     |
| ---------------------------- | ------------------------------------------------ |
| <Key k="j" />, <Key k="k" /> | Move to the next or previous row                 |
| <Key k="g" />, <Key k="G" /> | Jump to the first or last row                    |
| <Key k="a" />                | Accept the row and move on                       |
| <Key k="r" />                | Drop the row and move on                         |
| <Key k="u" />                | Undo the last decision                           |
| <Key k="e" />                | Edit the payee                                   |
| <Key k="c" />                | Edit the category                                |
| <Key k="m" />                | Edit the notes                                   |
| <Key k="d" />                | Edit the date                                    |
| <Key k="s" />                | Split the row across categories                  |
| <Key k="t" />                | Make the row a transfer                          |
| <Key k="o" />                | Import the rows from here into another account  |
| <Key k="O" />                | Import every row into one account                |
| <Key k="Tab" />              | Change how careful Actual is about the rows      |
| <Key k="A" />, <Key k="R" /> | Accept or drop every row                         |
| <Key k="w" />                | Put the review aside, and pick it up again later |
| <Key mod="ctrl" k="s" />     | Apply the import                                 |
| <Key k="?" />                | Show the keys                                    |

The review holds back the rows it is not sure about, and says why: a payee it does not know, a transaction that repeats an earlier one, or a row whose amount or date the file did not supply properly. You can accept a row anyway, or fix it and import it that way.

If you put a review aside with <Key k="w" />, the command bar offers **Resume the import review** the next time you open it. The review is kept on the device you made it on, not synced to your other devices.

### Files With Several Accounts

A file can hold the transactions of more than one account. The review starts with all of them in the account you opened it for, and each group of rows has a heading that says which account it goes into.

Actual's OFX parser does not keep the bank's account id, so the review cannot tell where one statement ends and the next begins. The boundaries are yours to place: put the cursor on the first row of the next statement, press <Key k="o" />, and choose the account it belongs to. The rows from there to the next heading move with it.

:::note
The payee names you remember are remembered for the whole budget, not per account. If the same vendor name appears in two accounts and you pick a different payee for each, only the last choice is remembered.
:::

## Import CSV Files

If your bank doesn't support downloading financial files, you can import a CSV file instead.

1. Open the account you want to import transactions into.
2. Press the **Import** button and select the file.
3. Select the **CSV** option.
4. Set up the fields to match the CSV file.
   - For the "CSV Fields" dropdowns, leave them as "Choose field…" to leave the related field blank. Otherwise select the column from your CSV that corresponds to each field.
   - If the date is not being imported correctly (the green date is how Actual interprets the date), you can change the date format to match your CSV file. If your date format is not shown in the dropdown, check that the date column is correctly selected from your CSV file.
   - If the file can't be imported at all, try changing the CSV delimiter to match your file. (Let us know if your file uses a different delimiter that isn't listed!)
   - You can optionally toggle on "Flip amount" if you want to negate all of the amounts in the CSV file.
   - You can optionally toggle on "Split amount into separate inflow/outflow columns" if your CSV file has separate columns for inflow and outflow amounts (also known as debit and credit.)
   - You can toggle on "Multiply amount" to add a multiplier to all of the amounts in the CSV file. This can be useful if you want to make an approximate currency conversion.
5. Once you're happy with the settings, press **Import**.

<img width="800" alt="The Import transactions (CSV) dialog with a preview of the file, the CSV field mapping, and the date, CSV and amount options" src="/img/transactions/importing-csv@2x.webp" />

## Manually Add Transactions

If desired, you can manually add transactions. This is the most work but allows you to manage accounts that may not work with any other importing mechanism.

1. Open the account to want to add transactions to.
2. Press the **Add New** button.
3. Fill out the transaction and press **Add**.

## Avoiding duplicate transactions

Actual will automatically try to avoid duplicate transactions. This works best with OFX/QFX files since they provide rich data about transactions. They provide an **id** that we can use to avoid importing duplicates.

After checking the **id**, Actual will look for transactions around the same date, with the same amount, and with a similar payee. If it thinks the transaction already exists, it will avoid creating a duplicate. This means you can manually enter a transaction, and later it will be matched when you import it from a file.

It will always favor the imported transaction. If it matches a manually-entered transaction, it will update the date to match the imported transaction. **Keeping dates in sync with your bank is important** as it allows you to compare the balance at any point in time with your bank.

When "Merge with existing transactions" is enabled, a **Reimport deleted transactions** checkbox is also available. When checked (the default for file imports), any transactions that were previously imported and then deleted will be reimported. Disable this option if you do _not_ want deleted transactions to reappear during import.

:::note
The [API](../api/reference.md#importtransactions) defaults `reimportDeleted` to `true` for backward compatibility. If you are importing via the API and want to skip deleted transactions, pass `reimportDeleted: false` explicitly.
:::

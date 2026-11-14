// @ts-strict-ignore
import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { runHandler } from '#server/mutators';
import * as prefs from '#server/prefs';
import { app as transactionsApp } from '#server/transactions/app';

beforeEach(global.emptyDatabase());

/**
 * These tests pin down the behaviour of Actual's import engine on the
 * UPDATE path, which is what decides whether a user's edit to an
 * already-imported transaction can be honoured.
 *
 * The findings, verified against the real engine:
 *
 *   - The update path computes `payee: existing.payee || trans.payee`, so
 *     the EXISTING payee wins and an incoming payee id is discarded. The
 *     same is true of `category` and `notes`.
 *   - `imported_id` is taken verbatim from the incoming payload.
 *   - `forceAddTransaction` routes the row down the ADD path, which
 *     CREATES A SECOND TRANSACTION rather than updating the first.
 *
 * That last point is the important one: `forceAddTransaction` is how
 * Actual's own import modal implements "keep both the old and the new
 * transaction", so it is the wrong tool for "change this transaction's
 * payee". A row whose payee or category the user edited is therefore
 * updated directly, through `transaction-update`, using the transaction id
 * that the import preview reported.
 */

const ACCOUNT = 'one';

async function setup() {
  await prefs.loadPrefs();
  await db.insertAccount({ id: ACCOUNT, name: 'Demo Checking' });
}

async function getRows() {
  return db.runQuery<{
    id: string;
    payee: string;
    imported_id: string | null;
    category: string | null;
    notes: string | null;
    amount: number;
  }>(
    'SELECT id, payee, imported_id, category, notes, amount FROM v_transactions WHERE account = ?',
    [ACCOUNT],
    true,
  );
}

describe('the import engine update path', () => {
  test('the existing payee wins over the incoming one', async () => {
    await setup();
    const firstPayee = await db.insertPayee({ name: 'Demo Payee One' });
    const secondPayee = await db.insertPayee({ name: 'Demo Payee Two' });

    const base = {
      date: '2026-09-07',
      amount: -2500,
      imported_payee: 'Demo Vendor',
      imported_id: 'FITID-1',
    };

    await reconcileTransactions(ACCOUNT, [{ ...base, payee: firstPayee }]);

    // A different note, so the update is actually reported. The payee
    // change on its own would not be: the existing payee wins, so no
    // field differs and nothing is written.
    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      { ...base, payee: secondPayee, notes: 'a different note' },
    ]);

    // It matched by imported_id and took the update path: no new row.
    expect(added.length).toBe(0);
    expect(updated.length).toBe(1);

    // The observable outcome: still ONE transaction, and its payee is the
    // existing one (`existing.payee || trans.payee`).
    const rows = await getRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payee).toBe(firstPayee);
    // The notes DID change, because the existing transaction had none.
    expect(rows[0].notes).toBe('a different note');
  });

  test('forceAddTransaction creates a second transaction, not an update', async () => {
    await setup();
    const firstPayee = await db.insertPayee({ name: 'Demo Payee One' });
    const secondPayee = await db.insertPayee({ name: 'Demo Payee Two' });

    const base = {
      date: '2026-09-07',
      amount: -2500,
      imported_payee: 'Demo Vendor',
      imported_id: 'FITID-1',
    };

    await reconcileTransactions(ACCOUNT, [{ ...base, payee: firstPayee }]);

    const { added, updated } = await reconcileTransactions(ACCOUNT, [
      { ...base, payee: secondPayee, forceAddTransaction: true },
    ]);

    // The forced row goes down the add path.
    expect(updated.length).toBe(0);
    expect(added.length).toBe(1);

    // So there are now TWO transactions. This is why the review layer
    // does NOT use forceAddTransaction for a user edit.
    const rows = await getRows();
    expect(rows.length).toBe(2);
    // One with the original payee, one with the new one.
    expect(rows.map(r => r.payee).sort()).toEqual(
      [firstPayee, secondPayee].sort(),
    );
  });

  test('a direct update changes the payee of an existing transaction', async () => {
    await setup();
    const firstPayee = await db.insertPayee({ name: 'Demo Payee One' });
    const secondPayee = await db.insertPayee({ name: 'Demo Payee Two' });

    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -2500,
        payee: firstPayee,
        imported_payee: 'Demo Vendor',
        imported_id: 'FITID-1',
      },
    ]);

    const rows = await getRows();
    expect(rows.length).toBe(1);

    // This is what the review layer does for a row the user edited: it
    // knows the transaction id from the import preview, and updates it
    // in place.
    //
    // `transaction-update` takes a whole transaction, but the server only
    // reads the fields that are present.
    await runHandler(transactionsApp.handlers['transaction-update'], {
      id: rows[0].id,
      account: ACCOUNT,
      amount: -2500,
      date: '2026-09-07',
      payee: secondPayee,
    });

    const after = await getRows();
    expect(after.length).toBe(1);
    expect(after[0].payee).toBe(secondPayee);
  });

  test('a direct update can also change the category', async () => {
    await setup();
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Groceries',
      cat_group: groupId,
    });

    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -2500,
        payee_name: 'Demo Vendor',
        imported_payee: 'Demo Vendor',
        imported_id: 'FITID-1',
      },
    ]);

    const rows = await getRows();
    expect(rows[0].category).toBeNull();

    await runHandler(transactionsApp.handlers['transaction-update'], {
      id: rows[0].id,
      account: ACCOUNT,
      amount: -2500,
      date: '2026-09-07',
      category,
    });

    const after = await getRows();
    expect(after[0].category).toBe(category);
  });

  test('the preview reports the matched transaction, so its id is known', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await reconcileTransactions(ACCOUNT, [
      {
        date: '2026-09-07',
        amount: -2500,
        payee,
        imported_payee: 'Demo Vendor',
        imported_id: 'FITID-1',
      },
    ]);

    const { updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [
        {
          date: '2026-09-07',
          amount: -2500,
          payee,
          imported_payee: 'Demo Vendor',
          imported_id: 'FITID-1',
          // A different note, so the preview reports the match with the
          // existing transaction rather than marking it ignored.
          notes: 'a different note',
        },
      ],
      { isPreview: true },
    );

    // The preview tells us which transaction the row matched, which is
    // what lets the review update it in place.
    expect(updatedPreview.length).toBe(1);
    expect(updatedPreview[0].existing).toBeTruthy();
    expect(updatedPreview[0].existing.id).toBeTruthy();
  });
});

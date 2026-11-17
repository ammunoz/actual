import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import * as prefs from '#server/prefs';

/**
 * The contract of the import PREVIEW.
 *
 * The review round-trips every row through the preview, and the echo
 * that comes back is how it learns what upstream's rule engine did to
 * the row. That echo is `updatedPreview`, and **what is in it depends
 * on what kind of row it is**.
 *
 * These tests pin that down, because the plan's mechanism depends on it
 * and nothing else states it. There are five kinds of row:
 *
 *   - MATCHED and DIFFERENT → `{ transaction, existing }`, with the
 *     existing transaction's id. That id is what lets the review update
 *     the matched transaction in place.
 *   - MATCHED and the SAME → `{ transaction, ignored: true }`, with no
 *     `existing`. There is nothing to report.
 *   - MATCHED and LOCKED → `{ transaction, ignored: true }`, with no
 *     `existing`, EVEN WHEN THE ROW DIFFERS. A reconciled transaction
 *     is not touched.
 *   - TOMBSTONE → `{ transaction, existing: false, tombstone: true }`.
 *     The `existing` is PRESENT and FALSY — not absent — so code that
 *     asks "is there an existing transaction?" has to tell `false` from
 *     `undefined`. A tombstone that MATCHES an existing transaction
 *     takes the match path instead, and never reaches this one.
 *   - NEW → nothing at all. It comes back in `added`, as its ID ONLY,
 *     and there is NO `updatedPreview` entry.
 *
 * A SKIPPED row (`skipTransaction`) is in none of them: it takes part in
 * the matching and then stops.
 *
 * A row marked `forceAddTransaction` also comes back as a new row — it
 * is added rather than matched — so it has the same hole as a NEW row.
 * The review never sets that flag: it is how Actual's own import modal
 * implements "keep both", and the review's job is to change the
 * transaction that matched, not to add a second one.
 *
 * The NEW row is the important one, and it is why the plan's "the echo
 * carries the rules' effect" is not enough on its own: for a new row —
 * the common case for an import — the preview says NOTHING about what a
 * rule did to it.
 *
 * The update path is pinned here too, because it decides what a rule
 * that changes a field can actually change: when the existing
 * transaction already HAS a category, the EXISTING value wins
 * (`existing.category || trans.category`), so a rule that sets a
 * category on a row that matched cannot change that transaction's
 * category. When the existing one has none, the incoming value is
 * used.
 */

beforeEach(global.emptyDatabase());

const ACCOUNT = 'one';

async function setup() {
  await prefs.loadPrefs();
  await db.insertAccount({ id: ACCOUNT, name: 'Demo Checking' });
}

/**
 * A transaction the file would send.
 *
 * The notes are what makes a row DIFFER from the one already in the
 * budget. That matters because the update path writes
 * `existing.notes || trans.notes` — so a row whose notes are already
 * there cannot be made to differ by changing anything else. The payee
 * change alone would not be reported: the existing payee wins.
 */
function incoming(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-07',
    amount: -2500,
    imported_payee: 'Demo Vendor',
    imported_id: 'FITID-1',
    ...overrides,
  };
}

/** The row as it was imported the FIRST time: with no notes. */
function original(overrides: Record<string, unknown> = {}) {
  return incoming(overrides);
}

/** The same row, with something that DIFFERS from the imported one. */
function changed(overrides: Record<string, unknown> = {}) {
  return incoming({ notes: 'a different note', ...overrides });
}

/** The ids of the transactions the budget holds for the account. */
function transactionIds(): string[] {
  const rows = db.runQuery<{ id: string }>(
    'SELECT id FROM v_transactions WHERE account = ?',
    [ACCOUNT],
    true,
  );
  return rows.map(row => row.id);
}

describe('what the preview reports', () => {
  test('a row that matched and differs comes back with the transaction it matched', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await reconcileTransactions(ACCOUNT, [original({ payee })]);

    const ids = transactionIds();
    expect(ids.length).toBe(1);
    const [transactionId] = ids;

    const { updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [changed({ payee, _previewKey: 'row-0' })],
      { isPreview: true },
    );

    expect(updatedPreview.length).toBe(1);
    const entry = updatedPreview[0];
    // The id is the whole point: it is what lets the review update the
    // matched transaction in place. It is the RIGHT id, not just an
    // id.
    expect(entry.existing?.id).toBe(transactionId);
    expect(entry.ignored).toBeFalsy();
    // The transaction that was sent comes back too, carrying the
    // transient key — which is how the review lines a row up with its
    // entry. The key starts with an underscore because the insert path
    // runs every field through `conform`, which throws on a field the
    // transactions table does not have.
    expect((entry.transaction as { _previewKey?: string })._previewKey).toBe(
      'row-0',
    );
  });

  test('a row that matched and does NOT differ comes back as ignored', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await reconcileTransactions(ACCOUNT, [original({ payee })]);

    const { updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [original({ payee })],
      { isPreview: true },
    );

    // Nothing differs, so there is nothing to report: the entry says
    // "ignored" and carries NO `existing`.
    //
    // `toBeUndefined`, not `toBeFalsy`: the tombstone entry carries
    // `existing: false`, which is PRESENT. This file exists to tell
    // those two apart, so it must not blur them.
    expect(updatedPreview.length).toBe(1);
    expect(updatedPreview[0].ignored).toBe(true);
    expect(updatedPreview[0].existing).toBeUndefined();
  });

  test('a row that matched a LOCKED transaction is ignored even when it differs', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await reconcileTransactions(ACCOUNT, [original({ payee })]);

    const ids = transactionIds();
    expect(ids.length).toBe(1);
    const [transactionId] = ids;
    // A reconciled transaction is locked: the import does not touch it.
    await db.update('transactions', { id: transactionId, reconciled: 1 });

    const { updatedPreview, updated } = await reconcileTransactions(
      ACCOUNT,
      [changed({ payee })],
      { isPreview: true },
    );

    // The row DIFFERS — it has a note the transaction does not have —
    // and it is still ignored, and it is not updated.
    expect(updatedPreview.length).toBe(1);
    expect(updatedPreview[0].ignored).toBe(true);
    expect(updatedPreview[0].existing).toBeUndefined();
    expect(updated.length).toBe(0);
  });

  test('a tombstone comes back with `existing: false`', async () => {
    await setup();

    const { updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [
        incoming({
          date: '2026-09-07',
          amount: -2500,
          tombstone: true,
        }),
      ],
      { isPreview: true },
    );

    expect(updatedPreview.length).toBe(1);
    const entry = updatedPreview[0];
    // PRESENT and FALSY. It is not the same as absent: code that asks
    // "is there an existing transaction?" has to tell `false` from
    // `undefined`.
    expect(entry.existing).toBe(false);
    expect(entry.tombstone).toBe(true);
  });

  test('a NEW row comes back in `added`, as its id only', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { added, updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [
        original({
          payee,
          // The key the review uses to line a row up with its preview
          // entry.
          _previewKey: 'row-0',
          imported_id: 'FITID-NEW',
        }),
      ],
      { isPreview: true },
    );

    // The row is new: the budget has nothing with that FITID.
    expect(added.length).toBe(1);
    expect(typeof added[0]).toBe('string');
    // **There is no `updatedPreview` entry for it.** The echo says
    // NOTHING about a new row — so it cannot say what a rule did to
    // one.
    expect(updatedPreview.length).toBe(0);
  });

  test('a new row and a matched row are told apart by the preview', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await reconcileTransactions(ACCOUNT, [original({ payee })]);

    const ids = transactionIds();
    expect(ids.length).toBe(1);
    const [transactionId] = ids;

    const { added, updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [
        // The matched row, with something that differs.
        changed({ payee, _previewKey: 'row-0' }),
        // The new row.
        original({
          payee,
          _previewKey: 'row-1',
          imported_id: 'FITID-NEW',
        }),
      ],
      { isPreview: true },
    );

    // One of each: the matched row is in the preview, the new one is
    // not.
    expect(updatedPreview.length).toBe(1);
    expect(updatedPreview[0].existing?.id).toBe(transactionId);
    expect(added.length).toBe(1);
  });

  test('a SKIPPED row is in none of them', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { added, updated, updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [
        original({
          payee,
          // The review marks a row it does not want with this, rather
          // than leaving it out, so it keeps taking part in the
          // matching.
          skipTransaction: true,
        }),
      ],
      { isPreview: true },
    );

    expect(added.length).toBe(0);
    expect(updated.length).toBe(0);
    expect(updatedPreview.length).toBe(0);
  });
});

describe('what the update path writes', () => {
  test('the existing category wins over the incoming one', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Category',
      cat_group: groupId,
    });
    const otherCategory = await db.insertCategory({
      name: 'Demo Other',
      cat_group: groupId,
    });

    await reconcileTransactions(ACCOUNT, [original({ payee, category })]);

    // A different category, and a note that differs, so the update is
    // actually reported.
    const { updated } = await reconcileTransactions(ACCOUNT, [
      changed({ payee, category: otherCategory }),
    ]);

    expect(updated.length).toBe(1);

    // `runQuery` with `fetchAll` is synchronous: it returns the rows.
    const rows = db.runQuery<{ category: string | null }>(
      'SELECT category FROM v_transactions WHERE account = ?',
      [ACCOUNT],
      true,
    );
    expect(rows.length).toBe(1);
    // `existing.category || trans.category` — the EXISTING category
    // wins, and the incoming one is discarded.
    expect(rows[0].category).toBe(category);
  });

  test('the incoming category is used when the existing one is empty', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Category',
      cat_group: groupId,
    });

    await reconcileTransactions(ACCOUNT, [original({ payee })]);

    await reconcileTransactions(ACCOUNT, [changed({ payee, category })]);

    const rows = db.runQuery<{ category: string | null }>(
      'SELECT category FROM v_transactions WHERE account = ?',
      [ACCOUNT],
      true,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].category).toBe(category);
  });
});

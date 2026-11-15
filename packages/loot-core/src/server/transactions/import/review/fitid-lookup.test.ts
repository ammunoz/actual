import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { q } from '#shared/query';

beforeEach(global.emptyDatabase());

/**
 * The review asks the budget which of its rows are ALREADY in the budget,
 * by the bank's transaction id (the FITID) — the key Actual's own matching
 * pass uses first.
 *
 * These tests pin down that question against the real engine, because the
 * review's answer to it decides whether a user's edit to an
 * already-imported transaction is applied in place or silently thrown away.
 */
describe('the FITID lookup', () => {
  test('finds the transactions that carry the FITIDs', async () => {
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });
    await db.insertTransaction({
      id: 'txn-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -2500,
      imported_id: 'FITID-1',
    });
    await db.insertTransaction({
      id: 'txn-2',
      account: 'acct-1',
      date: '2026-09-08',
      amount: -100,
      imported_id: 'FITID-2',
    });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ account: 'acct-1', imported_id: { $oneof: ['FITID-1'] } })
        .select(['id', 'imported_id']),
    );

    expect(data).toEqual([{ id: 'txn-1', imported_id: 'FITID-1' }]);
  });

  test('never finds a transaction in another account', async () => {
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });
    await db.insertAccount({ id: 'acct-2', name: 'Demo Savings' });
    await db.insertTransaction({
      id: 'txn-1',
      account: 'acct-2',
      date: '2026-09-07',
      amount: -2500,
      imported_id: 'FITID-1',
    });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ account: 'acct-1', imported_id: { $oneof: ['FITID-1'] } })
        .select(['id', 'imported_id']),
    );

    // A FITID is only unique WITHIN an account. A transaction in another
    // account that shares one is a different transaction, and editing it
    // would be editing the wrong row.
    expect(data).toEqual([]);
  });

  test('finds nothing for a transaction that is not there', async () => {
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ account: 'acct-1', imported_id: { $oneof: ['FITID-1'] } })
        .select(['id', 'imported_id']),
    );

    expect(data).toEqual([]);
  });
});

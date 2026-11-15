import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { q } from '#shared/query';

beforeEach(global.emptyDatabase());

/**
 * The review reconciles the legs of a split that is already in the budget.
 * It finds them by asking the budget for the transaction WITH its legs,
 * grouped under it.
 *
 * The way it asks matters: without the `splits: 'grouped'` option the
 * query returns the transactions one by one and leaves the SPLIT PARENTS
 * out entirely — a split is not a row of its own in that shape. The
 * reconciliation would then find no parent, and would silently do nothing
 * while the row was still held back from the import.
 */
describe('the split query', () => {
  test('returns a split parent with its legs under it', async () => {
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });
    await db.insertPayee({ id: 'pay-1', name: 'Demo Vendor' });
    await db.insertTransaction({
      id: 'txn-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -2500,
      payee: 'pay-1',
      is_parent: true,
      imported_id: 'FITID-1',
    });
    await db.insertTransaction({
      id: 'child-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -1500,
      is_child: true,
      parent_id: 'txn-1',
      sort_order: -1,
    });
    await db.insertTransaction({
      id: 'child-2',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -1000,
      is_child: true,
      parent_id: 'txn-1',
      sort_order: -2,
    });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ id: { $oneof: ['txn-1'] } })
        .select('*')
        .options({ splits: 'grouped' }),
    );

    const parent = (data as { id: string; subtransactions?: unknown[] }[])[0];
    expect(parent?.id).toBe('txn-1');
    // The legs are ON the parent, which is where the review reads them
    // from.
    expect(parent?.subtransactions).toHaveLength(2);
  });

  test('without the option, a split parent is not there at all', async () => {
    // This is why the option matters: the default shape leaves the split
    // parents out, so a review that did not ask for the legs grouped
    // would find nothing to reconcile.
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });
    await db.insertTransaction({
      id: 'txn-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -2500,
      is_parent: true,
      imported_id: 'FITID-1',
    });
    await db.insertTransaction({
      id: 'child-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -2500,
      is_child: true,
      parent_id: 'txn-1',
      sort_order: -1,
    });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ id: { $oneof: ['txn-1'] } })
        .select('*'),
    );

    expect(data).toEqual([]);
  });

  test('finds a transaction that is not a split yet', async () => {
    await db.insertAccount({ id: 'acct-1', name: 'Demo Checking' });
    await db.insertTransaction({
      id: 'txn-1',
      account: 'acct-1',
      date: '2026-09-07',
      amount: -2500,
      imported_id: 'FITID-1',
    });

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ id: { $oneof: ['txn-1'] } })
        .select('*')
        .options({ splits: 'grouped' }),
    );

    expect(data).toHaveLength(1);
  });
});

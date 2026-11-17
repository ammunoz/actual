import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import * as prefs from '#server/prefs';
import { insertRule, loadRules } from '#server/transactions/transaction-rules';

/**
 * The contract of `ruledTransactions`.
 *
 * The import runs the rules BEFORE it matches or adds anything, so the
 * rules' effect on a row is settled before the row is written. This is the
 * preview's answer to "what will a rule do to this row", and it is the
 * only place the answer exists: `added` carries ids and `updatedPreview`
 * carries only the rows that matched something.
 *
 * These tests pin what `ruledTransactions` IS, because the review's whole
 * rule lock rests on it:
 *
 *   - ONE ENTRY PER ROW THAT CAME IN, IN ORDER. The review lines a row up
 *     with its entry by the transient `_previewKey`, and the order is what
 *     makes the list readable when the key is missing.
 *   - THE TRANSACTION AS THE RULES LEFT IT. A field a rule set carries the
 *     rule's value.
 *   - NO ID. The id is minted later, on the insert path, and the review
 *     does not want one.
 *   - NO `payee_name`. It is a field the rule engine matches on, not a
 *     transaction column, and upstream strips it.
 *   - THE TRANSIENT `_previewKey` KEPT. It is how the review lines a row
 *     up with its entry, and it is harmless: the insert path runs every
 *     field through `conform`, which ignores a field whose name starts
 *     with an underscore.
 *
 * A test's NAME is the fact it pins. A failure here says which of these
 * upstream changed, which is what makes a conflict safe to resolve.
 */

beforeEach(global.emptyDatabase());

const ACCOUNT = 'one';

async function setup() {
  await prefs.loadPrefs();
  await loadMappings();
  await db.insertAccount({ id: ACCOUNT, name: 'Demo Checking' });
}

/** A transaction the file would send. */
function incoming(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-07',
    amount: -2500,
    imported_payee: 'Demo Vendor',
    imported_id: 'FITID-1',
    ...overrides,
  };
}

describe('the ruled transactions the preview reports', () => {
  test('there is one per row that came in, and they are in order', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [
        incoming({ payee, imported_id: 'FITID-1', _previewKey: 'row-0' }),
        incoming({ payee, imported_id: 'FITID-2', _previewKey: 'row-1' }),
        incoming({ payee, imported_id: 'FITID-3', _previewKey: 'row-2' }),
      ],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    // One per row, not one per row that MATCHED: the rows that matched
    // something are reported in `updatedPreview`, and the rows that are
    // new are reported nowhere else.
    expect(ruled).toHaveLength(3);
    // In the order they came in, and each carrying the transient key the
    // review lines a row up with. The key is what proves these are the
    // rows that came in, and that they came in in this order.
    expect(
      ruled.map(trans => (trans as { _previewKey?: string })._previewKey),
    ).toEqual(['row-0', 'row-1', 'row-2']);
  });

  test('a ruled transaction carries the value a rule set', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Category',
      cat_group: groupId,
    });

    await loadRules();
    await insertRule({
      id: 'rule-category',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'category', value: category }],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    expect(ruled).toHaveLength(1);
    // The rule's value. The row was sent with NO category, so the only
    // way a category can be on it is the rule.
    expect(ruled[0].category).toBe(category);
  });

  test('a ruled transaction has no id', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { ruledTransactions, added } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    // The `added` row DOES have an id — that is what `added` carries.
    expect(typeof added[0]).toBe('string');
    // The ruled transaction does not: the id is minted later, on the
    // insert path, and a ruled transaction is the transaction the rules
    // worked on, before anything was written.
    expect(ruled[0].id).toBeUndefined();
  });

  test('a ruled transaction has no payee_name, even though a rule set one', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await loadRules();
    await insertRule({
      id: 'rule-payee-name',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee_name', value: 'Another Payee' }],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    // The rule DID set a payee name: the transaction's payee is now the
    // one the rule named, not the one that was sent. The rule's payee was
    // created by the preview, so it comes back as an id.
    expect(typeof ruled[0].payee).toBe('string');
    expect(ruled[0].payee).not.toBe(payee);
    // And the name itself is not on the transaction that came back: it is
    // a field the engine matches on, not a transaction column.
    expect((ruled[0] as { payee_name?: string }).payee_name).toBeUndefined();
  });

  test('a ruled transaction keeps the transient preview key', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    await loadRules();
    await insertRule({
      id: 'rule-notes',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'notes', value: 'ruled' }],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee, _previewKey: 'row-0' })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);

    // The rules DID something to the transaction...
    expect(ruled[0].notes).toBe('ruled');
    // ...and the key is still there. The key is how the review lines a
    // row up with its entry, so it has to survive the rules.
    expect((ruled[0] as { _previewKey?: string })._previewKey).toBe('row-0');
  });

  test('a row the rules did not touch is still reported', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    // No rule fired, but the row is still there: the review needs one
    // entry per row to line the rows up, whether or not a rule touched
    // it.
    expect(ruled).toHaveLength(1);
    expect(ruled[0].imported_payee).toBe('Demo Vendor');
  });

  test('a row marked to be skipped is still reported', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [
        incoming({
          payee,
          _previewKey: 'row-0',
          // The review marks a row it does not want with this, rather than
          // leaving it out, so it keeps taking part in the matching.
          skipTransaction: true,
        }),
      ],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];

    // The skip happens on the WRITE path. The row still needs an entry of
    // its own here, or the review cannot line the rows up.
    expect(ruled).toHaveLength(1);
    expect((ruled[0] as { _previewKey?: string })._previewKey).toBe('row-0');
  });

  test('the real import does not report them', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const { ruledTransactions } = await reconcileTransactions(ACCOUNT, [
      incoming({ payee }),
    ]);

    // The real import does not need to know what the rules did — and its
    // response is what an API caller pays for.
    expect(ruledTransactions).toBeUndefined();
  });
});

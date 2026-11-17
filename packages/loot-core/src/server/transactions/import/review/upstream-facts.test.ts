import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import * as prefs from '#server/prefs';
import {
  finalizeTransactionForRules,
  insertRule,
  loadRules,
  prepareTransactionForRules,
  runRulesWithAppliedRules,
} from '#server/transactions/transaction-rules';
import type { TransactionForRules } from '#server/transactions/transaction-rules';

/**
 * The facts about upstream's engine that the review's rule lock leans on.
 *
 * The review does not re-implement the rule engine — it asks the engine
 * what it did. That is only safe as long as the engine behaves the way the
 * review assumes, and upstream is free to change it.
 *
 * **These tests pin FACTS, not implementations.** They say "the rules run
 * before the matching", not "the rules run on line 878". An upstream
 * refactor that keeps the fact does not break them, and an upstream
 * change that breaks the fact breaks them with a message that says which
 * fact broke — which is what makes a conflict safe to resolve rather than
 * a guess.
 *
 * A test's NAME is the fact it pins.
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

/** The categories of the transactions the budget holds for the account. */
function transactionCategories(): (string | null)[] {
  const rows = db.runQuery<{ category: string | null }>(
    'SELECT category FROM v_transactions WHERE account = ?',
    [ACCOUNT],
    true,
  );
  return rows.map(row => row.category);
}

describe('the facts the rule lock leans on', () => {
  test('the rules run before the matching, so a MATCHED row carries the rule value', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Category',
      cat_group: groupId,
    });

    // The row is in the budget already.
    await reconcileTransactions(ACCOUNT, [incoming({ payee })]);

    await loadRules();
    await insertRule({
      id: 'rule-category',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'category', value: category }],
    });

    const { ruledTransactions, updatedPreview } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);

    // The row MATCHED — there is an `updatedPreview` entry for it — and
    // the rule still ran on it. The rules run first; the matching comes
    // after.
    expect(updatedPreview.length).toBe(1);
    expect(ruled[0].category).toBe(category);
  });

  test('the update path prefers the existing value over the rule value', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const existingCategory = await db.insertCategory({
      name: 'Existing Category',
      cat_group: groupId,
    });
    const ruleCategory = await db.insertCategory({
      name: 'Rule Category',
      cat_group: groupId,
    });

    await reconcileTransactions(ACCOUNT, [
      incoming({ payee, category: existingCategory }),
    ]);

    await loadRules();
    await insertRule({
      id: 'rule-category',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'category', value: ruleCategory }],
    });

    // The rule fired: the preview says the row's category is the rule's.
    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ payee })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);
    expect(ruled[0].category).toBe(ruleCategory);

    await reconcileTransactions(ACCOUNT, [incoming({ payee })]);

    // `existing.category || trans.category` — the EXISTING category wins,
    // so a rule cannot change the category of a transaction that is
    // already in the budget. This is why the review's lock applies only
    // to the rows the import ADDS.
    expect(transactionCategories()).toEqual([existingCategory]);
  });

  test('the insert path writes the rule value for a NEW row', async () => {
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

    await reconcileTransactions(ACCOUNT, [incoming({ payee })]);

    // A NEW row takes the rule's value unconditionally. This is the case
    // the review's lock is about.
    expect(transactionCategories()).toEqual([category]);
  });

  test('a rule set is unconditional: it replaces the value the row carried', async () => {
    await setup();
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const sentCategory = await db.insertCategory({
      name: 'Sent Category',
      cat_group: groupId,
    });
    const ruleCategory = await db.insertCategory({
      name: 'Rule Category',
      cat_group: groupId,
    });

    await loadRules();
    await insertRule({
      id: 'rule-category',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'category', value: ruleCategory }],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({ category: sentCategory })],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);

    // The row carried the other category, and the rule's action is not a
    // suggestion: it replaced it.
    expect(ruled[0].category).toBe(ruleCategory);
  });

  test('the transaction the rules worked on keeps the transient preview key', async () => {
    await setup();

    const { transaction } = await runRulesWithAppliedRules({
      date: '2026-09-07',
      amount: -2500,
      imported_payee: 'Demo Vendor',
      _previewKey: 'row-0',
    });

    // The review lines a row up with its preview entry by this key, so it
    // has to survive the rules.
    expect((transaction as { _previewKey?: string })._previewKey).toBe('row-0');
  });

  test('the rule engine sees the payee by name, and the finalized transaction does not', async () => {
    await setup();
    const payee = await db.insertPayee({ name: 'Demo Payee One' });

    const prepared = await prepareTransactionForRules(
      {
        id: 'a-transaction',
        account: ACCOUNT,
        amount: -2500,
        date: '2026-09-07',
        payee,
      },
      null,
      { includeBalance: false },
    );

    // The engine matches on the payee's NAME — that is how a rule can
    // say "this payee" without knowing its id.
    expect(prepared.payee_name).toBe('Demo Payee One');
    // And the account is there too, for the rules that match on it.
    expect(prepared._account?.name).toBe('Demo Checking');

    const result = await finalizeTransactionForRules(prepared);

    // `payee_name` is stripped before the transaction is returned: it is
    // a field the engine matches on, not a transaction column.
    expect('payee_name' in result).toBe(false);
    // `_account` is kept: the rule engine's own bookkeeping. (The return
    // type does not say so — the field is not a transaction column.)
    expect((result as TransactionForRules)._account?.name).toBe(
      'Demo Checking',
    );
  });

  test('an action with splitIndex 0 sets the field on the transaction, not on a leg', async () => {
    await setup();
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
      actions: [
        {
          op: 'set',
          field: 'category',
          value: category,
          // The rules editor writes `splitIndex: 0` on every action it
          // adds: it is the pre-split group, and it sets the field on the
          // transaction itself. The engine's own test for "this is a leg"
          // is a TRUTHY split index.
          options: { splitIndex: 0 },
        },
      ],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({})],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);

    // The transaction's own category is the rule's, and there is no split.
    expect(ruled[0].category).toBe(category);
    expect(ruled[0].subtransactions).toBeUndefined();
  });

  test('an action with a split index sets the field on a leg, not on the transaction', async () => {
    await setup();
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
      actions: [
        {
          op: 'set',
          field: 'category',
          value: category,
          options: { splitIndex: 1 },
        },
      ],
    });

    const { ruledTransactions } = await reconcileTransactions(
      ACCOUNT,
      [incoming({})],
      { isPreview: true },
    );
    const ruled = ruledTransactions ?? [];
    expect(ruled).toHaveLength(1);

    // The transaction's own category is NOT the rule's: the rule set the
    // category on a leg.
    expect(ruled[0].category).not.toBe(category);
    expect(ruled[0].subtransactions).toBeDefined();
  });
});

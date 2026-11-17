import { reconcileTransactions } from '#server/accounts/sync';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import * as prefs from '#server/prefs';
import { Action } from '#server/rules';
import {
  insertRule,
  loadRules,
  ruleSetFields,
} from '#server/transactions/transaction-rules';

/**
 * The attribution: which rules fired, and which fields they took.
 *
 * The review has to say "a rule sets this field", and it has to say WHICH
 * rule, so the user can go and change it. The engine knows both, so the
 * engine reports them: the transaction carries `_appliedRules`, and each
 * entry names a rule and the fields it set.
 *
 * **The fields are the rule's ACTIONS' fields, not the ones whose value
 * happened to change.** A rule that sets the category to the value the
 * transaction already had still CONTROLS the category: an edit to it would
 * be discarded when the rule runs again. So a report built from the changed
 * values would miss exactly the case the review exists to catch.
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

/**
 * The rules the preview reported for the first row.
 *
 * The rules ride on the transaction, so this reads them off the row the
 * preview reported.
 */
async function appliedRulesFor(
  overrides: Record<string, unknown> = {},
): Promise<{
  rules: unknown[];
  transaction: Record<string, unknown>;
  sentPayee: string;
}> {
  const payee = await db.insertPayee({ name: 'Demo Payee One' });
  const { ruledTransactions } = await reconcileTransactions(
    ACCOUNT,
    [incoming({ payee, ...overrides })],
    { isPreview: true },
  );
  const ruled = ruledTransactions ?? [];
  expect(ruled).toHaveLength(1);
  return {
    rules: ruled[0]._appliedRules ?? [],
    transaction: ruled[0] as unknown as Record<string, unknown>,
    sentPayee: payee,
  };
}

describe('the rules the preview reports', () => {
  test('a rule that fired is reported with the fields it set', async () => {
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
      actions: [{ op: 'set', field: 'category', value: category }],
    });

    const { rules } = await appliedRulesFor();

    expect(rules).toEqual([{ id: 'rule-category', fields: ['category'] }]);
  });

  test('a rule that set a field to the value the transaction already had is still reported', async () => {
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
      actions: [{ op: 'set', field: 'category', value: category }],
    });

    // The row was sent with the category the rule sets, so NOTHING about
    // the transaction changed. The rule still controls the category.
    const { rules } = await appliedRulesFor({ category });

    expect(rules).toEqual([{ id: 'rule-category', fields: ['category'] }]);
  });

  test('a rule that did not fire is not reported', async () => {
    await setup();

    await loadRules();
    await insertRule({
      id: 'rule-other-vendor',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'is', field: 'imported_payee', value: 'Some Other Vendor' },
      ],
      actions: [{ op: 'set', field: 'notes', value: 'not this row' }],
    });

    const { rules, transaction } = await appliedRulesFor();

    expect(rules).toEqual([]);
    // And the rule's action did not happen, so the report is not just
    // empty by accident.
    expect(transaction.notes).toBeUndefined();
  });

  test('the rules are reported in the order they ran', async () => {
    await setup();

    await loadRules();
    await insertRule({
      id: 'rule-first',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'notes', value: 'first' }],
    });
    await insertRule({
      id: 'rule-second',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'category', value: 'a-category' }],
    });

    const { rules } = await appliedRulesFor();

    expect(rules).toEqual([
      { id: 'rule-first', fields: ['notes'] },
      { id: 'rule-second', fields: ['category'] },
    ]);
  });

  test('a rule that sets the payee by name claims the payee', async () => {
    await setup();

    await loadRules();
    await insertRule({
      id: 'rule-payee',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee_name', value: 'Another Payee' }],
    });

    const { rules, transaction, sentPayee } = await appliedRulesFor();

    // The field is `payee`, because that is the field the TRANSACTION
    // names: the action sets the payee by name, and the engine resolves
    // the name to an id. A report that said `payee_name` would name a
    // field the transaction does not have.
    expect(rules).toEqual([{ id: 'rule-payee', fields: ['payee'] }]);
    // And the payee the rule chose is on the transaction as an id — not
    // the one that was sent.
    expect(typeof transaction.payee).toBe('string');
    expect(transaction.payee).not.toBe(sentPayee);
  });

  test('a rule that sets a field with splitIndex 0 claims the field', async () => {
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
          // The rules editor writes `splitIndex: 0` on EVERY action it
          // adds — it is the pre-split group, and it sets the field on the
          // transaction itself.
          options: { splitIndex: 0 },
        },
      ],
    });

    const { rules, transaction } = await appliedRulesFor();

    // The category IS the transaction's, so the rule claims it — and the
    // transaction carries the rule's value.
    expect(rules).toEqual([{ id: 'rule-category', fields: ['category'] }]);
    expect(transaction.category).toBe(category);
  });

  test('a rule that sets a field on a split leg does not claim the transaction field', async () => {
    await setup();
    const groupId = await db.insertCategoryGroup({ name: 'Demo Group' });
    const category = await db.insertCategory({
      name: 'Demo Category',
      cat_group: groupId,
    });

    await loadRules();
    await insertRule({
      id: 'rule-split',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [
        {
          op: 'set',
          field: 'category',
          value: category,
          // A TRUTHY split index is a leg: the engine puts the action in
          // `childActions`.
          options: { splitIndex: 1 },
        },
      ],
    });

    const { rules, transaction } = await appliedRulesFor();

    // The action set the category on a LEG of the split, not on the
    // transaction, so the transaction's own category is not the rule's to
    // claim.
    expect(rules).toEqual([{ id: 'rule-split', fields: [] }]);
    // And the transaction's own category is untouched: the rule's value
    // is on the leg.
    expect(transaction.category).not.toBe(category);
    // The rule's value IS on the leg, so the rule really did run.
    const legs = transaction.subtransactions as { category?: string }[];
    expect(legs[0]?.category).toBe(category);
  });

  test('a rule that deletes the transaction claims the tombstone', async () => {
    await setup();

    await loadRules();
    await insertRule({
      id: 'rule-delete',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'delete-transaction', value: 'x' }],
    });

    const { rules, transaction } = await appliedRulesFor();

    // The rule does not set a value the user can edit — it removes the
    // row — but the report says what it did, so the caller is not left
    // guessing.
    expect(rules).toEqual([{ id: 'rule-delete', fields: ['tombstone'] }]);
    expect(transaction.tombstone).toBe(1);
  });
});

/**
 * The fields a rule's actions set — the whole table.
 *
 * The engine's split test is duplicated in `ruleSetFields`, because the
 * engine's own predicate lives in a file the fork does not otherwise
 * touch. This table pins the fork's copy of it, over every action the
 * rules editor can write. The engine's side is pinned by the two tests
 * above that run a real rule through the real engine, one with
 * `splitIndex: 0` and one with a leg's index — if the engine's predicate
 * moves, those fail.
 */
describe('the fields a rule action sets', () => {
  const cases: { name: string; action: Action; fields: string[] }[] = [
    {
      name: 'a set action sets its field',
      action: new Action('set', 'category', 'a-category', undefined),
      fields: ['category'],
    },
    {
      name: 'a set action with splitIndex 0 sets its field',
      action: new Action('set', 'category', 'a-category', { splitIndex: 0 }),
      fields: ['category'],
    },
    {
      name: 'a set action with a split index sets a leg, not the field',
      action: new Action('set', 'category', 'a-category', { splitIndex: 1 }),
      fields: [],
    },
    {
      name: 'a set action on the payee by name sets the payee',
      action: new Action('set', 'payee_name', 'A Payee', undefined),
      fields: ['payee'],
    },
    {
      name: 'a set action on the payee by id sets the payee',
      action: new Action('set', 'payee', 'a-payee-id', undefined),
      fields: ['payee'],
    },
    {
      name: 'a split amount with a fixed amount sets the amount',
      action: new Action('set-split-amount', null, 100, {
        method: 'fixed-amount',
      }),
      fields: ['amount'],
    },
    {
      name: 'a split amount by formula sets the amount',
      action: new Action('set-split-amount', null, null, {
        method: 'formula',
        formula: '=1',
      }),
      fields: ['amount'],
    },
    {
      name: 'a split amount by percentage sets nothing on its own',
      action: new Action('set-split-amount', null, 50, {
        method: 'fixed-percent',
      }),
      fields: [],
    },
    {
      name: 'a split amount by remainder sets nothing on its own',
      action: new Action('set-split-amount', null, null, {
        method: 'remainder',
      }),
      fields: [],
    },
    {
      name: 'a split amount with a split index sets a leg, not the amount',
      action: new Action('set-split-amount', null, 100, {
        method: 'fixed-amount',
        splitIndex: 1,
      }),
      fields: [],
    },
    {
      name: 'a prepended note sets the notes',
      action: new Action('prepend-notes', null, 'a note', undefined),
      fields: ['notes'],
    },
    {
      name: 'an appended note sets the notes',
      action: new Action('append-notes', null, 'a note', undefined),
      fields: ['notes'],
    },
    {
      name: 'a prepended note with a split index sets a leg, not the notes',
      action: new Action('prepend-notes', null, 'a note', { splitIndex: 1 }),
      fields: [],
    },
    {
      name: 'an appended note with a split index sets a leg, not the notes',
      action: new Action('append-notes', null, 'a note', { splitIndex: 1 }),
      fields: [],
    },
    {
      name: 'a linked schedule sets the schedule',
      action: new Action('link-schedule', null, 'a-schedule-id', undefined),
      fields: ['schedule'],
    },
    {
      name: 'a linked schedule with a split index sets a leg, not the schedule',
      action: new Action('link-schedule', null, 'a-schedule-id', {
        splitIndex: 1,
      }),
      fields: [],
    },
    {
      name: 'a deleted transaction sets the tombstone',
      action: new Action('delete-transaction', null, 'x', undefined),
      fields: ['tombstone'],
    },
    {
      name: 'a deletion with a split index sets a leg, not the tombstone',
      action: new Action('delete-transaction', null, 'x', { splitIndex: 1 }),
      fields: [],
    },
  ];

  for (const { name, action, fields } of cases) {
    test(name, () => {
      expect(ruleSetFields({ actions: [action] })).toEqual(fields);
    });
  }

  test('a rule with no actions sets no fields', () => {
    expect(ruleSetFields({ actions: [] })).toEqual([]);
  });

  test('a rule with two actions on the same field sets it once', () => {
    const action = new Action('set', 'category', 'a-category', undefined);
    expect(ruleSetFields({ actions: [action, action] })).toEqual(['category']);
  });
});

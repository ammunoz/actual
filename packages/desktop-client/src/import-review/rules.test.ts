import {
  buildPreviewState,
  resolvePayees,
  rowKey,
  updateEdits,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  ImportPreviewState,
  PreviewEdits,
  PreviewRow,
  ReviewCategory,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';
import type { RuleEntity } from '@actual-app/core/types/models/rule';

import {
  alreadySets,
  payeeToCategoryRule,
  rowPayeeTarget,
  rulesForRow,
  ruleToWrite,
  sameConditions,
  vendorToPayeeRule,
} from './rules';

const PAYEES: readonly ReviewPayee[] = [
  { id: 'p-coffee', name: 'Demo Coffee Shop' },
  { id: 'p-other', name: 'Demo Other Payee' },
];

const CATEGORIES: readonly ReviewCategory[] = [
  { id: 'c-coffee', name: 'Coffee Shops', groupName: 'Dining' },
];

/** The review's state, with one row, as the resolver and the preview build it. */
function mkState(overrides: Record<string, unknown> = {}): ImportPreviewState {
  const resolved = resolvePayees(
    [
      {
        accountId: 'a-1',
        importedId: 'fit-1',
        date: '2026-09-07',
        amountCents: -2500,
        payeeRaw: 'Demo Coffee Shop Downtown',
        previewKey: 'row-0',
        ...overrides,
      },
    ] as never,
    {
      existingPayees: PAYEES,
      accounts: [{ id: 'a-checking', name: 'Demo Checking' }],
    },
  );
  return buildPreviewState(resolved, 'cautious');
}

/** The row, with the user's edits applied. */
function mkRow(edits: PreviewEdits = {}): PreviewRow {
  const state = mkState();
  const next = updateEdits(state, rowKey(state.rows[0]), edits);
  return next.rows[0];
}

describe('the vendor rule', () => {
  it('matches the raw vendor string, exactly', () => {
    const rule = vendorToPayeeRule('Demo Coffee', {
      kind: 'id',
      id: 'p-coffee',
    });

    expect(rule.conditions).toEqual([
      { op: 'is', field: 'imported_payee', value: 'Demo Coffee' },
    ]);
    expect(rule.actions).toEqual([
      { op: 'set', field: 'payee', value: 'p-coffee' },
    ]);
  });

  it('names a payee the budget does not have yet', () => {
    // There is no id for a payee that does not exist, so the rule names
    // it and upstream creates it the first time the rule fires.
    const rule = vendorToPayeeRule('Demo Coffee', {
      kind: 'name',
      name: 'Demo Coffee',
    });

    expect(rule.actions).toEqual([
      { op: 'set', field: 'payee_name', value: 'Demo Coffee' },
    ]);
  });

  it('runs before the transaction is posted', () => {
    expect(vendorToPayeeRule('X', { kind: 'id', id: 'p' }).stage).toBe('pre');
  });
});

describe('the category rule', () => {
  it('matches the payee by id, not by the vendor string', () => {
    const rule = payeeToCategoryRule('p-coffee', 'c-coffee');

    expect(rule.conditions).toEqual([
      { op: 'is', field: 'payee', value: 'p-coffee' },
    ]);
    expect(rule.actions).toEqual([
      { op: 'set', field: 'category', value: 'c-coffee' },
    ]);
  });
});

describe('same conditions', () => {
  it('is true for the same conditions', () => {
    expect(
      sameConditions(
        {
          conditionsOp: 'and',
          conditions: vendorToPayeeRule('A', { kind: 'id', id: 'p' })
            .conditions,
        },
        {
          conditionsOp: 'and',
          conditions: vendorToPayeeRule('A', { kind: 'id', id: 'q' })
            .conditions,
        },
      ),
    ).toBe(true);
  });

  it('is false for a different value', () => {
    expect(
      sameConditions(
        {
          conditionsOp: 'and',
          conditions: vendorToPayeeRule('A', { kind: 'id', id: 'p' })
            .conditions,
        },
        {
          conditionsOp: 'and',
          conditions: vendorToPayeeRule('B', { kind: 'id', id: 'p' })
            .conditions,
        },
      ),
    ).toBe(false);
  });

  it('is false for a different operator', () => {
    expect(
      sameConditions(
        {
          conditionsOp: 'and',
          conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
        },
        {
          conditionsOp: 'and',
          conditions: [{ op: 'contains', field: 'imported_payee', value: 'A' }],
        },
      ),
    ).toBe(false);
  });

  it('is false for a different field', () => {
    expect(
      sameConditions(
        {
          conditionsOp: 'and',
          conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
        },
        {
          conditionsOp: 'and',
          conditions: [{ op: 'is', field: 'notes', value: 'A' }],
        },
      ),
    ).toBe(false);
  });

  it('is false for a different operator between the conditions', () => {
    expect(
      sameConditions(
        { conditionsOp: 'and', conditions: [] },
        { conditionsOp: 'or', conditions: [] },
      ),
    ).toBe(false);
  });
});

describe('the action a rule already has', () => {
  it('is found', () => {
    const rule = vendorToPayeeRule('A', { kind: 'id', id: 'p-coffee' });

    expect(alreadySets(rule, 'payee', 'p-coffee')).toBe(true);
    expect(alreadySets(rule, 'payee', 'p-other')).toBe(false);
    expect(alreadySets(rule, 'category', 'p-coffee')).toBe(false);
  });
});

describe('the rule to write', () => {
  it('adds a rule when there is none', () => {
    const { method, rule } = ruleToWrite(
      [],
      vendorToPayeeRule('A', { kind: 'id', id: 'p' }),
    );

    expect(method).toBe('rule-add');
    expect(rule).not.toHaveProperty('id');
  });

  it('amends a rule with the same conditions', () => {
    // Two rules with the same conditions are a tie, and upstream breaks
    // the tie on the rule id — a random UUID. So a second rule would
    // have an unpredictable winner.
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-old' }],
    };

    const { method, rule } = ruleToWrite(
      [existing],
      vendorToPayeeRule('A', { kind: 'id', id: 'p-new' }),
    );

    expect(method).toBe('rule-update');
    expect(rule).toEqual({
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
      // The action on the SAME field is REPLACED, not added: two
      // actions on one field would contradict each other.
      actions: [{ op: 'set', field: 'payee', value: 'p-new' }],
    });
  });

  it('does not treat a rule that says two things as saying this', () => {
    // The rule sets the field twice, and the LAST action wins. So it
    // does not say what the user asked for, and the review must not
    // answer "already says this".
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
      actions: [
        { op: 'set', field: 'payee', value: 'p-coffee' },
        { op: 'set', field: 'payee', value: 'p-other' },
      ],
    };

    const { method } = ruleToWrite(
      [existing],
      vendorToPayeeRule('A', { kind: 'id', id: 'p-coffee' }),
    );

    expect(method).toBe('rule-update');
  });

  it('keeps the actions on the fields the new rule does not set', () => {
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
      actions: [
        { op: 'set', field: 'payee', value: 'p-old' },
        { op: 'set', field: 'category', value: 'c-old' },
      ],
    };

    const { rule } = ruleToWrite(
      [existing],
      vendorToPayeeRule('A', { kind: 'id', id: 'p-new' }),
    );

    expect((rule as RuleEntity).actions).toEqual([
      { op: 'set', field: 'category', value: 'c-old' },
      { op: 'set', field: 'payee', value: 'p-new' },
    ]);
  });

  it('does not write a rule that already says the same thing', () => {
    // A write that changes nothing still takes a step in the undo
    // history and still syncs, so there is no write at all.
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'A' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-coffee' }],
    };

    const { method, rule } = ruleToWrite(
      [existing],
      vendorToPayeeRule('A', { kind: 'id', id: 'p-coffee' }),
    );

    expect(method).toBe('none');
    expect(rule).toEqual(existing);
  });
});

describe('the payee a row would be imported with', () => {
  it('is the one the user chose, by id', () => {
    const row = mkRow({ payeeCanonical: 'Demo Other Payee' });

    expect(rowPayeeTarget(row, PAYEES)).toEqual({
      kind: 'id',
      id: 'p-other',
    });
  });

  it('is named, not an id, when the budget does not have the payee', () => {
    const row = mkRow({ payeeCanonical: 'A New Payee' });

    expect(rowPayeeTarget(row, PAYEES)).toEqual({
      kind: 'name',
      name: 'A New Payee',
    });
  });

  it('is the one the resolver matched', () => {
    // "Demo Coffee Shop" is a prefix of the raw vendor string, so the
    // resolver's prefix layer matches it.
    const row = mkRow();

    expect(rowPayeeTarget(row, PAYEES)).toEqual({
      kind: 'id',
      id: 'p-coffee',
    });
  });

  it('is nothing for a transfer', () => {
    // A transfer's payee is the hidden payee Actual keeps for one
    // account. A rule that named it would be about transfers, not about
    // a vendor.
    const row = mkRow({ transferAccountId: 'a-checking' });

    expect(rowPayeeTarget(row, PAYEES)).toBeUndefined();
  });
});

describe('the rules a row can offer', () => {
  it('offers the vendor rule', () => {
    const rules = rulesForRow(mkRow(), PAYEES, CATEGORIES);

    expect(rules.vendorToPayee).toEqual({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        {
          op: 'is',
          field: 'imported_payee',
          value: 'Demo Coffee Shop Downtown',
        },
      ],
      actions: [{ op: 'set', field: 'payee', value: 'p-coffee' }],
    });
  });

  it('does not offer the category rule without a category', () => {
    const rules = rulesForRow(mkRow(), PAYEES, CATEGORIES);

    expect(rules.payeeToCategory).toBeUndefined();
  });

  it('offers the category rule once a category is picked', () => {
    const row = mkRow({ categoryId: 'c-coffee' });

    const rules = rulesForRow(row, PAYEES, CATEGORIES);

    expect(rules.payeeToCategory).toEqual({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: 'p-coffee' }],
      actions: [{ op: 'set', field: 'category', value: 'c-coffee' }],
    });
  });

  it('does not offer the category rule for a category the budget has lost', () => {
    // A stale id would make a rule that never fires.
    const row = mkRow({ categoryId: 'c-gone' });

    const rules = rulesForRow(row, PAYEES, CATEGORIES);

    expect(rules.payeeToCategory).toBeUndefined();
  });

  it('does not offer the category rule for a payee that has no id', () => {
    // The condition matches on the payee ID, and a payee the budget
    // does not have yet has none.
    const row = mkRow({
      payeeCanonical: 'A New Payee',
      categoryId: 'c-coffee',
    });

    const rules = rulesForRow(row, PAYEES, CATEGORIES);

    expect(rules.vendorToPayee).toBeDefined();
    expect(rules.payeeToCategory).toBeUndefined();
  });
});

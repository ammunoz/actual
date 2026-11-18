import type { RuleEntity } from '@actual-app/core/types/models/rule';
import { describe, expect, it } from 'vitest';

import { describeRule } from './rule-descriptions';

const names = {
  payeeNames: new Map([
    ['payee-1', 'Kroger'],
    ['payee-2', 'Demo Grocery Store'],
  ]),
  categoryNames: new Map([['category-1', 'Food']]),
};

function rule(overrides: Partial<RuleEntity> = {}): RuleEntity {
  return {
    id: 'rule-1',
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [],
    actions: [],
    ...overrides,
  };
}

describe('describeRule', () => {
  it('says what a vendor rule matches and what it does', () => {
    // The vendor string is the file's own string, and the rule will see
    // it exactly as the file spells it on every future import.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'SQ *BLUE BOTTLE' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'payee-1' }],
      }),
      names,
    );

    expect(described).toEqual({
      from: 'SQ *BLUE BOTTLE',
      to: 'Kroger',
    });
  });

  it('says the payee a rule matches by name, not by id', () => {
    const described = describeRule(
      rule({
        conditions: [{ op: 'is', field: 'payee', value: 'payee-2' }],
        actions: [{ op: 'set', field: 'category', value: 'category-1' }],
      }),
      names,
    );

    expect(described).toEqual({
      from: 'Demo Grocery Store',
      to: 'Food',
    });
  });

  it('says the name a rule sets, when it sets a name', () => {
    // A rule that sets the payee by NAME says the name, because that is
    // what it will create.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'SQ *BLUE BOTTLE' },
        ],
        actions: [{ op: 'set', field: 'payee_name', value: 'New Payee' }],
      }),
      names,
    );

    expect(described?.to).toBe('New Payee');
  });

  it('does not describe a rule it cannot say in one line', () => {
    // A rule that matches two different things cannot be said as
    // "from → to" without lying, so it is not described at all.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'A' },
          { op: 'is', field: 'imported_payee', value: 'B' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'payee-1' }],
      }),
      names,
    );

    expect(described).toBeUndefined();
  });

  it('does not describe a rule that does not SET a field', () => {
    // "from → to" would read as a replacement, when the rule only
    // appends a note. The caller says the field instead.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'SQ *BLUE BOTTLE' },
        ],
        actions: [{ op: 'prepend-notes', value: 'a note' }],
      }),
      names,
    );

    expect(described).toBeUndefined();
  });

  it('does not describe a condition that is not an exact match', () => {
    // "contains X" is not "is X", and saying it as "X → Y" would claim an
    // exact match the rule never made.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'contains', field: 'imported_payee', value: 'BLUE BOTTLE' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'payee-1' }],
      }),
      names,
    );

    expect(described).toBeUndefined();
  });

  it('shows a value it cannot resolve as it is', () => {
    // A payee the budget does not have — deleted, or a stale list — is
    // shown as its id, so the description says what the rule says.
    const described = describeRule(
      rule({
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'SQ *BLUE BOTTLE' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'payee-gone' }],
      }),
      names,
    );

    expect(described?.to).toBe('payee-gone');
  });
});

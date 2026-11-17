import type {
  PreviewEdits,
  PreviewSplitLeg,
} from '@actual-app/core/server/transactions/import/review/index';
import type { AppliedRule } from '@actual-app/core/types/models/transaction';

import {
  editChangesRuledField,
  ruleEffectsFor,
  visibleEffectFor,
  visibleEffectsFor,
} from './rule-effects';
import type { ReportedRow, RuleEffect } from './rule-effects';

/**
 * What the review does with the rules' report.
 *
 * The preview tells the review which rules fired on a row and which fields
 * each one set. This turns that into the fields the review LOCKS, and the
 * value each locked field will carry.
 *
 * The two things that matter:
 *
 *   - a field a rule CONTROLS is locked, even when the rule set it to the
 *     value the row already had. An edit to it would be discarded, so the
 *     review has to say so.
 *   - a row that is already in the budget is NOT locked: the import's
 *     update path prefers the existing value, so a rule cannot change it.
 */

function reported(
  overrides: Partial<ReportedRow> & { _appliedRules?: AppliedRule[] } = {},
): ReportedRow {
  const { _appliedRules, ...rest } = overrides;
  return {
    account: 'an-account',
    amount: -2500,
    date: '2026-09-07',
    ...rest,
    _appliedRules,
  } as ReportedRow;
}

const NO_MATCHES = { matchedRowKeys: new Set<string>() };

/** A split leg, for the rows that are split. */
function leg(overrides: Partial<PreviewSplitLeg> = {}): PreviewSplitLeg {
  return {
    amountCents: -1250,
    categoryId: undefined,
    ...overrides,
  } as PreviewSplitLeg;
}

describe('the fields the review locks', () => {
  test('a rule that set a field locks that field', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      NO_MATCHES,
    );

    const effect = effects.get('row-0')?.get('category');
    expect(effect).toEqual({
      field: 'category',
      ruleId: 'rule-1',
      value: 'a-category',
    });
  });

  test('a field no rule touched is not locked', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      NO_MATCHES,
    );

    // The payee is not in the report, so it is not locked — even though
    // the transaction carries one.
    expect(effects.get('row-0')?.has('payee')).toBe(false);
  });

  test('the LAST rule to act is the one that has the last word', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'the-second-category',
          _appliedRules: [
            { id: 'rule-1', fields: ['category'] },
            { id: 'rule-2', fields: ['category'] },
          ],
        }),
      ],
      NO_MATCHES,
    );

    // Upstream applies the rules in order and the last action lands, so
    // the second rule is the one the user has to go and change.
    expect(effects.get('row-0')?.get('category')?.ruleId).toBe('rule-2');
    // And the value is the one the transaction carries, which is the one
    // the last rule set.
    expect(effects.get('row-0')?.get('category')?.value).toBe(
      'the-second-category',
    );
  });

  test('a row that is already in the budget is not locked', () => {
    // The import's update path prefers the existing value, so a rule
    // cannot change this row — and locking it would be a lie.
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      { matchedRowKeys: new Set(['row-0']) },
    );

    expect(effects.has('row-0')).toBe(false);
  });

  test('a row with no preview key cannot be lined up, so it is not locked', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.size).toBe(0);
  });

  test('a row no rule touched has no effects at all', () => {
    const effects = ruleEffectsFor(
      [reported({ _previewKey: 'row-0' })],
      NO_MATCHES,
    );

    expect(effects.size).toBe(0);
  });

  test('a rule that sets a field the review does not show is ignored', () => {
    // `imported_payee` is a real transaction column and a rule can set
    // it, but the review does not edit it, so it is not locked.
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          _appliedRules: [{ id: 'rule-1', fields: ['imported_payee'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.size).toBe(0);
  });

  test('a rule that set nothing on the transaction itself locks nothing', () => {
    // A split rule sets the field on a LEG, so the transaction's own
    // fields are not the rule's to claim.
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          _appliedRules: [{ id: 'rule-1', fields: [] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.size).toBe(0);
  });
});

describe('the effects that apply to a row', () => {
  const row = (edits: PreviewEdits = {}) => ({
    previewKey: 'row-0',
    edits,
  });

  test('a split row does not show a rule that sets its category', () => {
    // The categories of a split live on the legs, and a category is not
    // written on a split parent — so the rule says nothing about what
    // the row will import.
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      NO_MATCHES,
    );

    const split = row({ splits: [leg(), leg()] });
    expect(visibleEffectsFor(effects, split)).toEqual([]);
    expect(visibleEffectFor(effects, split, 'category')).toBeUndefined();
  });

  test('a split row DOES show a rule that sets its amount', () => {
    // The rule changes the PARENT, and the legs then no longer add up to
    // it. The user has to know.
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          amount: -1234,
          _appliedRules: [{ id: 'rule-1', fields: ['amount'] }],
        }),
      ],
      NO_MATCHES,
    );

    const split = row({ splits: [leg(), leg()] });
    expect(visibleEffectsFor(effects, split)).toEqual([
      { field: 'amount', ruleId: 'rule-1', value: -1234 },
    ]);
    expect(visibleEffectFor(effects, split, 'amount')?.ruleId).toBe('rule-1');
  });

  test('an ordinary row shows every effect', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: 'a-category',
          _appliedRules: [{ id: 'rule-1', fields: ['category', 'amount'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(visibleEffectsFor(effects, row()).length).toBe(2);
  });
});

describe('whether an edit changes a ruled field', () => {
  const categoryEffect: RuleEffect = {
    field: 'category',
    ruleId: 'rule-1',
    value: 'a-category',
  };

  test('an edit that sets the field to the rule value is NOT a change', () => {
    // The user is not fighting the rule; they agree with it. The rule
    // would set the same thing, so the edit is allowed.
    expect(
      editChangesRuledField(categoryEffect, { categoryId: 'a-category' }),
    ).toBe(false);
  });

  test('an edit that sets the field to something else IS a change', () => {
    expect(
      editChangesRuledField(categoryEffect, { categoryId: 'another-category' }),
    ).toBe(true);
  });

  test('an edit that CLEARS a field the rule also cleared is NOT a change', () => {
    // The rule clears the category, and the user clears it too: they
    // agree with the rule.
    const clearingRule: RuleEffect = {
      field: 'category',
      ruleId: 'rule-1',
      value: null,
    };
    expect(editChangesRuledField(clearingRule, { categoryId: '' })).toBe(false);
    // And the user picking a category IS a change.
    expect(
      editChangesRuledField(clearingRule, { categoryId: 'a-category' }),
    ).toBe(true);
  });

  test('an edit that CLEARS the field IS a change', () => {
    // The rule sets a category; the user clears it. That is a change.
    expect(editChangesRuledField(categoryEffect, { categoryId: '' })).toBe(
      true,
    );
  });

  test('an edit that does not touch the field is NOT a change', () => {
    expect(editChangesRuledField(categoryEffect, {})).toBe(false);
  });

  test('the payee is compared by id, not by name', () => {
    const payeeEffect: RuleEffect = {
      field: 'payee',
      ruleId: 'rule-1',
      value: 'a-payee-id',
    };
    // The user picked the payee the rule sets: the same payee, so no
    // change.
    expect(
      editChangesRuledField(
        payeeEffect,
        { payeeCanonical: 'Kroger' },
        'a-payee-id',
      ),
    ).toBe(false);
    // The user picked another one.
    expect(
      editChangesRuledField(
        payeeEffect,
        { payeeCanonical: 'Publix' },
        'another-payee-id',
      ),
    ).toBe(true);
    // The user NAMED a payee the budget does not have: there is no id,
    // and a new payee is not the rule's.
    expect(
      editChangesRuledField(payeeEffect, { payeeCanonical: 'A New Payee' }),
    ).toBe(true);
  });

  test('the amount is compared in cents', () => {
    const amountEffect: RuleEffect = {
      field: 'amount',
      ruleId: 'rule-1',
      value: -2500,
    };
    expect(editChangesRuledField(amountEffect, { amountCents: -2500 })).toBe(
      false,
    );
    expect(editChangesRuledField(amountEffect, { amountCents: -3000 })).toBe(
      true,
    );
  });

  test('the date is compared as a string', () => {
    const dateEffect: RuleEffect = {
      field: 'date',
      ruleId: 'rule-1',
      value: '2026-09-07',
    };
    expect(editChangesRuledField(dateEffect, { date: '2026-09-07' })).toBe(
      false,
    );
    expect(editChangesRuledField(dateEffect, { date: '2026-09-08' })).toBe(
      true,
    );
  });

  test('the notes are compared as a string', () => {
    const notesEffect: RuleEffect = {
      field: 'notes',
      ruleId: 'rule-1',
      value: 'a note',
    };
    expect(editChangesRuledField(notesEffect, { memo: 'a note' })).toBe(false);
    expect(editChangesRuledField(notesEffect, { memo: 'another note' })).toBe(
      true,
    );
  });
});

describe('the values the review shows', () => {
  test('the payee is the id the rule set', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          payee: 'a-payee-id',
          _appliedRules: [{ id: 'rule-1', fields: ['payee'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.get('row-0')?.get('payee')?.value).toBe('a-payee-id');
  });

  test('the amount is in cents', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          amount: -1234,
          _appliedRules: [{ id: 'rule-1', fields: ['amount'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.get('row-0')?.get('amount')?.value).toBe(-1234);
  });

  test('a field the rule CLEARED is null', () => {
    const effects = ruleEffectsFor(
      [
        reported({
          _previewKey: 'row-0',
          category: undefined,
          _appliedRules: [{ id: 'rule-1', fields: ['category'] }],
        }),
      ],
      NO_MATCHES,
    );

    expect(effects.get('row-0')?.get('category')?.value).toBeNull();
  });
});

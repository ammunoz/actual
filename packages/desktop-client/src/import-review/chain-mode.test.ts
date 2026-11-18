import type { PreviewRow } from '@actual-app/core/server/transactions/import/review/index';
import { describe, expect, it } from 'vitest';

import { initialChainContext, nextChainField } from './chain-mode';
import type { EditorMode } from './editor-mode';
import type { RuledField } from './rule-effects';

function mkRow(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    accountId: 'a-1',
    importedId: 't-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    memo: 'a bank memo',
    payeeCanonical: 'Demo Canonical',
    payeeMatchSource: 'none',
    flags: [],
    decision: 'pending',
    edits: {},
    ...overrides,
  };
}

/** A row the file says is a transfer. */
function transferRow(): PreviewRow {
  return mkRow({ matchedTransferAccountId: 'acct-2' });
}

/** A row the user split into legs. */
function splitRow(): PreviewRow {
  return mkRow({
    edits: {
      splits: [{ categoryId: 'cat-1', amountCents: -2500 }],
    },
  });
}

const NO_RULES: ReadonlySet<RuledField> = new Set<RuledField>();

/**
 * The next field, the way the modal asks: the chain's plan is built
 * from the row, and the next field is read out of it.
 */
function next(
  current: EditorMode,
  row: PreviewRow,
  ruledFields: ReadonlySet<RuledField> = NO_RULES,
  hasAmountFlag = false,
): EditorMode | undefined {
  const context = initialChainContext(row, ruledFields, hasAmountFlag);
  return nextChainField(current, context, row, ruledFields);
}

describe('nextChainField', () => {
  it('goes from the payee to the category', () => {
    expect(next('payee', mkRow())).toBe('category');
  });

  it('skips the category on a transfer row', () => {
    // A transfer has no category of its own: the account it transfers to
    // is the category.
    expect(next('payee', transferRow())).toBe('memo');
  });

  it('skips the category on a split row', () => {
    // A split's legs carry their own categories.
    expect(next('payee', splitRow())).toBe('memo');
  });

  it('does not jump to the amount from the payee', () => {
    // The amount is the LAST field, never the second.
    expect(next('payee', mkRow(), NO_RULES, true)).toBe('category');
  });

  it('goes from the category to the notes', () => {
    expect(next('category', mkRow())).toBe('memo');
  });

  it('goes from the category to the notes, not to the amount', () => {
    expect(next('category', mkRow(), NO_RULES, true)).toBe('memo');
  });

  it('goes from the notes to the amount when the amount is flagged', () => {
    expect(next('memo', mkRow(), NO_RULES, true)).toBe('amount');
  });

  it('ends after the notes when the amount is not flagged', () => {
    expect(next('memo', mkRow())).toBeUndefined();
  });

  it('skips a category a rule owns', () => {
    const ruled = new Set<RuledField>(['category']);
    expect(next('payee', mkRow(), ruled)).toBe('memo');
  });

  it('skips an amount a rule owns, even when it is flagged', () => {
    // The editor would refuse the commit, so the chain does not stop
    // there.
    const ruled = new Set<RuledField>(['amount']);
    expect(next('memo', mkRow(), ruled, true)).toBeUndefined();
  });

  it('ends at a field the chain does not visit', () => {
    // The chain is over when the user is on a field it never stopped at.
    const ruled = new Set<RuledField>(['category']);
    expect(next('category', mkRow(), ruled)).toBeUndefined();
  });

  it('offers the category again when the row stops being a transfer', () => {
    // The chain's plan is rebuilt after every commit, so a row that
    // became an ordinary transaction gets its category back. Giving a
    // transfer row a payee is what does it: the payee edit takes the
    // transfer away.
    const transfer = transferRow();
    const ordinary: PreviewRow = {
      ...transfer,
      edits: { ...transfer.edits, transferAccountId: '' },
    };
    const context = initialChainContext(ordinary, NO_RULES, false);
    expect(context.remaining).toEqual(['payee', 'category', 'memo']);
    expect(nextChainField('payee', context, ordinary, NO_RULES)).toBe(
      'category',
    );
  });
});

describe('initialChainContext', () => {
  it('walks the payee, the category and the notes', () => {
    expect(initialChainContext(mkRow(), NO_RULES, false)).toEqual({
      remaining: ['payee', 'category', 'memo'],
    });
  });

  it('includes the amount when the row is flagged about it', () => {
    expect(initialChainContext(mkRow(), NO_RULES, true)).toEqual({
      remaining: ['payee', 'category', 'memo', 'amount'],
    });
  });

  it('starts past a payee a rule owns', () => {
    // The payee is usually the first field, but a rule that owns it
    // means the user cannot change it.
    const ruled = new Set<RuledField>(['payee']);
    expect(initialChainContext(mkRow(), ruled, false)).toEqual({
      remaining: ['category', 'memo'],
    });
  });

  it('skips the category on a transfer row', () => {
    expect(initialChainContext(transferRow(), NO_RULES, false)).toEqual({
      remaining: ['payee', 'memo'],
    });
  });

  it('skips the category on a split row', () => {
    expect(initialChainContext(splitRow(), NO_RULES, false)).toEqual({
      remaining: ['payee', 'memo'],
    });
  });

  it('has nothing to walk when every field is ruled', () => {
    const ruled = new Set<RuledField>(['payee', 'category', 'notes']);
    expect(initialChainContext(mkRow(), ruled, false)).toEqual({
      remaining: [],
    });
  });

  it('leaves the amount out of a split row', () => {
    // A split's amount belongs to the split: the legs have to add up to
    // it, and the editor refuses to change it. The split pane is where
    // it is fixed, so the chain does not stop there.
    expect(initialChainContext(splitRow(), NO_RULES, true)).toEqual({
      remaining: ['payee', 'memo'],
    });
  });
});

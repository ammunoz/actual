import type { PreviewRow } from '@actual-app/core/server/transactions/import/review/index';

import {
  EDITOR_FOR_ACTION,
  exactMatchIndex,
  filterSuggestions,
  initialTextForMode,
  nextHighlightIndex,
  parseAmountText,
  parseDateText,
} from './editor-mode';

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

describe('EDITOR_FOR_ACTION', () => {
  it('maps every edit action to a field', () => {
    expect(EDITOR_FOR_ACTION['edit-payee']).toBe('payee');
    expect(EDITOR_FOR_ACTION['edit-category']).toBe('category');
    expect(EDITOR_FOR_ACTION['edit-memo']).toBe('memo');
    expect(EDITOR_FOR_ACTION['edit-amount']).toBe('amount');
    expect(EDITOR_FOR_ACTION['edit-date']).toBe('date');
  });

  it('has an editor only for the field edits', () => {
    // The record is exhaustive over the field edits, so an action that
    // opens a different surface — the transfer, the split — is not in it
    // at all, and cannot be added to it by accident.
    expect(Object.keys(EDITOR_FOR_ACTION).sort()).toEqual([
      'edit-amount',
      'edit-category',
      'edit-date',
      'edit-memo',
      'edit-payee',
    ]);
  });
});

describe('initialTextForMode', () => {
  it('shows the payee the row would import with', () => {
    expect(initialTextForMode('payee', mkRow())).toBe('Demo Canonical');
  });

  it('shows the payee the user has already chosen', () => {
    const row = mkRow({
      edits: { payeeCanonical: 'Demo Chosen' },
    });
    expect(initialTextForMode('payee', row)).toBe('Demo Chosen');
  });

  it('shows the bank memo when the user has not touched it', () => {
    expect(initialTextForMode('memo', mkRow())).toBe('a bank memo');
  });

  it('shows an empty memo when the user cleared it', () => {
    // An empty string is the user saying "no notes", not "not touched".
    const row = mkRow({ edits: { memo: '' } });
    expect(initialTextForMode('memo', row)).toBe('');
  });

  it('shows the amount as a decimal with two places', () => {
    expect(initialTextForMode('amount', mkRow())).toBe('-25.00');
  });

  it('shows the amount the user committed', () => {
    const row = mkRow({ edits: { amountCents: -12050 } });
    expect(initialTextForMode('amount', row)).toBe('-120.50');
  });

  it('shows the category name it is given', () => {
    // The row carries ids, not names, so the editor resolves the name.
    expect(
      initialTextForMode('category', mkRow(), { categoryName: 'Groceries' }),
    ).toBe('Groceries');
  });

  it('shows no category name when there is none', () => {
    expect(initialTextForMode('category', mkRow())).toBe('');
  });

  it('shows the date', () => {
    expect(initialTextForMode('date', mkRow())).toBe('2026-09-07');
  });

  it('shows the date the user committed', () => {
    const row = mkRow({ edits: { date: '2026-09-09' } });
    expect(initialTextForMode('date', row)).toBe('2026-09-09');
  });
});

describe('parseAmountText', () => {
  it('reads a decimal amount into integer cents', () => {
    expect(parseAmountText('-25.50')).toBe(-2550);
    expect(parseAmountText('25')).toBe(2500);
    expect(parseAmountText('0')).toBe(0);
  });

  it('trims the text', () => {
    expect(parseAmountText('  -25.50  ')).toBe(-2550);
  });

  it('rejects an empty field', () => {
    // Clearing the field and confirming it would write a silent $0.
    expect(parseAmountText('')).toBeNull();
    expect(parseAmountText('   ')).toBeNull();
  });

  it('rejects text that is not a number', () => {
    expect(parseAmountText('abc')).toBeNull();
    expect(parseAmountText('12abc')).toBeNull();
    expect(parseAmountText('-25,50')).toBeNull();
  });

  it('rejects an amount that is not a finite number', () => {
    expect(parseAmountText('Infinity')).toBeNull();
    expect(parseAmountText('NaN')).toBeNull();
  });

  it('rejects more than two decimals', () => {
    // The amount is rounded to the cent by `amountToInteger`, so a third
    // decimal would be silently dropped. A mistake should say so.
    expect(parseAmountText('25.555')).toBeNull();
    expect(parseAmountText('25.5')).toBe(2550);
  });

  it('rejects a number that is not a plain decimal', () => {
    // `Number()` would read these as numbers, which they are not.
    expect(parseAmountText('0x10')).toBeNull();
    expect(parseAmountText('1e3')).toBeNull();
    expect(parseAmountText('25,50')).toBeNull();
  });

  it('accepts a leading dot', () => {
    expect(parseAmountText('.5')).toBe(50);
  });
});

describe('parseDateText', () => {
  it('reads a plain date', () => {
    expect(parseDateText('2026-09-09')).toBe('2026-09-09');
  });

  it('trims the text', () => {
    expect(parseDateText('  2026-09-09 ')).toBe('2026-09-09');
  });

  it('rejects a malformed date', () => {
    expect(parseDateText('not-a-date')).toBeNull();
    expect(parseDateText('2026-9-9')).toBeNull();
    expect(parseDateText('')).toBeNull();
  });

  it('rejects a date that is shaped like one but is not', () => {
    // The gate derives its date flag from the effective date, so an
    // impossible date would be committed and immediately re-flagged.
    expect(parseDateText('2026-02-31')).toBeNull();
    expect(parseDateText('2026-13-01')).toBeNull();
  });
});

describe('filterSuggestions', () => {
  const suggestions = [
    { id: 'p-1', name: 'Demo Grocery Store' },
    { id: 'p-2', name: 'Demo Payee Two' },
    { id: 'p-3', name: 'Other Vendor' },
  ];

  it('matches everything for an empty filter', () => {
    expect(filterSuggestions(suggestions, '')).toHaveLength(3);
  });

  it('matches on a part of the name', () => {
    expect(filterSuggestions(suggestions, 'grocery')).toEqual([suggestions[0]]);
  });

  it('ignores case', () => {
    expect(filterSuggestions(suggestions, 'GROCERY')).toHaveLength(1);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSuggestions(suggestions, 'zzz')).toHaveLength(0);
  });
});

describe('exactMatchIndex', () => {
  const suggestions = [
    { id: 'p-1', name: 'Demo Grocery Store' },
    { id: 'p-2', name: 'Demo Payee Two' },
  ];

  it('finds the suggestion whose name is the text', () => {
    expect(exactMatchIndex(suggestions, 'Demo Payee Two')).toBe(1);
  });

  it('ignores case and surrounding space', () => {
    expect(exactMatchIndex(suggestions, '  demo payee two ')).toBe(1);
  });

  it('is -1 for a name the budget does not have', () => {
    // The picker highlights the exact match and nothing else: confirming a
    // NEW payee's name must not pick some other payee.
    expect(exactMatchIndex(suggestions, 'Demo Brand New Payee')).toBe(-1);
  });

  it('is -1 for an empty text', () => {
    expect(exactMatchIndex(suggestions, '')).toBe(-1);
  });
});

describe('nextHighlightIndex', () => {
  it('moves down', () => {
    expect(nextHighlightIndex(3, 0, 1)).toBe(1);
  });

  it('wraps around at the end', () => {
    expect(nextHighlightIndex(3, 2, 1)).toBe(0);
  });

  it('wraps around at the start', () => {
    expect(nextHighlightIndex(3, 0, -1)).toBe(2);
  });

  it('is -1 when there is nothing to highlight', () => {
    expect(nextHighlightIndex(0, 0, 1)).toBe(-1);
  });
});

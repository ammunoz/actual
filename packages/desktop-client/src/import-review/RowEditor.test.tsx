import type {
  PreviewRow,
  ReviewCategory,
} from '@actual-app/core/server/transactions/import/review/index';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RowEditor } from './RowEditor';

const CATEGORIES: readonly ReviewCategory[] = [
  { id: 'c-food', name: 'Groceries', groupName: 'Food' },
  { id: 'c-fun', name: 'Fun', groupName: 'Fun' },
  // The same name in another group: the case the group name exists for.
  { id: 'c-food-2', name: 'Groceries', groupName: 'Everyday' },
];

function mkRow(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    accountId: 'a-1',
    importedId: 'fit-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Coffee Shop',
    payeeCanonical: 'Demo Coffee Shop',
    payeeMatchSource: 'none',
    previewKey: 'row-0',
    flags: [],
    decision: 'pending',
    edits: {},
    ...overrides,
  };
}

describe('the row editor', () => {
  it('shows the group a category is in', () => {
    // Two categories can have the same name in different groups. Without
    // the group, the picker shows two identical entries and the user
    // cannot tell which one they are picking.
    render(
      <RowEditor
        row={mkRow()}
        mode="category"
        payees={[]}
        categories={CATEGORIES}
        onCommit={vi.fn()}
      />,
    );

    const groups = screen.getAllByTestId('import-review-editor-group');
    expect(groups.map(group => group.textContent)).toEqual([
      'Food',
      'Fun',
      'Everyday',
    ]);
  });

  it('says which group an option is in', () => {
    // The visible name is the start of the accessible name; the group is
    // the rest of it, so a screen reader says which of the two
    // same-named categories is meant.
    render(
      <RowEditor
        row={mkRow()}
        mode="category"
        payees={[]}
        categories={CATEGORIES}
        onCommit={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('import-review-editor-option');
    expect(options.map(option => option.getAttribute('aria-label'))).toEqual([
      'Groceries, Food',
      // A group that repeats the name adds nothing to the name.
      'Fun',
      'Groceries, Everyday',
    ]);
  });

  it('points at the category the row has', () => {
    // The row's category is "Groceries" in the group "Everyday". A name
    // is not unique, so the picker points at the one the row has — and
    // confirming straight away keeps it, instead of committing the
    // other "Groceries".
    render(
      <RowEditor
        row={mkRow({ edits: { categoryId: 'c-food-2' } })}
        mode="category"
        payees={[]}
        categories={CATEGORIES}
        onCommit={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('import-review-editor-option');
    // The field shows the category's name, so the list is filtered to the
    // two categories with that name — and the row's own one is the one
    // that is pointed at.
    expect(options.map(option => option.getAttribute('aria-label'))).toEqual([
      'Groceries, Food',
      'Groceries, Everyday',
    ]);
    expect(
      options.map(option => option.getAttribute('data-highlighted')),
    ).toEqual(['false', 'true']);
    // The accessible state says the same thing.
    expect(options.map(option => option.getAttribute('aria-selected'))).toEqual(
      ['false', 'true'],
    );
  });

  it('points at the payee the row has', () => {
    // Two payees can have the same name too. The row's payee is the
    // second one, and the picker points at it.
    render(
      <RowEditor
        row={mkRow({ matchedPayeeId: 'p-2' })}
        mode="payee"
        payees={[
          { id: 'p-1', name: 'Demo Coffee Shop' },
          { id: 'p-2', name: 'Demo Coffee Shop' },
        ]}
        categories={[]}
        onCommit={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('import-review-editor-option');
    expect(
      options.map(option => option.getAttribute('data-highlighted')),
    ).toEqual(['false', 'true']);
  });

  it('points at the payee the user picked', () => {
    // The user's pick is a NAME, so the payee is found by its name, and
    // the name wins over the resolver's id: the row has both, and the
    // name is the one the user chose.
    //
    // The two payees share a name, so the name alone cannot say which
    // one — and the picker falls back to the first. What matters here is
    // that the NAME is used at all: with the resolver's id, the second
    // payee would be pointed at.
    render(
      <RowEditor
        row={mkRow({
          matchedPayeeId: 'p-2',
          edits: { payeeCanonical: 'demo coffee shop' },
        })}
        mode="payee"
        payees={[
          { id: 'p-1', name: 'Demo Coffee Shop' },
          { id: 'p-2', name: 'Demo Coffee Shop' },
        ]}
        categories={[]}
        onCommit={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('import-review-editor-option');
    expect(
      options.map(option => option.getAttribute('data-highlighted')),
    ).toEqual(['true', 'false']);
  });
});

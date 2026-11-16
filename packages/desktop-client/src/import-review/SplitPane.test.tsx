import type {
  PreviewEdits,
  PreviewRow,
  ReviewCategory,
} from '@actual-app/core/server/transactions/import/review/index';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SplitPane } from './SplitPane';

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

describe('the split pane', () => {
  it('points a leg at its own category', async () => {
    // A leg whose category is "Groceries" in the group "Everyday". The
    // name is not unique, so the picker points at the leg's own
    // category — and confirming straight away keeps it, instead of
    // committing the other "Groceries" into the split.
    const onCommit = vi.fn<(edits: PreviewEdits) => void>();
    render(
      <SplitPane
        row={mkRow({
          edits: {
            splits: [
              { amountCents: -1500, categoryId: 'c-food-2' },
              { amountCents: -1000, categoryId: 'c-fun' },
            ],
          },
        })}
        categories={CATEGORIES}
        onCommit={onCommit}
      />,
    );

    const legs = screen.getAllByTestId('import-review-split-leg');
    const firstLeg = within(legs[0]);
    // The pane has a picker per leg, and only the focused one may claim
    // the focus — so the list is closed until the field is focused.
    await userEvent.click(
      firstLeg.getByTestId('import-review-split-leg-category-0'),
    );

    const firstLegOptions = firstLeg.queryAllByTestId(
      'import-review-editor-option',
    );
    expect(
      [...firstLegOptions].map(option => option.getAttribute('aria-label')),
    ).toEqual(['Groceries, Food', 'Groceries, Everyday']);
    expect(
      [...firstLegOptions].map(option =>
        option.getAttribute('data-highlighted'),
      ),
    ).toEqual(['false', 'true']);

    // Confirming straight away keeps the leg's own category.
    await userEvent.keyboard('{Enter}');

    // And saving the split keeps it there.
    await userEvent.click(screen.getByRole('button', { name: 'Save split' }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0][0];
    expect(committed.splits?.[0]?.categoryId).toBe('c-food-2');
  });
});

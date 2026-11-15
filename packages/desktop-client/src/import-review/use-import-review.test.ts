import { send } from '@actual-app/core/platform/client/connection';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useCustomSyncedPref } from './use-custom-synced-pref';
import {
  readVendorMap,
  toReviewRows,
  useImportReview,
} from './use-import-review';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

vi.mock('./use-custom-synced-pref', () => ({
  useCustomSyncedPref: vi.fn(),
}));

describe('toReviewRows', () => {
  it('reads the FITID from imported_id', () => {
    const rows = toReviewRows(
      [{ imported_id: 'FITID-1', date: '2026-09-07', amount: -2500 }],
      { accountId: 'a-1' },
    );
    expect(rows[0].importedId).toBe('FITID-1');
  });

  it('leaves importedId undefined when the file has no FITID', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -2500 }], {
      accountId: 'a-1',
    });
    expect(rows[0].importedId).toBeUndefined();
  });

  it('reads the raw vendor string from imported_payee', () => {
    const rows = toReviewRows(
      [{ imported_payee: 'POS PURCHASE 4251', date: '2026-09-07', amount: -1 }],
      { accountId: 'a-1' },
    );
    expect(rows[0].payeeRaw).toBe('POS PURCHASE 4251');
  });

  it('falls back to payee_name when imported_payee is absent', () => {
    const rows = toReviewRows(
      [{ payee_name: 'Demo Vendor', date: '2026-09-07', amount: -1 }],
      { accountId: 'a-1' },
    );
    expect(rows[0].payeeRaw).toBe('Demo Vendor');
  });

  it('uses an empty payee when the file has neither', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -1 }], {
      accountId: 'a-1',
    });
    expect(rows[0].payeeRaw).toBe('');
  });

  it('assigns a unique previewKey to every row', () => {
    const rows = toReviewRows(
      [
        { date: '2026-09-07', amount: -1 },
        { date: '2026-09-07', amount: -2 },
        { date: '2026-09-07', amount: -3 },
      ],
      { accountId: 'a-1' },
    );
    const keys = rows.map(r => r.previewKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('assigns a previewKey even when the FITIDs repeat', () => {
    const rows = toReviewRows(
      [
        { imported_id: 'SAME', date: '2026-09-07', amount: -1 },
        { imported_id: 'SAME', date: '2026-09-07', amount: -2 },
      ],
      { accountId: 'a-1' },
    );
    expect(rows[0].previewKey).not.toBe(rows[1].previewKey);
  });

  it('converts the amount from major units to integer cents', () => {
    // Actual's OFX parser returns the amount in the currency's major units
    // (e.g. -120.50). The import API wants integer cents.
    const rows = toReviewRows([{ date: '2026-09-07', amount: -120.5 }], {
      accountId: 'a-1',
    });
    expect(rows[0].amountCents).toBe(-12050);
  });

  it('rounds a fractional amount to the nearest cent', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: 1.005 }], {
      accountId: 'a-1',
    });
    expect(Number.isInteger(rows[0].amountCents)).toBe(true);
  });

  it('keeps a whole amount intact', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: -25 }], {
      accountId: 'a-1',
    });
    expect(rows[0].amountCents).toBe(-2500);
  });

  it('falls back to 0 for a non-numeric amount', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: 'oops' }], {
      accountId: 'a-1',
    });
    expect(rows[0].amountCents).toBe(0);
  });

  it('flags a row whose amount could not be read', () => {
    const rows = toReviewRows([{ date: '2026-09-07', amount: 'oops' }], {
      accountId: 'a-1',
    });
    expect(rows[0].flags).toEqual([
      expect.objectContaining({ kind: 'amount-mismatch' }),
    ]);
  });

  it('flags a row whose date could not be read', () => {
    // An empty date is rejected by the import with a confusing error, so
    // the row is flagged instead of being sent.
    const rows = toReviewRows([{ date: 'not-a-date', amount: -100 }], {
      accountId: 'a-1',
    });
    expect(rows[0].flags).toEqual([
      expect.objectContaining({ kind: 'date-out-of-range' }),
    ]);
  });

  it('flags a row with no date at all', () => {
    const rows = toReviewRows([{ amount: -100 }], { accountId: 'a-1' });
    expect(rows[0].flags).toEqual([
      expect.objectContaining({ kind: 'date-out-of-range' }),
    ]);
  });

  it('does not flag a well-formed row', () => {
    const rows = toReviewRows(
      [{ date: '2026-09-07', amount: -100, imported_payee: 'Demo Vendor' }],
      { accountId: 'a-1' },
    );
    expect(rows[0].flags).toBeUndefined();
  });

  it('reads the bank memo', () => {
    const rows = toReviewRows(
      [{ date: '2026-09-07', amount: -1, notes: 'a bank note' }],
      { accountId: 'a-1' },
    );
    expect(rows[0].memo).toBe('a bank note');
  });

  it('handles an empty list', () => {
    expect(toReviewRows([], { accountId: 'a-1' })).toEqual([]);
  });
});

describe('readVendorMap', () => {
  it('is undefined for an unset preference', () => {
    expect(readVendorMap(undefined)).toBeUndefined();
  });

  it('is undefined for an empty string', () => {
    expect(readVendorMap('')).toBeUndefined();
  });

  it('parses a well-formed map', () => {
    const raw = JSON.stringify({
      v: 1,
      updatedAt: '2026-09-07T12:00:00.000Z',
      entries: { 'Demo Vendor': 'p-1' },
    });
    expect(readVendorMap(raw)?.entries['Demo Vendor']).toBe('p-1');
  });

  it('is undefined for malformed JSON rather than throwing', () => {
    expect(readVendorMap('{not json')).toBeUndefined();
  });

  it('is undefined for a well-formed JSON that fails validation', () => {
    expect(readVendorMap(JSON.stringify({ v: 99 }))).toBeUndefined();
  });
});

describe('useImportReview', () => {
  const sendMock = vi.mocked(send);
  const prefMock = vi.mocked(useCustomSyncedPref);

  const PAYEES = [
    { id: 'p-1', name: 'Demo Grocery Store', transfer_acct: null },
    { id: 'p-2', name: 'Demo Vendor', transfer_acct: null },
  ];
  const ACCOUNTS = [
    { id: 'a-1', name: 'Demo Checking', offbudget: 0, closed: 0 },
  ];
  const CATEGORIES = {
    list: [{ id: 'c-1', name: 'Groceries', hidden: 0, is_income: 0 }],
  };
  const PARSED = {
    transactions: [
      {
        imported_id: 'FITID-1',
        date: '2026-09-07',
        amount: -25,
        imported_payee: 'Demo Vendor',
      },
      {
        imported_id: 'FITID-2',
        date: '2026-09-08',
        amount: -10,
        imported_payee: 'Demo Other',
      },
    ],
    errors: [],
  };

  beforeEach(() => {
    sendMock.mockReset();
    prefMock.mockReset();
    prefMock.mockReturnValue([undefined, vi.fn()]);
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
          // The review asks the budget which of its rows are already in
          // it, by FITID. Nothing is in the budget yet.
          return { data: [], dependencies: [] };
        case 'transactions-import':
          // The import reports a change, so the apply counts as having
          // changed something.
          return {
            updatedPreview: [],
            added: [{ id: 'trx-1' }],
            updated: [],
            errors: [],
          };
        default:
          throw new Error(`unexpected send: ${name}`);
      }
    }) as never);
  });

  async function renderReview() {
    const view = renderHook(() =>
      useImportReview({
        accountId: 'a-1',
        filename: '/tmp/demo.ofx',
        onImported: vi.fn(),
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));
    return view;
  }

  it('parses the file into rows', async () => {
    const { result } = await renderReview();
    expect(result.current.state?.rows).toHaveLength(2);
    expect(result.current.summary.total).toBe(2);
  });

  it('reports no unsaved work for a review the user has not touched', async () => {
    const { result } = await renderReview();
    expect(result.current.unsavedWork).toEqual({
      hasWork: false,
      decided: 0,
      edited: 0,
    });
  });

  it('reports the work a decision makes', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.decide(0, 'accept');
    });

    expect(result.current.unsavedWork).toEqual({
      hasWork: true,
      decided: 1,
      edited: 0,
    });
  });

  it('reports the work an edit makes', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.edit(0, { memo: 'a note' });
    });

    expect(result.current.unsavedWork).toEqual({
      hasWork: true,
      decided: 0,
      edited: 1,
    });
  });

  it('reports no unsaved work again once the work is undone', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.decide(0, 'accept');
    });
    expect(result.current.unsavedWork.hasWork).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.unsavedWork.hasWork).toBe(false);
  });

  it('undoes a bulk accept in ONE step', async () => {
    // A bulk action is one change, so it is one undo — not one undo per
    // row.
    const { result } = await renderReview();

    act(() => {
      result.current.decideAll('accept');
    });
    expect(result.current.summary.accepted).toBe(2);

    act(() => {
      result.current.undo();
    });
    expect(result.current.summary.accepted).toBe(0);
    expect(result.current.summary.pending).toBe(2);
  });

  it('updates a row that is already in the budget, in place', async () => {
    // The budget already holds the first row's FITID.
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1' }],
            dependencies: [],
          };
        case 'transaction-update':
          return {};
        case 'transactions-import':
          return {
            updatedPreview: [],
            added: [],
            updated: [],
            errors: [],
          };
        default:
          throw new Error(`unexpected send: ${name}`);
      }
    }) as never);

    const { result } = await renderReview();

    act(() => {
      result.current.edit(0, { memo: 'a note from the review' });
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.error).toBeNull();
    expect(sendMock).toHaveBeenCalledWith(
      'transaction-update',
      expect.objectContaining({
        id: 'txn-1',
        notes: 'a note from the review',
      }),
    );
  });

  it('updates the payee of a row that is already in the budget', async () => {
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1' }],
            dependencies: [],
          };
        case 'transaction-update':
          return {};
        case 'transactions-import':
          return {
            updatedPreview: [],
            added: [],
            updated: [],
            errors: [],
          };
        default:
          throw new Error(`unexpected send: ${name}`);
      }
    }) as never);

    const { result } = await renderReview();

    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(result.current.error).toBeNull();
    expect(sendMock).toHaveBeenCalledWith(
      'transaction-update',
      expect.objectContaining({
        id: 'txn-1',
        payee: 'p-1',
      }),
    );
  });

  it('undoes an edit', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.edit(0, { payeeCanonical: 'Demo Grocery Store' });
    });
    expect(result.current.state?.rows[0].edits.payeeCanonical).toBe(
      'Demo Grocery Store',
    );

    act(() => {
      result.current.undo();
    });
    expect(result.current.state?.rows[0].edits.payeeCanonical).toBeUndefined();
  });

  it('undoes a decision', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.decide(0, 'accept');
    });
    expect(result.current.state?.rows[0].decision).toBe('accept');

    act(() => {
      result.current.undo();
    });
    expect(result.current.state?.rows[0].decision).toBe('pending');
  });

  it('does not write the vendor map while the review is open', async () => {
    // Writing the preference re-parses the file, which would throw away
    // the very decisions that produced the entry.
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });

    expect(setPref).not.toHaveBeenCalled();
  });

  it('writes the vendor map when the import succeeds', async () => {
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setPref).toHaveBeenCalledTimes(1);
    const written = JSON.parse(setPref.mock.calls[0][0]);
    expect(written.entries['Demo Vendor']).toBe('p-1');
  });

  it('does not write a vendor map entry for a payee whose name is the raw name', async () => {
    // The map maps a VENDOR string to a payee. A payee that already has
    // the name does not need an entry: the resolver finds it by itself.
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Vendor' },
        { chosenPayeeId: 'p-2' },
      );
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setPref).not.toHaveBeenCalled();
  });

  it('does not write the vendor map when the import changed nothing', async () => {
    // The choices were not used, so they are not worth remembering.
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);
    sendMock.mockImplementation((async (name: string) => {
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setPref).not.toHaveBeenCalled();
  });

  it('does not remember a payee choice for a row the user dropped', async () => {
    // A row the user threw away says nothing about how the vendor string
    // should be resolved.
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });
    act(() => {
      result.current.decide(0, 'drop');
    });
    act(() => {
      result.current.edit(
        1,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setPref).toHaveBeenCalledTimes(1);
    const written = JSON.parse(setPref.mock.calls[0][0]);
    expect(written.entries['Demo Other']).toBe('p-1');
    expect(written.entries['Demo Vendor']).toBeUndefined();
  });

  it('forgets a vendor map entry the user undid', async () => {
    const setPref = vi.fn();
    prefMock.mockReturnValue([undefined, setPref]);

    const { result } = await renderReview();
    act(() => {
      result.current.edit(
        0,
        { payeeCanonical: 'Demo Grocery Store' },
        { chosenPayeeId: 'p-1' },
      );
    });
    act(() => {
      result.current.undo();
    });

    await act(async () => {
      await result.current.apply();
    });

    expect(setPref).not.toHaveBeenCalled();
  });
});

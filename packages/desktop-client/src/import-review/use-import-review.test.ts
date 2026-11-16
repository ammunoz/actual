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

vi.mock('./use-import-session', () => ({
  useImportSession: vi.fn(() => ({
    session: undefined,
    save: vi.fn(() => true),
    clear: vi.fn(),
  })),
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
    { id: 'a-2', name: 'Demo Savings', offbudget: 0, closed: 0 },
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

  it('puts a row into another account', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });

    // The rows are partitioned at the row the user routed.
    expect(result.current.groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 1, accountId: 'a-2' },
    ]);
    expect(result.current.state?.rows.map(row => row.accountId)).toEqual([
      'a-1',
      'a-2',
    ]);
  });

  it('keeps the decisions and the edits when the routing changes', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.decide(0, 'accept');
      result.current.edit(0, { memo: 'a note from the review' });
    });

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });

    // The resolution is the resolver's; the decision and the edit are
    // the user's.
    expect(result.current.state?.rows[0].decision).toBe('accept');
    expect(result.current.state?.rows[0].edits.memo).toBe(
      'a note from the review',
    );
  });

  it('undoes a routing change', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });
    expect(result.current.groups).toHaveLength(2);

    act(() => {
      result.current.undo();
    });

    expect(result.current.groups).toEqual([{ start: 0, accountId: 'a-1' }]);
    expect(result.current.state?.rows.map(row => row.accountId)).toEqual([
      'a-1',
      'a-1',
    ]);
  });

  it('asks the budget about every account the rows go to', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });

    // The FITID lookup covers every account: a FITID is only unique
    // within one, so a row is matched against its OWN account.
    const queryCalls = sendMock.mock.calls.filter(call => call[0] === 'query');
    const lookup = queryCalls[queryCalls.length - 1];
    expect(lookup?.[1]).toEqual(
      expect.objectContaining({
        filterExpressions: [
          {
            account: { $oneof: ['a-1', 'a-2'] },
            imported_id: { $oneof: ['FITID-1', 'FITID-2'] },
          },
        ],
      }),
    );
  });

  it('puts every row into one account', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });
    await act(async () => {
      await result.current.routeAll('a-2');
    });

    expect(result.current.groups).toEqual([{ start: 0, accountId: 'a-2' }]);
    expect(result.current.state?.rows.map(row => row.accountId)).toEqual([
      'a-2',
      'a-2',
    ]);
  });

  it('imports each group into its own account', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });
    await act(async () => {
      await result.current.apply();
    });

    // Upstream's import takes ONE account per call, so a review that
    // routes its rows into two accounts imports twice.
    const imports = sendMock.mock.calls.filter(
      call => call[0] === 'transactions-import' && call[1]?.isPreview === false,
    );
    expect(imports.map(call => call[1]?.accountId)).toEqual(['a-1', 'a-2']);
  });

  it('routes the rows even when one of them cannot be imported', async () => {
    const { result } = await renderReview();

    // A transfer to an account with no transfer payee cannot be
    // imported. The preview refuses it, and the refusal is swallowed:
    // the row will not import either way, and the apply step reports it
    // in the user's words.
    act(() => {
      result.current.edit(1, { transferAccountId: 'a-2' });
    });

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });

    expect(result.current.status).toBe('reviewing');
    expect(result.current.groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 1, accountId: 'a-2' },
    ]);
  });

  it('creates a payee two groups need only once', async () => {
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
          // Both rows are already in the budget, in the accounts they
          // are routed to.
          return {
            data: [
              { id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' },
              { id: 'txn-2', imported_id: 'FITID-2', account: 'a-2' },
            ],
            dependencies: [],
          };
        case 'payee-create':
          return 'p-new';
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
      result.current.edit(0, { payeeCanonical: 'Brand New Payee' });
      result.current.edit(1, { payeeCanonical: 'Brand New Payee' });
    });

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });
    await act(async () => {
      await result.current.apply();
    });

    // `payee-create` does not dedupe by name — it always inserts — so a
    // payee two groups need has to be created once.
    const creates = sendMock.mock.calls.filter(
      call => call[0] === 'payee-create',
    );
    expect(creates).toHaveLength(1);
    expect(creates[0][1]).toEqual({ name: 'Brand New Payee' });
  });

  it('writes nothing when a group cannot be imported', async () => {
    const { result } = await renderReview();

    // A transfer to an account with no transfer payee cannot be
    // imported, and the refusal happens while the payloads are built.
    act(() => {
      result.current.edit(1, { transferAccountId: 'a-2' });
    });

    await act(async () => {
      await result.current.routeRow(1, 'a-2');
    });
    await act(async () => {
      await result.current.apply();
    });

    // The FIRST group was not written either: every payload is built
    // before anything is written.
    const imports = sendMock.mock.calls.filter(
      call => call[0] === 'transactions-import' && call[1]?.isPreview === false,
    );
    expect(imports).toHaveLength(0);
    const updates = sendMock.mock.calls.filter(
      call => call[0] === 'transaction-update',
    );
    expect(updates).toHaveLength(0);
  });

  it('undoes a routing change with the matches it had', async () => {
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
          // The transaction with this FITID is in a-1 and nowhere else.
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' }],
            dependencies: [],
          };
        case 'transactions-import':
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

    const { result } = await renderReview();

    // The row is in a-1, where the transaction with that FITID is.
    expect(result.current.isAlreadyImported('row-0')).toBe(true);

    await act(async () => {
      await result.current.routeRow(0, 'a-2');
    });
    // The row is in a-2 now, where there is no transaction with that
    // FITID.
    expect(result.current.isAlreadyImported('row-0')).toBe(false);

    act(() => {
      result.current.undo();
    });

    // The undo restores the matches too. A row that pointed at a
    // transaction in the account it was routed AWAY from would have that
    // transaction edited.
    expect(result.current.isAlreadyImported('row-0')).toBe(true);
  });

  it('drops a routing change that an undo overtook', async () => {
    // The second lookup hangs until the test lets it go, so the change
    // is still being made when the user undoes.
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let lookups = 0;

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
          lookups += 1;
          if (lookups > 1) await gate;
          return { data: [], dependencies: [] };
        case 'transactions-import':
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

    const { result } = await renderReview();

    let routing: Promise<boolean> | undefined;
    act(() => {
      routing = result.current.routeRow(1, 'a-2');
    });

    act(() => {
      result.current.undo();
    });

    await act(async () => {
      release?.();
      await routing;
    });

    // The change never happened, so the routing is as it was.
    expect(result.current.groups).toEqual([{ start: 0, accountId: 'a-1' }]);
  });

  // A review that was put aside: two rows, both pending.
  const SAVED_SESSION = {
    v: 2,
    savedAt: '2026-09-07T12:00:00.000Z',
    accountId: 'a-1',
    groups: [{ start: 0, accountId: 'a-1' }],
    filename: '/tmp/demo.ofx',
    trustLevel: 'cautious' as const,
    focusedIndex: 0,
    rows: [
      {
        accountId: 'a-1',
        importedId: 'FITID-1',
        date: '2026-09-07',
        amountCents: -2500,
        payeeRaw: 'Demo Vendor',
        previewKey: 'row-0',
        payeeCanonical: 'Demo Vendor',
        payeeMatchSource: 'existing-prefix' as const,
        matchedPayeeId: 'p-2',
        flags: [],
        decision: 'pending' as const,
        edits: {},
      },
      {
        accountId: 'a-1',
        importedId: 'FITID-2',
        date: '2026-09-08',
        amountCents: -1000,
        payeeRaw: 'Demo Other',
        previewKey: 'row-1',
        payeeCanonical: 'Demo Other',
        payeeMatchSource: 'existing-prefix' as const,
        flags: [],
        decision: 'pending' as const,
        edits: {},
      },
    ],
    editedRowKeys: [],
    vendorChoices: [],
    fingerprint: 'abc123',
  };

  it('routes a review that was picked up again', async () => {
    const view = renderHook(() =>
      useImportReview({
        accountId: 'a-1',
        filename: '/tmp/demo.ofx',
        session: SAVED_SESSION,
        onImported: vi.fn(),
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));

    await act(async () => {
      await view.result.current.routeRow(1, 'a-2');
    });

    // The rows are still there: a picked-up review can be routed like
    // any other.
    expect(view.result.current.state?.rows).toHaveLength(2);
    expect(view.result.current.state?.rows.map(row => row.accountId)).toEqual([
      'a-1',
      'a-2',
    ]);
  });

  it('puts the cursor on a row of the review it picked up', async () => {
    // The session was saved from a review with more rows than this one
    // has, so its cursor points at a row that is not here.
    //
    // The session is a constant: a new object on every render would
    // re-open the review on every render, and the review would never
    // settle.
    const session = { ...SAVED_SESSION, focusedIndex: 99 };
    const view = renderHook(() =>
      useImportReview({
        accountId: 'a-1',
        filename: '/tmp/demo.ofx',
        session,
        onImported: vi.fn(),
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));

    expect(view.result.current.focusedIndex).toBe(1);
  });

  it('resolves the rows again when the vendor map arrives late', async () => {
    // The vendor map is a synced preference, so it can arrive after the
    // review has opened. The rows were resolved without it, and nothing
    // resolved them again — so an entry that arrived late was never
    // used.
    const setPref = vi.fn();
    let mapRaw: string | undefined;
    prefMock.mockImplementation(() => [mapRaw, setPref]);

    const view = await renderReview();

    // Without the map, the row's vendor string is a prefix of a payee
    // the budget has.
    expect(view.result.current.state?.rows[0].matchedPayeeId).toBe('p-2');

    // The map arrives, and it says the vendor string is a different
    // payee.
    mapRaw = JSON.stringify({
      v: 1,
      updatedAt: '2026-09-07T12:00:00.000Z',
      entries: { 'Demo Vendor': 'p-1' },
    });

    await act(async () => {
      view.rerender();
    });

    expect(view.result.current.state?.rows[0].matchedPayeeId).toBe('p-1');
    expect(view.result.current.state?.rows[0].payeeMatchSource).toBe(
      'vendor-map',
    );
  });

  it('keeps the decisions when the vendor map arrives late', async () => {
    // The rows are resolved again, and the user's decisions and edits
    // have to survive it: resolving them again is not a reason to throw
    // the work away.
    const setPref = vi.fn();
    let mapRaw: string | undefined;
    prefMock.mockImplementation(() => [mapRaw, setPref]);

    const view = await renderReview();

    act(() => {
      view.result.current.decide(0, 'accept');
      view.result.current.edit(0, { memo: 'a note from the review' });
    });

    mapRaw = JSON.stringify({
      v: 1,
      updatedAt: '2026-09-07T12:00:00.000Z',
      entries: { 'Demo Vendor': 'p-1' },
    });

    await act(async () => {
      view.rerender();
    });

    expect(view.result.current.state?.rows[0].decision).toBe('accept');
    expect(view.result.current.state?.rows[0].edits.memo).toBe(
      'a note from the review',
    );
    // And the row was resolved again, with the map that arrived.
    expect(view.result.current.state?.rows[0].matchedPayeeId).toBe('p-1');
  });

  it('does not resolve a picked-up review again', async () => {
    // A review that was put aside and picked up again comes back with
    // the rows the user approved, resolved as they were then. Resolving
    // them against the budget as it is now would change what the user
    // agreed to.
    const setPref = vi.fn();
    prefMock.mockImplementation(() => [
      JSON.stringify({
        v: 1,
        updatedAt: '2026-09-07T12:00:00.000Z',
        entries: { 'Demo Vendor': 'p-1' },
      }),
      setPref,
    ]);

    const view = renderHook(() =>
      useImportReview({
        accountId: 'a-1',
        filename: '/tmp/demo.ofx',
        session: SAVED_SESSION,
        onImported: vi.fn(),
      }),
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));

    // The row still has the payee it was approved with, and the map did
    // not resolve it to a different one.
    expect(view.result.current.state?.rows[0].matchedPayeeId).toBe('p-2');
    expect(view.result.current.state?.rows[0].payeeMatchSource).toBe(
      'existing-prefix',
    );
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
          // The account is part of the answer: a FITID is only unique
          // within an account.
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' }],
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
          // The account is part of the answer: a FITID is only unique
          // within an account.
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' }],
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

  it('reconciles the legs of a split that is already in the budget', async () => {
    // The row is already in the budget and the user split it. The import
    // cannot do this on its own — its update path writes columns and
    // never touches the legs — so the review rewrites them.
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
          // The legs come back GROUPED under their parent, which is how
          // the budget is asked for them: without that option the query
          // leaves the split parents out entirely.
          return {
            data: [
              {
                id: 'txn-1',
                account: 'a-1',
                date: '2026-09-07',
                amount: -2500,
                payee: 'p-2',
                is_parent: true,
                imported_id: 'FITID-1',
                subtransactions: [
                  {
                    id: 'child-1',
                    account: 'a-1',
                    date: '2026-09-07',
                    amount: -2500,
                    category: 'c-1',
                    is_child: true,
                    parent_id: 'txn-1',
                    sort_order: -1,
                  },
                ],
              },
            ],
            dependencies: [],
          };
        case 'transactions-batch-update':
          return { added: [], updated: [], deleted: [] };
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
      result.current.edit(0, {
        splits: [{ amountCents: -1500, categoryId: 'c-1' }],
      });
    });

    await act(async () => {
      await result.current.apply();
    });

    // The legs were rewritten, and the row was NOT sent to the import:
    // the import's update path cannot touch the legs.
    expect(sendMock).toHaveBeenCalledWith(
      'transactions-batch-update',
      expect.objectContaining({
        updated: expect.arrayContaining([
          expect.objectContaining({ id: 'txn-1', is_parent: true }),
          expect.objectContaining({ id: 'child-1', amount: -1500 }),
        ]),
      }),
    );

    // The legs are asked for GROUPED under their parent. Without that
    // option the query leaves the split parents out, and the
    // reconciliation would find nothing to reconcile.
    const queryCalls = sendMock.mock.calls.filter(call => call[0] === 'query');
    const reconciliationQuery = queryCalls[queryCalls.length - 1];
    expect(reconciliationQuery?.[1]).toEqual(
      expect.objectContaining({
        tableOptions: expect.objectContaining({ splits: 'grouped' }),
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

  it('undo puts the cursor back on the row it undid', async () => {
    const { result } = await renderReview();

    // Accepting the first row moves the cursor on to the second one —
    // so the undo has to bring it back, or the row the user undid is off
    // screen.
    act(() => {
      result.current.decide(0, 'accept');
      result.current.moveFocus(1);
    });
    expect(result.current.focusedIndex).toBe(1);

    act(() => {
      result.current.undo();
    });

    expect(result.current.state?.rows[0].decision).toBe('pending');
    expect(result.current.focusedIndex).toBe(0);
  });

  it('keeps the cursor on a row', async () => {
    const { result } = await renderReview();

    // There are two rows, so the cursor cannot go past the second one.
    act(() => {
      result.current.moveFocus(5);
    });
    expect(result.current.focusedIndex).toBe(1);

    // And it can still move up from there — a cursor that had walked
    // past the end would come back to the end instead of to the row
    // above it.
    act(() => {
      result.current.moveFocus(-1);
    });
    expect(result.current.focusedIndex).toBe(0);

    // And it cannot go before the first one.
    act(() => {
      result.current.moveFocus(-5);
    });
    expect(result.current.focusedIndex).toBe(0);
  });

  it('can move up from the last row', async () => {
    const { result } = await renderReview();

    // The cursor is on the last row and the user moves down: nothing
    // happens, because there is nothing below. But the cursor must not
    // have walked PAST the last row either — otherwise moving up would
    // bring it back to the last row instead of to the one above it, and
    // the key would look broken.
    act(() => {
      result.current.focus(1);
      result.current.moveFocus(1);
    });
    expect(result.current.focusedIndex).toBe(1);

    act(() => {
      result.current.moveFocus(-1);
    });
    expect(result.current.focusedIndex).toBe(0);
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

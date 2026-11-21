import { createElement } from 'react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';

import { send } from '@actual-app/core/platform/client/connection';
import type { RuleEntity } from '@actual-app/core/types/models/rule';
import { configureStore } from '@reduxjs/toolkit';
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

/**
 * A store for the review to dispatch into.
 *
 * The rows that land are MARKED, and that mark is a Redux action. The
 * test does not care what the app's store does with it — only that the
 * action was dispatched — so the store is a stub whose reducer ignores
 * everything it is given.
 */
function testStore() {
  const store = configureStore({ reducer: () => ({}) });
  const dispatch = vi.spyOn(store, 'dispatch');
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store, children });
  return { dispatch, wrapper };
}

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
  /** The budget's rules. Empty: the review starts with none. */
  const RULES: RuleEntity[] = [];
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
        case 'rules-get':
          // The budget's rules. The review reads them so a rule it
          // creates can be AMENDED rather than added.
          return RULES;
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
    const { wrapper } = testStore();
    const view = renderHook(
      () =>
        useImportReview({
          accountId: 'a-1',
          filename: '/tmp/demo.ofx',
          onImported: vi.fn(),
        }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));
    return view;
  }

  it('parses the file into rows', async () => {
    const { result } = await renderReview();
    expect(result.current.state?.rows).toHaveLength(2);
    expect(result.current.summary.total).toBe(2);
  });

  it('sets the trust level directly, keeping the rows and their edits', async () => {
    const { result } = await renderReview();

    act(() => {
      result.current.edit(0, { memo: 'a note' });
    });
    expect(result.current.unsavedWork.hasWork).toBe(true);

    act(() => {
      result.current.setTrustLevel('trusted');
    });

    expect(result.current.trustLevel).toBe('trusted');
    // The gate is re-evaluated on the SAME rows: re-parsing the file would
    // discard the note the user just wrote.
    expect(result.current.state?.trustLevel).toBe('trusted');
    expect(result.current.unsavedWork.hasWork).toBe(true);
    expect(result.current.state?.rows[0].edits.memo).toBe('a note');
  });

  it('shows the rows only once the rules have reported their effects', async () => {
    // The rows and the rule effects belong together: the cells, the
    // status line and the rule picker all answer questions about the
    // same row. A table that appeared before the effects arrived would
    // say "this row has no rules" about a row that has one.
    let releaseQuery: () => void = () => undefined;
    const queryGate = new Promise<void>(resolve => {
      releaseQuery = resolve;
    });
    const base = sendMock.getMockImplementation() as
      | ((...args: unknown[]) => unknown)
      | undefined;
    sendMock.mockImplementation((async (name: string, ...args: unknown[]) => {
      if (name === 'query') await queryGate;
      return base?.(name, ...args);
    }) as never);

    const { wrapper } = testStore();
    const view = renderHook(
      () =>
        useImportReview({
          accountId: 'a-1',
          filename: '/tmp/demo.ofx',
          onImported: vi.fn(),
        }),
      { wrapper },
    );
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith('query', expect.anything()),
    );

    // The budget's answer is still on its way: nothing is on screen that
    // a keypress could ask about.
    expect(view.result.current.state).toBeNull();

    await act(async () => {
      releaseQuery();
    });
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));
    expect(view.result.current.state?.rows).toHaveLength(2);
    expect(view.result.current.ruleEffects).toBeDefined();
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

  it('writes a rule with the shape upstream understands', async () => {
    const { result } = await renderReview();

    let written: unknown;
    sendMock.mockImplementation((async (name: string, args: unknown) => {
      if (name === 'rule-add') {
        written = args;
        return { id: 'rule-1', ...(args as object) };
      }
      if (name === 'rules-get') return RULES;
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    let outcome = 'failed';
    await act(async () => {
      outcome = await result.current.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'Demo Vendor' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
      });
    });

    expect(outcome).toBe('created');
    expect(written).toEqual({
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
    });
  });

  it('amends a rule that already says the same thing', async () => {
    // Two rules with the same conditions are a tie, and upstream breaks
    // the tie on the rule id — a random UUID. So a second rule would
    // have an unpredictable winner.
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-old' }],
    };

    // The mock is set BEFORE the review opens: the review reads the
    // rules when it opens, and the amendment is decided against that
    // copy.
    const methods: string[] = [];
    let written: unknown;
    sendMock.mockImplementation((async (name: string, args: unknown) => {
      methods.push(name);
      if (name === 'rule-update') {
        written = args;
        return args;
      }
      if (name === 'rules-get') return [existing];
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    const { result } = await renderReview();

    await act(async () => {
      await result.current.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'Demo Vendor' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'p-new' }],
      });
    });

    expect(methods).toContain('rule-update');
    expect(methods).not.toContain('rule-add');
    expect(written).toEqual({
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-new' }],
    });
  });

  it('does not write a rule that already says the same thing', async () => {
    // A write that changes nothing still takes a step in the undo
    // history and still syncs. So there is no write at all, and the
    // review says the rule was already there.
    const existing: RuleEntity = {
      id: 'rule-1',
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'imported_payee', value: 'Demo Vendor' }],
      actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
    };

    const methods: string[] = [];
    sendMock.mockImplementation((async (name: string) => {
      methods.push(name);
      if (name === 'rules-get') return [existing];
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    const { result } = await renderReview();

    let outcome = 'created';
    await act(async () => {
      outcome = await result.current.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'Demo Vendor' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
      });
    });

    expect(outcome).toBe('unchanged');
    expect(methods).not.toContain('rule-add');
    expect(methods).not.toContain('rule-update');
  });

  it('says so when the rule could not be written', async () => {
    const { result } = await renderReview();

    sendMock.mockImplementation((async (name: string) => {
      if (name === 'rule-add') {
        return { error: { conditionErrors: ['no-null'] } };
      }
      if (name === 'rules-get') return RULES;
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    let outcome = 'created';
    await act(async () => {
      outcome = await result.current.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'Demo Vendor' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
      });
    });

    expect(outcome).toBe('failed');
    // The hook does not raise the banner for a rule that would not
    // write: the notice carries it, and a banner would sit there for
    // the rest of the review over something the user can fix by
    // pressing the button again.
    expect(result.current.error).toBeNull();
  });

  it('says the rule was made even when the refresh failed', async () => {
    // The rule IS in the budget once the write lands. Everything after
    // that only refreshes the review's copy of the budget, and a
    // failure there does not undo the rule. So the outcome must not be
    // "failed" — that would tell the user nothing was changed, and it
    // would be a lie.
    const { result } = await renderReview();

    sendMock.mockImplementation((async (name: string) => {
      if (name === 'rule-add') return { id: 'rule-1' };
      if (name === 'rules-get') throw new Error('the budget is gone');
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    let outcome = 'failed';
    await act(async () => {
      outcome = await result.current.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [
          { op: 'is', field: 'imported_payee', value: 'Demo Vendor' },
        ],
        actions: [{ op: 'set', field: 'payee', value: 'p-1' }],
      });
    });

    expect(outcome).toBe('created-stale');
  });

  it('refuses a second rule write while one is in flight', async () => {
    // Two writes at once would both read the same list of rules, and
    // both would decide to ADD — and two rules with the same
    // conditions are a tie that upstream breaks on the rule id, which
    // is a random UUID.
    const { result } = await renderReview();

    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    sendMock.mockImplementation((async (name: string) => {
      if (name === 'rule-add') {
        await gate;
        return { id: 'rule-1' };
      }
      if (name === 'rules-get') return RULES;
      if (name === 'payees-get') return PAYEES;
      if (name === 'accounts-get') return ACCOUNTS;
      if (name === 'get-categories') return CATEGORIES;
      if (name === 'transactions-parse-file') return PARSED;
      if (name === 'transactions-import') {
        return { updatedPreview: [], added: [], updated: [], errors: [] };
      }
      if (name === 'query') return { data: [], dependencies: [] };
      throw new Error(`unexpected send: ${name}`);
    }) as never);

    const rule = {
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
      conditions: [
        {
          op: 'is' as const,
          field: 'imported_payee' as const,
          value: 'Demo Vendor',
        },
      ],
      actions: [{ op: 'set' as const, field: 'payee', value: 'p-1' }],
    };

    let first = 'created';
    let second = 'created';
    await act(async () => {
      const firstWrite = result.current.createRule(rule);
      second = await result.current.createRule(rule);
      release?.();
      first = await firstWrite;
    });

    expect(second).toBe('busy');
    expect(first).toBe('created');
  });

  it('imports every row into the account the review was opened for', async () => {
    const { result } = await renderReview();

    await act(async () => {
      await result.current.apply();
    });

    // Upstream's import takes ONE account per call, and every row of the
    // file goes into the account the review was opened for.
    const imports = sendMock.mock.calls.filter(
      call => call[0] === 'transactions-import' && call[1]?.isPreview === false,
    );
    expect(imports).toHaveLength(1);
    expect(imports[0][1]?.accountId).toBe('a-1');
  });

  it('marks the rows that landed, so the budget says what just arrived', async () => {
    const { dispatch, wrapper } = testStore();
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'rules-get':
          return RULES;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
          return { data: [], dependencies: [] };
        case 'transactions-import':
          return {
            updatedPreview: [],
            added: ['trx-1'],
            updated: ['trx-2'],
            errors: [],
          };
        default:
          throw new Error(`unexpected send: ${name}`);
      }
    }) as never);

    const view = renderHook(
      () =>
        useImportReview({
          accountId: 'a-1',
          filename: '/tmp/demo.ofx',
          onImported: vi.fn(),
        }),
      { wrapper },
    );
    await waitFor(() => expect(view.result.current.status).toBe('reviewing'));

    await act(async () => {
      await view.result.current.apply();
    });

    // The mark is a REDUX action, so the transaction list can render the
    // new rows the way it renders upstream's own import.
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'transactions/setNewTransactions',
        payload: {
          newTransactions: ['trx-1'],
          matchedTransactions: ['trx-2'],
        },
      }),
    );
  });

  it('asks the budget about the account the rows go into', async () => {
    await renderReview();

    // The FITID lookup is scoped to the account: a FITID is only unique
    // within one, so a row is matched against the account it is in.
    const queryCalls = sendMock.mock.calls.filter(call => call[0] === 'query');
    const lookup = queryCalls[queryCalls.length - 1];
    expect(lookup?.[1]).toEqual(
      expect.objectContaining({
        filterExpressions: [
          {
            account: { $oneof: ['a-1'] },
            imported_id: { $oneof: ['FITID-1', 'FITID-2'] },
          },
        ],
      }),
    );
  });

  it('creates a payee two rows need only once', async () => {
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'rules-get':
          // The budget's rules. The review reads them so a rule it
          // creates can be AMENDED rather than added.
          return RULES;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
          // Both rows are already in the budget, in the account they are
          // imported into.
          return {
            data: [
              { id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' },
              { id: 'txn-2', imported_id: 'FITID-2', account: 'a-1' },
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
      await result.current.apply();
    });

    // `payee-create` does not dedupe by name — it always inserts — so a
    // payee two rows need has to be created once.
    const creates = sendMock.mock.calls.filter(
      call => call[0] === 'payee-create',
    );
    expect(creates).toHaveLength(1);
    expect(creates[0][1]).toEqual({ name: 'Brand New Payee' });
  });

  it('writes nothing when a row cannot be imported', async () => {
    const { result } = await renderReview();

    // A transfer to an account with no transfer payee cannot be
    // imported, and the refusal happens while the payload is built.
    act(() => {
      result.current.edit(1, { transferAccountId: 'a-2' });
    });

    await act(async () => {
      await result.current.apply();
    });

    // Nothing was written: the payload is built before anything is
    // written.
    const imports = sendMock.mock.calls.filter(
      call => call[0] === 'transactions-import' && call[1]?.isPreview === false,
    );
    expect(imports).toHaveLength(0);
    const updates = sendMock.mock.calls.filter(
      call => call[0] === 'transaction-update',
    );
    expect(updates).toHaveLength(0);
  });

  // A review that was put aside: two rows, both pending.
  const SAVED_SESSION = {
    v: 3,
    savedAt: '2026-09-07T12:00:00.000Z',
    accountId: 'a-1',
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

  it('puts the cursor on a row of the review it picked up', async () => {
    // The session was saved from a review with more rows than this one
    // has, so its cursor points at a row that is not here.
    //
    // The session is a constant: a new object on every render would
    // re-open the review on every render, and the review would never
    // settle.
    const session = { ...SAVED_SESSION, focusedIndex: 99 };
    const { wrapper } = testStore();
    const view = renderHook(
      () =>
        useImportReview({
          accountId: 'a-1',
          filename: '/tmp/demo.ofx',
          session,
          onImported: vi.fn(),
        }),
      { wrapper },
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

    const { wrapper } = testStore();
    const view = renderHook(
      () =>
        useImportReview({
          accountId: 'a-1',
          filename: '/tmp/demo.ofx',
          session: SAVED_SESSION,
          onImported: vi.fn(),
        }),
      { wrapper },
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
        case 'rules-get':
          // The budget's rules. The review reads them so a rule it
          // creates can be AMENDED rather than added.
          return RULES;
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
        case 'rules-get':
          // The budget's rules. The review reads them so a rule it
          // creates can be AMENDED rather than added.
          return RULES;
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
        case 'rules-get':
          // The budget's rules. The review reads them so a rule it
          // creates can be AMENDED rather than added.
          return RULES;
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
        // Two legs that add up to the row's -2500: the sum guard now
        // refuses a one-leg split before it reaches reconciliation.
        splits: [
          { amountCents: -1500, categoryId: 'c-1' },
          { amountCents: -1000, categoryId: 'c-1' },
        ],
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

  it('shows a matched split as display context, not an edit', async () => {
    // A row that matched a split already in the budget carries its legs as
    // context so pressing `s` shows the real allocation. It must NOT become
    // an edit: an untouched row stays unedited and is not rewritten.
    sendMock.mockImplementation((async (name: string, payload?: unknown) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'rules-get':
          return RULES;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query': {
          const opts = (payload as { tableOptions?: { splits?: string } })
            .tableOptions;
          if (opts?.splits === 'grouped') {
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
                      amount: -1500,
                      category: 'c-1',
                      is_child: true,
                      parent_id: 'txn-1',
                      sort_order: -1,
                    },
                    {
                      id: 'child-2',
                      account: 'a-1',
                      date: '2026-09-07',
                      amount: -1000,
                      category: 'c-1',
                      is_child: true,
                      parent_id: 'txn-1',
                      sort_order: -2,
                    },
                  ],
                },
              ],
              dependencies: [],
            };
          }
          // The FITID match for the first row.
          return {
            data: [{ id: 'txn-1', imported_id: 'FITID-1', account: 'a-1' }],
            dependencies: [],
          };
        }
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
    const row = result.current.state?.rows[0];
    expect(row?.existingSplitLegs).toEqual([
      { amountCents: -1500, categoryId: 'c-1' },
      { amountCents: -1000, categoryId: 'c-1' },
    ]);
    // Still not user work: the legs are context, not edits.
    expect(row?.edits.splits).toBeUndefined();
    expect(result.current.unsavedWork.hasWork).toBe(false);
  });

  it('refuses an unbalanced split on a matched row without writing it', async () => {
    // The split guard must run on the reconciliation path too: otherwise
    // the legs' sum silently rewrites the matched parent's amount. The
    // user's split stays in the review so they can fix it and retry.
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'rules-get':
          return RULES;
        case 'get-categories':
          return CATEGORIES;
        case 'transactions-parse-file':
          return PARSED;
        case 'query':
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
                subtransactions: [],
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
        splits: [
          { amountCents: -1500, categoryId: 'c-1' },
          { amountCents: -500, categoryId: 'c-2' },
        ],
      });
    });

    let applied: boolean | undefined;
    await act(async () => {
      applied = await result.current.apply();
    });

    expect(applied).toBe(false);
    expect(result.current.error).toContain('The legs do not add up');
    // No budget write happened: the split is still in the review.
    expect(sendMock).not.toHaveBeenCalledWith(
      'transactions-batch-update',
      expect.anything(),
    );
    expect(result.current.state?.rows[0].edits.splits).toEqual([
      { amountCents: -1500, categoryId: 'c-1' },
      { amountCents: -500, categoryId: 'c-2' },
    ]);
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

  it('one undo takes back a chain-terminal accept but keeps the edits', async () => {
    const { result } = await renderReview();

    // The edit chain commits its last field, accepts the row, then moves
    // on. Each call snapshots, so one undo must take back only the accept:
    // the field the user just fixed has to survive, and the cursor has to
    // return to that row rather than the one the chain left it on.
    act(() => {
      result.current.edit(0, { payeeCanonical: 'Kroger' });
      result.current.decide(0, 'accept');
      result.current.moveFocus(1);
    });
    expect(result.current.state?.rows[0].decision).toBe('accept');
    expect(result.current.focusedIndex).toBe(1);

    act(() => {
      result.current.undo();
    });

    expect(result.current.state?.rows[0].decision).toBe('pending');
    expect(result.current.state?.rows[0].edits.payeeCanonical).toBe('Kroger');
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

  it('reads the rules again when they are asked for', async () => {
    // The rules can change while the review is open — the user edits one
    // in upstream's own editor. The review's copy of the rules has to
    // follow, because the next rule the review writes is an AMENDMENT of
    // the rule with the same conditions, and the amendment is built from
    // the copy the review holds. A stale copy would amend the OLD rule:
    // the user's edit to it would be undone, silently.
    const { result } = await renderReview();

    const EDITED: RuleEntity = {
      ...RULES[0],
      actions: [{ op: 'set', field: 'notes', value: 'edited by the user' }],
    };
    sendMock.mockImplementation((async (name: string) => {
      switch (name) {
        case 'rules-get':
          return [EDITED];
        case 'payees-get':
          return PAYEES;
        case 'accounts-get':
          return ACCOUNTS;
        case 'get-categories':
          return CATEGORIES;
        case 'query':
          return { data: [], dependencies: [] };
        case 'transactions-import':
          return {
            updatedPreview: [],
            added: [],
            updated: [],
            errors: [],
            ruledTransactions: [],
          };
        default:
          throw new Error(`unexpected send: ${name}`);
      }
    }) as never);

    await act(async () => {
      await result.current.refreshRuleEffects();
    });

    // The review holds the rule the user edited, not the one it read
    // when it opened.
    expect(result.current.rules).toHaveLength(1);
    expect(result.current.rules[0].actions).toEqual([
      { op: 'set', field: 'notes', value: 'edited by the user' },
    ]);
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
      if (name === 'rules-get') return RULES;
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

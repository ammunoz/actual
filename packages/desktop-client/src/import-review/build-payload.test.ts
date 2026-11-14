import {
  buildPreviewState,
  resolvePayees,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';

import { buildImportPayload, buildUpdatePayload } from './build-payload';

const PAYEES = [
  { id: 'p-coffee', name: 'Demo Coffee Shop', transfer_acct: null },
  { id: 'p-two', name: 'Demo Payee Two', transfer_acct: null },
  { id: 'p-transfer', name: 'Demo Checking', transfer_acct: 'a-checking' },
];

const CATEGORIES = [{ id: 'c-groceries', name: 'Groceries' }];

function mkRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'a-1',
    importedId: 'fit-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Coffee Shop',
    previewKey: 'row-0',
    ...overrides,
  };
}

function buildState(rows: readonly Record<string, unknown>[]) {
  const resolved = resolvePayees(rows as never, {
    existingPayees: [
      { id: 'p-coffee', name: 'Demo Coffee Shop' },
      { id: 'p-transfer', name: 'Demo Checking', transferAcct: 'a-checking' },
    ],
    accounts: [{ id: 'a-checking', name: 'Demo Checking' }],
  });
  return buildPreviewState(resolved, 'cautious');
}

describe('buildImportPayload', () => {
  it('sends the account, date and amount', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].account).toBe('a-1');
    expect(payload[0].date).toBe('2026-09-07');
    expect(payload[0].amount).toBe(-2500);
  });

  it('carries imported_id byte-for-byte', () => {
    const state = buildState([mkRow({ importedId: 'FITID-0001-X' })]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].imported_id).toBe('FITID-0001-X');
  });

  it('carries the transient row key with a leading underscore', () => {
    // Actual's insert path throws on a field the transactions table does
    // not have, unless it starts with an underscore. The preview key has
    // to travel through the import, so it has to be underscore-prefixed.
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0]._previewKey).toBeTruthy();
    expect(payload[0]).not.toHaveProperty('previewKey');
  });

  it('excludes a row that is updated in place', () => {
    // The import's update path keeps the existing payee, category and
    // notes, so sending the row again would undo the edit.
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
      updatedRowKeys: new Set([rowKey(state.rows[0])]),
    });
    expect(payload).toEqual([]);
  });

  it('sends the RAW vendor string as imported_payee', () => {
    const state = buildState([mkRow({ payeeRaw: 'POS PURCHASE 4251' })]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].imported_payee).toBe('POS PURCHASE 4251');
  });

  it('sends the resolved payee id when there is one', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-coffee');
    expect(payload[0].payee_name).toBeUndefined();
  });

  it('sends payee_name only when no payee id is known', () => {
    const state = buildState([mkRow({ payeeRaw: 'Brand New Vendor' })]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBeUndefined();
    expect(payload[0].payee_name).toBe('Brand New Vendor');
  });

  it('marks accepted rows as cleared', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].cleared).toBe(true);
  });

  it('marks a dropped row with skipTransaction instead of omitting it', () => {
    const state = buildState([mkRow()]);
    const dropped = {
      ...state,
      rows: state.rows.map(row => ({ ...row, decision: 'drop' as const })),
    };
    const payload = buildImportPayload(dropped, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].skipTransaction).toBe(true);
  });

  it('does not set skipTransaction on a pending row', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].skipTransaction).toBeUndefined();
  });

  it('does NOT set forceAddTransaction on any row', () => {
    // `forceAddTransaction` routes a row down Actual's ADD path, which
    // creates a SECOND transaction. It is not a way to change an existing
    // transaction's payee.
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0]).not.toHaveProperty('forceAddTransaction');
  });

  it('resolves a transfer account to its transfer payee id', () => {
    const state = buildState([mkRow({ payeeRaw: 'Demo Checking' })]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-transfer');
  });

  it('drops a stale category id', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: [], // c-groceries is not live
    });
    expect(payload[0].category).toBeUndefined();
  });

  it('sends the notes the user set', () => {
    const state = buildState([mkRow()]);
    const withMemo = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, memo: 'a note' },
      })),
    };
    const payload = buildImportPayload(withMemo, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].notes).toBe('a note');
  });

  it('does not send notes when the user cleared them', () => {
    const state = buildState([mkRow({ memo: 'bank memo' })]);
    const cleared = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, memo: '' },
      })),
    };
    const payload = buildImportPayload(cleared, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].notes).toBe('');
  });

  it('puts a split on subtransactions and leaves the parent uncategorised', () => {
    const state = buildState([mkRow()]);
    const split = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: {
          ...row.edits,
          splits: [
            { amountCents: -1500, categoryId: 'c-groceries' },
            { amountCents: -1000, categoryId: 'c-groceries' },
          ],
        },
      })),
    };
    const payload = buildImportPayload(split, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].subtransactions).toEqual([
      { amount: -1500, category: 'c-groceries' },
      { amount: -1000, category: 'c-groceries' },
    ]);
  });

  it('drops a stale category from a split leg', () => {
    const state = buildState([mkRow()]);
    const split = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: {
          ...row.edits,
          splits: [
            { amountCents: -1500, categoryId: 'c-deleted' },
            { amountCents: -1000, categoryId: 'c-groceries' },
          ],
        },
      })),
    };
    const payload = buildImportPayload(split, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].subtransactions?.[0]).toEqual({ amount: -1500 });
  });

  it('omits subtransactions entirely for an ordinary row', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].subtransactions).toBeUndefined();
  });

  it('uses the user amount edit', () => {
    const state = buildState([mkRow()]);
    const edited = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, amountCents: -3000 },
      })),
    };
    const payload = buildImportPayload(edited, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].amount).toBe(-3000);
  });

  it('returns an empty array for an empty state', () => {
    const state = buildPreviewState([], 'cautious');
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toEqual([]);
  });
});

describe('buildUpdatePayload', () => {
  // Keyed by the row's key, which is the transient preview key.
  const MATCHED = new Map([['row-0', 'trx-1']]);

  function buildEditedState(edits: Record<string, unknown>) {
    const state = buildState([mkRow()]);
    return {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, ...edits },
      })),
    };
  }

  it('produces no update for a row the user did not edit', () => {
    const state = buildState([mkRow()]);
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(),
    });
    expect(updates).toEqual([]);
  });

  it('produces no update when the row matched nothing', () => {
    // Without the matched transaction's id we cannot update in place, and
    // forcing an add would duplicate the transaction.
    const state = buildEditedState({ payeeCanonical: 'Demo Payee Two' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: new Map(),
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toEqual([]);
  });

  it('produces no update for a dropped row', () => {
    const state = buildState([mkRow()]);
    const dropped = {
      ...state,
      rows: state.rows.map(row => ({ ...row, decision: 'drop' as const })),
    };
    const { updates } = buildUpdatePayload(dropped, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toEqual([]);
  });

  it('updates the matched transaction when the user changed the payee', () => {
    const state = buildEditedState({ payeeCanonical: 'Demo Payee Two' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.id).toBe('trx-1');
    expect(updates[0].update.account).toBe('a-1');
    // The payee the USER chose, not the one the resolver matched.
    expect(updates[0].update.payee).toBe('p-two');
  });

  it('updates the category when the user changed it', () => {
    const state = buildEditedState({ categoryId: 'c-groceries' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates[0].update.category).toBe('c-groceries');
  });

  it('drops a stale category from the update', () => {
    const state = buildEditedState({ categoryId: 'c-deleted' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toEqual([]);
  });

  it('updates the notes when the user changed them', () => {
    const state = buildEditedState({ memo: 'a note' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates[0].update.notes).toBe('a note');
  });

  it('always carries the amount and date, because the handler takes a whole transaction', () => {
    const state = buildEditedState({ memo: 'a note' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates[0].update.amount).toBe(-2500);
    expect(updates[0].update.date).toBe('2026-09-07');
  });

  it('sends an update when the ONLY change is the amount', () => {
    // The amount and the date are always on the update, because
    // `transaction-update` takes a whole transaction. Comparing the
    // update's own keys would make this row look unchanged and drop the
    // edit.
    const state = buildEditedState({ amountCents: -3000 });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.amount).toBe(-3000);
  });

  it('sends an update when the ONLY change is the date', () => {
    const state = buildEditedState({ date: '2026-09-09' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.date).toBe('2026-09-09');
  });

  it('does NOT send an update when the edit equals the original value', () => {
    const state = buildEditedState({ amountCents: -2500 });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toEqual([]);
  });

  it('reports the payee to create when the user named a new one', () => {
    // `transaction-update` cannot create a payee from a name, so the
    // caller has to create it first.
    const state = buildEditedState({ payeeCanonical: 'Demo Brand New Payee' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.payee).toBeUndefined();
    expect(updates[0].payeeNameToCreate).toBe('Demo Brand New Payee');
  });

  it('uses the id of an existing payee when the user named one', () => {
    const state = buildEditedState({ payeeCanonical: 'Demo Payee Two' });
    const { updates } = buildUpdatePayload(state, {
      accountId: 'a-1',
      matchedTransactionIds: MATCHED,
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates[0].update.payee).toBe('p-two');
    expect(updates[0].payeeNameToCreate).toBeUndefined();
  });
});

describe('buildImportPayload — a user payee edit beats the resolver match', () => {
  const PAYEES = [
    { id: 'p-coffee', name: 'Demo Coffee Shop', transfer_acct: null },
    { id: 'p-two', name: 'Demo Payee Two', transfer_acct: null },
  ];

  function buildStateWithEdit(edits: Record<string, unknown>) {
    const state = buildState([mkRow()]);
    return {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, ...edits },
      })),
    };
  }

  it('uses the payee the user chose, not the one the resolver matched', () => {
    // The resolver matched 'p-coffee' from the raw vendor string. The user
    // then chose 'Demo Payee Two', and their choice has to win.
    const state = buildStateWithEdit({ payeeCanonical: 'Demo Payee Two' });
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-two');
    expect(payload[0].payee_name).toBeUndefined();
  });

  it('sends the name when the user chose a payee that does not exist', () => {
    const state = buildStateWithEdit({
      payeeCanonical: 'Demo Brand New Payee',
    });
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBeUndefined();
    expect(payload[0].payee_name).toBe('Demo Brand New Payee');
  });

  it('still uses the resolver match when the user did not choose a payee', () => {
    const state = buildState([mkRow()]);
    const payload = buildImportPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-coffee');
  });
});

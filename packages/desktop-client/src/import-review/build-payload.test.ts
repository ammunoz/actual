import {
  buildPreviewState,
  resolvePayees,
  rowKey,
  updateEdits,
} from '@actual-app/core/server/transactions/import/review/index';

import {
  buildApplyPayload,
  buildPreviewPayload,
  buildUpdatePayload,
} from './build-payload';

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

describe('the transfer target', () => {
  it('sends the target accounts transfer payee', () => {
    const state = buildState([mkRow()]);
    const transfer = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: 'a-checking' },
      })),
    };
    const payload = buildApplyPayload(transfer, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-transfer');
  });

  it('refuses a target the budget has no transfer payee for', () => {
    // Without the check the row would fall through to the ordinary payee
    // path and land as an ordinary transaction, with nothing saying so.
    const state = buildState([mkRow()]);
    const transfer = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: 'a-nope' },
      })),
    };
    expect(() =>
      buildApplyPayload(transfer, {
        accountId: 'a-1',
        payees: PAYEES,
        categories: CATEGORIES,
      }),
    ).toThrow(/TRANSFER-001/);
  });

  it('lands a cleared auto-detected transfer under the vendors name', () => {
    // The resolver detected the transfer because the vendor string WAS
    // an account's name. The user says it is not a transfer, so the row
    // lands under an ordinary payee with that name — which is the
    // vendor's own name, not a new vendor.
    const state = buildState([mkRow({ payeeRaw: 'Demo Checking' })]);
    const cleared = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: '' },
      })),
    };
    const payload = buildApplyPayload(cleared, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBeUndefined();
    expect(payload[0].payee_name).toBe('Demo Checking');
  });

  it('refuses a row that is both a transfer and a split', () => {
    // The two say contradictory things about where the money goes: a
    // transfer's payee is the other account, and a split's legs carry
    // their own categories. The UI refuses the edit; the apply step is
    // the last place that can catch it.
    const state = buildState([mkRow()]);
    const both = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: {
          ...row.edits,
          transferAccountId: 'a-checking',
          splits: [
            { amountCents: -1500, categoryId: 'c-groceries' },
            { amountCents: -1000, categoryId: 'c-groceries' },
          ],
        },
      })),
    };
    expect(() =>
      buildApplyPayload(both, {
        accountId: 'a-1',
        payees: PAYEES,
        categories: CATEGORIES,
      }),
    ).toThrow(/SPLIT-006/);
  });

  it('sends an ordinary row when the transfer was cleared', () => {
    // The empty string is the "cleared" marker: it overrides the
    // resolver's auto-detect.
    const state = buildState([mkRow()]);
    const transfer = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: '' },
      })),
    };
    const payload = buildApplyPayload(transfer, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-coffee');
  });
});

describe('the update path of a transfer', () => {
  // A row that is already in the budget is edited IN PLACE, through
  // `transaction-update`. A transfer is a COLUMN, so it can be applied
  // there — and it has to be, or the edit would be dropped silently.
  function buildTransferState(
    edits: Record<string, unknown>,
    rowOverrides: Record<string, unknown> = {},
  ) {
    const state = buildState([mkRow(rowOverrides)]);
    return {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, ...edits },
      })),
    };
  }

  const opts = {
    accountId: 'a-1',
    matchedTransactionIds: new Map([['row-0', 'trx-1']]),
    payees: PAYEES,
    categories: CATEGORIES,
    editedRowKeys: new Set(['row-0']),
  };

  it('sends an update for a row whose ONLY edit is the transfer', () => {
    // Without this the update would carry nothing at all, and the
    // transfer would be dropped while the import reported success.
    const state = buildTransferState({ transferAccountId: 'a-checking' });
    const { updates } = buildUpdatePayload(state, opts);
    expect(updates).toHaveLength(1);
    expect(updates[0].update.payee).toBe('p-transfer');
  });

  it('keeps the FITID on the transaction it updates', () => {
    // The row is excluded from the import payload, because it is updated
    // in place. Actual's import UPDATE path is what writes `imported_id`
    // on a matched row, so without it here the transaction would lose its
    // dedup key — and the next import of the same file would add it a
    // second time.
    const state = buildTransferState({ memo: 'a note' });
    const { updates } = buildUpdatePayload(state, opts);
    expect(updates).toHaveLength(1);
    expect(updates[0].update.imported_id).toBe('fit-1');
  });

  it('does not clear the FITID of a row that has none', () => {
    // A row without a FITID must not wipe the one the transaction
    // already has.
    const state = buildTransferState({ memo: 'a note' }, { importedId: '' });
    const { updates } = buildUpdatePayload(state, opts);
    expect(updates).toHaveLength(1);
    expect(updates[0].update.imported_id).toBeUndefined();
  });

  it('sends nothing when the transfer is the one the resolver found', () => {
    // The resolver's transfer detection matched the vendor string
    // against an account name, so the row was already this transfer.
    const state = buildState([mkRow({ payeeRaw: 'Demo Checking' })]);
    const same = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: 'a-checking' },
      })),
    };
    const { updates } = buildUpdatePayload(same, opts);
    expect(updates).toEqual([]);
  });

  it('clears the payee when an auto-detected transfer is removed', () => {
    // The resolver matched the ACCOUNT, not a payee, so there is no
    // payee to go back to. Creating a payee named after the account
    // would put the money under a vendor that does not exist.
    const state = buildState([mkRow({ payeeRaw: 'Demo Checking' })]);
    const cleared = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, transferAccountId: '' },
      })),
    };
    const { updates } = buildUpdatePayload(cleared, opts);
    expect(updates).toHaveLength(1);
    expect(updates[0].update.payee).toBeNull();
    expect(updates[0].payeeNameToCreate).toBeUndefined();
  });

  it('refuses a transfer target the budget cannot honour', () => {
    const state = buildTransferState({ transferAccountId: 'a-nope' });
    expect(() => buildUpdatePayload(state, opts)).toThrow(/TRANSFER-001/);
  });
});

describe('buildApplyPayload', () => {
  it('sends the account, date and amount', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
      updatedRowKeys: new Set([rowKey(state.rows[0])]),
    });
    expect(payload).toEqual([]);
  });

  it('sends the RAW vendor string as imported_payee', () => {
    const state = buildState([mkRow({ payeeRaw: 'POS PURCHASE 4251' })]);
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].imported_payee).toBe('POS PURCHASE 4251');
  });

  it('sends the resolved payee id when there is one', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-coffee');
    expect(payload[0].payee_name).toBeUndefined();
  });

  it('sends payee_name only when no payee id is known', () => {
    const state = buildState([mkRow({ payeeRaw: 'Brand New Vendor' })]);
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBeUndefined();
    expect(payload[0].payee_name).toBe('Brand New Vendor');
  });

  it('marks accepted rows as cleared', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(dropped, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].skipTransaction).toBe(true);
  });

  it('does not set skipTransaction on a pending row', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0]).not.toHaveProperty('forceAddTransaction');
  });

  it('resolves a transfer account to its transfer payee id', () => {
    const state = buildState([mkRow({ payeeRaw: 'Demo Checking' })]);
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-transfer');
  });

  it('drops a stale category id', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(withMemo, {
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
    const payload = buildApplyPayload(cleared, {
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
    const payload = buildApplyPayload(split, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].subtransactions).toEqual([
      { amount: -1500, category: 'c-groceries' },
      { amount: -1000, category: 'c-groceries' },
    ]);
  });

  it('says a split leg has no category when its category is stale', () => {
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
    const payload = buildApplyPayload(split, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    // `null`, not an omitted key: upstream's `makeChild` decides
    // inherit-vs-override with `"category" in data`, so a leg without the
    // key inherits the parent's category. `null` says "no category".
    expect(payload[0].subtransactions?.[0]).toEqual({
      amount: -1500,
      category: null,
    });
  });

  it('omits subtransactions entirely for an ordinary row', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(edited, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].amount).toBe(-3000);
  });

  it('returns an empty array for an empty state', () => {
    const state = buildPreviewState([], 'cautious');
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toEqual([]);
  });
});

describe('buildApplyPayload — the trust-level gate', () => {
  /**
   * A row whose vendor string matches no payee and cannot be canonicalised
   * into one: the resolver finds nothing, and flags it.
   */
  function buildBlockedState(trustLevel: 'paranoid' | 'cautious' | 'trusted') {
    const state = buildState([mkRow({ payeeRaw: '' })]);
    return buildPreviewState(
      state.rows.map(row => ({
        ...row,
        flags: [
          { kind: 'unknown-payee' as const, code: 'PAYEE-UNK-001' as const },
        ],
      })),
      trustLevel,
    );
  }

  it('marks a blocked row so it is not imported', () => {
    const state = buildBlockedState('cautious');
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].skipTransaction).toBe(true);
  });

  it('still marks a blocked row the user merely accepted', () => {
    // The gate holds over a plain accept. The row is released again if the
    // trust level is lowered.
    const state = buildBlockedState('cautious');
    const accepted = {
      ...state,
      rows: state.rows.map(row => ({ ...row, decision: 'accept' as const })),
    };
    const payload = buildApplyPayload(accepted, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].skipTransaction).toBe(true);
  });

  it('does not mark a blocked row the user overrode', () => {
    const state = buildBlockedState('cautious');
    const overridden = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        decision: 'accept-override' as const,
      })),
    };
    const payload = buildApplyPayload(overridden, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].skipTransaction).toBeUndefined();
  });

  it('marks a hard-blocked row even when the user overrode it', () => {
    // Its amount is broken, so an override cannot release it.
    //
    // The amount is 0 cents, which is a whole number, so the ENGINE can
    // accept the row: it is sent, but marked so it does not land. A row
    // the engine cannot accept at all is omitted instead.
    const state = buildPreviewState(
      buildState([mkRow()]).rows.map(row => ({
        ...row,
        amountCents: 0,
        flags: [
          {
            kind: 'amount-mismatch' as const,
            code: 'AMT-MISMATCH-001' as const,
          },
        ],
      })),
      'trusted',
    );
    const overridden = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        decision: 'accept-override' as const,
      })),
    };
    const payload = buildApplyPayload(overridden, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].skipTransaction).toBe(true);
  });

  it('omits a row the engine cannot accept, in BOTH payloads', () => {
    // A row whose date the file did not supply makes the whole import
    // throw: Actual's matching pass does `subDays(trans.date, 7)` before it
    // looks at `skipTransaction`. Marking the row is not enough, so the
    // row is not sent at all.
    const rows = buildState([
      mkRow(),
      mkRow({ previewKey: 'row-1', importedId: 'fit-2' }),
    ]).rows;
    const state = buildPreviewState(
      rows.map((row, index) =>
        index === 1
          ? {
              ...row,
              date: 'Invalid Date',
              flags: [
                {
                  kind: 'date-out-of-range' as const,
                  code: 'DATE-RANGE-001' as const,
                },
              ],
            }
          : row,
      ),
      'cautious',
    );
    const opts = {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    };
    expect(buildPreviewPayload(state, opts)).toHaveLength(1);
    expect(buildApplyPayload(state, opts)).toHaveLength(1);
  });

  it('sends a row whose date the user fixed', () => {
    // The fix clears the flag and makes the row sendable again.
    const state = buildPreviewState(
      buildState([mkRow()]).rows.map(row => ({
        ...row,
        date: 'Invalid Date',
        flags: [
          {
            kind: 'date-out-of-range' as const,
            code: 'DATE-RANGE-001' as const,
          },
        ],
      })),
      'cautious',
    );
    const fixed = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, date: '2026-09-09' },
      })),
    };
    const payload = buildApplyPayload(fixed, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].date).toBe('2026-09-09');
    expect(payload[0].skipTransaction).toBeUndefined();
  });

  it('imports a blocked row once the trust level is relaxed', () => {
    const state = buildBlockedState('trusted');
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].skipTransaction).toBeUndefined();
  });

  it('does not update a row the gate holds back', () => {
    // An update would put the row in the budget by the back door.
    //
    // The edit is the memo, not the payee: editing the payee would CLEAR
    // the unknown-payee flag, which is the point of the edit-aware gate.
    const state = buildBlockedState('cautious');
    const edited = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, memo: 'a note' },
      })),
    };
    const { updates } = buildUpdatePayload(edited, {
      accountId: 'a-1',
      matchedTransactionIds: new Map([['row-0', 'trx-1']]),
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toEqual([]);
  });

  it('updates a held-back row once the user fixes what was wrong with it', () => {
    // Picking a payee clears the unknown-payee flag, so the row is no
    // longer held back and the edit can be applied.
    const state = buildBlockedState('cautious');
    const edited = {
      ...state,
      rows: state.rows.map(row => ({
        ...row,
        edits: { ...row.edits, payeeCanonical: 'Demo Payee Two' },
      })),
    };
    const { updates } = buildUpdatePayload(edited, {
      accountId: 'a-1',
      matchedTransactionIds: new Map([['row-0', 'trx-1']]),
      payees: PAYEES,
      categories: CATEGORIES,
      editedRowKeys: new Set(['row-0']),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].update.payee).toBe('p-two');
  });
});

describe('buildApplyPayload — a cleared category', () => {
  it('sends the category the resolver found when the user has not picked one', () => {
    const state = buildPreviewState(
      buildState([mkRow()]).rows.map(row => ({
        ...row,
        matchedCategoryId: 'c-groceries',
      })),
      'cautious',
    );
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].category).toBe('c-groceries');
  });

  it('omits the category when the user cleared it', () => {
    // `undefined` means "the user has not picked one", so it falls back to
    // the resolver's category. An EMPTY string is how the user says "no
    // category", and it has to be spelled out.
    const built = buildPreviewState(
      buildState([mkRow()]).rows.map(row => ({
        ...row,
        matchedCategoryId: 'c-groceries',
      })),
      'cautious',
    );
    const state = updateEdits(built, rowKey(built.rows[0]), {
      categoryId: '',
    });
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].category).toBeUndefined();
  });
});

describe('buildPreviewPayload', () => {
  it('marks nothing, so every row comes back with a match', () => {
    // Actual skips a marked row BEFORE it reports the match, so a marked
    // row would come back with no correlation at all, and any later edit
    // to it could never be applied in place.
    const state = buildState([mkRow()]);
    const dropped = {
      ...state,
      rows: state.rows.map(row => ({ ...row, decision: 'drop' as const })),
    };
    const payload = buildPreviewPayload(dropped, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].skipTransaction).toBeUndefined();
  });

  it('sends the same row the apply payload sends', () => {
    const state = buildState([mkRow()]);
    const opts = {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    };
    expect(buildPreviewPayload(state, opts)).toEqual(
      buildApplyPayload(state, opts),
    );
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

describe('buildApplyPayload — a user payee edit beats the resolver match', () => {
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
    const payload = buildApplyPayload(state, {
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
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBeUndefined();
    expect(payload[0].payee_name).toBe('Demo Brand New Payee');
  });

  it('still uses the resolver match when the user did not choose a payee', () => {
    const state = buildState([mkRow()]);
    const payload = buildApplyPayload(state, {
      accountId: 'a-1',
      payees: PAYEES,
      categories: CATEGORIES,
    });
    expect(payload[0].payee).toBe('p-coffee');
  });
});

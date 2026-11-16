import type { PreviewRow } from '@actual-app/core/server/transactions/import/review/index';
import { describe, expect, it } from 'vitest';

import {
  buildSession,
  fingerprintRows,
  isUsableSession,
  MAX_SESSION_BYTES,
  readSession,
  sessionToPreviewState,
  staleRowNames,
  writeSession,
} from './session';

function row(overrides: Partial<PreviewRow> = {}): PreviewRow {
  return {
    accountId: 'a-1',
    importedId: 'FITID-1',
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: 'Demo Vendor',
    previewKey: 'row-0',
    payeeCanonical: 'Demo Vendor',
    payeeMatchSource: 'existing-prefix',
    flags: [],
    decision: 'pending',
    edits: {},
    ...overrides,
  };
}

type Session = ReturnType<typeof buildSession>;

function session(
  overrides: Partial<{
    accountId: string;
    filename: string;
    trustLevel: 'paranoid' | 'cautious' | 'trusted';
    focusedIndex: number;
    state: {
      rows: PreviewRow[];
      trustLevel: 'paranoid' | 'cautious' | 'trusted';
    };
    groups: readonly { start: number; accountId: string }[];
    editedRowKeys: ReadonlySet<string>;
    vendorChoices: ReadonlyMap<string, { raw: string; payeeId: string }>;
    savedAt: string;
  }> = {},
): Session {
  return buildSession({
    accountId: 'a-1',
    groups: [{ start: 0, accountId: 'a-1' }],
    filename: '/tmp/demo.ofx',
    trustLevel: 'cautious',
    focusedIndex: 0,
    state: { rows: [row()], trustLevel: 'cautious' },
    editedRowKeys: new Set<string>(),
    vendorChoices: new Map(),
    savedAt: '2026-09-07T12:00:00.000Z',
    ...overrides,
  });
}

describe('buildSession', () => {
  it('holds the rows and what the user did with them', () => {
    const saved = session({
      editedRowKeys: new Set(['row-0']),
      vendorChoices: new Map([
        ['row-0', { raw: 'POS PURCHASE', payeeId: 'p-1' }],
      ]),
    });

    expect(saved.rows).toHaveLength(1);
    expect(saved.editedRowKeys).toEqual(['row-0']);
    expect(saved.vendorChoices).toEqual([
      ['row-0', { raw: 'POS PURCHASE', payeeId: 'p-1' }],
    ]);
    // The format version: a session written by an older version of the
    // review is discarded rather than half-understood.
    expect(saved.v).toBe(2);
  });

  it('holds the routing', () => {
    // A session that came back without the routing would put every row
    // into the account the review was opened for, which is not what the
    // user had done.
    const saved = session({
      groups: [
        { start: 0, accountId: 'a-1' },
        { start: 1, accountId: 'a-2' },
      ],
    });

    expect(saved.groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 1, accountId: 'a-2' },
    ]);
  });

  it('refuses a routing that does not cover the rows', () => {
    const broken = { ...session(), groups: [{ start: 3, accountId: 'a-1' }] };
    expect(isUsableSession(broken)).toBe(false);
  });

  it('refuses a routing with no groups', () => {
    const broken = { ...session(), groups: [] };
    expect(isUsableSession(broken)).toBe(false);
  });

  it('holds the trust level and the row the user was on', () => {
    const saved = session({
      trustLevel: 'trusted',
      focusedIndex: 3,
      state: { rows: [row()], trustLevel: 'trusted' },
    });

    expect(saved.trustLevel).toBe('trusted');
    expect(saved.focusedIndex).toBe(3);
  });

  it('does NOT hold the undo history', () => {
    // The undo stack holds whole states, and fifty of them would be a few
    // megabytes for a review the user is picking up again, not editing.
    const saved = session();
    expect(Object.keys(saved)).not.toContain('undoStack');
  });
});

describe('fingerprintRows', () => {
  it('is the same for the same rows', () => {
    const rows = [row()];
    expect(fingerprintRows(rows)).toBe(fingerprintRows(rows));
  });

  it('is different for different rows', () => {
    expect(fingerprintRows([row()])).not.toBe(
      fingerprintRows([row({ importedId: 'FITID-2' })]),
    );
  });
});

describe('the session as a string', () => {
  it('survives a round trip', () => {
    const saved = session({
      editedRowKeys: new Set(['row-0']),
      focusedIndex: 2,
    });

    const read = readSession(writeSession(saved));

    expect(read?.rows).toHaveLength(1);
    expect(read?.editedRowKeys).toEqual(['row-0']);
    expect(read?.focusedIndex).toBe(2);
  });

  it('is nothing when the stored value is not a session', () => {
    expect(readSession(null)).toBeUndefined();
    expect(readSession('')).toBeUndefined();
    expect(readSession('not json')).toBeUndefined();
    expect(readSession('{}')).toBeUndefined();
    expect(readSession('{"v":99}')).toBeUndefined();
  });

  it('is nothing when a row is not a row', () => {
    const broken = { ...session(), rows: [{ date: 42 }] };
    expect(readSession(JSON.stringify(broken))).toBeUndefined();
  });

  it('refuses a session from another version', () => {
    const older = { ...session(), v: 0 };
    expect(isUsableSession(older)).toBe(false);
  });
});

describe('sessionToPreviewState', () => {
  it('gives the rows and the trust level back', () => {
    const state = sessionToPreviewState(
      session({
        trustLevel: 'trusted',
        state: { rows: [row()], trustLevel: 'trusted' },
      }),
    );

    expect(state.trustLevel).toBe('trusted');
    expect(state.rows).toHaveLength(1);
  });
});

describe('staleRowNames', () => {
  const live = {
    accounts: [{ id: 'a-1', name: 'Demo Checking' }],
    payees: [{ id: 'p-1', name: 'Demo Vendor' }],
    categories: [{ id: 'c-1', name: 'Groceries' }],
  };

  it('says nothing when everything is still there', () => {
    const saved = session();
    expect(staleRowNames(saved, live)).toEqual([]);
  });

  it('says when the account is gone', () => {
    const saved = session({ accountId: 'a-gone' });
    expect(staleRowNames(saved, live)).toContain('a-gone');
  });

  it('says when a category is gone', () => {
    const saved = session();
    saved.rows[0].edits.categoryId = 'c-gone';
    expect(staleRowNames(saved, live)).toContain('c-gone');
  });

  it("says when a leg's category is gone", () => {
    const saved = session();
    saved.rows[0].edits.splits = [{ amountCents: -2500, categoryId: 'c-gone' }];
    expect(staleRowNames(saved, live)).toContain('c-gone');
  });

  it('says nothing about a payee the user TYPED', () => {
    // A payee the user typed is not in the budget yet: the import
    // creates it.
    const saved = session();
    saved.rows[0].edits.payeeCanonical = 'Demo Brand New Payee';
    expect(staleRowNames(saved, live)).toEqual([]);
  });
});

describe('the size of a session', () => {
  it('is bounded', () => {
    expect(MAX_SESSION_BYTES).toBeLessThan(1024 * 1024);
  });
});

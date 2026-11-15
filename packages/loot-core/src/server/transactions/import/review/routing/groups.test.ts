import { describe, expect, it } from 'vitest';

import {
  accountForRow,
  defaultGroups,
  distinctAccounts,
  groupAt,
  groupRanges,
  isValidRouting,
  rangeOfGroup,
  rowsOfGroup,
  setAllRowsAccount,
  setRowAccount,
} from './groups';

/**
 * The routing is the partition of the rows into the accounts they are
 * imported into. These tests pin down the invariants the rest of the
 * feature relies on:
 *
 *   - the groups cover the rows exactly (no gap, no overlap),
 *   - a group's end is where the next group starts,
 *   - two groups next to each other with the same account are one group,
 *   - giving a row an account splits its group at that row.
 */
describe('defaultGroups', () => {
  it('is one group covering every row', () => {
    expect(defaultGroups(3, 'a-1')).toEqual([{ start: 0, accountId: 'a-1' }]);
  });

  it('is nothing when there are no rows', () => {
    expect(defaultGroups(0, 'a-1')).toEqual([]);
  });
});

describe('groupAt', () => {
  const groups = [
    { start: 0, accountId: 'a-1' },
    { start: 2, accountId: 'a-2' },
  ];

  it('finds the group a row belongs to', () => {
    expect(groupAt(groups, 0)?.accountId).toBe('a-1');
    expect(groupAt(groups, 1)?.accountId).toBe('a-1');
    expect(groupAt(groups, 2)?.accountId).toBe('a-2');
    expect(groupAt(groups, 5)?.accountId).toBe('a-2');
  });

  it('finds nothing for a row before the first group', () => {
    expect(groupAt(groups, -1)).toBeUndefined();
  });
});

describe('accountForRow', () => {
  it('says which account a row is imported into', () => {
    const groups = [
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
    ];
    expect(accountForRow(groups, 1)).toBe('a-1');
    expect(accountForRow(groups, 2)).toBe('a-2');
  });
});

describe('rangeOfGroup', () => {
  it('ends where the next group starts', () => {
    const groups = [
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
    ];
    const range = rangeOfGroup(groups, 2, 5);
    expect(range?.start).toBe(2);
    expect(range?.end).toBe(4);
    expect(range?.count).toBe(3);
  });

  it('says nothing for a group that is not there', () => {
    expect(
      rangeOfGroup([{ start: 0, accountId: 'a-1' }], 3, 5),
    ).toBeUndefined();
  });
});

describe('rowsOfGroup', () => {
  it('lists the rows the group covers', () => {
    const groups = [
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
    ];
    expect(rowsOfGroup(groups, 2, 5)).toEqual([2, 3, 4]);
  });
});

describe('groupRanges', () => {
  it('covers the rows exactly', () => {
    const groups = [
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
    ];
    const ranges = groupRanges(groups, 5);
    expect(ranges).toEqual([
      {
        group: { start: 0, accountId: 'a-1' },
        start: 0,
        end: 1,
        count: 2,
      },
      {
        group: { start: 2, accountId: 'a-2' },
        start: 2,
        end: 4,
        count: 3,
      },
    ]);
  });
});

describe('distinctAccounts', () => {
  it('says each account once', () => {
    const groups = [
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
      { start: 4, accountId: 'a-1' },
    ];
    expect(distinctAccounts(groups)).toEqual(['a-1', 'a-2']);
  });
});

describe('setRowAccount', () => {
  it('splits the group at the row', () => {
    // Rows 1-3 to a-1, rows 4-6 to a-2.
    const groups = setRowAccount([{ start: 0, accountId: 'a-1' }], 3, 'a-2', 6);
    expect(groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 3, accountId: 'a-2' },
    ]);
  });

  it('gives the whole group to the new account when the row is its first', () => {
    const groups = setRowAccount([{ start: 0, accountId: 'a-1' }], 0, 'a-2', 6);
    expect(groups).toEqual([{ start: 0, accountId: 'a-2' }]);
  });

  it('undoes a split by giving the row the account above it', () => {
    // Rows 1-3 to a-1, rows 4-6 to a-2, then row 4 back to a-1: the two
    // groups end up next to each other with the same account, so they are
    // one group again.
    const groups = setRowAccount(
      [
        { start: 0, accountId: 'a-1' },
        { start: 3, accountId: 'a-2' },
      ],
      3,
      'a-1',
      6,
    );
    expect(groups).toEqual([{ start: 0, accountId: 'a-1' }]);
  });

  it('keeps two groups apart when another account sits between them', () => {
    // Rows 1-2 to a-1, row 3 to a-2, rows 4-6 to a-1. The two a-1
    // groups are NOT next to each other, so they stay apart.
    const groups = setRowAccount(
      [
        { start: 0, accountId: 'a-1' },
        { start: 2, accountId: 'a-2' },
      ],
      3,
      'a-1',
      6,
    );
    expect(groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
      { start: 3, accountId: 'a-1' },
    ]);
  });

  it('merges back when the split is undone', () => {
    const split = setRowAccount([{ start: 0, accountId: 'a-1' }], 3, 'a-2', 6);
    const merged = setRowAccount(split, 3, 'a-1', 6);
    expect(merged).toEqual([{ start: 0, accountId: 'a-1' }]);
  });

  it('changes nothing when the row already has that account', () => {
    // Two adjacent groups with the same account are one group, so there
    // is nothing to split.
    const groups = [{ start: 0, accountId: 'a-1' }];
    expect(setRowAccount(groups, 3, 'a-1', 6)).toEqual(groups);
  });

  it('routes the rows after the cursor', () => {
    const groups = setRowAccount(
      [
        { start: 0, accountId: 'a-1' },
        { start: 2, accountId: 'a-2' },
      ],
      4,
      'a-3',
      6,
    );
    expect(groups).toEqual([
      { start: 0, accountId: 'a-1' },
      { start: 2, accountId: 'a-2' },
      { start: 4, accountId: 'a-3' },
    ]);
  });

  it('leaves the routing alone for a row that is not there', () => {
    const groups = [{ start: 0, accountId: 'a-1' }];
    expect(setRowAccount(groups, 9, 'a-2', 3)).toEqual(groups);
    expect(setRowAccount(groups, -1, 'a-2', 3)).toEqual(groups);
  });

  it('does not mutate the routing it was given', () => {
    const groups = [{ start: 0, accountId: 'a-1' }];
    setRowAccount(groups, 3, 'a-2', 6);
    expect(groups).toEqual([{ start: 0, accountId: 'a-1' }]);
  });
});

describe('setAllRowsAccount', () => {
  it('puts every row into one account', () => {
    const groups = setAllRowsAccount(
      [
        { start: 0, accountId: 'a-1' },
        { start: 3, accountId: 'a-2' },
      ],
      'a-3',
      6,
    );
    expect(groups).toEqual([{ start: 0, accountId: 'a-3' }]);
  });

  it('is nothing when there are no rows', () => {
    expect(setAllRowsAccount([], 'a-1', 0)).toEqual([]);
  });
});

describe('isValidRouting', () => {
  it('accepts a routing that covers the rows', () => {
    expect(
      isValidRouting(
        [
          { start: 0, accountId: 'a-1' },
          { start: 3, accountId: 'a-2' },
        ],
        6,
      ),
    ).toBe(true);
  });

  it('accepts a routing of one group', () => {
    expect(isValidRouting([{ start: 0, accountId: 'a-1' }], 6)).toBe(true);
  });

  it('refuses a routing that does not start at the first row', () => {
    expect(isValidRouting([{ start: 1, accountId: 'a-1' }], 6)).toBe(false);
  });

  it('covers the rows between two groups', () => {
    // A group's end is where the next group starts, so there is never a
    // gap: the first group covers rows 1-3 and the second rows 4-6.
    expect(
      isValidRouting(
        [
          { start: 0, accountId: 'a-1' },
          { start: 3, accountId: 'a-2' },
        ],
        6,
      ),
    ).toBe(true);
    expect(
      isValidRouting(
        [
          { start: 0, accountId: 'a-1' },
          { start: 4, accountId: 'a-2' },
        ],
        6,
      ),
    ).toBe(true);
  });

  it('refuses a routing whose groups overlap', () => {
    expect(
      isValidRouting(
        [
          { start: 0, accountId: 'a-1' },
          { start: 0, accountId: 'a-2' },
        ],
        6,
      ),
    ).toBe(false);
  });

  it('refuses a routing that runs past the last row', () => {
    expect(isValidRouting([{ start: 6, accountId: 'a-1' }], 6)).toBe(false);
  });

  it('refuses two adjacent groups with the same account', () => {
    expect(
      isValidRouting(
        [
          { start: 0, accountId: 'a-1' },
          { start: 3, accountId: 'a-1' },
        ],
        6,
      ),
    ).toBe(false);
  });

  it('refuses nonsense', () => {
    expect(isValidRouting(undefined, 6)).toBe(false);
    expect(isValidRouting('nonsense', 6)).toBe(false);
    expect(isValidRouting([{ start: 0 }], 6)).toBe(false);
    expect(isValidRouting([{ start: 0, accountId: '' }], 6)).toBe(false);
    expect(isValidRouting([{ start: 0.5, accountId: 'a-1' }], 6)).toBe(false);
  });

  it('is nothing for an empty review', () => {
    expect(isValidRouting([], 0)).toBe(true);
    expect(isValidRouting([{ start: 0, accountId: 'a-1' }], 0)).toBe(false);
  });
});

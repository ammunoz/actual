/**
 * The routing: which rows go to which account.
 *
 * A bank file usually holds ONE account's transactions, and the review
 * imports them into the account the user opened it for. A file can hold
 * more than one — a bank that exports both of the user's accounts into a
 * single file — and then the rows have to be routed.
 *
 * Actual's OFX parser flattens every statement of a file into one list and
 * drops `ACCTID`, so the review is given a flat list of rows with no trace
 * of which statement each row came from. The routing is therefore the
 * user's to make: they say which rows belong to which account.
 *
 * The model is a **partition of the rows into contiguous groups**, each with
 * one destination account. Contiguous, because a file's statements come one
 * after the other: the rows of a statement are a run, never interleaved.
 *
 * The user's only operation is "give the row at the cursor an account".
 * That splits the group containing the cursor at the cursor and gives the
 * second half the new account; groups that end up next to each other with
 * the same account are merged back together. So "rows 1-3 to Checking, rows
 * 4-6 to Savings" is done by putting the cursor on row 4 and picking
 * Savings, and picking Checking on row 4 again undoes it. There is no
 * separate "start a new group" action: the partition is implied by where
 * the account changes.
 *
 * Pure: every helper returns new arrays; no input is mutated and nothing
 * here touches React, the filesystem, or the server.
 */

/**
 * A contiguous run of rows that are imported into one account.
 *
 * The run's END is implied: it ends where the next group starts. Storing
 * only the start keeps a routing compact — a review of a thousand rows
 * with two accounts is two numbers, not a thousand.
 */
export type RowGroup = {
  /** The first row of the group, inclusive. */
  start: number;
  /** The account the group's rows are imported into. */
  accountId: string;
};

/**
 * A group together with the rows it covers.
 *
 * This is what the interface shows: a header naming the account and the
 * rows under it.
 */
export type GroupRange = {
  /** The group itself. */
  group: RowGroup;
  /** The first row, inclusive. */
  start: number;
  /** The last row, inclusive. */
  end: number;
  /** How many rows the group covers. */
  count: number;
};

/**
 * Pure: the routing a review starts with.
 *
 * One group covering every row, with the account the review was opened
 * for. That is exactly what the review did before routing existed, so the
 * feature changes nothing until the user routes something.
 */
export function defaultGroups(rowCount: number, accountId: string): RowGroup[] {
  if (rowCount <= 0) return [];
  return [{ start: 0, accountId }];
}

/**
 * Pure: the group a row belongs to.
 *
 * The groups are sorted and do not overlap, so the last one that starts at
 * or before the row is the one the row belongs to.
 *
 * A row PAST the last group gets the last group: the bounds are the
 * caller's job, and a cursor that has been left behind should not make a
 * row look like it belongs to no account at all.
 */
export function groupAt(
  groups: readonly RowGroup[],
  index: number,
): RowGroup | undefined {
  if (index < 0) return undefined;
  let found: RowGroup | undefined;
  for (const group of groups) {
    if (group.start > index) break;
    found = group;
  }
  return found;
}

/**
 * Pure: the account a row is imported into.
 */
export function accountForRow(
  groups: readonly RowGroup[],
  index: number,
): string | undefined {
  return groupAt(groups, index)?.accountId;
}

/**
 * Pure: the range a group covers.
 *
 * `groupStart` is the row a group BEGINS at, not a row the group
 * contains: the group's rows run from there to where the next group
 * starts.
 */
export function rangeOfGroup(
  groups: readonly RowGroup[],
  groupStart: number,
  rowCount: number,
): GroupRange | undefined {
  const position = groups.findIndex(group => group.start === groupStart);
  if (position === -1) return undefined;
  return rangeAt(groups, position, rowCount);
}

/**
 * Pure: the rows a group covers.
 */
export function rowsOfGroup(
  groups: readonly RowGroup[],
  groupStart: number,
  rowCount: number,
): number[] {
  const range = rangeOfGroup(groups, groupStart, rowCount);
  if (!range) return [];
  const rows: number[] = [];
  for (let row = range.start; row <= range.end; row++) {
    rows.push(row);
  }
  return rows;
}

/**
 * Pure: the range of the group at a position.
 *
 * The end of a group is where the next one starts, so the last group
 * ends with the last row.
 */
function rangeAt(
  groups: readonly RowGroup[],
  position: number,
  rowCount: number,
): GroupRange {
  const group = groups[position];
  const next = groups[position + 1];
  const end = next ? next.start - 1 : rowCount - 1;
  return {
    group,
    start: group.start,
    end,
    count: end - group.start + 1,
  };
}

/**
 * Pure: every group, with the rows it covers.
 *
 * This is what the interface renders: a header per group.
 */
export function groupRanges(
  groups: readonly RowGroup[],
  rowCount: number,
): GroupRange[] {
  return groups.map((_group, position) => rangeAt(groups, position, rowCount));
}

/**
 * Pure: the accounts the routing uses, each once.
 *
 * The lookups that are scoped to an account — the FITID lookup, the import
 * preview — are done once per account, not once per group.
 */
export function distinctAccounts(groups: readonly RowGroup[]): string[] {
  const seen = new Set<string>();
  const accounts: string[] = [];
  for (const group of groups) {
    if (seen.has(group.accountId)) continue;
    seen.add(group.accountId);
    accounts.push(group.accountId);
  }
  return accounts;
}

/**
 * Pure: the routing that puts a row into an account.
 *
 * The row's group is split at the row: the rows before it keep the group's
 * account, the rows from it onwards get the new one. Groups that end up
 * next to each other with the same account are then merged, so picking the
 * account of the group above undoes the split rather than leaving two
 * groups that look the same.
 *
 * Picking the account the row's group ALREADY has changes nothing: two
 * adjacent groups with the same account are one group, and the routing
 * says so. The routing that comes back is then EQUAL to the one that
 * went in, but not the same array: compare the two with
 * `isSameRouting`, not with `===`.
 */
export function setRowAccount(
  groups: readonly RowGroup[],
  index: number,
  accountId: string,
  rowCount: number,
): RowGroup[] {
  const position = positionOfRow(groups, index, rowCount);
  if (position === -1) return [...groups];

  const group = groups[position];
  if (group.accountId === accountId) return [...groups];

  const replacement: RowGroup[] = [];
  // The rows before the cursor keep the group's account. When the cursor
  // is the group's FIRST row there is nothing before it, and the whole
  // group moves to the new account.
  if (index > group.start) {
    replacement.push({ start: group.start, accountId: group.accountId });
  }
  replacement.push({ start: index, accountId });

  const candidates = [
    ...groups.slice(0, position),
    ...replacement,
    ...groups.slice(position + 1),
  ];

  return mergeAdjacent(candidates);
}
/**
 * Pure: whether two routings are the same.
 *
 * The routing functions return a NEW array every time, so "did this
 * change?" cannot be answered by identity. It matters: a routing change
 * re-resolves every row, and doing that for a routing that did not change
 * would throw away nothing and cost a lot.
 */
export function isSameRouting(
  a: readonly RowGroup[],
  b: readonly RowGroup[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (group, index) =>
      group.start === b[index].start && group.accountId === b[index].accountId,
  );
}

/**
 * Pure: the routing that puts EVERY row into one account.
 *
 * This is the way back: one group, one account, whatever the routing was.
 */
export function setAllRowsAccount(
  _groups: readonly RowGroup[],
  accountId: string,
  rowCount: number,
): RowGroup[] {
  return defaultGroups(rowCount, accountId);
}

/**
 * Pure: the position of the group a row belongs to.
 */
function positionOfRow(
  groups: readonly RowGroup[],
  index: number,
  rowCount: number,
): number {
  if (index < 0 || index >= rowCount) return -1;
  let position = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].start > index) break;
    position = i;
  }
  return position;
}

/**
 * Pure: merge the groups that sit next to each other with the same
 * account.
 *
 * Two adjacent groups with the same account are one group: the routing
 * says where the account CHANGES, and if it does not change there is
 * nothing to say.
 */
function mergeAdjacent(groups: readonly RowGroup[]): RowGroup[] {
  const merged: RowGroup[] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && previous.accountId === group.accountId) continue;
    merged.push(group);
  }
  return merged;
}

/**
 * Pure: whether a routing is one this review can use.
 *
 * A routing read back from a saved session has to be checked: it may have
 * been written by an older version of the review, or by something else
 * entirely. A routing that does not cover the rows exactly is refused, so
 * a review never runs against a partition it cannot trust.
 */
export function isValidRouting(
  groups: unknown,
  rowCount: number,
): groups is RowGroup[] {
  if (!Array.isArray(groups)) return false;
  if (rowCount <= 0) return groups.length === 0;
  if (groups.length === 0) return false;

  let previousStart = -1;
  let previousAccount: string | undefined;
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) return false;
    const { start, accountId } = group as Record<string, unknown>;
    if (typeof start !== 'number' || !Number.isInteger(start)) return false;
    if (typeof accountId !== 'string' || accountId.length === 0) return false;
    // The groups must cover the rows exactly: they start at the first
    // row, they do not overlap, and they do not run past the last row.
    if (start <= previousStart) return false;
    if (start < 0 || start >= rowCount) return false;
    // The first group has to start at the first row.
    if (previousStart === -1 && start !== 0) return false;
    // Two adjacent groups with the same account are one group.
    if (accountId === previousAccount) return false;
    previousStart = start;
    previousAccount = accountId;
  }

  return true;
}

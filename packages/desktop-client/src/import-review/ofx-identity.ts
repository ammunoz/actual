/**
 * The identity -> account map, as a set of pure functions.
 *
 * An OFX file carries its bank's own identifiers for the account it came
 * from. Remembering which Actual account each identity was imported into
 * lets the review warn when a file is aimed at a different account, and
 * lets the standalone import page suggest the right one.
 *
 * The map lives in a synced preference as a JSON string. This module never
 * reads or writes it: callers pass the raw string in and get a new one back.
 * Keeping the data pure makes the tricky parts — migrated legacy entries,
 * dominance rules and history caps — testable without a budget.
 */

/** How many recent accounts to keep for each identity. */
export const OFX_IDENTITY_LAST_N_CAP = 3;

/** How many successful imports of one account make it a safe suggestion. */
export const OFX_IDENTITY_DOMINANT_MIN_HITS = 2;

export type IdentityEntry = {
  /** The account the identity was last imported into. */
  accountId: string;
  /** ISO-8601 timestamp of that import. */
  updatedAt: string;
  /** Successful imports into `accountId`. */
  hits: number;
  /** Recent imports, newest first, capped at `OFX_IDENTITY_LAST_N_CAP`. */
  lastN: Array<{ accountId: string; at: string }>;
};

export type AccountRef = { id: string; name: string };

export type AccountMismatch = {
  /** The identity that found the remembered account. */
  identity: string;
  /** The account that identity remembers. */
  mappedAccountId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeEntry(value: unknown): IdentityEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { accountId, updatedAt, hits, lastN } = value;
  if (typeof accountId !== 'string' || accountId.length === 0) return undefined;
  if (typeof updatedAt !== 'string') return undefined;

  // Clamp the count: the suggestion only cares about a small threshold, so
  // a corrupted pref must not inflate confidence arbitrarily.
  const normalizedHits =
    typeof hits === 'number' && Number.isFinite(hits) && hits >= 1
      ? Math.min(Math.floor(hits), 1000)
      : 1;

  const normalizedLastN: IdentityEntry['lastN'] = [];
  const seenAccounts = new Set<string>();
  if (Array.isArray(lastN)) {
    for (const item of lastN) {
      if (!isRecord(item)) continue;
      if (typeof item.accountId !== 'string' || item.accountId.length === 0) {
        continue;
      }
      if (typeof item.at !== 'string') continue;
      if (seenAccounts.has(item.accountId)) continue;
      seenAccounts.add(item.accountId);
      normalizedLastN.push({ accountId: item.accountId, at: item.at });
      if (normalizedLastN.length >= OFX_IDENTITY_LAST_N_CAP) break;
    }
  }
  if (normalizedLastN.length === 0) {
    normalizedLastN.push({ accountId, at: updatedAt });
  }

  return {
    accountId,
    updatedAt,
    hits: normalizedHits,
    lastN: normalizedLastN,
  };
}

/**
 * Parse the preference string into a map. Never throws.
 *
 * Older versions stored only `{ accountId, updatedAt }`. Those entries are
 * migrated to a single hit, so they do not immediately become suggestions —
 * a second successful import is needed before an account is trusted enough
 * to prefill the picker.
 */
export function readIdentityMap(
  raw: string | undefined,
): ReadonlyMap<string, IdentityEntry> {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return new Map();

  const map = new Map<string, IdentityEntry>();
  for (const [identity, value] of Object.entries(parsed)) {
    if (identity.length === 0) continue;
    const entry = normalizeEntry(value);
    if (entry) map.set(identity, entry);
  }
  return map;
}

/**
 * The one account this file remembers, if it differs from the target.
 *
 * Several identities in one file can point to the same other account; only
 * one distinct mismatch is reported. Files with no remembered identity, or
 * whose identities all match the target, produce no mismatch.
 */
export function findMismatch(
  map: ReadonlyMap<string, IdentityEntry>,
  identities: readonly string[],
  targetAccountId: string,
): AccountMismatch | null {
  for (const identity of identities) {
    const entry = map.get(identity);
    if (!entry || entry.accountId === targetAccountId) continue;
    return { identity, mappedAccountId: entry.accountId };
  }
  return null;
}

/**
 * Record a successful import of `identities` into `accountId`.
 *
 * Returns the new preference string; the input map is not mutated. An import
 * into a different account than before resets `hits` for the new account so
 * a one-off exception cannot inherit the old account's dominance, while the
 * previous account stays in `lastN` for the "last time" wording.
 */
export function recordAccounts(
  map: ReadonlyMap<string, IdentityEntry>,
  identities: readonly string[],
  accountId: string,
  nowIso: string,
): string {
  const next = new Map(map);
  for (const identity of new Set(identities)) {
    if (identity.length === 0) continue;
    const existing = next.get(identity);
    const hits =
      existing && existing.accountId === accountId ? existing.hits + 1 : 1;
    const previous = existing?.lastN ?? [];
    next.set(identity, {
      accountId,
      updatedAt: nowIso,
      hits,
      lastN: [
        { accountId, at: nowIso },
        ...previous.filter(item => item.accountId !== accountId),
      ].slice(0, OFX_IDENTITY_LAST_N_CAP),
    });
  }
  return JSON.stringify(Object.fromEntries(next));
}

/**
 * The account to prefill in the setup picker, if the history is trustworthy.
 *
 * A suggestion requires at least `OFX_IDENTITY_DOMINANT_MIN_HITS` imports
 * into one account, no recent import into a different account, and that the
 * account still exists and is open. A single past import, or a recent
 * exception such as a tax account, deliberately yields no suggestion.
 */
export function suggestAccount(
  entry: IdentityEntry | undefined,
  openAccounts: readonly AccountRef[],
): string | undefined {
  if (!entry) return undefined;
  if (entry.hits < OFX_IDENTITY_DOMINANT_MIN_HITS) return undefined;
  if (entry.lastN.some(item => item.accountId !== entry.accountId)) {
    return undefined;
  }
  if (!openAccounts.some(account => account.id === entry.accountId)) {
    return undefined;
  }
  return entry.accountId;
}

import type { ReviewPayee } from '#server/transactions/import/review/types';

import type { FuzzyMatch, FuzzyPayeeCandidate } from './fuzzy';
import { DEFAULT_MAX_RESULTS, DEFAULT_MIN_SCORE } from './fuzzy';

/**
 * A cache of fuzzy payee matches.
 *
 * The fuzzy layer is the expensive one: it scores every candidate payee
 * against the row's raw vendor string, and it does that for every row.
 * On a large file that is thousands of scores, and the review re-runs
 * the whole resolution every time something changes — a rule is
 * created, a row is routed, the trust level moves.
 *
 * The result depends only on the row's raw string, the payee list, and
 * the thresholds. None of those change when a rule is written, so the
 * answers can be kept.
 *
 * **The cache holds the MATCHES, not the resolved rows.** A resolved row
 * carries the flags, and the flags depend on the user's edits — the
 * gate clears the `unknown-payee` and `fuzzy-payee-match` flags once the
 * user picks a payee. A cache of resolved rows would serve a stale
 * flag, and the gate would hold back a row the user had already fixed.
 *
 * The matches are the expensive part and nothing else.
 */
export type FuzzyCache = {
  /**
   * Look up a cached match list.
   *
   * The payee list's fingerprint is a level of the map, not part of the
   * key. The fingerprint is a few kilobytes — it holds every payee's
   * id, name, and transfer status — and putting it in every key would
   * copy it once per row. On a ten thousand row file that is hundreds of
   * megabytes of key strings for the answers themselves.
   */
  get(
    fingerprint: string,
    key: string,
  ): readonly FuzzyMatch<FuzzyPayeeCandidate>[] | undefined;
  /** Store a match list. */
  set(
    fingerprint: string,
    key: string,
    matches: readonly FuzzyMatch<FuzzyPayeeCandidate>[],
  ): void;
  /** Forget everything. */
  clear(): void;
  /** How many entries are held. Reported, not enforced. */
  readonly size: number;
};

/**
 * A fresh, empty cache.
 *
 * A `Map`, not a module-level singleton: two budgets open at once must
 * not share one cache, and the entries are only valid for the payee
 * list they were computed against.
 */
export function buildFuzzyCache(): FuzzyCache {
  // The outer map is the payee list's fingerprint; the inner one is
  // the rows' keys.
  const byFingerprint = new Map<
    string,
    Map<string, readonly FuzzyMatch<FuzzyPayeeCandidate>[]>
  >();

  const rowsFor = (fingerprint: string) => {
    let rows = byFingerprint.get(fingerprint);
    if (rows === undefined) {
      rows = new Map();
      byFingerprint.set(fingerprint, rows);
    }
    return rows;
  };

  return {
    get: (fingerprint, key) => byFingerprint.get(fingerprint)?.get(key),
    set: (fingerprint, key, matches) => {
      rowsFor(fingerprint).set(key, matches);
    },
    clear: () => {
      byFingerprint.clear();
    },
    get size() {
      let total = 0;
      for (const rows of byFingerprint.values()) {
        total += rows.size;
      }
      return total;
    },
  };
}

/**
 * A stable fingerprint of the payee list.
 *
 * The fingerprint is what makes a stale hit IMPOSSIBLE rather than
 * merely unlikely: the payee list is part of the cache's key, so a list
 * that changed cannot hit the old entries.
 *
 * It covers the **ids, the names, and the transfer status**:
 *
 * - The **ids** matter because the match names the payee's id.
 * - The **names** matter because the match names the payee's name.
 * - The **transfer status** matters because the resolver's index
 *   EXCLUDES transfer payees from the candidate list, so a payee that
 *   became a transfer leaves the candidates and the answer changes.
 *
 * **It is not hashed.** The joined string *is* the fingerprint: string
 * comparison is exact, and a hash would only add a collision risk.
 *
 * **Each record is JSON-encoded.** Payee names are free text a person
 * typed, so a name may contain any character — including the separator
 * this joins on. JSON encoding each record removes that: the separator
 * cannot appear inside an encoded record, because JSON escapes the
 * control characters.
 */
export function fingerprintPayees(payees: readonly ReviewPayee[]): string {
  return payees
    .map(payee =>
      JSON.stringify([payee.id, payee.name, payee.transferAcct ?? null]),
    )
    .sort()
    .join('\u0000');
}

/**
 * The cache key for one row's fuzzy matches.
 *
 * It holds **everything the fuzzy layer reads about the row, and
 * nothing else**: the row's raw vendor string and the thresholds.
 *
 * The payee list's fingerprint is NOT in it — that is the cache's outer
 * level. See the type's docblock for why.
 *
 * The rules are deliberately NOT in the key. The rules do not change
 * the fuzzy layer's answer, and including them would invalidate the
 * whole cache on every rule write — which is exactly when the cache
 * matters most.
 */
export function fuzzyCacheKey(
  fuzzy: { minScore?: number; maxResults?: number } | undefined,
  raw: string,
): string {
  // The EFFECTIVE thresholds, not the raw ones. The resolver applies
  // the fuzzy module's defaults, so a resolve with no thresholds at all
  // behaves exactly like one with the defaults spelled out — and the
  // two must not take two different cache entries.
  return JSON.stringify([
    fuzzy?.minScore ?? DEFAULT_MIN_SCORE,
    fuzzy?.maxResults ?? DEFAULT_MAX_RESULTS,
    raw,
  ]);
}

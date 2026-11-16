/**
 * Fuzzy payee matching helpers. Pure functional.
 *
 * Composite scorer — three signals, max-of-three:
 *
 *   tokenSetRatio  |intersection of whitespace tokens| / |union|
 *                  Tolerant of word reorder ("Coffee Shop Demo" vs
 *                  "Demo Coffee Shop") and of additive noise
 *                  ("DEMO COFFEE SHOP #1234" vs "Demo Coffee Shop").
 *                  Misses typos because a typo'd token doesn't match.
 *
 *   partialRatio   Best contiguous-substring match, scored by LCS
 *                  ratio. Catches single-word typos and abbreviations
 *                  ("Demo Cofee" vs "Demo Coffee Shop") by finding the
 *                  substring of one string that best matches the other.
 *                  Down-weighted (returns 0) when the two strings
 *                  differ in length by 2x or more — partial matches
 *                  become unreliable at that point (any short common
 *                  token can find a high-scoring tail-match in a long
 *                  string). The length guard handles the most extreme
 *                  length-gap cases; the 0.7 default threshold catches
 *                  the rest.
 *
 *   lcsRatio       Classic longest-common-subsequence ratio. Strict
 *                  in-order tolerance, no tokenization. Kept for
 *                  backward compatibility with the existing test
 *                  surface; rarely wins after tokenSet + partial are
 *                  computed.
 *
 *   fuzzyScore(a, b) = max(tokenSet, partial, lcs)
 */

import { canonicalize } from './strip';

export type FuzzyPayeeCandidate = {
  id: string;
  name: string;
};

export type FuzzyMatch<T extends FuzzyPayeeCandidate> = {
  candidate: T;
  score: number;
};

export type FuzzyMatchOpts = {
  /** Minimum composite score to keep a match. Default 0.7. */
  minScore?: number;
  /** Cap returned matches. Default 5. */
  maxResults?: number;
};

/**
 * The fuzzy layer's defaults.
 *
 * They are exported because the resolver's cache key has to use the
 * SAME thresholds the scoring will use — and a second copy of them
 * would silently drift.
 *
 * The minimum score for a fuzzy match to be kept. A lower threshold
 * admits clearly wrong matches: "Demo Grocery Store" against "Online
 * store" scores 0.667, and "Demo Payroll Deposit" against "Home Depot"
 * scores 0.600, while a real typo like "Demo Cofee Shop" against "Demo
 * Coffee Shop" scores 0.968.
 */
export const DEFAULT_MIN_SCORE = 0.7;
export const DEFAULT_MAX_RESULTS = 5;
// partialRatio is down-weighted (returns 0) when the two strings differ in
// length by more than this factor. Rationale: a short string can always find a
// high-scoring tail-match in a long string (e.g. a generic common word
// scoring 1.0 against a longer raw that happens to contain it as a tail
// token), producing false positives on city-tail / generic-word collisions.
const PARTIAL_MIN_LENGTH_RATIO = 0.5;

/**
 * Pure: the length of the longest common subsequence of two strings.
 * Classic dynamic programming; uses a flat Uint32Array for the DP row to
 * avoid the O(n*m) allocation cost of nested arrays.
 *
 * O(n*m) time, O(max(n,m)) space.
 */
export function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Iterate with `rows` as the outer loop (i), `cols` as the inner (j).
  // Pick the LONGER string as rows; the inner column buffer is then
  // max(n,m)+1 long.
  const [rows, cols] = a.length >= b.length ? [a, b] : [b, a];
  const m = cols.length;
  const prev = new Uint32Array(m + 1);
  const curr = new Uint32Array(m + 1);
  for (let i = 1; i <= rows.length; i++) {
    const ri = rows.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      curr[j] =
        ri === cols.charCodeAt(j - 1)
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    // swap prev/curr without copying
    for (let j = 0; j <= m; j++) {
      prev[j] = curr[j] ?? 0;
      curr[j] = 0;
    }
  }
  return prev[m] ?? 0;
}

/**
 * Pure: LCS ratio normalized to [0, 1]. Returns 1 for two empty strings, 0
 * if either side is empty.
 */
export function lcsRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/**
 * Pure: token-set ratio on whitespace-tokenized, lowercased input.
 *
 *   ratio = |intersection| / |union|
 *
 * Tolerates word reorder and additive noise (extra store numbers, trailing
 * state codes, etc.) but does NOT tolerate typos — a typo'd token doesn't
 * match its correct spelling and contributes 0 to the intersection.
 */
export function tokenSetRatio(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter += 1;
  const union = tokensA.size + tokensB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pure: best contiguous-substring match, scored by LCS ratio.
 *
 * Returns 0 when the strings differ in length by more than
 * `PARTIAL_MIN_LENGTH_RATIO`. Without this guard, a short common word can
 * find a perfect 1.0 match in any longer string. The guard handles the
 * extreme cases; the 0.7 default threshold catches the rest.
 *
 * Implementation note: the window is fixed at `short.length`. A
 * variable-length window would also catch alignments where the
 * best-matching region is shorter than the shorter string. Acceptable for
 * payee-length strings (typically 10–30 chars).
 */
export function partialRatio(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (lenRatio < PARTIAL_MIN_LENGTH_RATIO) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let best = 0;
  for (let i = 0; i <= long.length - short.length; i++) {
    const sub = long.slice(i, i + short.length);
    const r = lcsRatio(short, sub);
    if (r > best) best = r;
  }
  return best;
}

/**
 * Pure: composite fuzzy score — the maximum of tokenSetRatio, partialRatio,
 * and lcsRatio. Whichever signal fits the input best wins.
 */
export function fuzzyScore(a: string, b: string): number {
  return Math.max(tokenSetRatio(a, b), partialRatio(a, b), lcsRatio(a, b));
}

/**
 * Pure: rank `candidates` against the canonicalized `raw` by composite fuzzy
 * score. Returns up to `maxResults` matches with score >= `minScore`, sorted
 * by score descending (ties broken by candidate id ascending for
 * deterministic output). Empty input returns `[]`.
 *
 * The canonicalize step mirrors the resolver's fuzzy layer so the match sees
 * the same shape as the user's budget payee names after structural
 * normalization.
 */
export function fuzzyMatchPayees<T extends FuzzyPayeeCandidate>(
  raw: string,
  candidates: readonly T[],
  opts: FuzzyMatchOpts = {},
): readonly FuzzyMatch<T>[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
  const canonical = canonicalize(raw).toLowerCase();
  if (canonical === '') return [];
  const scored: Array<FuzzyMatch<T> | null> = candidates.map(c => {
    const score = fuzzyScore(canonical, c.name.toLowerCase());
    return score >= minScore ? { candidate: c, score } : null;
  });
  return scored
    .filter((m): m is FuzzyMatch<T> => m !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, maxResults);
}

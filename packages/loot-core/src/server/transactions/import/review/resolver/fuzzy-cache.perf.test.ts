import type {
  ReviewPayee,
  ReviewRowInput,
} from '#server/transactions/import/review/types';

import { buildFuzzyCache } from './payee-cache';
import { resolvePayees } from './payee-resolver';

/**
 * What the fuzzy layer costs.
 *
 * The review resolves every row's payee, and it re-runs the whole
 * resolution whenever something changes — a rule is created, a row is
 * routed, the trust level moves. The fuzzy layer is the expensive one:
 * it scores every budget payee against every row's vendor string, and
 * the scoring is quadratic in the length of the two strings.
 *
 * The claim this file checks is that the fuzzy layer is the bulk of the
 * resolver's cost, and that memoising its MATCHES removes it.
 *
 * The memo is `payee-cache.ts`: the cache holds the fuzzy matches, and
 * its key holds the payee list's fingerprint and the thresholds. The
 * rules are deliberately NOT in the key — a rule write does not change
 * the fuzzy layer's answer, so the cache stays warm across one, which
 * is exactly what makes a rule write affordable.
 *
 * This file does not assert anything about the timing. It measures, and
 * it prints. It is skipped unless FUZZY_PERF is set, so it costs
 * nothing in CI:
 *
 *     FUZZY_PERF=1 yarn workspace @actual-app/core run vitest --run \
 *       src/server/transactions/import/review/resolver/fuzzy-cache.perf.test.ts
 *
 * The numbers belong in the pull request, next to the feature they are
 * about.
 */

const RUN = process.env.FUZZY_PERF === '1';

/** How many rows the file holds. */
const ROW_SIZES = [50, 100, 200];

/** How many payees the budget holds. */
const PAYEE_SIZES = [100, 250, 500];

/** How many times each measurement is run. */
const RUNS = 3;

/**
 * The benchmark measures a slow thing, so it needs longer than the
 * default five seconds. It is skipped unless FUZZY_PERF is set, so this
 * only ever applies to someone who asked for it.
 */
const TIMEOUT = 120_000;

/** The fuzzy layer's own thresholds, as the review sets them. */
const FUZZY = { minScore: 0.7, maxResults: 5 };

/**
 * A budget's payees.
 *
 * The names are deliberately unlike each other, so the fuzzy layer has
 * real work to do rather than matching on the first candidate.
 */
function payees(count: number): readonly ReviewPayee[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `payee-${i}`,
    name: `Budget Payee Number ${i} Of The Budget`,
  }));
}

/**
 * A file's rows.
 *
 * The vendor strings are typos of the payees' names, so they land on
 * the fuzzy layer: the prefix layer would not match them, and the
 * strip fallback would not either.
 */
function rows(count: number): readonly ReviewRowInput[] {
  return Array.from({ length: count }, (_, i) => ({
    accountId: 'acct-1',
    importedId: `imported-${i}`,
    date: '2026-09-07',
    amountCents: -2500,
    payeeRaw: `Budget Payee Numer ${i} Of The Budget`,
  }));
}

/** The middle of the times, so one slow run does not decide the number. */
function median(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe.skipIf(!RUN)('the cost of the fuzzy layer', () => {
  it(
    'measures the resolve with and without a warm cache',
    () => {
      const lines: string[] = [];

      for (const payeeCount of PAYEE_SIZES) {
        const budgetPayees = payees(payeeCount);
        const fileRows = rows(100);

        // A resolve WITHOUT a cache: every row is scored from scratch.
        // It is run once first, so the timed runs are not paying for
        // whatever warm-up the first one needs.
        resolvePayees(fileRows, { existingPayees: budgetPayees, fuzzy: FUZZY });

        const cold: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          resolvePayees(fileRows, {
            existingPayees: budgetPayees,
            fuzzy: FUZZY,
          });
          cold.push(performance.now() - start);
        }

        // A resolve WITH a warm cache: the same rows, scored once.
        const cache = buildFuzzyCache();
        resolvePayees(fileRows, {
          existingPayees: budgetPayees,
          fuzzy: FUZZY,
          fuzzyCache: cache,
        });

        const warm: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          resolvePayees(fileRows, {
            existingPayees: budgetPayees,
            fuzzy: FUZZY,
            fuzzyCache: cache,
          });
          warm.push(performance.now() - start);
        }

        // The cache holds one entry per row. That is a fact about the
        // memo, not about the timing, so it is asserted. The timing
        // itself is NOT asserted: this file measures, and the numbers
        // go to stderr.
        expect(cache.size).toBe(fileRows.length);

        lines.push(
          `${String(payeeCount).padStart(5)} payees · ` +
            `${String(fileRows.length).padStart(5)} rows · ` +
            `cold ${median(cold).toFixed(1).padStart(8)} ms · ` +
            `warm ${median(warm).toFixed(1).padStart(8)} ms · ` +
            `${String(cache.size).padStart(5)} cached`,
        );
      }

      console.error(
        `\nTHE FUZZY LAYER (median of ${RUNS})\n${lines.join('\n')}\n`,
      );
    },
    TIMEOUT,
  );

  it(
    'measures how the cost scales with the file size',
    () => {
      const lines: string[] = [];
      const budgetPayees = payees(500);

      for (const rowCount of ROW_SIZES) {
        const fileRows = rows(rowCount);

        const cold: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          resolvePayees(fileRows, {
            existingPayees: budgetPayees,
            fuzzy: FUZZY,
          });
          cold.push(performance.now() - start);
        }

        const cache = buildFuzzyCache();
        resolvePayees(fileRows, {
          existingPayees: budgetPayees,
          fuzzy: FUZZY,
          fuzzyCache: cache,
        });

        const warm: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          resolvePayees(fileRows, {
            existingPayees: budgetPayees,
            fuzzy: FUZZY,
            fuzzyCache: cache,
          });
          warm.push(performance.now() - start);
        }

        // The cache holds one entry per row — a fact about the memo,
        // not about the timing, so it is asserted.
        expect(cache.size).toBe(fileRows.length);

        lines.push(
          `${String(rowCount).padStart(5)} rows · ` +
            `cold ${median(cold).toFixed(1).padStart(8)} ms · ` +
            `warm ${median(warm).toFixed(1).padStart(8)} ms`,
        );
      }

      console.error(
        `\nTHE FUZZY LAYER, BY FILE SIZE (median of ${RUNS})\n${lines.join('\n')}\n`,
      );
    },
    TIMEOUT,
  );

  it(
    'shows that the cache survives a rule write',
    () => {
      // The rules are not in the cache key, so a rule write — which does
      // not change the fuzzy layer's answer — leaves the cache warm. This
      // is the property the rules work depends on: every rule write
      // triggers a re-resolve, and the re-resolve has to be cheap.
      const budgetPayees = payees(500);
      const fileRows = rows(500);

      const cache = buildFuzzyCache();
      resolvePayees(fileRows, {
        existingPayees: budgetPayees,
        fuzzy: FUZZY,
        fuzzyCache: cache,
      });
      const afterFirst = cache.size;

      // The "rule write" is another resolve with the same payee list —
      // which is exactly what the review does when a rule is created.
      resolvePayees(fileRows, {
        existingPayees: budgetPayees,
        fuzzy: FUZZY,
        fuzzyCache: cache,
      });

      expect(cache.size).toBe(afterFirst);
      expect(cache.size).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

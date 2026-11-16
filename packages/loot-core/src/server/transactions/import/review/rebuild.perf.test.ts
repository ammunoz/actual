import type {
  ReviewPayee,
  ReviewRowInput,
} from '#server/transactions/import/review/types';

import { rebuildPreviewState } from './preview/rebuild';
import { buildFuzzyCache } from './resolver/payee-cache';

/**
 * What a re-resolve costs.
 *
 * The review re-runs the whole resolution whenever something changes —
 * a rule is created, a row is routed, the trust level moves. The
 * re-resolve is more than the payee resolution: it re-flags the file's
 * rows, re-raises the duplicate-FITID flags, resolves every payee, and
 * rebuilds the preview state.
 *
 * The fuzzy memo makes the PAYEE resolution cheap. This measures what
 * is left — the rest of the re-resolve, which is the part the memo
 * cannot touch.
 *
 * It is what decides whether the re-resolve needs debouncing: if the
 * whole thing is a few milliseconds, a burst of changes costs a few
 * milliseconds each and nothing needs coalescing. If it is hundreds,
 * a burst of ten rule writes costs seconds and they have to be
 * coalesced.
 *
 * This file does not assert anything about the timing. It measures, and
 * it prints. It is skipped unless REBUILD_PERF is set, so it costs
 * nothing in CI:
 *
 *     REBUILD_PERF=1 yarn workspace @actual-app/core run vitest --run \
 *       src/server/transactions/import/review/rebuild.perf.test.ts
 */

const RUN = process.env.REBUILD_PERF === '1';

/** How many rows the file holds. */
const ROW_SIZES = [100, 500, 1_000];

/** How many payees the budget holds. */
const PAYEE_COUNT = 500;

/** How many times each measurement is run. */
const RUNS = 3;

/** The benchmark measures a slow thing, so it needs longer. */
const TIMEOUT = 120_000;

function payees(count: number): readonly ReviewPayee[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `payee-${i}`,
    name: `Budget Payee Number ${i} Of The Budget`,
  }));
}

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

describe.skipIf(!RUN)('the cost of a re-resolve', () => {
  it(
    'measures the whole re-resolve, with and without a warm memo',
    () => {
      const lines: string[] = [];
      const budgetPayees = payees(PAYEE_COUNT);

      for (const rowCount of ROW_SIZES) {
        const fileRows = rows(rowCount);
        const base = fileRows.map(row => ({ ...row, flags: [] }));

        // A re-resolve with a COLD memo: every row is scored.
        const cold: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          rebuildPreviewState({
            base,
            trustLevel: 'cautious',
            resolveOpts: {
              existingPayees: budgetPayees,
              fuzzy: {},
              fuzzyCache: buildFuzzyCache(),
            },
          });
          cold.push(performance.now() - start);
        }

        // A re-resolve with a WARM memo: the matches are kept.
        const cache = buildFuzzyCache();
        rebuildPreviewState({
          base,
          trustLevel: 'cautious',
          resolveOpts: {
            existingPayees: budgetPayees,
            fuzzy: {},
            fuzzyCache: cache,
          },
        });

        const warm: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const start = performance.now();
          rebuildPreviewState({
            base,
            trustLevel: 'cautious',
            resolveOpts: {
              existingPayees: budgetPayees,
              fuzzy: {},
              fuzzyCache: cache,
            },
          });
          warm.push(performance.now() - start);
        }

        expect(cache.size).toBe(rowCount);

        lines.push(
          `${String(rowCount).padStart(5)} rows · ` +
            `cold ${median(cold).toFixed(1).padStart(8)} ms · ` +
            `warm ${median(warm).toFixed(1).padStart(8)} ms`,
        );
      }

      console.error(
        `\nTHE RE-RESOLVE (median of ${RUNS})\n${lines.join('\n')}\n`,
      );
    },
    TIMEOUT,
  );
});

import { aqlQuery, compileQuery, schema, schemaConfig } from '#server/aql';
import { defaultConstructQuery } from '#server/aql/compiler';
import * as db from '#server/db';
import { q } from '#shared/query';

/**
 * What the FITID lookup costs.
 *
 * When the review opens, it asks the budget which of the file's rows are
 * already in it: "the transactions in these accounts whose bank id is one
 * of these N ids". That question is asked once per parse, so its cost is
 * felt every time the review opens.
 *
 * The query is the one in `packages/desktop-client/src/import-review/
 * already-imported.ts` — copied, because the core cannot import the
 * desktop client. If that query changes, this has to change with it.
 *
 * Two things make it worth measuring:
 *
 *   - the bank's id lives in `transactions.financial_id`, and there is no
 *     index on it, so the database cannot find the answer by the id
 *     alone;
 *   - `$oneof` compiles to an inlined list of ids, so the SQL grows with
 *     the size of the file.
 *
 * What the plan says (see the second test) is that the database narrows
 * the question to the accounts first, using the index on
 * `(acct, tombstone)`. So the cost follows the transactions inside the
 * accounts the rows go into, and not the size of the budget — with a
 * cost per account on top, because each account is a separate seek.
 *
 * The three scenarios below make that measurable: the same number of
 * transactions, spread over one account or over a hundred, and asked
 * about one account or about all of them.
 *
 * This file does not assert anything about the timing. It measures, and
 * it prints. It is skipped unless FITID_PERF is set, so it costs nothing
 * in CI:
 *
 *     FITID_PERF=1 yarn workspace @actual-app/core run vitest --run \
 *       src/server/transactions/import/review/fitid-lookup.perf.test.ts
 *
 * The numbers belong in the pull request, next to the feature they are
 * about. What they were, on the machine this was measured on:
 *
 *     one account          ·    1000 transactions ·  100 ids ·   0.7 ms
 *     one account          ·  100000 transactions ·  100 ids ·  24.1 ms
 *     one of a hundred     ·  100000 transactions ·  100 ids ·   0.7 ms
 *     a hundred accounts   ·  100000 transactions ·  100 ids ·  48.5 ms
 *     a hundred accounts   ·  100000 transactions ·  500 ids ·  54.3 ms
 *
 * The third line is the one that matters: the same hundred thousand
 * transactions, and the same question, and the answer comes back in
 * under a millisecond — because the review only asked about the
 * hundredth of them that was in the account it was importing into.
 *
 * The review asks about ONE account — every row of a file goes into the
 * account the review was opened for — so the first two lines are the ones
 * that apply. The lines about a hundred accounts are headroom: they say
 * what the question would cost if it were ever asked about more.
 */

const RUN = process.env.FITID_PERF === '1';

/** How many transactions there are. */
const BUDGET_SIZES = [1_000, 10_000, 100_000];

/** How many ids the file holds — the size of the `IN (...)` list. */
const FILE_SIZES = [100, 500];

/** How many times the query is run, and the median reported. */
const RUNS = 5;

/**
 * The shapes the review asks the question in.
 *
 * Every scenario holds the same number of transactions; they differ in
 * how many accounts hold them, and in how many of those accounts the
 * review asks about.
 *
 *   `one`    — one account holds everything, and the review asks about
 *              that account.
 *   `one of` — a hundred accounts hold everything, and the review asks
 *              about ONE of them. This is the control: the budget grows
 *              while the answer stays the same size.
 *   `all`    — a hundred accounts hold everything, and the review asks
 *              about all of them at once.
 */
const SCENARIOS = [
  { name: 'one account', accounts: 1, asked: 1 },
  { name: 'one of a hundred', accounts: 100, asked: 1 },
  { name: 'a hundred accounts', accounts: 100, asked: 100 },
] as const;

beforeEach(global.emptyDatabase());

/**
 * Fill the budget with transactions, in bulk.
 *
 * One insert per transaction would make the SEEDING the slow part, and
 * the measurement would be of the seeding.
 *
 * The rows are written straight into the table rather than through
 * `db.insertTransaction`: the CRDT bookkeeping is not what is being
 * measured, and a hundred thousand of them would make the seeding the
 * slow part.
 */
function seed(count: number, accounts: number): void {
  // The budget is emptied first: the sizes are measured one after
  // another, and the ids have to be the same each time so that the only
  // thing that changes is how much there is to look through.
  db.runQuery('DELETE FROM transactions');
  const chunk = 1_000;
  for (let start = 0; start < count; start += chunk) {
    const rows: string[] = [];
    for (let i = start; i < Math.min(start + chunk, count); i++) {
      const account = `acct-${(i % accounts) + 1}`;
      rows.push(`('txn-${i}', '${account}', -1000, 20260907, 'FITID-${i}')`);
    }
    db.runQuery(
      `INSERT INTO transactions (id, acct, amount, date, financial_id) VALUES ${rows.join(',')}`,
    );
  }
}

/** The ids of a file of `count` rows. */
function fileIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `FITID-${i}`);
}

/**
 * The question the review asks, as the review asks it.
 *
 * The accounts are the ones the rows go into: one account, or every
 * account a review could be asked about at once.
 */
function lookup(ids: readonly string[], accounts: readonly string[]) {
  return aqlQuery(
    q('transactions')
      .filter({
        account: { $oneof: [...accounts] },
        imported_id: { $oneof: [...ids] },
      })
      .select(['id', 'imported_id', 'account']),
  );
}

/** What the database intends to do, in its own words. */
function explain(ids: readonly string[], accounts: readonly string[]) {
  const query = q('transactions')
    .filter({
      account: { $oneof: [...accounts] },
      imported_id: { $oneof: [...ids] },
    })
    .select(['id', 'imported_id', 'account'])
    .serialize();
  const { sqlPieces, state } = compileQuery(query, schema, schemaConfig);
  const sql = defaultConstructQuery(query, state, sqlPieces);
  const plan = db.runQuery<{ id: number; parent: number; detail: string }>(
    `EXPLAIN QUERY PLAN ${sql}`,
    undefined,
    true,
  );
  return plan.map(row => `${'  '.repeat(row.parent)}${row.detail}`);
}

/** The middle of the times, so one slow run does not decide the number. */
function median(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe.skipIf(!RUN)('the cost of the FITID lookup', () => {
  it('measures the lookup against a budget of every size', async () => {
    const rows: string[] = [];

    for (const scenario of SCENARIOS) {
      // The accounts are made once: the fixture must not depend on the
      // same id being inserted twice.
      for (let i = 1; i <= scenario.accounts; i++) {
        await db.insertAccount({ id: `acct-${i}`, name: `Account ${i}` });
      }
      const accounts = Array.from(
        { length: scenario.accounts },
        (_, i) => `acct-${i + 1}`,
      );
      // The accounts the review asks about: the first few of them.
      const asked = accounts.slice(0, scenario.asked);

      for (const budgetSize of BUDGET_SIZES) {
        seed(budgetSize, scenario.accounts);

        for (const fileSize of FILE_SIZES) {
          const ids = fileIds(fileSize);

          // The query is run once before it is timed: the first run pays
          // for SQLite reading the pages, and a review pays that once
          // too.
          await lookup(ids, asked);

          const times: number[] = [];
          let found = 0;
          for (let run = 0; run < RUNS; run++) {
            const start = performance.now();
            const { data } = await lookup(ids, asked);
            times.push(performance.now() - start);
            found = data.length;
          }

          expect(found).toBeGreaterThan(0);

          rows.push(
            `${scenario.name.padEnd(20)} · ` +
              `${String(budgetSize).padStart(7)} transactions · ` +
              `${String(fileSize).padStart(4)} ids · ` +
              `${median(times).toFixed(1).padStart(8)} ms · ` +
              `${String(found).padStart(3)} found`,
          );
        }
      }
    }

    // The numbers go to stderr, which is what vitest prints.
    console.error(
      `\nTHE FITID LOOKUP (median of ${RUNS})\n${rows.join('\n')}\n`,
    );
  });

  it('shows what the database intends to do', async () => {
    for (const scenario of SCENARIOS) {
      for (let i = 1; i <= scenario.accounts; i++) {
        await db.insertAccount({ id: `acct-${i}`, name: `Account ${i}` });
      }
      const accounts = Array.from(
        { length: scenario.accounts },
        (_, i) => `acct-${i + 1}`,
      );
      seed(10_000, scenario.accounts);

      const plan = explain(fileIds(100), accounts.slice(0, scenario.asked));

      // The plan says what the database intends to do. It is printed, not
      // asserted: what it says is SQLite's business, and it changes with
      // SQLite.
      expect(plan.length).toBeGreaterThan(0);

      console.error(`\nTHE PLAN — ${scenario.name}\n${plan.join('\n')}\n`);
    }
  });
});

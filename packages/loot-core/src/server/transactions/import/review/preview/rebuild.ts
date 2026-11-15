/**
 * Rebuilding the review's rows for a new routing.
 *
 * The rows of a review are resolved against the budget: the payee each
 * vendor string means, the transfer a row looks like, the flags that
 * follow from both. A routing change moves rows between accounts, and
 * that can change the resolution — a row whose vendor string is exactly
 * a budget account's name is a TRANSFER to that account, unless the row
 * is IN that account, in which case it cannot be.
 *
 * So a routing change re-resolves the rows. What it must NOT do is
 * throw away the user's work: the decision they made on a row and the
 * edits they typed are theirs, not the resolver's, and they are carried
 * across by the row's key.
 *
 * The re-resolution is a plain second call to the resolver over rows
 * whose account has been set from the routing. It is not a special path:
 * the resolver is the single source of truth for what a row means, and a
 * second code path that "mostly" agrees with it would be a second thing
 * to keep in step with it.
 *
 * Pure: every helper returns a new state; no input is mutated.
 */

import { resolvePayees } from '#server/transactions/import/review/resolver/payee-resolver';
import type { ResolveOpts } from '#server/transactions/import/review/resolver/payee-resolver';
import { accountForRow } from '#server/transactions/import/review/routing/groups';
import type { RowGroup } from '#server/transactions/import/review/routing/groups';
import type {
  ReviewRowInput,
  TrustLevel,
} from '#server/transactions/import/review/types';

import { buildPreviewState, withCarriedWork } from './preview-state';
import type { ImportPreviewState } from './preview-state';

/**
 * Pure: the rows of a review, resolved for a routing.
 *
 * `base` is the parsed rows BEFORE they were resolved — the rows the
 * resolver is given, so the resolution is always derived from the file
 * rather than from a previous resolution.
 */
export function rebuildPreviewState(opts: {
  /** The parsed rows, before resolution. */
  base: readonly ReviewRowInput[];
  /** The routing: which rows go to which account. */
  groups: readonly RowGroup[];
  /**
   * The state the user has been working on.
   *
   * Optional: with no previous state there is no work to carry, and the
   * fresh rows keep their own decisions.
   */
  previous?: ImportPreviewState;
  /** The trust level the gate is using. */
  trustLevel: TrustLevel;
  /** What the resolver resolves against. */
  resolveOpts: ResolveOpts;
}): ImportPreviewState {
  const routed = opts.base.map((row, index) => {
    const accountId = accountForRow(opts.groups, index);
    // A row with no account — a routing that does not cover it — keeps
    // the account it had. The resolver's self-transfer exclusion reads
    // the row's account, so a stale account is worse than none.
    if (accountId === undefined) return row;
    return { ...row, accountId };
  });

  const resolved = resolvePayees(routed, opts.resolveOpts);
  const fresh = buildPreviewState(resolved, opts.trustLevel);

  return withCarriedWork(fresh, opts.previous ?? fresh);
}

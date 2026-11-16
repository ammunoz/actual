/**
 * Rebuilding the review's rows.
 *
 * The rows of a review are resolved against the budget: the payee each
 * vendor string means, the transfer a row looks like, the flags that
 * follow from both. A resolution can go stale while the review is open —
 * the vendor map is a synced preference, so it can arrive after the review
 * opened, or change under it — and then the rows have to be resolved
 * again.
 *
 * What a re-resolution must NOT do is throw away the user's work: the
 * decision they made on a row and the edits they typed are theirs, not the
 * resolver's, and they are carried across by the row's key.
 *
 * The re-resolution is a plain second call to the resolver over the rows
 * the file supplied. It is not a special path: the resolver is the single
 * source of truth for what a row means, and a second code path that
 * "mostly" agrees with it would be a second thing to keep in step with it.
 *
 * Pure: every helper returns a new state; no input is mutated.
 */

import {
  fileFlags,
  flagDuplicateFitids,
} from '#server/transactions/import/review/resolver/flags';
import { resolvePayees } from '#server/transactions/import/review/resolver/payee-resolver';
import type { ResolveOpts } from '#server/transactions/import/review/resolver/payee-resolver';
import type {
  ReviewRowInput,
  TrustLevel,
} from '#server/transactions/import/review/types';

import { buildPreviewState, withCarriedWork } from './preview-state';
import type { ImportPreviewState } from './preview-state';

/**
 * Pure: the rows of a review, resolved again.
 *
 * `base` is the parsed rows BEFORE they were resolved — the rows the
 * resolver is given, so the resolution is always derived from the file
 * rather than from a previous resolution.
 *
 * The rows carry the account they are imported into. Every row of a review
 * goes into the same one: a file is imported into the account the review
 * was opened for.
 *
 * The rows MUST already carry it: the resolver's self-transfer exclusion
 * reads the row's account, so a row without one is resolved as though it
 * were in no account at all.
 */
export function rebuildPreviewState(opts: {
  /** The parsed rows, before resolution. */
  base: readonly ReviewRowInput[];
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
  // The flags are computed afresh: the file's own flags are carried over,
  // the duplicate-FITID flags are raised again from the rows, and the
  // resolver's flags are raised again by the resolver. Carrying the
  // resolver's flags over would raise them twice, and the rows would
  // collect a copy of every flag on every re-resolution.
  const cleaned = opts.base.map(row => ({ ...row, flags: fileFlags(row) }));
  const flagged = flagDuplicateFitids(cleaned);

  const resolved = resolvePayees(flagged, opts.resolveOpts);
  const fresh = buildPreviewState(resolved, opts.trustLevel);

  return withCarriedWork(fresh, opts.previous ?? fresh);
}

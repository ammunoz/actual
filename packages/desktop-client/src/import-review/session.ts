/**
 * The saved review.
 *
 * A review can be put aside and picked up later: the user presses `w`,
 * the review is saved and the modal closes, and the command bar brings it
 * back. The work — the decisions, the edits, the splits, the trust level,
 * the row the user was on — is what the session holds.
 *
 * The session is DEVICE-LOCAL and lives in `localStorage`, not in a synced
 * preference: a review is a work in progress on one machine, and a synced
 * preference would push the whole blob through the CRDT on every save.
 *
 * It holds the PARSED ROWS, not the file. The file is a path on the
 * machine that read it — and in the browser it lives in the server's
 * memory, which is gone when the server restarts — so a session that
 * pointed at the file would come back empty. The rows are what the user
 * was looking at, and they are plain data.
 */

import type {
  ImportPreviewState,
  PreviewDecision,
  PreviewEdits,
  PreviewRow,
  TrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';

/**
 * The format version.
 *
 * A session written by an older version of the review is discarded rather
 * than half-understood.
 *
 * Version 3 is the review without multi-account routing: a version 2
 * session held a routing — which rows went into which account — and that
 * routing is gone, so a version 2 session is discarded rather than
 * restored with its account choices silently dropped.
 */
export const SESSION_VERSION = 3;

/**
 * How big a session may be before the review refuses to save it.
 *
 * `localStorage` holds a few megabytes, and a review of a few hundred
 * rows is a few hundred kilobytes. The cap is well under the limit, so
 * the save never fails halfway.
 */
export const MAX_SESSION_BYTES = 512 * 1024;

/**
 * A payee the user chose for a row, remembered so the vendor map can
 * record it when the import goes through.
 */
export type SessionVendorChoice = {
  /** The raw vendor string the row carried. */
  raw: string;
  /** The payee the user chose. */
  payeeId: string;
};

/**
 * A saved review.
 */
export type ImportReviewSession = {
  /** The format version. */
  v: number;
  /** When the session was saved. */
  savedAt: string;
  /**
   * The account the review was opened for.
   *
   * It is the account every row is imported into. A file is imported into
   * the account it was opened for, so there is nothing else to remember.
   */
  accountId: string;
  /** The file the rows came from, so the user can recognise the review. */
  filename: string;
  /** The trust level the gate was using. */
  trustLevel: TrustLevel;
  /** The row the user was on. */
  focusedIndex: number;
  /** The rows, with their decisions and edits. */
  rows: PreviewRow[];
  /** The rows the user edited, so the apply step updates them in place. */
  editedRowKeys: string[];
  /** The payee choices the user made. */
  vendorChoices: [string, SessionVendorChoice][];
  /**
   * A fingerprint of the rows.
   *
   * Two reviews of two files look alike in the list, so the user is shown
   * this to tell them apart.
   */
  fingerprint: string;
};

/**
 * Pure: a fingerprint of the rows a session holds.
 *
 * It is the bank's transaction id, the date and the amount of every row,
 * hashed. It is not a security thing: it is a way for the user to tell
 * two sessions apart.
 */
export function fingerprintRows(
  rows: readonly Pick<PreviewRow, 'importedId' | 'date' | 'amountCents'>[],
): string {
  const source = rows
    .map(row => `${row.importedId ?? ''}|${row.date}|${row.amountCents}`)
    .join('\n');

  // A simple hash: the fingerprint only has to be stable and short.
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 33) ^ source.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Pure: the session for a review.
 */
export function buildSession(opts: {
  accountId: string;
  filename: string;
  trustLevel: TrustLevel;
  focusedIndex: number;
  state: ImportPreviewState;
  editedRowKeys: ReadonlySet<string>;
  vendorChoices: ReadonlyMap<string, SessionVendorChoice>;
  savedAt: string;
}): ImportReviewSession {
  return {
    v: SESSION_VERSION,
    savedAt: opts.savedAt,
    accountId: opts.accountId,
    filename: opts.filename,
    trustLevel: opts.trustLevel,
    focusedIndex: opts.focusedIndex,
    rows: opts.state.rows as PreviewRow[],
    editedRowKeys: [...opts.editedRowKeys],
    vendorChoices: [...opts.vendorChoices.entries()],
    fingerprint: fingerprintRows(opts.state.rows),
  };
}

/**
 * Pure: the preview state a session holds.
 */
export function sessionToPreviewState(
  session: ImportReviewSession,
): ImportPreviewState {
  return {
    rows: session.rows,
    trustLevel: session.trustLevel,
  };
}

/**
 * Pure: whether a value is a session the review can use.
 *
 * A malformed session is treated as no session at all: a bad blob should
 * not stop the user from importing.
 */
export function isUsableSession(value: unknown): value is ImportReviewSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Partial<ImportReviewSession>;

  if (session.v !== SESSION_VERSION) return false;
  if (typeof session.accountId !== 'string') return false;
  if (typeof session.filename !== 'string') return false;
  if (!Array.isArray(session.rows)) return false;
  if (!Array.isArray(session.editedRowKeys)) return false;
  if (!Array.isArray(session.vendorChoices)) return false;
  if (typeof session.focusedIndex !== 'number') return false;
  if (
    session.trustLevel !== 'paranoid' &&
    session.trustLevel !== 'cautious' &&
    session.trustLevel !== 'trusted'
  ) {
    return false;
  }

  return session.rows.every(
    row =>
      typeof row === 'object' &&
      row !== null &&
      typeof row.date === 'string' &&
      typeof row.amountCents === 'number' &&
      typeof row.payeeRaw === 'string' &&
      isDecision(row.decision) &&
      isEdits(row.edits),
  );
}

function isDecision(value: unknown): value is PreviewDecision {
  return (
    value === 'pending' ||
    value === 'accept' ||
    value === 'accept-override' ||
    value === 'drop'
  );
}

function isEdits(value: unknown): value is PreviewEdits {
  if (typeof value !== 'object' || value === null) return false;
  const edits = value as PreviewEdits;
  if (edits.splits !== undefined && !Array.isArray(edits.splits)) return false;
  return true;
}

/**
 * Pure: read a session out of a stored string.
 *
 * A malformed payload is treated as no session rather than an error.
 */
export function readSession(
  raw: string | null | undefined,
): ImportReviewSession | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isUsableSession(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure: the session as a stored string.
 */
export function writeSession(session: ImportReviewSession): string {
  return JSON.stringify(session);
}

/**
 * Pure: the rows of a session that point at something the budget no
 * longer has.
 *
 * The names are returned, so the user is told WHAT is missing rather
 * than being handed a review that cannot be imported.
 */
export function staleRowNames(
  session: ImportReviewSession,
  live: {
    accounts: readonly { id: string; name: string }[];
    payees: readonly { id: string; name: string }[];
    categories: readonly { id: string; name: string }[];
  },
): string[] {
  const accountIds = new Set(live.accounts.map(account => account.id));
  const categoryIds = new Set(live.categories.map(category => category.id));
  const payeeIds = new Set(live.payees.map(payee => payee.id));

  const stale = new Set<string>();

  if (!accountIds.has(session.accountId)) {
    stale.add(session.accountId);
  }

  for (const row of session.rows) {
    const edits = row.edits ?? {};
    if (edits.categoryId !== undefined && edits.categoryId !== '') {
      if (!categoryIds.has(edits.categoryId)) {
        stale.add(edits.categoryId);
      }
    }
    if (edits.payeeCanonical !== undefined && edits.payeeCanonical !== '') {
      // A payee the user TYPED is not in the budget yet — the import
      // creates it — so it cannot go missing. A payee they PICKED from
      // the list can: that is a payee of the budget, and the budget can
      // lose it.
      const picked = session.vendorChoices.find(
        ([rowKey]) => rowKey === row.previewKey,
      )?.[1];
      if (picked && !payeeIds.has(picked.payeeId)) {
        stale.add(picked.payeeId);
      }
    }
    if (edits.splits) {
      for (const leg of edits.splits) {
        if (leg.categoryId && !categoryIds.has(leg.categoryId)) {
          stale.add(leg.categoryId);
        }
      }
    }
  }

  return [...stale];
}

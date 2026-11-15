/**
 * Orchestrates the review workflow: parse the file, resolve the payees,
 * reconcile against the budget, and hold the review state.
 *
 * This hook is the only place in the feature that talks to Actual's
 * server. The domain layer below it is pure, which is what makes the
 * workflow testable without a budget.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { send } from '@actual-app/core/platform/client/connection';
import {
  applyDecision,
  buildPreviewState,
  emptyVendorMap,
  evaluateRow,
  evaluateRows,
  filterStaleVendorMapEntries,
  flagDuplicateFitids,
  isSplitRow,
  isUsableDate,
  normalizePayeeName,
  resolvePayees,
  rowKey,
  SplitValidationError,
  summarize,
  TransferValidationError,
  unsavedWork,
  updateEdits,
  upsertVendorMapEntry,
  validateVendorMap,
  withTrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  Flag,
  ImportPreviewState,
  PreviewDecision,
  PreviewEdits,
  PreviewRow,
  PreviewSummary,
  ResolvedRow,
  ReviewAccount,
  ReviewCategory,
  ReviewPayee,
  ReviewRowInput,
  RowEvaluation,
  TrustLevel,
  UnsavedWork,
  VendorMap,
} from '@actual-app/core/server/transactions/import/review/index';
import { q } from '@actual-app/core/shared/query';
import { amountToInteger } from '@actual-app/core/shared/util';
import type {
  ImportTransactionEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { aqlQuery } from '#queries/aqlQuery';

import {
  findImportedTransactions,
  matchRowsToTransactions,
} from './already-imported';
import {
  buildApplyPayload,
  buildPreviewPayload,
  buildUpdatePayload,
} from './build-payload';
import type { ReviewPayeeRef } from './build-payload';
import { nextTrustLevel } from './keymap';
import { splitErrorMessage } from './split-error-labels';
import { buildSplitReconciliation, legsOf } from './split-reconcile';
import type { SplitTransactionUpdate } from './split-reconcile';
import { transferErrorMessage } from './transfer-error-labels';
import { VENDOR_MAP_PREF } from './types';
import { useCustomSyncedPref } from './use-custom-synced-pref';

export type ReviewStatus = 'idle' | 'parsing' | 'reviewing' | 'applying';

/**
 * What an edit says about the payee the user chose.
 */
export type EditOptions = {
  /**
   * The id of the payee the user picked, when they picked one that already
   * exists in the budget.
   *
   * The id is what the vendor map records: the raw vendor string is worth
   * remembering, so the next import of the same file resolves to the same
   * payee without asking again.
   */
  chosenPayeeId?: string;
};

/**
 * A payee the user chose for a row, remembered so the vendor map can
 * record it.
 */
type VendorChoice = {
  /** The raw vendor string the row carried. */
  raw: string;
  /** The payee the user chose. */
  payeeId: string;
};

/**
 * A snapshot of the review, taken before a change so it can be undone.
 */
type UndoSnapshot = {
  state: ImportPreviewState;
  editedRowKeys: ReadonlySet<string>;
  /**
   * The vendor-map entries the review had earned when the snapshot was
   * taken.
   *
   * They are part of the snapshot because undoing a payee choice has to
   * undo the choice, not just the row: a map that remembered a choice the
   * user took back would decide the next import on their behalf.
   */
  vendorChoices: ReadonlyMap<string, VendorChoice>;
};

/**
 * How many changes the review remembers.
 *
 * The stack holds whole states, and a state is a list of frozen rows, so a
 * snapshot only costs the row that changed. Fifty is far more than a
 * review needs and small enough that nobody will notice the ceiling.
 */
const MAX_UNDO_STEPS = 50;

export type UseImportReviewOpts = {
  /** The budget account the rows are imported into. */
  accountId: string;
  /** The file to review. */
  filename: string;
  /** Called after a successful apply, with whether anything changed. */
  onImported: (didChange: boolean) => void;
};

/**
 * The summary of a review that has nothing in it yet.
 *
 * The counts are all zero rather than undefined, so the UI can render them
 * without a special case for "the file has not been parsed".
 */
export const EMPTY_SUMMARY: PreviewSummary = Object.freeze({
  total: 0,
  blocked: 0,
  skipped: 0,
  warned: 0,
  accepted: 0,
  overridden: 0,
  dropped: 0,
  pending: 0,
  inflowCount: 0,
  outflowCount: 0,
});

/**
 * The work there is to lose, before the file has been parsed.
 */
const EMPTY_UNSAVED_WORK: UnsavedWork = Object.freeze({
  hasWork: false,
  decided: 0,
  edited: 0,
});

export type ImportReviewState = {
  status: ReviewStatus;
  error: string | null;
  /** The rows as they stand, with decisions and edits applied. */
  state: ImportPreviewState | null;
  /** The index of the focused row. */
  focusedIndex: number;
  /** The trust level the gate matrix uses. */
  trustLevel: TrustLevel;
  /** The live payees, as the resolver needs them. */
  payees: readonly ReviewPayee[];
  /** The live accounts, as the resolver needs them. */
  accounts: readonly ReviewAccount[];
  /** The live categories, for the category picker. */
  categories: readonly ReviewCategory[];
  /**
   * What the review counts add up to: the decisions the user made, and
   * what the trust level is doing to the rows.
   */
  summary: PreviewSummary;
  /**
   * What the gate says about each row, keyed by the row's key.
   *
   * The UI reads this to badge the rows and to explain the focused row.
   */
  evaluations: ReadonlyMap<string, RowEvaluation>;
  /**
   * Whether the row is ALREADY in the budget.
   *
   * The import preview reports which existing transaction each row
   * matched. A row that matched is edited IN PLACE, and that path
   * writes columns: it cannot create the legs a split is made of. So
   * such a row cannot be split, and the review says so rather than
   * dropping the split on the floor.
   *
   * KNOWN LIMIT: the preview only reports a match whose fields DIFFER
   * from the existing transaction's, so a row that matches an
   * unchanged transaction is not reported here. The apply step has the
   * same limit — and it is the apply step, not this, that is the
   * guarantee that a split is never dropped silently.
   */
  isAlreadyImported: (key: string) => boolean;
  /**
   * What closing the review would throw away: the rows the user decided
   * and the rows the user edited.
   *
   * The review asks before it throws anything away, and this is what says
   * whether there is anything to ask about. The confirmation tells the
   * user what it is about to lose, so the numbers have to be the real
   * ones.
   */
  unsavedWork: UnsavedWork;
  /** Set the decision on a row. */
  decide: (index: number, decision: PreviewDecision) => void;
  /**
   * Set the decision on every row that has not been decided yet.
   *
   * One bulk action is one undo, not one undo per row.
   */
  decideAll: (decision: PreviewDecision) => void;
  /** Replace a row's edits. */
  edit: (index: number, edits: PreviewEdits, opts?: EditOptions) => void;
  /** Move the focus to an absolute index. */
  focus: (index: number) => void;
  /** Move the focus by a delta, clamped to the row range. */
  moveFocus: (delta: number) => void;
  /** Undo the most recent decision. */
  undo: () => void;
  /** Cycle the trust level. */
  cycleTrustLevel: () => void;
  /** Apply the import. Resolves to whether the import went through. */
  apply: () => Promise<boolean>;
  /** Discard and close. */
  close: () => void;
};

/**
 * Read the vendor map out of the synced preference. A malformed payload is
 * treated as an empty map rather than an error: a bad blob should not stop
 * the user from importing.
 */
export function readVendorMap(raw: string | undefined): VendorMap | undefined {
  if (!raw) return undefined;
  try {
    return validateVendorMap(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Pure: turn Actual's parsed transactions into review rows.
 *
 * Actual's parser returns `imported_payee` (the raw vendor string), `amount`
 * (in the currency's major units, e.g. -120.50), `date` and `notes`. The
 * import API wants integer cents, so the amount is converted here — the
 * same conversion Actual's own import modal does.
 *
 * The `imported_id` is the bank's FITID, which Actual's OFX parser sets even
 * though the loose parse type does not declare it — it is read defensively
 * here.
 *
 * A transient `previewKey` is assigned so every row has a unique key even
 * when the file has no FITIDs or repeats one.
 *
 * The account is the one the rows are imported INTO. The resolver needs it:
 * a transaction cannot transfer to the account it is in, so the row's own
 * account is not a candidate when the resolver looks for a transfer.
 */
export function toReviewRows(
  transactions: readonly Record<string, unknown>[],
  opts: { accountId: string },
): ReviewRowInput[] {
  const { accountId } = opts;
  return transactions.map((trans, index) => {
    const importedId =
      typeof trans.imported_id === 'string' ? trans.imported_id : undefined;
    const rawPayee =
      typeof trans.imported_payee === 'string'
        ? trans.imported_payee
        : typeof trans.payee_name === 'string'
          ? trans.payee_name
          : '';
    const rawAmount =
      typeof trans.amount === 'number' ? trans.amount : Number(trans.amount);
    const date = typeof trans.date === 'string' ? trans.date : '';
    const amountIsUsable = Number.isFinite(rawAmount);
    // An empty date would be rejected by the import with a confusing
    // error, so a row without one is flagged instead of being sent. The
    // same check the gate uses, so a row is not flagged here and cleared
    // there.
    const dateIsUsable = isUsableDate(date);

    const flags: Flag[] = [];
    if (!amountIsUsable) {
      flags.push({
        kind: 'amount-mismatch',
        code: 'AMT-MISMATCH-001',
        note: 'the file did not supply a usable amount',
      });
    }
    if (!dateIsUsable) {
      flags.push({
        kind: 'date-out-of-range',
        code: 'DATE-RANGE-001',
        note: 'the file did not supply a usable date',
      });
    }

    return {
      accountId,
      importedId,
      date,
      // An amount the file did not supply becomes 0 cents, but the row is
      // FLAGGED so the user sees it rather than importing a silent $0
      // transaction.
      amountCents: amountIsUsable ? amountToInteger(rawAmount) : 0,
      payeeRaw: rawPayee,
      memo: typeof trans.notes === 'string' ? trans.notes : undefined,
      previewKey: `row-${index}`,
      ...(flags.length > 0 && { flags }),
    };
  });
}

/**
 * The budget's payees, in the shape the payload builder needs.
 */
function payeeRefs(payees: readonly ReviewPayee[]): readonly ReviewPayeeRef[] {
  return payees.map(p => ({
    id: p.id,
    name: p.name,
    transfer_acct: p.transferAcct,
  }));
}

/**
 * The hook that drives the review.
 */
export function useImportReview(opts: UseImportReviewOpts): ImportReviewState {
  const { accountId, filename, onImported } = opts;
  const { t } = useTranslation();

  const [status, setStatus] = useState<ReviewStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ImportPreviewState | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [trustLevel, setTrustLevel] = useState<TrustLevel>('cautious');
  const [payees, setPayees] = useState<readonly ReviewPayee[]>([]);
  const [accounts, setAccounts] = useState<readonly ReviewAccount[]>([]);
  const [categories, setCategories] = useState<readonly ReviewCategory[]>([]);

  const [vendorMapRaw, setVendorMapRaw] = useCustomSyncedPref(VENDOR_MAP_PREF);

  // The vendor map as it was when the review opened.
  //
  // It is read through a ref on purpose. The parse effect used to depend on
  // the preference itself, which meant WRITING the map re-parsed the file
  // and threw away every decision the user had made — and the map is
  // written as a result of those decisions. A review reads the map once;
  // the next review sees the updated one.
  const vendorMapRawRef = useRef(vendorMapRaw);
  useEffect(() => {
    vendorMapRawRef.current = vendorMapRaw;
  }, [vendorMapRaw]);

  // The vendor-map entries the user earned by picking a payee, keyed by the
  // raw vendor string they picked it for. They are written when the import
  // succeeds, not while the review is open.
  const vendorChoices = useRef<Map<string, VendorChoice>>(new Map());

  // The rows the user explicitly edited, so the apply step can update them
  // in place.
  const editedRowKeys = useRef<ReadonlySet<string>>(new Set());

  // The changes the review remembers, so they can be undone. A snapshot is
  // taken before every change, and holds the whole state: a bulk action is
  // then one undo rather than one undo per row.
  const undoStack = useRef<readonly UndoSnapshot[]>([]);

  // The transaction each row matched, keyed by the row's key. The import
  // preview reports this, and it is what lets a user's edit to an
  // already-imported transaction be applied in place.
  const matchedTransactionIds = useRef<ReadonlyMap<string, string>>(new Map());

  // The trust level the review started with. It is read by the parse effect
  // but is deliberately not one of its dependencies: changing it must not
  // re-parse the file and discard the user's decisions.
  const trustLevelRef = useRef(trustLevel);
  useEffect(() => {
    trustLevelRef.current = trustLevel;
  }, [trustLevel]);

  // Guards against a second apply starting while one is running.
  const applyingRef = useRef(false);

  // Load the budget's data and parse the file, in ONE pass.
  //
  // They are a single effect on purpose. Splitting them meant the parse
  // effect ran once with empty payees and accounts — before the first
  // effect had loaded them — and then again once the data arrived, so the
  // file was parsed twice and the first pass resolved against nothing.
  //
  // The trust level is deliberately NOT a dependency: it only feeds the
  // gate matrix, which is applied when the state is summarised. Re-parsing
  // on a trust-level change would throw away every decision the user had
  // made.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('parsing');
      setError(null);
      // A re-parse starts the review over: the decisions and edits from the
      // previous parse belong to rows that no longer exist.
      editedRowKeys.current = new Set();
      matchedTransactionIds.current = new Map();
      vendorChoices.current = new Map();
      undoStack.current = [];

      try {
        const [payeeEntities, accountEntities, categoryEntities, parsed] =
          await Promise.all([
            send('payees-get'),
            send('accounts-get'),
            send('get-categories'),
            send('transactions-parse-file', {
              filepath: filename,
              options: {},
            }),
          ]);

        if (cancelled) return;

        if (parsed.errors && parsed.errors.length > 0) {
          setStatus('idle');
          setError(parsed.errors[0].message);
          return;
        }

        const payeeList: readonly ReviewPayee[] = payeeEntities.map(p => ({
          id: p.id,
          name: p.name,
          transferAcct: p.transfer_acct,
        }));
        const accountList: readonly ReviewAccount[] = accountEntities.map(
          a => ({
            id: a.id,
            name: a.name,
            offbudget: a.offbudget === 1,
            closed: a.closed === 1,
          }),
        );
        // The categories, in the order the budget GROUPS them, each
        // carrying its group name.
        //
        // The group matters: the split editor asks the user to pick a
        // category for every leg, and two groups can hold categories with
        // the same name. A flat list cannot tell them apart.
        const grouped = categoryEntities.grouped ?? [];
        const groupedCategories: ReviewCategory[] = grouped.flatMap(group =>
          (group.categories ?? []).map(category => ({
            id: category.id,
            name: category.name,
            groupName: group.name,
            hidden: category.hidden,
            isIncome: category.is_income,
          })),
        );
        // A category that is in no group would be lost by grouping alone,
        // so it is added at the end rather than dropped.
        const groupedIds = new Set(
          groupedCategories.map(category => category.id),
        );
        const orphans: ReviewCategory[] = categoryEntities.list
          .filter(category => !groupedIds.has(category.id))
          .map(category => ({
            id: category.id,
            name: category.name,
            hidden: category.hidden,
            isIncome: category.is_income,
          }));
        const categoryList: readonly ReviewCategory[] = [
          ...groupedCategories,
          ...orphans,
        ];

        setPayees(payeeList);
        setAccounts(accountList);
        setCategories(categoryList);

        const raw = flagDuplicateFitids(
          toReviewRows(
            // Safe: the parse handler's loose type is a union of a structured
            // transaction and a CSV record, and `toReviewRows` reads each
            // field defensively, checking the type before it uses it.
            parsed.transactions as Record<string, unknown>[],
            { accountId },
          ),
        );

        // Actual's own rules cover what a separate rules system would do.
        // They run server-side during import, keyed on `imported_payee`, so
        // there is no second rules system to maintain here.
        const vendorMap = readVendorMap(vendorMapRawRef.current);
        const liveMap = vendorMap
          ? filterStaleVendorMapEntries(vendorMap, payeeList)
          : undefined;

        const resolved: readonly ResolvedRow[] = resolvePayees(raw, {
          existingPayees: payeeList,
          accounts: accountList,
          vendorMap: liveMap,
          fuzzy: { minScore: 0.7, maxResults: 5 },
        });

        const next = buildPreviewState(resolved, trustLevelRef.current);
        setState(next);
        setFocusedIndex(0);

        // Ask Actual which of these rows match an existing transaction. The
        // preview reports the matched transaction's id, which is what lets a
        // user's edit to an already-imported transaction be applied in place
        // (Actual's import UPDATE path keeps the existing payee).
        //
        // The PREVIEW payload marks nothing as skipped: Actual skips a
        // marked row before it reports the match, so a marked row would
        // come back with no correlation at all.
        const preview = await send('transactions-import', {
          accountId,
          // The same cast as the import itself, for the same reason: a
          // split leg's category is `null` when it has none, and
          // upstream's type says `string | undefined`.
          transactions: buildPreviewPayload(next, {
            accountId,
            payees: payeeRefs(payeeList),
            categories: categoryList.map(c => ({ id: c.id })),
          }) as ImportTransactionEntity[],
          isPreview: true,
        });

        if (cancelled) return;

        // Which rows are ALREADY in the budget?
        //
        // The import preview cannot answer that: it reports the matched
        // transaction only when the matched row's fields DIFFER from it, so
        // a file imported a second time matches its own transactions
        // exactly and the preview reports nothing. Asking the budget
        // directly, by FITID, is the only way to learn the truth.
        const importedIds = next.rows
          .map(row => row.importedId)
          .filter((id): id is string => typeof id === 'string');
        const alreadyImported = await findImportedTransactions({
          accountId,
          importedIds,
        });
        if (cancelled) return;

        const matched = new Map<string, string>(
          matchRowsToTransactions(next.rows, alreadyImported),
        );

        // The preview still knows about one thing the FITID lookup cannot
        // see: a row with NO FITID that Actual matched against an existing
        // transaction by date and amount. Those matches are kept, because
        // they are the same transaction the import itself would update.
        preview.updatedPreview?.forEach(entry => {
          const existing = entry.existing;
          if (!existing?.id) return;
          // The preview echoes back the transaction we sent, so the transient
          // preview key travels with it.
          //
          // Safe: the echo is the transaction we sent, plus whatever the
          // rule engine added to it. The cast is only needed because the
          // preview's type does not declare the transient field.
          const key = (
            entry.transaction as { _previewKey?: string } | undefined
          )?._previewKey;
          if (typeof key === 'string') {
            matched.set(key, existing.id);
          }
        });
        matchedTransactionIds.current = matched;

        setStatus('reviewing');
      } catch (err) {
        if (cancelled) return;
        setStatus('idle');
        setError(err instanceof Error ? err.message : t('The import failed'));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
    // The vendor map is deliberately NOT a dependency: it is read through a
    // ref, because a write to it must never re-parse the file.
  }, [filename, accountId, t]);

  /**
   * Rewrite the legs of the splits that are already in the budget.
   *
   * The budget is asked for the transactions and their legs, because the
   * review's legs are matched to the existing ones IN ORDER: a leg that
   * is already there is updated rather than replaced, so anything the
   * user put on it survives.
   *
   * The difference is sent as one batch, which is what upstream's own
   * desktop UI sends when a split is edited.
   */
  const reconcileSplits = useCallback(async (rows: readonly PreviewRow[]) => {
    const parentIds = rows
      .map(row => matchedTransactionIds.current.get(rowKey(row)))
      .filter((id): id is string => !!id);

    if (parentIds.length === 0) return;

    const { data } = await aqlQuery(
      q('transactions')
        .filter({ id: { $oneof: parentIds } })
        .select('*')
        // The legs are asked for GROUPED under their parent.
        //
        // Without the option, the query returns the transactions one by
        // one and leaves the SPLIT PARENTS out entirely — a split is not
        // a row of its own in that shape. So the review would find no
        // parent, and the reconciliation would silently do nothing while
        // the row was still held back from the import.
        .options({ splits: 'grouped' }),
    );
    const transactions = (
      Array.isArray(data) ? data : []
    ) as TransactionEntity[];

    const added: TransactionEntity[] = [];
    const updated: SplitTransactionUpdate[] = [];
    const deleted: { id: string }[] = [];

    for (const row of rows) {
      const parentId = matchedTransactionIds.current.get(rowKey(row));
      if (!parentId) continue;
      const parent = transactions.find(
        transaction => transaction.id === parentId,
      );
      if (!parent) continue;

      const reconciliation = buildSplitReconciliation({
        parent,
        children: legsOf(parent),
        legs: row.edits.splits ?? [],
      });
      added.push(...reconciliation.added);
      updated.push(...reconciliation.updated);
      deleted.push(...reconciliation.deleted);
    }

    if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
      return false;
    }

    await send('transactions-batch-update', {
      added,
      // The cast is here, and only here: a split's parent has no category
      // of its own — the legs carry them — so the parent's category has to
      // be CLEARED, and `null` is how the database says "no category". The
      // column is nullable; the entity type does not say so.
      updated: updated as Partial<TransactionEntity>[],
      deleted,
    });
    return true;
  }, []);

  const buildUpdates = useCallback(() => {
    if (!state) return { updates: [] };
    return buildUpdatePayload(state, {
      accountId,
      matchedTransactionIds: matchedTransactionIds.current,
      payees: payeeRefs(payees),
      categories: categories.map(c => ({ id: c.id })),
      editedRowKeys: editedRowKeys.current,
    });
  }, [state, accountId, payees, categories]);

  /**
   * Write the vendor-map entries the user's payee choices earned.
   *
   * It happens AFTER the import succeeded, and never while the review is
   * open: writing the preference re-parses the file, which would throw
   * away the very decisions that produced the entries.
   */
  const writeVendorMap = useCallback(
    (review: ImportPreviewState) => {
      const choices = vendorChoices.current;
      if (choices.size === 0) return;

      // A row the user THREW AWAY says nothing about how the vendor
      // string should be resolved: they did not want that transaction. The
      // choice is only remembered for the rows they kept.
      const dropped = new Set(
        review.rows
          .filter(row => row.decision === 'drop')
          .map(row => rowKey(row)),
      );

      const now = new Date().toISOString();
      let map = readVendorMap(vendorMapRawRef.current) ?? emptyVendorMap(now);
      for (const [rowKey, choice] of choices) {
        if (dropped.has(rowKey)) continue;
        if (choice.raw.length === 0 || choice.payeeId.length === 0) continue;
        map = upsertVendorMapEntry(map, choice.raw, choice.payeeId, now);
      }
      setVendorMapRaw(JSON.stringify(map));
    },
    [setVendorMapRaw],
  );

  /**
   * Record the state as it is NOW, so the change that follows can be
   * undone.
   *
   * The snapshot is skipped when the top of the stack already holds this
   * state. That is what makes it safe to call from inside a state
   * updater: an updater that runs twice — React may do that — records the
   * same change once, because the second run sees the state it just
   * recorded.
   */
  const pushUndo = useCallback((current: ImportPreviewState) => {
    const stack = undoStack.current;
    if (stack[stack.length - 1]?.state === current) return;
    undoStack.current = [
      ...stack.slice(-(MAX_UNDO_STEPS - 1)),
      {
        state: current,
        editedRowKeys: new Set(editedRowKeys.current),
        vendorChoices: new Map(vendorChoices.current),
      },
    ];
  }, []);

  const decide = useCallback(
    (index: number, decision: PreviewDecision) => {
      setState(current => {
        if (!current) return current;
        const row = current.rows[index];
        if (!row) return current;
        pushUndo(current);
        return applyDecision(current, rowKey(row), decision);
      });
    },
    [pushUndo],
  );

  const decideAll = useCallback(
    (decision: PreviewDecision) => {
      setState(current => {
        if (!current) return current;
        const pending = current.rows.filter(row => row.decision === 'pending');
        if (pending.length === 0) return current;
        // One snapshot for the whole bulk action, so one undo takes it
        // all back.
        pushUndo(current);
        // The domain's `applyDecision` finds its row by key, so applying
        // it once per row is quadratic in the number of rows. An import
        // file has hundreds of rows at most, so this is cheap, and going
        // around the domain helper would mean duplicating its rules here.
        let next = current;
        for (const row of pending) {
          next = applyDecision(next, rowKey(row), decision);
        }
        return next;
      });
    },
    [pushUndo],
  );
  const edit = useCallback(
    (index: number, edits: PreviewEdits, opts?: EditOptions) => {
      setState(current => {
        if (!current) return current;
        const row = current.rows[index];
        if (!row) return current;
        pushUndo(current);
        // Remember that the user touched this row, so the apply step can
        // update the matched transaction in place.
        editedRowKeys.current = new Set([
          ...editedRowKeys.current,
          rowKey(row),
        ]);

        // The user picked a payee for a vendor string the budget does not
        // know. Remembering that is what the vendor map is for: the next
        // import of the same file resolves to the same payee without
        // asking.
        const chosenId = opts?.chosenPayeeId;
        if (chosenId) {
          const payee = payees.find(candidate => candidate.id === chosenId);
          const raw = row.payeeRaw.trim();
          if (
            payee &&
            raw.length > 0 &&
            normalizePayeeName(raw) !== normalizePayeeName(payee.name)
          ) {
            vendorChoices.current.set(rowKey(row), { raw, payeeId: chosenId });
          }
        }

        return updateEdits(current, rowKey(row), edits);
      });
    },
    [pushUndo, payees],
  );

  const isAlreadyImported = useCallback((key: string) => {
    return matchedTransactionIds.current.has(key);
  }, []);

  const focus = useCallback((index: number) => {
    setFocusedIndex(index);
  }, []);

  const moveFocus = useCallback((delta: number) => {
    setFocusedIndex(current => Math.max(0, current + delta));
  }, []);

  const undo = useCallback(() => {
    const stack = undoStack.current;
    const last = stack[stack.length - 1];
    if (!last) return;
    undoStack.current = stack.slice(0, -1);
    // The set of edited rows is part of the snapshot: undoing an edit back
    // to nothing has to remove the row again, or the apply step would
    // write a no-op update for it.
    editedRowKeys.current = new Set(last.editedRowKeys);
    vendorChoices.current = new Map(last.vendorChoices);
    setState(last.state);
  }, []);

  const cycleTrustLevel = useCallback(() => {
    setTrustLevel(current => {
      const next = nextTrustLevel(current);
      // The trust level only feeds the gate matrix, so it is applied to the
      // existing state. Re-parsing would discard the user's decisions.
      setState(currentState =>
        currentState ? withTrustLevel(currentState, next) : currentState,
      );
      return next;
    });
  }, []);

  const apply = useCallback(async (): Promise<boolean> => {
    // Reentrancy guard. The Import button is disabled while applying, but
    // the `ctrl+s` hotkey is not, so a second press would start a second
    // apply. Two concurrent imports would write the rows twice, and a row
    // without a FITID has no dedup key to protect it.
    if (applyingRef.current) return false;
    // There is nothing to apply before the file has been parsed, or after
    // parsing failed.
    if (!state) return false;
    applyingRef.current = true;

    setStatus('applying');
    setError(null);

    let didChange = false;

    try {
      const livePayeeNames = new Set(
        payees.map(payee => normalizePayeeName(payee.name)),
      );

      // A row the user SPLIT and that is already in the budget is
      // reconciled: the legs are rewritten, the parent is updated, and the
      // row is not sent to the import at all.
      //
      // The import cannot do this on its own. Its UPDATE path writes
      // columns on the transaction it matched and never touches the legs,
      // so the user's new split would be dropped and the import would
      // report success. The reconciliation does what upstream's own
      // desktop UI does when a split is edited: it rewrites the legs and
      // sends the difference.
      const splitRows = state.rows.filter(row => {
        if (!isSplitRow(row.edits)) return false;
        // A row that is thrown away, or that the gate holds back, does
        // not land at all, so it cannot lose a split.
        if (row.decision === 'drop') return false;
        const evaluation = evaluateRow(row, state.trustLevel, {
          livePayeeNames,
        });
        if (!evaluation.willImport) return false;
        return matchedTransactionIds.current.has(rowKey(row));
      });

      // Rows the user edited AND that matched an existing transaction are
      // updated in place: Actual's import UPDATE path keeps the existing
      // payee and category, so an edit sent through `transactions-import`
      // would be silently discarded.
      const { updates } = buildUpdates();

      // The rows that are about to be updated are excluded from the
      // import, so the import's update path cannot undo them.
      const updatedRowKeys = new Set(updates.map(u => u.rowKey));

      // The splits that are reconciled are excluded too: the
      // reconciliation writes the parent and its legs, and the import
      // would take the parent's FITID-matched row down its update path,
      // which cannot touch the legs.
      for (const row of splitRows) {
        updatedRowKeys.add(rowKey(row));
      }

      // The import payload is built BEFORE anything is written.
      //
      // Building it can refuse the import: a transfer whose target has no
      // transfer payee, or a split whose legs do not add up. A refusal
      // after the edits were written would leave the user's edits in the
      // budget and the rest of the file unimported, with no way to tell
      // that is what happened. Built first, a refusal happens with
      // nothing written.
      const payload = buildApplyPayload(state, {
        accountId,
        payees: payeeRefs(payees),
        categories: categories.map(c => ({ id: c.id })),
        updatedRowKeys,
      });

      // The splits that are already in the budget are reconciled FIRST,
      // so the legs are in place before anything else is written.
      if (splitRows.length > 0) {
        // Whether anything was written is what the review reports, so the
        // reconciliation says so rather than the review assuming it.
        didChange = (await reconcileSplits(splitRows)) || didChange;
      }

      // A payee the user named that no existing payee matches has to be
      // created before the update can point at it: `transaction-update`
      // cannot create a payee from a name, because `payee_name` is not a
      // column on the transaction.
      const createdPayeeIds = new Map<string, string>();

      for (const { update, payeeNameToCreate } of updates) {
        if (payeeNameToCreate !== undefined) {
          let payeeId = createdPayeeIds.get(payeeNameToCreate);
          if (!payeeId) {
            const created = await send('payee-create', {
              name: payeeNameToCreate,
            });
            if (typeof created === 'string') {
              payeeId = created;
              createdPayeeIds.set(payeeNameToCreate, payeeId);
            }
          }
          if (!payeeId) {
            // The payee could not be created, so the update would go
            // through WITHOUT the payee the user chose - the edit would be
            // silently dropped while the apply reported success. Better to
            // say so.
            setStatus('reviewing');
            setError(t('The payee could not be created'));
            return false;
          }
          update.payee = payeeId;
        }
        await send('transaction-update', update);
        didChange = true;
      }

      if (payload.length === 0) {
        // Every row was updated in place. The updates above were written,
        // so this is a SUCCESS, not a failure with nothing to do.
        setStatus('reviewing');
        if (didChange) {
          writeVendorMap(state);
          onImported(true);
          return true;
        }
        // Every row was dropped or held back, so there was nothing to
        // write. Saying so is the difference between "the import failed"
        // and "the import did nothing because you asked for nothing".
        setError(t('There is nothing to import'));
        return false;
      }

      // The updates above are already written by the time the import runs,
      // so the two are not atomic: if the import fails, the updates stay.
      // That is deliberate — the updates are the user's explicit edits and
      // re-sending them would be a no-op — but it is worth knowing.
      let importErrors: { message: string }[] | undefined;
      let added: string[] = [];
      let updated: string[] = [];
      try {
        const result = await send('transactions-import', {
          accountId,
          // The cast is here, and only here, because upstream types a
          // split leg's `category` as `string | undefined` while its
          // runtime accepts `null` — and the difference is load-bearing:
          // upstream's `makeChild` decides inherit-vs-override with
          // `"category" in data`, so a leg WITHOUT the key inherits the
          // parent's category. `null` says "no category" outright.
          //
          // Widening the call instead would push the same problem into
          // every caller of `transactions-import`.
          transactions: payload as ImportTransactionEntity[],
          isPreview: false,
        });
        importErrors = result.errors;
        added = result.added ?? [];
        updated = result.updated ?? [];
      } catch (err) {
        setStatus('reviewing');
        // The updates above were already written, so the message says
        // which half failed: the user has to know that their edits are
        // in the budget even though the import did not go through.
        setError(
          t('The edits were saved, but the import failed: {{message}}', {
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return false;
      }
      if (importErrors && importErrors.length > 0) {
        setStatus('reviewing');
        // The edits above are already written, so the message says so:
        // the user has to know that their edits are in the budget even
        // though the import did not go through.
        setError(
          didChange
            ? t('The edits were saved, but the import failed: {{message}}', {
                message: importErrors[0].message,
              })
            : importErrors[0].message,
        );
        return false;
      }

      // Whether anything actually changed, from what the server reports —
      // not from the absence of errors. A payload of only dropped rows
      // imports nothing.
      didChange = didChange || added.length > 0 || updated.length > 0;
    } catch (err) {
      setStatus('reviewing');
      // A split that does not fit its row is reported in the user's
      // words, not as the domain's code: the code is for logs and for
      // tests, and a person has to be able to read it.
      if (err instanceof SplitValidationError) {
        setError(splitErrorMessage(err.code, t));
        return false;
      }
      // The same for a transfer the budget cannot honour: the code is
      // for logs and for tests, and a person has to be able to read it.
      if (err instanceof TransferValidationError) {
        setError(transferErrorMessage(err.code, t));
        return false;
      }
      setError(err instanceof Error ? err.message : t('The import failed'));
      return false;
    } finally {
      applyingRef.current = false;
    }

    setStatus('reviewing');
    if (didChange) {
      // The import went through and changed something, so the payee
      // choices the user made were USED, and they are worth remembering.
      //
      // The map is written HERE and not while the review is open: writing
      // the preference re-parses the file and throws away the very
      // decisions that produced the entries.
      writeVendorMap(state);
      onImported(true);
      return true;
    }

    // Nothing changed. Every row was dropped, or the trust level held it
    // back, or the transactions were already in the budget exactly as
    // they are. The review says so: a keypress that appears to do
    // nothing is worse than one that says "there was nothing to do".
    setError(t('There is nothing to import'));
    return false;
  }, [
    accountId,
    buildUpdates,
    reconcileSplits,
    state,
    payees,
    categories,
    onImported,
    t,
    writeVendorMap,
  ]);

  const close = useCallback(() => {
    onImported(false);
  }, [onImported]);

  // What the gate says about each row, and what the review adds up to.
  //
  // Both are derived from the state, the trust level and the live payees,
  // so they are recomputed whenever any of those change. They are NOT
  // stored: the gate is a property of the rows, not a thing the review
  // keeps.
  const { summary, evaluations } = useMemo(() => {
    if (!state) {
      return {
        summary: EMPTY_SUMMARY,
        evaluations: new Map<string, RowEvaluation>(),
      };
    }

    // The gate needs the live payee names to tell whether a payee the user
    // picked still has to be created.
    const livePayeeNames = new Set(payees.map(p => normalizePayeeName(p.name)));
    const opts = { livePayeeNames };

    // The rows are evaluated ONCE: the summary reads the same evaluations
    // the badges do.
    const map = evaluateRows(state, opts);

    return { summary: summarize(state, map), evaluations: map };
  }, [state, payees]);

  // What the user would lose if the review were closed.
  //
  // The domain owns the definition — it is a property of the rows — so
  // this is only the live answer to it.
  const unsaved = useMemo(
    () => (state ? unsavedWork(state) : EMPTY_UNSAVED_WORK),
    [state],
  );

  const rows = state?.rows ?? [];

  return {
    status,
    error,
    state,
    focusedIndex: Math.min(focusedIndex, Math.max(0, rows.length - 1)),
    trustLevel,
    payees,
    accounts,
    categories,
    summary,
    evaluations,
    unsavedWork: unsaved,
    isAlreadyImported,
    decide,
    decideAll,
    edit,
    focus,
    moveFocus,
    undo,
    cycleTrustLevel,
    apply,
    close,
  };
}

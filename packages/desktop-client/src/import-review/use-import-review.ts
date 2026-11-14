/**
 * Orchestrates the review workflow: parse the file, resolve the payees,
 * reconcile against the budget, and hold the review state.
 *
 * This hook is the only place in the feature that talks to Actual's
 * server. The domain layer below it is pure, which is what makes the
 * workflow testable without a budget.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import {
  applyDecision,
  buildPreviewState,
  filterStaleVendorMapEntries,
  resolvePayees,
  rowKey,
  updateEdits,
  validateVendorMap,
  withTrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  ImportPreviewState,
  PreviewDecision,
  PreviewEdits,
  ResolvedRow,
  ReviewAccount,
  ReviewCategory,
  ReviewPayee,
  ReviewRowInput,
  TrustLevel,
  VendorMap,
} from '@actual-app/core/server/transactions/import/review/index';
import { amountToInteger } from '@actual-app/core/shared/util';

import { buildImportPayload, buildUpdatePayload } from './build-payload';
import type { ReviewPayeeRef } from './build-payload';
import { nextTrustLevel } from './keymap';
import { VENDOR_MAP_PREF } from './types';
import { useCustomSyncedPref } from './use-custom-synced-pref';

export type ReviewStatus = 'idle' | 'parsing' | 'reviewing' | 'applying';

export type UseImportReviewOpts = {
  /** The budget account the rows are imported into. */
  accountId: string;
  /** The file to review. */
  filename: string;
  /** Called after a successful apply, with whether anything changed. */
  onImported: (didChange: boolean) => void;
};

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
  /** The payload the apply step will send. */
  /** Set the decision on a row. */
  decide: (index: number, decision: PreviewDecision) => void;
  /** Replace a row's edits. */
  edit: (index: number, edits: PreviewEdits) => void;
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
 */
export function toReviewRows(
  transactions: readonly Record<string, unknown>[],
): ReviewRowInput[] {
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

    return {
      accountId: '',
      importedId,
      date,
      // An amount the file did not supply becomes 0 cents, but the row is
      // FLAGGED so the user sees it rather than importing a silent $0
      // transaction.
      amountCents: amountIsUsable ? amountToInteger(rawAmount) : 0,
      payeeRaw: rawPayee,
      memo: typeof trans.notes === 'string' ? trans.notes : undefined,
      previewKey: `row-${index}`,
      ...(amountIsUsable
        ? {}
        : {
            flags: [
              {
                kind: 'amount-mismatch' as const,
                code: 'AMT-MISMATCH-001' as const,
                note: 'the file did not supply a usable amount',
              },
            ],
          }),
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

  const [status, setStatus] = useState<ReviewStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ImportPreviewState | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [trustLevel, setTrustLevel] = useState<TrustLevel>('cautious');
  const [payees, setPayees] = useState<readonly ReviewPayee[]>([]);
  const [accounts, setAccounts] = useState<readonly ReviewAccount[]>([]);
  const [categories, setCategories] = useState<readonly ReviewCategory[]>([]);

  const [vendorMapRaw] = useCustomSyncedPref(VENDOR_MAP_PREF);

  // The rows the user explicitly edited, so the apply step can update them
  // in place.
  const editedRowKeys = useRef<ReadonlySet<string>>(new Set());

  // The transaction each row matched, keyed by the row's key. The import
  // preview reports this, and it is what lets a user's edit to an
  // already-imported transaction be applied in place.
  const matchedTransactionIds = useRef<ReadonlyMap<string, string>>(new Map());

  // The trust level the review started with. It is read by the parse effect
  // but is deliberately not one of its dependencies: changing it must not
  // re-parse the file and discard the user's decisions.
  const trustLevelRef = useRef(trustLevel);
  trustLevelRef.current = trustLevel;

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
        const categoryList: readonly ReviewCategory[] =
          categoryEntities.list.map(c => ({
            id: c.id,
            name: c.name,
            hidden: c.hidden,
            isIncome: c.is_income,
          }));

        setPayees(payeeList);
        setAccounts(accountList);
        setCategories(categoryList);

        const raw = toReviewRows(
          // Safe: the parse handler's loose type is a union of a structured
          // transaction and a CSV record, and `toReviewRows` reads each
          // field defensively, checking the type before it uses it.
          parsed.transactions as Record<string, unknown>[],
        );

        // Actual's own rules cover what a separate rules system would do.
        // They run server-side during import, keyed on `imported_payee`, so
        // there is no second rules system to maintain here.
        const vendorMap = readVendorMap(vendorMapRaw);
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
        const preview = await send('transactions-import', {
          accountId,
          transactions: buildImportPayload(next, {
            accountId,
            payees: payeeRefs(payeeList),
            categories: categoryList.map(c => ({ id: c.id })),
          }),
          isPreview: true,
        });

        if (cancelled) return;

        const matched = new Map<string, string>();
        preview.updatedPreview?.forEach(entry => {
          const existing = entry.existing;
          if (!existing?.id) return;
          // The preview echoes back the transaction we sent, so the transient
          // preview key travels with it.
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
        setError(err instanceof Error ? err.message : 'Import failed');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [filename, vendorMapRaw, accountId]);

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

  const decide = useCallback((index: number, decision: PreviewDecision) => {
    setState(current => {
      if (!current) return current;
      const row = current.rows[index];
      if (!row) return current;
      return applyDecision(current, rowKey(row), decision);
    });
  }, []);

  const edit = useCallback((index: number, edits: PreviewEdits) => {
    setState(current => {
      if (!current) return current;
      const row = current.rows[index];
      if (!row) return current;
      // Remember that the user touched this row, so the apply step can
      // update the matched transaction in place.
      editedRowKeys.current = new Set([...editedRowKeys.current, rowKey(row)]);
      return updateEdits(current, rowKey(row), edits);
    });
  }, []);

  const focus = useCallback((index: number) => {
    setFocusedIndex(index);
  }, []);

  const moveFocus = useCallback((delta: number) => {
    setFocusedIndex(current => Math.max(0, current + delta));
  }, []);

  const undo = useCallback(() => {
    setState(current => {
      if (!current) return current;
      const last = [...current.rows]
        .reverse()
        .find(r => r.decision !== 'pending');
      if (!last) return current;
      return applyDecision(current, rowKey(last), 'pending');
    });
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
    applyingRef.current = true;

    setStatus('applying');
    setError(null);

    let didChange = false;

    try {
      // Rows the user edited AND that matched an existing transaction are
      // updated in place: Actual's import UPDATE path keeps the existing
      // payee and category, so an edit sent through `transactions-import`
      // would be silently discarded.
      const { updates } = buildUpdates();

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
          if (payeeId) {
            update.payee = payeeId;
          }
        }
        await send('transaction-update', update);
        didChange = true;
      }

      // The rows that were just updated are excluded from the import, so
      // the import's update path cannot undo them.
      const updatedRowKeys = new Set(updates.map(u => u.rowKey));
      const payload = buildImportPayload(state!, {
        accountId,
        payees: payeeRefs(payees),
        categories: categories.map(c => ({ id: c.id })),
        updatedRowKeys,
      });

      if (payload.length === 0) {
        // Every row was updated in place. The updates above were written,
        // so this is a SUCCESS, not a failure with nothing to do.
        setStatus('reviewing');
        if (didChange) {
          onImported(true);
        }
        return didChange;
      }

      // The updates above are already written by the time the import runs,
      // so the two are not atomic: if the import fails, the updates stay.
      // That is deliberate — the updates are the user's explicit edits and
      // re-sending them would be a no-op — but it is worth knowing.
      const {
        errors,
        added = [],
        updated = [],
      } = await send('transactions-import', {
        accountId,
        transactions: payload,
        isPreview: false,
      });
      if (errors && errors.length > 0) {
        setStatus('reviewing');
        setError(errors[0].message);
        return false;
      }

      // Whether anything actually changed, from what the server reports —
      // not from the absence of errors. A payload of only dropped rows
      // imports nothing.
      didChange = didChange || added.length > 0 || updated.length > 0;
    } catch (err) {
      setStatus('reviewing');
      setError(err instanceof Error ? err.message : 'Import failed');
      return false;
    } finally {
      applyingRef.current = false;
    }

    setStatus('reviewing');
    if (didChange) {
      onImported(true);
    }
    return didChange;
  }, [accountId, buildUpdates, state, payees, categories, onImported]);

  const close = useCallback(() => {
    onImported(false);
  }, [onImported]);

  const summary = useMemo(() => state?.rows ?? [], [state]);

  return {
    status,
    error,
    state,
    focusedIndex: Math.min(focusedIndex, Math.max(0, summary.length - 1)),
    trustLevel,
    payees,
    accounts,
    categories,
    decide,
    edit,
    focus,
    moveFocus,
    undo,
    cycleTrustLevel,
    apply,
    close,
  };
}

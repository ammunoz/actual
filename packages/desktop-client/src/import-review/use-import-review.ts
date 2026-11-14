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
import { nextTrustLevel } from './keymap';
import type { ImportReviewTransaction } from './types';
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
  buildPayload: () => ImportReviewTransaction[];
  /** Set the decision on a row and advance. */
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

    return {
      accountId: '',
      importedId,
      date,
      amountCents: Number.isFinite(rawAmount) ? amountToInteger(rawAmount) : 0,
      payeeRaw: rawPayee,
      memo: typeof trans.notes === 'string' ? trans.notes : undefined,
      previewKey: `row-${index}`,
    };
  });
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

  // Load the budget's payees, accounts and categories once per account.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [payeeEntities, accountEntities, categoryEntities] =
        await Promise.all([
          send('payees-get'),
          send('accounts-get'),
          send('get-categories'),
        ]);
      if (cancelled) return;
      setPayees(
        payeeEntities.map(p => ({
          id: p.id,
          name: p.name,
          transferAcct: p.transfer_acct,
        })),
      );
      setAccounts(
        accountEntities.map(a => ({
          id: a.id,
          name: a.name,
          offbudget: a.offbudget === 1,
          closed: a.closed === 1,
        })),
      );
      setCategories(
        categoryEntities.list.map(c => ({
          id: c.id,
          name: c.name,
          hidden: c.hidden,
          isIncome: c.is_income,
        })),
      );
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Parse and resolve.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus('parsing');
      setError(null);

      const { errors, transactions = [] } = await send(
        'transactions-parse-file',
        { filepath: filename, options: {} },
      );

      if (cancelled) return;

      if (errors && errors.length > 0) {
        setStatus('idle');
        setError(errors[0].message);
        return;
      }

      const raw = toReviewRows(transactions as Record<string, unknown>[]);

      // Actual's own rules cover what a separate rules system would do.
      // They run server-side during import, keyed on `imported_payee`, so
      // there is no second rules system to maintain here.
      const vendorMap = readVendorMap(vendorMapRaw);
      const liveMap = vendorMap
        ? filterStaleVendorMapEntries(vendorMap, payees)
        : undefined;

      const resolved: readonly ResolvedRow[] = resolvePayees(raw, {
        existingPayees: payees,
        accounts,
        vendorMap: liveMap,
        fuzzy: { minScore: 0.6, maxResults: 5 },
      });

      const next = buildPreviewState(resolved, trustLevel);
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
          payees: payees.map(p => ({
            id: p.id,
            transfer_acct: p.transferAcct,
          })),
          categories: categories.map(c => ({ id: c.id })),
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
        const key = (entry.transaction as { previewKey?: string } | undefined)
          ?.previewKey;
        if (typeof key === 'string') {
          matched.set(key, existing.id);
        }
      });
      matchedTransactionIds.current = matched;

      setStatus('reviewing');
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    filename,
    vendorMapRaw,
    payees,
    accounts,
    categories,
    accountId,
    trustLevel,
  ]);

  const buildPayload = useCallback(() => {
    if (!state) return [];
    return buildImportPayload(state, {
      accountId,
      payees: payees.map(p => ({
        id: p.id,
        transfer_acct: p.transferAcct,
      })),
      categories: categories.map(c => ({ id: c.id })),
    });
  }, [state, accountId, payees, categories]);

  const buildUpdates = useCallback(() => {
    if (!state) return [];
    return buildUpdatePayload(state, {
      accountId,
      matchedTransactionIds: matchedTransactionIds.current,
      payees: payees.map(p => ({
        id: p.id,
        transfer_acct: p.transferAcct,
      })),
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
    setTrustLevel(current => nextTrustLevel(current));
  }, []);

  const apply = useCallback(async (): Promise<boolean> => {
    const payload = buildPayload();
    if (payload.length === 0) return false;
    setStatus('applying');
    setError(null);

    try {
      // Rows the user edited AND that matched an existing transaction are
      // updated in place: Actual's import UPDATE path keeps the existing
      // payee and category, so an edit sent through `transactions-import`
      // would be silently discarded.
      const updates = buildUpdates();
      for (const update of updates) {
        await send('transaction-update', update);
      }

      const { errors } = await send('transactions-import', {
        accountId,
        transactions: payload,
        isPreview: false,
      });
      if (errors && errors.length > 0) {
        setStatus('reviewing');
        setError(errors[0].message);
        return false;
      }
    } catch (err) {
      setStatus('reviewing');
      setError(err instanceof Error ? err.message : 'Import failed');
      return false;
    }

    setStatus('reviewing');
    onImported(true);
    return true;
  }, [accountId, buildPayload, buildUpdates, onImported]);

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
    buildPayload,
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

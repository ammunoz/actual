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
  buildFuzzyCache,
  emptyVendorMap,
  evaluateRow,
  evaluateRows,
  filterStaleVendorMapEntries,
  flagDuplicateFitids,
  isSplitRow,
  isUsableDate,
  normalizePayeeName,
  rebuildPreviewState,
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
import type { RuleEntity } from '@actual-app/core/types/models/rule';

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
import { ruleEffectsFor } from './rule-effects';
import type { ReportedRow, RuleEffects } from './rule-effects';
import { ruleToWrite } from './rules';
import type { ReviewRule } from './rules';
import {
  buildSession,
  MAX_SESSION_BYTES,
  sessionToPreviewState,
  staleRowNames,
  writeSession,
} from './session';
import type { ImportReviewSession } from './session';
import { splitErrorMessage } from './split-error-labels';
import { buildSplitReconciliation, legsOf } from './split-reconcile';
import type { SplitTransactionUpdate } from './split-reconcile';
import { transferErrorMessage } from './transfer-error-labels';
import { VENDOR_MAP_PREF } from './types';
import { useCustomSyncedPref } from './use-custom-synced-pref';
import { useImportSession } from './use-import-session';

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
  /**
   * The transactions the rows matched.
   *
   * A FITID matches within an account, so the matches belong to the
   * resolution as much as the rows do. Restoring the rows without the
   * matches would leave a row pointing at a transaction that is no
   * longer the one it matched — and the apply step would edit the wrong
   * transaction.
   */
  matchedTransactionIds: ReadonlyMap<string, string>;
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
  /**
   * Where the cursor was when the change was made.
   *
   * Accepting a row moves the cursor on, so without this an undo would
   * leave the cursor on the NEXT row — and the row the user just undid
   * would be off screen.
   */
  focusedIndex: number;
  /**
   * The vendor map the rows were resolved with.
   *
   * The map is part of the resolution, so it travels with it: an undo
   * that restored the rows without the map would restore a resolution
   * the map no longer agrees with, and the map would be lost for the
   * rest of the review.
   */
  resolvedMapRaw: string | undefined;
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
  /**
   * The saved review to pick up, instead of a file.
   *
   * A session holds the rows that were already parsed, so there is no
   * file to read: the review continues where it was left.
   */
  session?: ImportReviewSession | undefined;
  /** Called after a successful apply, with whether anything changed. */
  onImported: (didChange: boolean) => void;
};

/**
 * The summary of a review that has nothing in it yet.
 *
 * The counts are all zero rather than undefined, so the UI can render them
 * without a special case for "the file has not been parsed".
 */
/** No rule did anything to any row. */
const EMPTY_EFFECTS: RuleEffects = new Map();

export const EMPTY_SUMMARY: PreviewSummary = Object.freeze({
  total: 0,
  blocked: 0,
  skipped: 0,
  warned: 0,
  accepted: 0,
  overridden: 0,
  dropped: 0,
  pending: 0,
  willImport: 0,
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

/**
 * What came of a rule the review tried to write.
 *
 * - `created` — the rule is in the budget, and the review knows.
 * - `created-stale` — the rule is in the budget, but the review could
 *   not be refreshed afterwards, so it does not know. The rule IS
 *   there; the review's copy of the budget is behind.
 * - `unchanged` — the budget already said exactly this, so nothing was
 *   written.
 * - `failed` — nothing was written, and the reason is in the error.
 * - `busy` — another rule is being written, so this one was not
 *   started. Two writes at once could both decide to ADD a rule, and
 *   two rules with the same conditions are a tie that upstream breaks
 *   on the rule id — a random UUID.
 */
export type CreateRuleOutcome =
  | 'created'
  | 'created-stale'
  | 'unchanged'
  | 'failed'
  | 'busy';

/**
 * What upstream's rule handlers return.
 *
 * A successful write returns the rule. A rejected one returns the
 * errors: the CONDITION errors and the ACTION errors, each a code.
 * There is no message.
 */
type RuleWriteResult = {
  error?: {
    conditionErrors?: string[];
    actionErrors?: string[];
  };
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
  /**
   * The budget's rules.
   *
   * The details panel opens the rule that controls the focused row in
   * upstream's own editor, and that needs the whole rule.
   */
  rules: readonly RuleEntity[];
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
   * What the budget's rules do to each row, keyed by the row's key.
   *
   * The import preview reports the rules that fired on each row and the
   * fields they set, and this is that report, turned into the fields the
   * review LOCKS. A locked field is one the user cannot change: a rule
   * would discard the edit.
   *
   * Only the rows the import ADDS are here. A row that matched a
   * transaction already in the budget takes the import's update path,
   * where the EXISTING value wins, so a rule cannot change it.
   */
  ruleEffects: RuleEffects;
  /**
   * Ask the engine again what the rules do to every row.
   *
   * The rules can change while the review is open — the user edits one
   * in upstream's own editor, or a rule is made on another device. The
   * review asks the engine rather than working it out, so it asks again.
   */
  refreshRuleEffects: () => Promise<void>;
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
  /** Set the trust level directly, without re-parsing the file. */
  setTrustLevel: (level: TrustLevel) => void;
  /**
   * Create a rule, or amend the one that already says it.
   *
   * This is the ONLY path that creates a rule: nothing in the review
   * learns on its own. Resolves to what came of it.
   */
  createRule: (rule: ReviewRule) => Promise<CreateRuleOutcome>;
  /**
   * Put the review aside, so it can be picked up later.
   *
   * Returns false when it does not fit: the storage is full, or the
   * review is too big for it. The review says so rather than pretending
   * it was saved.
   */
  saveSession: () => boolean;
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
  const { accountId, filename, session, onImported } = opts;
  const { t } = useTranslation();

  const [status, setStatus] = useState<ReviewStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ImportPreviewState | null>(null);

  /**
   * The rows as they stand, right now.
   *
   * The re-resolve after a rule is written carries the user's work
   * across, and it must carry the work the user did WHILE the rule was
   * being written — a row accepted in that time is work, and the
   * re-resolve would throw it away.
   *
   * The ref is kept in step by an effect, which runs after every
   * change. The re-resolve happens at the end of a network round trip,
   * so the ref is up to date by then.
   */
  const stateRef = useRef<ImportPreviewState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The cursor is in a ref as well as in state.
  //
  // The undo snapshot has to record where the user WAS, and a change is
  // made from a callback that was created before the cursor moved. A
  // ref is read at the moment it is used, so it is always the cursor the
  // user is looking at — and a change that moves the cursor on records
  // the cursor it started from.
  const [focusedIndex, setFocusedIndex] = useState(0);
  /**
   * The fuzzy match cache.
   *
   * It lives as long as the review does, and it is thrown away with it.
   *
   * The fuzzy layer is the expensive one — it scores every budget payee
   * against every row's vendor string — and the review re-runs the whole
   * resolution whenever something changes. The cache holds the matches,
   * keyed on the payee list's fingerprint, so a re-resolve after a rule
   * write (or a routing change, or a trust-level change) reuses them.
   *
   * It is a `Map`, not a module-level singleton, so two budgets open at
   * once do not share one.
   */
  // `useState`'s initialiser runs ONCE, on the first render, so this
  // builds the cache once and keeps it. `useRef(buildFuzzyCache())`
  // would evaluate the factory on EVERY render and throw all but the
  // first result away.
  const [fuzzyCache] = useState(buildFuzzyCache);

  const focusedIndexRef = useRef(0);

  /** Move the cursor to a row. */
  const setCursor = useCallback((index: number) => {
    focusedIndexRef.current = index;
    setFocusedIndex(index);
  }, []);
  const [trustLevel, setTrustLevelState] = useState<TrustLevel>('cautious');
  const [payees, setPayees] = useState<readonly ReviewPayee[]>([]);
  const [accounts, setAccounts] = useState<readonly ReviewAccount[]>([]);
  const [categories, setCategories] = useState<readonly ReviewCategory[]>([]);

  /**
   * The rules, as the last write left them.
   *
   * The ref is what makes the amend decision right for a write that
   * starts after the previous one landed: the ref is updated the
   * moment a write lands, so the second write sees the rule the first
   * one made, and amends it instead of adding a second one.
   *
   * It does NOT cover two writes that start at the same time — for
   * that there is `ruleWriteRef` below.
   *
   * KNOWN LIMIT: a rule written on ANOTHER device while this review is
   * open is not seen. The next rule this review writes would then be
   * added rather than amended. The budget would have two rules with
   * the same conditions, and upstream would break the tie on the rule
   * id — a random UUID.
   */
  const rulesRef = useRef<readonly RuleEntity[]>([]);

  /**
   * The budget's rules, as the UI needs them.
   *
   * The ref is what the rule WRITES read — it has to be the list as it
   * was when the write started. The state is what the UI reads: the
   * details panel opens a rule in upstream's own editor, and it needs the
   * whole rule, not just its id.
   */
  const [rules, setRules] = useState<readonly RuleEntity[]>([]);

  /**
   * The rule write that is in flight, if there is one.
   *
   * Two writes that start at the same time would both read the same
   * list of rules, and both would decide that no rule with these
   * conditions exists — so both would add one, and two rules with the
   * same conditions are a tie that upstream breaks on the rule id,
   * which is a random UUID. The second write is refused instead.
   */
  const ruleWriteRef = useRef(false);

  const [vendorMapRaw, setVendorMapRaw] = useCustomSyncedPref(VENDOR_MAP_PREF);

  // Where a review is put aside when the user saves it.
  const { save: saveToStore, clear: clearFromStore } = useImportSession();

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

  // The vendor map the review has already accounted for.
  //
  // For a review that resolved its rows, that is the map they were
  // resolved with. For a review that was picked up again, it is the map
  // as it was — a picked-up review does not resolve its rows again, so
  // there is nothing for the map to be "resolved with".
  //
  // The map is a synced preference, so it can change while the review is
  // open: the budget reloads its preferences when it syncs, and another
  // device may have added an entry. The rows were resolved without it,
  // and nothing resolved them again — so an entry that arrived late was
  // simply not used.
  //
  // This says what the rows were resolved with, so the effect below can
  // tell a map that has arrived from one that was already there.
  const resolvedMapRawRef = useRef<string | undefined>(undefined);

  // The vendor-map entries the user earned by picking a payee, keyed by the
  // raw vendor string they picked it for. They are written when the import
  // succeeds, not while the review is open.
  const vendorChoices = useRef<Map<string, VendorChoice>>(new Map());

  // The rows the user explicitly edited, so the apply step can update them
  // in place.
  const editedRowKeys = useRef<ReadonlySet<string>>(new Set());

  // The parsed rows BEFORE they were resolved.
  //
  // A re-resolution happens when the vendor map changes under the review,
  // and the resolution has to start from the file rather than from a
  // previous resolution: resolving a resolution would resolve the
  // resolver's own output. The base rows are what the resolver is given,
  // so they are kept.
  const baseRows = useRef<readonly ReviewRowInput[]>([]);

  // The changes the review remembers, so they can be undone. A snapshot is
  // taken before every change, and holds the whole state: a bulk action is
  // then one undo rather than one undo per row.
  const undoStack = useRef<readonly UndoSnapshot[]>([]);

  // The transaction each row matched, keyed by the row's key. The import
  // preview reports this, and it is what lets a user's edit to an
  // already-imported transaction be applied in place.
  //
  // It is STATE and not a ref, because the answer can arrive after the
  // screen has moved on: the review asks the budget which of its rows
  // are already in it, and the rows that are already in the budget
  // change with the answer. A ref would be updated without anything
  // redrawing.
  /**
   * What the budget's rules do to each row.
   *
   * The import preview reports it, and the review locks the fields a rule
   * controls. It is refreshed when the preview is run again — after a rule
   * is written, and after the user edits a row (a rule's outcome can
   * depend on the payee the user picked).
   */
  const [ruleEffects, setRuleEffects] = useState<RuleEffects>(EMPTY_EFFECTS);

  const [matchedTransactionIds, setMatchedTransactionIds] = useState<
    ReadonlyMap<string, string>
  >(new Map());

  /**
   * The matched rows, as the preview reported them.
   *
   * A ref, because the rule effects are refreshed on their own schedule
   * and must not be rebuilt when the map changes.
   */
  const matchedRef = useRef<ReadonlyMap<string, string>>(matchedTransactionIds);
  useEffect(() => {
    matchedRef.current = matchedTransactionIds;
  }, [matchedTransactionIds]);

  /**
   * The newest effects request, per row.
   *
   * The rules' effect is asked for over the network, so two requests can
   * be in flight at once. The older answer must not overwrite the newer
   * one: a row that a rule has just started to control would show as
   * unlocked, and the user's edit would be discarded.
   */
  const effectsRequestsRef = useRef(new Map<string, number>());
  const effectsRequestSeqRef = useRef(0);

  // The trust level the review started with. It is read by the parse effect
  // but is deliberately not one of its dependencies: changing it must not
  // re-parse the file and discard the user's decisions.
  const trustLevelRef = useRef(trustLevel);
  useEffect(() => {
    trustLevelRef.current = trustLevel;
  }, [trustLevel]);

  // Guards against a second apply starting while one is running.
  const applyingRef = useRef(false);

  /**
   * What the resolver resolves against.
   *
   * The vendor map is read through a ref, so it is the map as it was when
   * the review opened: a review reads the map once, and the next review
   * sees the updated one.
   *
   * Actual's own rules cover what a separate rules system would do. They
   * run server-side during import, keyed on `imported_payee`, so there is
   * no second rules system to maintain here.
   */
  const resolveOptsFor = useCallback(
    (
      payeeList: readonly ReviewPayee[],
      accountList: readonly ReviewAccount[],
    ) => {
      const vendorMap = readVendorMap(vendorMapRawRef.current);
      const liveMap = vendorMap
        ? filterStaleVendorMapEntries(vendorMap, payeeList)
        : undefined;
      return {
        existingPayees: payeeList,
        accounts: accountList,
        vendorMap: liveMap,
        // No thresholds: the resolver applies the fuzzy module's own
        // defaults. Spelling them out here would be a second copy of
        // them, and the two could drift.
        fuzzy: {},
        // The cache is shared by every resolve this review does. Its
        // key holds the payee list's fingerprint, so a changed list
        // cannot hit a stale entry — but the entries for a list that is
        // gone are still held, so the cache is cleared when the list
        // changes.
        fuzzyCache,
      };
    },
    // The cache never changes: `useState`'s initialiser runs once. It
    // is listed because the rule asks for every value the callback
    // closes over.
    [fuzzyCache],
  );

  /**
   * Which rows are ALREADY in the budget.
   *
   * Two questions, two sources.
   *
   * The FITID lookup asks the budget DIRECTLY, and it is the authority.
   * The import preview cannot answer this: it reports the matched
   * transaction only when the matched row's fields DIFFER from it, so a
   * file imported a second time matches its own transactions exactly and
   * the preview reports nothing.
   *
   * The import preview knows about one thing the FITID lookup cannot see:
   * a row with NO FITID that Actual matched against an existing
   * transaction by date and amount. Those matches are kept, because they
   * are the same transaction the import itself would update. It is asked
   * about the review's own account, because that is the account it
   * matches within.
   */
  const lookupMatches = useCallback(
    async (
      rows: readonly PreviewRow[],
      accountId: string,
      payeeList: readonly ReviewPayee[],
      categoryList: readonly ReviewCategory[],
    ): Promise<{ matched: Map<string, string>; effects: RuleEffects }> => {
      const importedIds = rows
        .map(row => row.importedId)
        .filter((id): id is string => typeof id === 'string');

      const alreadyImported = await findImportedTransactions({
        accountId,
        importedIds,
      });

      const matched = new Map<string, string>(
        matchRowsToTransactions(rows, alreadyImported),
      );

      const accountRows = rows.filter(row => row.accountId === accountId);
      if (accountRows.length === 0) return { matched, effects: EMPTY_EFFECTS };

      // The PREVIEW payload marks nothing as skipped: Actual skips a
      // marked row before it reports the match, so a marked row would
      // come back with no correlation at all.
      let preview: {
        updatedPreview?: {
          existing?: { id?: string };
          transaction?: unknown;
        }[];
        ruledTransactions?: ReportedRow[];
      };
      try {
        preview = await send('transactions-import', {
          accountId,
          // The same cast as the import itself, for the same reason: a
          // split leg's category is `null` when it has none, and
          // upstream's type says `string | undefined`.
          transactions: buildPreviewPayload(
            { rows: accountRows, trustLevel: trustLevelRef.current },
            {
              accountId,
              payees: payeeRefs(payeeList),
              categories: categoryList.map(c => ({ id: c.id })),
            },
          ) as ImportTransactionEntity[],
          isPreview: true,
        });
      } catch (err) {
        // The preview REFUSES a row the import would refuse: a
        // transfer whose target has no transfer payee, or a split
        // whose legs do not add up. Such a row cannot be imported
        // either way, so its match does not matter — and the apply
        // step reports the refusal in the user's words.
        //
        // Only those refusals are swallowed. Anything else is a real
        // failure and is passed on.
        if (
          !(err instanceof TransferValidationError) &&
          !(err instanceof SplitValidationError)
        ) {
          throw err;
        }
        return { matched, effects: EMPTY_EFFECTS };
      }

      preview.updatedPreview?.forEach(entry => {
        const existing = entry.existing;
        if (!existing?.id) return;
        // The preview echoes back the transaction we sent, so the
        // transient preview key travels with it.
        //
        // Safe: the echo is the transaction we sent, plus whatever the
        // rule engine added to it. The cast is only needed because the
        // preview's type does not declare the transient field.
        const key = (entry.transaction as { _previewKey?: string } | undefined)
          ?._previewKey;
        if (typeof key === 'string') {
          matched.set(key, existing.id);
        }
      });

      // What the rules did to each row. The preview reports the rules
      // that fired on every row it was given, and the fork lines them up
      // with its own rows by the transient preview key.
      //
      // A row that MATCHED is not locked: the import's update path
      // prefers the existing value, so a rule cannot change it.
      const effects = ruleEffectsFor(preview.ruledTransactions ?? [], {
        matchedRowKeys: new Set(matched.keys()),
      });

      // A rule can CREATE a payee, and the preview is where it is
      // created — so the payee list the review holds is a moment out of
      // date. The list is read again when the preview named a payee the
      // review does not know, so the cell can say which payee it is.
      const known = new Set(payeeList.map(payee => payee.id));
      const unknown = (preview.ruledTransactions ?? []).some(
        trans => typeof trans.payee === 'string' && !known.has(trans.payee),
      );
      if (unknown) {
        const fresh = await send('payees-get');
        // The payee list changed, so the cache's entries are for a list
        // that is gone. The fingerprint in the key makes a stale HIT
        // impossible, but the entries would still be held.
        fuzzyCache.clear();
        setPayees(
          fresh.map(payee => ({
            id: payee.id,
            name: payee.name,
            transferAcct: payee.transfer_acct,
          })),
        );
      }

      return { matched, effects };
    },
    [fuzzyCache],
  );

  /**
   * Ask the engine what the rules do to some rows.
   *
   * The import preview is where the engine runs the rules, and the review
   * asks it for the answer rather than working it out: a rule's outcome
   * depends on the engine, and the engine changes.
   *
   * One row at a time is enough when the user has just edited a row. A
   * rule's outcome depends on that row's own payload and on nothing else,
   * so asking about the whole file would be the same answer, more slowly.
   */
  const refreshEffectsFor = useCallback(
    async (rows: readonly PreviewRow[]) => {
      if (rows.length === 0) return;

      const request = ++effectsRequestSeqRef.current;
      for (const row of rows) {
        effectsRequestsRef.current.set(rowKey(row), request);
      }

      try {
        const preview = await send('transactions-import', {
          accountId,
          transactions: buildPreviewPayload(
            { rows, trustLevel: trustLevelRef.current },
            {
              accountId,
              payees: payeeRefs(payees),
              categories: categories.map(category => ({ id: category.id })),
            },
          ) as ImportTransactionEntity[],
          isPreview: true,
        });

        // The rows whose answer is stale: a newer request for one of them
        // has been sent since, so this answer is not the newest one.
        const stale = new Set(
          rows
            .filter(
              row => effectsRequestsRef.current.get(rowKey(row)) !== request,
            )
            .map(row => rowKey(row)),
        );

        const effects = ruleEffectsFor(preview.ruledTransactions ?? [], {
          matchedRowKeys: new Set(matchedRef.current.keys()),
        });

        setRuleEffects(current => {
          const next = new Map(current);
          // The rows that were asked about are REPLACED, not merged: a
          // row that used to be ruled and no longer is must lose its
          // lock. Merging would keep the old entry, and the apply step
          // would then write the old rule's value — a wrong write, made
          // silently.
          for (const row of rows) {
            const key = rowKey(row);
            if (stale.has(key)) continue;
            next.delete(key);
          }
          for (const [key, rowEffects] of effects) {
            if (stale.has(key)) continue;
            next.set(key, rowEffects);
          }
          return next;
        });

        // A rule can CREATE a payee, and the preview is where it is
        // created — so the payee list the review holds is a moment out of
        // date. The list is read again when the preview named a payee
        // the review does not know.
        const known = new Set(payees.map(payee => payee.id));
        const unknown = (preview.ruledTransactions ?? []).some(
          trans => typeof trans.payee === 'string' && !known.has(trans.payee),
        );
        if (unknown) {
          const fresh = await send('payees-get');
          setPayees(
            fresh.map(payee => ({
              id: payee.id,
              name: payee.name,
              transferAcct: payee.transfer_acct,
            })),
          );
        }
      } catch (err) {
        // The preview refuses some rows — a transfer whose target has no
        // transfer payee. Such a row cannot be imported either way, and
        // the apply step says so. The review carries on.
        console.error('The rules could not be read for the row:', err);
      }
    },
    [accountId, categories, payees],
  );

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

    /**
     * Pick a saved review up again.
     *
     * The rows come back as they were — the user approved those rows,
     * against those payees, in that file. What is checked is the budget:
     * the account, the payees and the categories the rows point at may have
     * been deleted since the review was put aside, and a row that points at
     * something that is gone cannot be imported as it is.
     *
     * The rows that are already in the budget are asked about AGAIN: the
     * budget may have changed since the review was put aside, and the FITID
     * lookup is the only thing that says which rows are already there.
     */
    async function loadSession(saved: ImportReviewSession) {
      try {
        const [payeeEntities, accountEntities, categoryEntities, ruleEntities] =
          await Promise.all([
            send('payees-get'),
            send('accounts-get'),
            send('get-categories'),
            // The rules are read so a rule the user creates can be
            // AMENDED rather than added: two rules with the same
            // conditions are a tie, and upstream breaks the tie on the
            // rule id — a random UUID.
            send('rules-get'),
          ]);

        if (cancelled) return;

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
        const grouped = categoryEntities.grouped ?? [];
        const categoryList: readonly ReviewCategory[] = [
          ...grouped.flatMap(group =>
            (group.categories ?? []).map(category => ({
              id: category.id,
              name: category.name,
              groupName: group.name,
              hidden: category.hidden,
              isIncome: category.is_income,
            })),
          ),
          ...categoryEntities.list
            .filter(
              category =>
                !grouped.some(group =>
                  (group.categories ?? []).some(
                    candidate => candidate.id === category.id,
                  ),
                ),
            )
            .map(category => ({
              id: category.id,
              name: category.name,
              hidden: category.hidden,
              isIncome: category.is_income,
            })),
        ];

        setPayees(payeeList);
        // The payee list changed, so the cache's entries are for a list
        // that is gone. The fingerprint in the key makes a stale HIT
        // impossible — but the entries would still be held, so they are
        // dropped.
        fuzzyCache.clear();
        setAccounts(accountList);
        setCategories(categoryList);
        rulesRef.current = ruleEntities;
        setRules(ruleEntities);

        const stale = staleRowNames(saved, {
          accounts: accountList,
          payees: payeeList,
          categories: categoryList,
        });
        if (stale.length > 0) {
          setStatus('idle');
          setError(
            t(
              'Some of the saved rows point at something that no longer exists: {{names}}',
              { names: stale.join(', ') },
            ),
          );
          return;
        }

        // The base rows are kept, so the rows can be resolved again. The
        // session holds the RESOLVED rows, and the rebuild recomputes
        // the flags, so the resolution they carry does not leak into the
        // new one.
        baseRows.current = saved.rows;
        // A review reads the map once, whichever way it was opened. The
        // session's rows are the rows the user approved, resolved as they
        // were then; resolving them again against the budget as it is now
        // would change what the user agreed to.
        resolvedMapRawRef.current = vendorMapRawRef.current;

        const state = sessionToPreviewState(saved);
        setState(state);
        setTrustLevelState(saved.trustLevel);
        // The cursor has to be a row of THIS review: the session may
        // have been saved from a review with more rows.
        setCursor(
          Math.min(
            Math.max(0, saved.focusedIndex),
            Math.max(0, state.rows.length - 1),
          ),
        );
        editedRowKeys.current = new Set(saved.editedRowKeys);
        vendorChoices.current = new Map(saved.vendorChoices);

        // Which rows are ALREADY in the budget? Asked again, because the
        // budget may have changed since the review was put aside.
        const { matched, effects } = await lookupMatches(
          state.rows,
          accountId,
          payeeList,
          categoryList,
        );
        if (cancelled) return;

        setMatchedTransactionIds(matched);
        setRuleEffects(effects);

        setStatus('reviewing');
      } catch (err) {
        if (cancelled) return;
        setStatus('idle');
        setError(err instanceof Error ? err.message : t('The import failed'));
      }
    }

    async function load() {
      setStatus('parsing');
      setError(null);
      // A re-parse starts the review over: the decisions and edits from the
      // previous parse belong to rows that no longer exist.
      editedRowKeys.current = new Set();
      setMatchedTransactionIds(new Map());
      vendorChoices.current = new Map();
      undoStack.current = [];

      // A review that is being PICKED UP rather than started.
      //
      // The rows come back as they were: the user approved those rows,
      // against those payees, in that file. Re-resolving them against the
      // budget as it is now would change what the user agreed to.
      //
      // What IS checked is the budget: the account, the payees and the
      // categories the rows point at may have been deleted since the
      // review was put aside, and a row that points at something that is
      // gone cannot be imported as it is.
      if (session) {
        await loadSession(session);
        return;
      }

      try {
        const [
          payeeEntities,
          accountEntities,
          categoryEntities,
          ruleEntities,
          parsed,
        ] = await Promise.all([
          send('payees-get'),
          send('accounts-get'),
          send('get-categories'),
          // The rules are read so a rule the user creates can be
          // AMENDED rather than added: two rules with the same
          // conditions are a tie, and upstream breaks the tie on the
          // rule id — a random UUID.
          send('rules-get'),
          // A session holds the rows that were already parsed, so there
          // is no file to read: the review continues where it was left.
          session
            ? Promise.resolve(null)
            : send('transactions-parse-file', {
                filepath: filename,
                options: {},
              }),
        ]);

        if (cancelled) return;

        if (parsed && parsed.errors && parsed.errors.length > 0) {
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
        // The payee list changed: the cache's entries are for a list
        // that is gone.
        fuzzyCache.clear();
        setAccounts(accountList);
        setCategories(categoryList);
        rulesRef.current = ruleEntities;
        setRules(ruleEntities);

        // Safe: the parse handler's loose type is a union of a structured
        // transaction and a CSV record, and `toReviewRows` reads each
        // field defensively, checking the type before it uses it.
        const raw = flagDuplicateFitids(
          toReviewRows(
            (parsed?.transactions ?? []) as Record<string, unknown>[],
            { accountId },
          ),
        );

        // The rows are kept BEFORE they are resolved: a re-resolution
        // happens when the vendor map changes under the review, and a
        // resolution has to start from the file rather than from a
        // previous resolution.
        baseRows.current = raw;

        const next = rebuildPreviewState({
          base: raw,
          trustLevel: trustLevelRef.current,
          resolveOpts: resolveOptsFor(payeeList, accountList),
        });
        resolvedMapRawRef.current = vendorMapRawRef.current;

        if (cancelled) return;

        // Which rows are ALREADY in the budget, and what did the rules do
        // to them?
        const { matched, effects } = await lookupMatches(
          next.rows,
          accountId,
          payeeList,
          categoryList,
        );
        if (cancelled) return;

        // **The rows are set AFTER the answers, not before.** The rows
        // and the rules' effects belong together: a row that a rule
        // controls says so in the cell, in the status line and in the
        // rule picker. Setting the rows first would show a table whose
        // rules were still on their way, and a keypress in that window
        // would say "this row has no rules" about a row that has one.
        //
        // Nothing is lost by waiting: the modal shows a loading overlay
        // until the review is ready, so the rows were never visible
        // before the answers arrived.
        setMatchedTransactionIds(matched);
        setRuleEffects(effects);
        setState(next);
        setCursor(0);

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
  }, [
    filename,
    accountId,
    t,
    session,
    lookupMatches,
    resolveOptsFor,
    setCursor,
    // The cache never changes, but the effect clears it, so it is a
    // dependency the rule asks for.
    fuzzyCache,
  ]);

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
  const reconcileSplits = useCallback(
    async (rows: readonly PreviewRow[]) => {
      const parentIds = rows
        .map(row => matchedTransactionIds.get(rowKey(row)))
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
        const parentId = matchedTransactionIds.get(rowKey(row));
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
    },
    [matchedTransactionIds],
  );

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
      if (choices.size === 0) {
        // Nothing was written, so the map did not change — and the rows
        // were resolved with the map as it was.
        resolvedMapRawRef.current = vendorMapRawRef.current;
        return;
      }

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
      const raw = JSON.stringify(map);
      setVendorMapRaw(raw);
      // The rows already say what the map now says: the map was written
      // from the user's own choices, and those choices are in the rows.
      // Resolving them again would be work for a review that is closing.
      resolvedMapRawRef.current = raw;
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
  const pushUndo = useCallback(
    (current: ImportPreviewState, cursor: number): UndoSnapshot | undefined => {
      const stack = undoStack.current;
      if (stack[stack.length - 1]?.state === current) return undefined;
      const snapshot: UndoSnapshot = {
        state: current,
        matchedTransactionIds,
        editedRowKeys: new Set(editedRowKeys.current),
        vendorChoices: new Map(vendorChoices.current),
        focusedIndex: cursor,
        resolvedMapRaw: resolvedMapRawRef.current,
      };
      undoStack.current = [...stack.slice(-(MAX_UNDO_STEPS - 1)), snapshot];
      return snapshot;
    },
    [matchedTransactionIds],
  );

  const decide = useCallback(
    (index: number, decision: PreviewDecision) => {
      // The cursor as it is NOW. Accepting a row moves the cursor on, and
      // the snapshot has to record where the user was, not where the
      // cursor ended up.
      const cursor = focusedIndexRef.current;
      setState(current => {
        if (!current) return current;
        const row = current.rows[index];
        if (!row) return current;
        pushUndo(current, cursor);
        return applyDecision(current, rowKey(row), decision);
      });
    },
    [pushUndo],
  );

  const decideAll = useCallback(
    (decision: PreviewDecision) => {
      const cursor = focusedIndexRef.current;
      setState(current => {
        if (!current) return current;
        const pending = current.rows.filter(row => row.decision === 'pending');
        if (pending.length === 0) return current;
        // One snapshot for the whole bulk action, so one undo takes it
        // all back.
        pushUndo(current, cursor);
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
      const cursor = focusedIndexRef.current;
      // The row as the user sees it. The state ref is kept in step with
      // what is on screen, and the row the user is editing IS the one on
      // screen.
      const edited = stateRef.current?.rows[index];
      setState(current => {
        if (!current) return current;
        const row = current.rows[index];
        if (!row) return current;
        pushUndo(current, cursor);
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

      // A rule's outcome can depend on what the user just changed: a rule
      // that says "this payee is this category" fires on the payee. So the
      // engine is asked again about this row — otherwise a rule that
      // starts to apply would go on discarding the user's edit in silence.
      if (edited) {
        void refreshEffectsFor([{ ...edited, edits }]);
      }
    },
    [pushUndo, payees, refreshEffectsFor],
  );

  const isAlreadyImported = useCallback(
    (key: string) => {
      return matchedTransactionIds.has(key);
    },
    [matchedTransactionIds],
  );

  /**
   * Put the cursor on a row.
   *
   * The row has to exist: a cursor past the end of the review is a
   * cursor that cannot move, because every move is clamped back into
   * range and the user sees nothing happen.
   */
  const focus = useCallback(
    (index: number) => {
      const last = Math.max(0, (state?.rows.length ?? 0) - 1);
      setCursor(Math.min(last, Math.max(0, index)));
    },
    [setCursor, state],
  );

  /**
   * Move the cursor, and keep it on a row.
   *
   * Both ends are clamped. The upper end matters more than it looks:
   * accepting the last row moves the cursor past it, and a cursor that
   * is past the end makes "up" a no-op — the cursor goes from one past
   * the end back to the last row, which looks like nothing happened.
   */
  const moveFocus = useCallback(
    (delta: number) => {
      const last = Math.max(0, (state?.rows.length ?? 0) - 1);
      const next = Math.min(last, Math.max(0, focusedIndexRef.current + delta));
      setCursor(next);
    },
    [setCursor, state],
  );

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
    // The matches travel with the rows they were found for. A row that
    // points at a transaction it no longer matches would have that
    // transaction edited.
    setMatchedTransactionIds(last.matchedTransactionIds);
    setState(last.state);
    // The cursor goes back to where it was. Accepting a row moves it on,
    // so without this the undo leaves the user looking at the next row
    // while the row they undid is off screen.
    setCursor(last.focusedIndex);
    // The map travels with the rows it resolved. An undo that restored
    // the rows without it would leave the map applied to a resolution it
    // never saw — and the map would be lost for the rest of the review.
    resolvedMapRawRef.current = last.resolvedMapRaw;
    // The rows are back, so what the rules do to them is asked for again:
    // a rule that fired on the restored rows may not fire on the ones the
    // undo threw away, and the lock has to follow.
    void refreshEffectsFor(last.state.rows);
  }, [refreshEffectsFor, setCursor]);

  const setTrustLevel = useCallback((level: TrustLevel) => {
    // The trust level only feeds the gate matrix, so it is applied to the
    // existing state. Re-parsing would discard the user's decisions.
    setTrustLevelState(level);
    setState(currentState =>
      currentState ? withTrustLevel(currentState, level) : currentState,
    );
  }, []);

  // The vendor map changed: resolve the rows again.
  //
  // The map is read through a ref, so a map that arrived after the
  // review opened was never used — the rows were resolved without it and
  // nothing resolved them again. The rows are resolved again now,
  // carrying the user's decisions and edits across, so nothing they did
  // is lost.
  useEffect(() => {
    // The review is not open, or it is on its way out: the apply writes
    // the map itself, and resolving again then would be work for a
    // review that is closing.
    if (!state || applyingRef.current) return;
    // The rows were resolved with this map already.
    if (resolvedMapRawRef.current === vendorMapRaw) return;

    resolvedMapRawRef.current = vendorMapRaw;

    const next = rebuildPreviewState({
      base: baseRows.current,
      previous: state,
      trustLevel: trustLevelRef.current,
      resolveOpts: resolveOptsFor(payees, accounts),
    });
    setState(next);
  }, [accounts, payees, resolveOptsFor, state, vendorMapRaw]);

  /**
   * Create a rule, or amend the one that already says it.
   *
   * **This is the only way the review creates a rule.** Nothing in the
   * review learns on its own: picking a payee changes that transaction
   * and nothing else. A rule exists because the user asked for one.
   *
   * The rule is written with upstream's own handlers — `rule-add` for a
   * new one, `rule-update` when one with the same conditions already
   * exists. The second case matters: two rules with the same conditions
   * are a tie, and upstream breaks the tie on the rule id, which is a
   * random UUID. So the winner would be decided at random, and the
   * review could not say which rule applied.
   *
   * Three things happen after the write:
   *
   *   - the rules are read again, so the review's own copy is the
   *     server's. `rules-get` reads the in-memory cache, and the cache
   *     is updated by the sync listener the write went through — but
   *     reading it again does not depend on that.
   *   - the payees are read again. A rule can create a payee (upstream's
   *     `payee_name` action), and the client's list would otherwise be
   *     stale — and a stale list means the fuzzy memo's fingerprint does
   *     not change, so it would serve an answer about a payee that is
   *     gone.
   *   - the rows are resolved again, carrying the user's decisions and
   *     edits across.
   */
  const createRule = useCallback(
    (rule: ReviewRule): Promise<CreateRuleOutcome> => {
      // There is nothing to re-resolve before the file has been parsed.
      if (!stateRef.current) return Promise.resolve('failed');

      // One rule write at a time. Two at once would both read the same
      // list of rules, and both would decide to ADD — and two rules
      // with the same conditions are a tie that upstream breaks on the
      // rule id, which is a random UUID.
      if (ruleWriteRef.current) return Promise.resolve('busy');
      ruleWriteRef.current = true;

      // The write is done in an inner promise so the flag can be
      // released when it settles, however it settles. A `try`/`finally`
      // would say the same thing, but the compiler cannot see which
      // values a callback depends on across one.
      const write = (async () => {
        const { method, rule: toWrite } = ruleToWrite(rulesRef.current, rule);

        // The rule already says this: there is nothing to write, and a
        // write that changes nothing still takes a step in the undo
        // history and still syncs.
        if (method === 'none') return 'unchanged';

        let result: RuleWriteResult | undefined;
        try {
          result = (await send(method, toWrite)) as RuleWriteResult;
        } catch (err) {
          console.error('The rule could not be written:', err);
          return 'failed';
        }

        if (result?.error) {
          // Upstream reports what was wrong with the rule — the
          // condition and the action, each with a code — and there is
          // no message. The codes go to the console, where a developer
          // will find them; the user gets a plain sentence from the
          // notice.
          const codes = [
            ...(result.error.conditionErrors ?? []),
            ...(result.error.actionErrors ?? []),
          ].filter((code): code is string => typeof code === 'string');
          if (codes.length > 0) {
            console.error('The rule was rejected:', codes.join(', '));
          }
          return 'failed';
        }

        // The rule IS in the budget at this point. Everything below
        // refreshes the REVIEW's copy of the budget, and a failure
        // there does not undo the rule — so it has its own outcome,
        // because "nothing was changed" would be a lie.
        let freshRules: readonly RuleEntity[];
        let freshPayees: readonly {
          id: string;
          name: string;
          transfer_acct?: string | null;
        }[];
        try {
          [freshRules, freshPayees] = await Promise.all([
            send('rules-get'),
            send('payees-get'),
          ]);
        } catch (err) {
          console.error('The budget could not be read after the rule:', err);
          return 'created-stale';
        }

        rulesRef.current = freshRules;
        setRules(freshRules);

        const payeeList: readonly ReviewPayee[] = freshPayees.map(p => ({
          id: p.id,
          name: p.name,
          transferAcct: p.transfer_acct,
        }));

        // The payee list may have changed — a rule can create a payee —
        // so the memo's entries are for a list that is gone. The
        // fingerprint in the key makes a stale HIT impossible, but the
        // entries would still be held, so they are dropped.
        fuzzyCache.clear();
        setPayees(payeeList);

        const next = rebuildPreviewState({
          base: baseRows.current,
          // The work as it stands NOW, not as it stood when the write
          // started.
          previous: stateRef.current ?? undefined,
          trustLevel: trustLevelRef.current,
          resolveOpts: resolveOptsFor(payeeList, accounts),
        });
        setState(next);

        // The rules changed, so what they do to each row has to be asked
        // for again. This is the whole point of writing a rule: the row
        // the user was looking at is now under the rule's control, and
        // the review has to say so.
        void refreshEffectsFor(next.rows);

        return 'created';
      })();

      // A throw after the write — the re-fetch, the re-resolve — must
      // not leave the caller with a rejected promise and no notice. It
      // is caught here, so the review says what happened.
      return write
        .catch(err => {
          console.error('The rule could not be written:', err);
          return 'failed' as const;
        })
        .finally(() => {
          ruleWriteRef.current = false;
        });
    },
    [accounts, fuzzyCache, refreshEffectsFor, resolveOptsFor],
  );

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
        return matchedTransactionIds.has(rowKey(row));
      });

      // ---- Phase 1: build -------------------------------------------
      //
      // The payload is built BEFORE anything is written.
      //
      // Building it can refuse the import: a transfer whose target has no
      // transfer payee, or a split whose legs do not add up. A refusal
      // after the edits were written would leave the user's edits in the
      // budget and the rest of the file unimported, with no way to tell
      // that is what happened. Built first, a refusal happens with
      // nothing written.
      //
      // Every row of the file goes into the account the review was opened
      // for, so there is one payload.
      const { updates } = buildUpdatePayload(state, {
        accountId,
        matchedTransactionIds,
        payees: payeeRefs(payees),
        categories: categories.map(c => ({ id: c.id })),
        editedRowKeys: editedRowKeys.current,
      });

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

      const payload = buildApplyPayload(state, {
        accountId,
        payees: payeeRefs(payees),
        categories: categories.map(c => ({ id: c.id })),
        updatedRowKeys,
        // A field a rule controls goes out with the RULE's value, so the
        // payload agrees with what the review showed.
        ruleEffects,
      });

      // ---- Phase 2: write -------------------------------------------
      //
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
      //
      // The payees are created ONCE, before the import runs, and the
      // names are collected across the updates. `payee-create` does NOT
      // dedupe by name — it always inserts — so a payee that both an
      // update and the import need would otherwise be created twice, and
      // an import that creates the same payee would leave a duplicate
      // behind.
      const createdPayeeIds = new Map<string, string>();
      const namesToCreate = new Set<string>();
      for (const { payeeNameToCreate } of updates) {
        if (payeeNameToCreate !== undefined) {
          namesToCreate.add(payeeNameToCreate);
        }
      }
      for (const name of namesToCreate) {
        const created = await send('payee-create', { name });
        if (typeof created === 'string') {
          createdPayeeIds.set(name, created);
        }
      }

      // The updates.
      for (const { update, payeeNameToCreate } of updates) {
        if (payeeNameToCreate !== undefined) {
          const payeeId = createdPayeeIds.get(payeeNameToCreate);
          if (!payeeId) {
            // The payee could not be created, so the update would go
            // through WITHOUT the payee the user chose - the edit would
            // be silently dropped while the apply reported success.
            // Better to say so.
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
          // The work is in the budget now, so there is nothing left to
          // pick up later.
          clearFromStore();
          onImported(true);
          return true;
        }
        // Every row was dropped or held back, so there was nothing to
        // write. Saying so is the difference between "the import failed"
        // and "the import did nothing because you asked for nothing".
        setError(t('There is nothing to import'));
        return false;
      }

      // The import.
      //
      // The updates above are already written by the time the import runs,
      // so the two are not atomic: if the import fails, the updates stay.
      // That is deliberate — the updates are the user's explicit edits and
      // re-sending them would be a no-op — but it is worth knowing.
      const accountName =
        accounts.find(account => account.id === accountId)?.name ?? accountId;
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
          didChange
            ? t(
                'The edits were saved, but the import into {{account}} failed: {{message}}',
                {
                  account: accountName,
                  message: err instanceof Error ? err.message : String(err),
                },
              )
            : t('The import into {{account}} failed: {{message}}', {
                account: accountName,
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
            ? t(
                'The edits were saved, but the import into {{account}} failed: {{message}}',
                { account: accountName, message: importErrors[0].message },
              )
            : t('The import into {{account}} failed: {{message}}', {
                account: accountName,
                message: importErrors[0].message,
              }),
        );
        return false;
      }

      // Whether anything actually changed, from what the server reports
      // — not from the absence of errors. A payload of only dropped rows
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
    accounts,
    categories,
    clearFromStore,
    matchedTransactionIds,
    reconcileSplits,
    ruleEffects,
    state,
    payees,
    onImported,
    t,
    writeVendorMap,
  ]);

  /**
   * Put the review aside.
   *
   * The session holds the rows and what the user did with them. It does
   * NOT hold the undo history: the stack holds whole states, and fifty of
   * them would be a few megabytes of JSON for a review the user is
   * picking up again, not editing.
   */
  const saveSession = useCallback((): boolean => {
    if (!state) return false;

    const session = buildSession({
      accountId,
      filename,
      trustLevel,
      focusedIndex,
      state,
      editedRowKeys: editedRowKeys.current,
      vendorChoices: vendorChoices.current,
      savedAt: new Date().toISOString(),
    });

    // The size is checked before the save: a session that does not fit
    // is better refused than half-written.
    if (writeSession(session).length > MAX_SESSION_BYTES) return false;

    return saveToStore(session);
  }, [accountId, filename, focusedIndex, saveToStore, state, trustLevel]);

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

  /**
   * Read the rules again, and ask the engine what they do to every row.
   *
   * The rules can change while the review is open — the user edits one
   * in upstream's own editor, or a rule is made on another device. The
   * review asks the engine rather than working it out, so it asks again.
   *
   * **The rule LIST is read again too, and it has to be.** The next rule
   * the review writes is an AMENDMENT of the rule with the same
   * conditions, and the amendment is built from the list the review
   * holds. A list that is a moment out of date would amend the OLD
   * rule: the user's edit to it would be silently undone, and the
   * action they added would be dropped.
   */
  const refreshRuleEffects = useCallback(async () => {
    try {
      const fresh = await send('rules-get');
      rulesRef.current = fresh;
      setRules(fresh);
    } catch (err) {
      console.error('The rules could not be read after the edit:', err);
    }
    await refreshEffectsFor(stateRef.current?.rows ?? []);
  }, [refreshEffectsFor]);

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
    rules,
    summary,
    evaluations,
    ruleEffects,
    refreshRuleEffects,
    unsavedWork: unsaved,
    isAlreadyImported,
    decide,
    decideAll,
    edit,
    focus,
    moveFocus,
    undo,
    setTrustLevel,
    createRule,
    saveSession,
    apply,
    close,
  };
}

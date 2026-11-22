import type {
  ComponentType,
  KeyboardEvent as ReactKeyboardEvent,
  SVGProps,
} from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PressEvent } from 'react-aria-components';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { AnimatedLoading } from '@actual-app/components/icons/AnimatedLoading';
import {
  SvgBlock,
  SvgCheckmark,
  SvgClose,
  SvgFlag,
  SvgPause,
  SvgTag,
  SvgUpload,
} from '@actual-app/components/icons/v1';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { TextOneLine } from '@actual-app/components/text-one-line';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  effectiveAmountCents,
  effectiveTransferAccountId,
  gateRow,
  isSplitRow,
  normalizePayeeName,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  FlagKind,
  PreviewEdits,
  PreviewRow,
  ReviewCategory,
  RowEvaluation,
  RowGate,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';
import type {
  NewRuleEntity,
  RuleEntity,
} from '@actual-app/core/types/models/rule';
import { css } from '@emotion/css';
import { format as formatDate, parseISO } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { useAccounts } from '#hooks/useAccounts';
import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';
import { useMetadataPref } from '#hooks/useMetadataPref';
// oxlint-disable-next-line eslint/no-restricted-imports
import { useNavigate } from '#hooks/useNavigate';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch, useSelector, useStore } from '#redux';

import { BankIcon } from './BankIcon';
import { initialChainContext, nextChainField } from './chain-mode';
import type { ChainContext } from './chain-mode';
import { DetailField } from './DetailField';
import { EDITOR_FOR_ACTION } from './editor-mode';
import type { EditorMode } from './editor-mode';
import { isOverridableHeld } from './held-rows';
import { HelpOverlay } from './HelpOverlay';
import { HintStrip } from './HintStrip';
import { KeyCap } from './KeyCap';
import {
  actionForHotkey,
  CLOSING_ACTIONS,
  GLOBAL_ACTIONS,
  KEYMAP,
  REVIEW_SCOPE,
  TRUST_LEVELS,
} from './keymap';
import type { ReviewAction } from './keymap';
import { LeaveImportModal } from './LeaveImportModal';
import { OwnershipRow } from './OwnershipRow';
import { ReviewColumns } from './review-columns';
import { REVIEW_TITLE_ID, ReviewHeader, trustLevelLabel } from './ReviewHeader';
import { ReviewProgress } from './ReviewProgress';
import { RowEditor } from './RowEditor';
import { describeRule } from './rule-descriptions';
import {
  editChangesRuledField,
  RULED_FIELD_FOR_MODE,
  visibleEffectFor,
  visibleEffectsFor,
} from './rule-effects';
import type { RuledField, RuleEffect } from './rule-effects';
import { RuledCell, useClearedByRuleLabel } from './RuledCell';
import { RulePicker } from './RulePicker';
import type { RulePickerItem } from './RulePicker';
import { newRuleSeed, rulesForRow } from './rules';
import type { ReviewRule } from './rules';
import { readSession } from './session';
import type { ImportReviewSession } from './session';
import { SplitPane } from './SplitPane';
import { StatusChip } from './StatusChip';
import { TransferPane } from './TransferPane';
import { useImportReview } from './use-import-review';
import { storageKey, useImportSession } from './use-import-session';
import { ZoneLabel, ZoneSubhead } from './ZoneLabel';

/**
 * The detail region's height, in pixels.
 *
 * A fixed height, not a maxHeight: the detail is a dedicated region whose
 * size must not depend on what the selected row happens to contain. If it
 * shrank for a clean row and grew for a flagged one, moving the cursor
 * would make the whole layout jump. A row with more to say scrolls inside
 * one of the two columns instead.
 */
const DETAIL_HEIGHT = 312;

/** The hairline that separates the status line's number pairs. */
function StatusSeparator() {
  return (
    <View
      style={{
        width: 1,
        height: 16,
        flexShrink: 0,
        backgroundColor: theme.tableBorder,
      }}
    />
  );
}

export type ImportPageProps = {
  /**
   * The account to import into, when the page was reached through an
   * account's convenience "Import" button. When absent, the user picks an
   * account on the page.
   */
  accountId?: string | undefined;
  /** The file chosen by the caller, if any. */
  filename?: string | undefined;
  /**
   * The saved review to pick up, instead of a file.
   *
   * A session holds the rows that were already parsed, so there is no
   * file to read: the review continues where it was left.
   */
  session?: ImportReviewSession | undefined;
};

/**
 * The badge in the status column.
 *
 * The ICON carries the state and the WORD says it exactly: "Skipped" is
 * the trust level holding a row back, and no other word says that.
 *
 * The colours are the app's own semantic tokens, taken the way the app's
 * own status badge takes them (`schedules/StatusBadge.tsx`): the DARKER
 * variant of each, because the lighter one does not clear WCAG AA on the
 * modal's background in the light theme — orange700 is 2.86:1 on white.
 */
type GateBadge = {
  label: string;
  tone: 'error' | 'warning' | 'success' | 'muted';
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

/**
 * The colour a badge's tone wears.
 *
 * **Red means "this row will not import as-is."** Both the blocked rows
 * and the skipped ones wear it, because that is the fact the user needs
 * before anything else: the gate is holding this row back. The ICON says
 * which kind — a cross for the data being broken, a pause for the trust
 * level holding it — and the word says it exactly. Amber means "it will
 * import, but look at it".
 *
 * The tokens are the app's own semantic ones, taken the way the app's own
 * status badge takes them (`schedules/StatusBadge.tsx`): the DARKER
 * variant of each, because the lighter one does not clear WCAG AA on the
 * modal's background in the light theme — orange700 is 2.86:1 on white.
 *
 * The DROPPED badge wears the plain ink rather than a muted grey. A muted
 * grey that clears AA does not exist in the app's palette, and the word is
 * a state the user has to read: `pageTextSubdued` is 2.15:1 on white. The
 * STRIKE-THROUGH carries the "gone" instead of a colour.
 */
function badgeColour(tone: GateBadge['tone']): string {
  switch (tone) {
    case 'error':
      return theme.errorTextDarker;
    case 'warning':
      return theme.warningTextDark;
    case 'success':
      return theme.noticeText;
    case 'muted':
    default:
      return theme.pageText;
  }
}

/**
 * What the pane below the table is showing.
 *
 * The editor, the split editor, the transfer editor, the help overlay and
 * the confirmation are the same pane: they cannot both be open, because
 * there is only one keyboard and only one of them may have it.
 */
type PaneMode =
  | { kind: 'editor'; field: EditorMode; chain?: ChainContext }
  | { kind: 'split' }
  | { kind: 'transfer' }
  | { kind: 'help' }
  | { kind: 'rules'; items: readonly RulePickerItem[] }
  | null;

/**
 * The keyboard-driven import review, as a standalone page.
 *
 * The page owns its own hotkey scope and disables the `app` scope while it
 * is open, so the bindings below never fire the app-level shortcuts. See
 * the scope effects below — they replace what the `Modal` wrapper used to
 * provide when the review was a modal.
 */
export function ImportPage({
  accountId: callerAccountId,
  filename: callerFilename,
  session: callerSession,
}: ImportPageProps) {
  const { t } = useTranslation();
  const { atLeastMediumWidth } = useResponsive();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { clear: clearSession } = useImportSession();
  const [budgetId] = useMetadataPref('id');

  // The account and file can arrive as query params from an account's
  // convenience Import button. On a `resume` navigation the saved review is
  // read synchronously from localStorage, so the page mounts with the rows
  // already in hand and the hook never tries to re-read the (now stale)
  // upload path.
  const isResume = searchParams.get('resume') === '1';
  const resumedSession = useMemo(() => {
    if (!isResume || !budgetId) return undefined;
    try {
      return readSession(window.localStorage.getItem(storageKey(budgetId)));
    } catch {
      return undefined;
    }
  }, [isResume, budgetId]);
  const session = callerSession ?? resumedSession;
  const accountId =
    callerAccountId ?? searchParams.get('account') ?? session?.accountId ?? '';
  const filename =
    callerFilename ?? searchParams.get('file') ?? session?.filename ?? '';

  // A bare `/import` (the canonical entry) has no account or file yet.
  // Show a small setup screen: pick the account, choose a file, then carry
  // both in the URL so the review loads exactly as it does from an account
  // page's convenience button.
  const { data: allAccounts = [] } = useAccounts();
  const openAccounts = allAccounts.filter(acc => !acc.closed);
  const needsSetup = !session && (!filename || !accountId);
  const [setupAccount, setSetupAccount] = useState(
    () => accountId || openAccounts[0]?.id || '',
  );
  // `useAccounts` is a react-query hook: on a cold load `data` is undefined
  // until the list resolves, so the initial state above can be empty. Keep
  // the selection in step with the loaded accounts.
  useEffect(() => {
    if (!setupAccount && openAccounts[0]) {
      setSetupAccount(openAccounts[0].id);
    }
  }, [setupAccount, openAccounts]);
  const chooseFile = async () => {
    // Fall back to the first account in case the effect has not run yet.
    const target = setupAccount || openAccounts[0]?.id;
    if (!target) return;
    try {
      const res = await window.Actual.openFileDialog({
        filters: [
          {
            name: t('Financial files'),
            extensions: ['qif', 'ofx', 'qfx', 'csv', 'tsv', 'xml'],
          },
        ],
      });
      if (res?.[0]) {
        void navigate(
          `/import?account=${encodeURIComponent(target)}&file=${encodeURIComponent(res[0])}`,
          { replace: true },
        );
      }
    } catch {
      setNotice(t('The file could not be opened.'));
    }
  };

  // Each column owns its scroll at desktop widths; on a narrow window the
  // pair stacks and the outer box takes the single scrollbar instead.
  const detailColumnStyle = atLeastMediumWidth
    ? {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto' as const,
        scrollbarGutter: 'stable' as const,
        gap: 4,
        paddingTop: 12,
        paddingBottom: 12,
      }
    : { flexShrink: 0, gap: 4, paddingTop: 12, paddingBottom: 12 };
  const format = useFormat();
  const locale = useLocale();
  const dispatchModal = useDispatch();
  /**
   * Leave the review page.
   *
   * On a page there is no modal stack to remove from. Leaving means going
   * back to where the user came from: the account they imported into when
   * there is one, otherwise the previous page. Any modal that was pushed on
   * top of the review (the rule editor, or a merge-payees prompt) is closed
   * by `Modals.tsx` on the route change.
   */
  const closeReview = useCallback(() => {
    if (accountId) void navigate(`/accounts/${accountId}`);
    else void navigate(-1);
  }, [accountId, navigate]);
  const review = useImportReview({
    accountId,
    filename,
    session,
  });
  const { enableScope, disableScope } = useHotkeysContext();

  // The page owns the review's hotkey scope. The Modal wrapper used to do
  // this when the review was a modal; on a page we do it ourselves.
  useEffect(() => {
    if (needsSetup) return;
    enableScope(REVIEW_SCOPE);
    return () => disableScope(REVIEW_SCOPE);
  }, [enableScope, disableScope, needsSetup]);

  /**
   * Is upstream's rule editor open on top of the review?
   *
   * It is read from the MODAL STACK, not from local state: the editor can
   * be closed with its own X button, which fires no callback of the
   * review's, and a local flag would stay true and leave the review's
   * hotkeys switched off for good.
   */
  const isEditingRule = useSelector(state =>
    state.modals.modalStack.some(modal => modal.name === 'edit-rule'),
  );

  // The pane below the table: the editor for a field, the split editor,
  // the help, or the confirmation.
  const [pane, setPane] = useState<PaneMode>(null);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
  // When an apply pushes another modal (e.g. "merge unused payees"), leave
  // the review hidden but stay on the page: navigating would close that
  // modal through `Modals.tsx` and lose the user's pending question.
  const [hideAfterApply, setHideAfterApply] = useState(false);
  const store = useStore();
  const stackedModalCount = useSelector(
    state => state.modals.modalStack.length,
  );
  useEffect(() => {
    // An apply that raised a question (e.g. merge unused payees) kept the
    // route in place so `Modals.tsx` would not close it. Once that question
    // is answered, go back to the account with the imported transactions.
    if (hideAfterApply && stackedModalCount === 0) closeReview();
  }, [hideAfterApply, stackedModalCount, closeReview]);
  const afterApply = useCallback(
    (didChange: boolean) => {
      if (!didChange) return;
      // Read the stack NOW: the apply may have pushed a question (e.g.
      // merge unused payees) that must survive the review going away.
      if (store.getState().modals.modalStack.length > 0) {
        setHideAfterApply(true);
      } else {
        closeReview();
      }
    },
    [store, closeReview],
  );

  // The `Why?` disclosure belongs to the row under the cursor. It closes
  // when the cursor moves, so an explanation of one row is never left
  // hanging over another.
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => setWhyOpen(false), [review.focusedIndex]);

  // A row can be touched by many rules. Only the first two lines show by
  // default; the rest sit behind a disclosure so the Rules zone cannot
  // push the actions off screen. Like `whyOpen`, it belongs to the row
  // under the cursor and closes when the cursor moves.
  const [rulesOpen, setRulesOpen] = useState(false);
  useEffect(() => setRulesOpen(false), [review.focusedIndex]);

  // The list's floor is measured, not a pixel constant: three rows plus
  // the sticky header, at whatever size this font, zoom and locale actually
  // render. Measure the BORDER box — the rows carry vertical padding, and
  // a content-box read would come up short by exactly that padding.
  const headerElRef = useRef<HTMLDivElement | null>(null);
  const captionElRef = useRef<HTMLDivElement | null>(null);
  // Every row gets a ref: the first one is measured for the list's floor,
  // and the focused one is scrolled into view when the cursor moves.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [captionHeight, setCaptionHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);

  // A pane owns the keyboard while it is up. When it closes, the focus
  // has to come back to the grid or the user is typing into a button
  // that is no longer there.
  const gridRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const paneWasOpenRef = useRef(false);
  const pendingGridRefocusRef = useRef(false);

  /**
   * Give the keyboard back to the grid.
   *
   * The grid owns the review's keys. A control that acted hands the
   * keyboard back, so the row keys work again straight away.
   *
   * The scroll is not moved: the user's pointer may be over a row
   * action, and a scroll would take the target out from under it.
   */
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  // As a modal the review trapped Tab inside the dialog. On a page, Tab
  // would otherwise walk out into the sidebar while a row is under the
  // cursor. Wrap focus at the shell's edges, but stand down while a pane
  // or a stacked modal owns the keyboard.
  const onShellKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'Tab' ||
      pane !== null ||
      isEditingRule ||
      leaveModalOpen
    ) {
      return;
    }
    const shell = shellRef.current;
    if (!shell) return;
    const focusable = Array.from(
      shell.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Why the last thing the user asked for did not happen.
  //
  // It is shown next to the pane rather than in it, because the pane it
  // belongs to may not even be open: a row that cannot be split is
  // refused before the pane opens.
  const [notice, setNotice] = useState<string | null>(null);

  // The date, in the app's own format.
  //
  // The review shows dates the way the rest of Actual shows them, so the
  // row reads like the transactions table. An impossible date is shown as
  // it is: the review flags it, and the user has to see WHAT is wrong.
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const reviewDate = (date: string): string => {
    const parsed = parseISO(date);
    if (Number.isNaN(parsed.getTime())) return date;
    return formatDate(parsed, dateFormat);
  };

  // The detail panel spells the month out ("September 04, 2026") where the
  // list keeps the compact MM/dd/yyyy. It follows the user's locale, like
  // the rest of Actual's long dates, while the list stays in the budget's
  // own date format so the two read consistently with their surroundings.
  // An impossible date is still shown as-is: the review flags it, and the
  // user has to see WHAT is wrong rather than a silently repaired value.
  const reviewDateLong = (date: string): string => {
    const parsed = parseISO(date);
    if (Number.isNaN(parsed.getTime())) return date;
    return formatDate(parsed, 'MMMM dd, yyyy', { locale });
  };

  // The row's own commands are framed chips, the way the mockup draws
  // them: a border, the table's header surface and the page's ink. They
  // are secondary to the Import button, so they wear the table's tokens
  // rather than the button's default surface.
  //
  // These go in a CLASS, not an inline style: an inline style would also
  // beat the button's hover and disabled rules, leaving the chips with
  // no hover colour and a disabled chip that looked enabled.
  const actionButtonClass = css({
    backgroundColor: theme.tableHeaderBackground,
    borderColor: theme.tableBorder,
    color: theme.pageText,
    '&[data-hovered]': { backgroundColor: theme.buttonNormalBackgroundHover },
    '&[data-disabled]': {
      backgroundColor: theme.buttonNormalDisabledBackground,
      borderColor: theme.buttonNormalDisabledBorder,
      color: theme.buttonNormalDisabledText,
    },
  });

  /** The gate's outcome, in the user's words. */
  const gateLabel = (gate: RowGate): string => {
    switch (gate) {
      case 'block':
        return t('Blocked');
      case 'skip':
        return t('Skipped');
      case 'warn':
        return t('Flagged');
      default:
        return t('Allowed');
    }
  };

  // The badge says what the gate is doing with the row. A row the gate
  // holds back is badged with the reason it is held back, not with a
  // generic "problem", because the two need different things from the
  // user: a held row can be overridden, a flagged one only needs a look.
  //
  // A dropped row is badged as dropped: the user threw it away, which is a
  // stronger statement than the gate, and badging it "Blocked" would say
  // the opposite of what happened to it.
  //
  // The GATE decides, except that a dropped row is final: a row the user
  // threw away is badged as dropped whatever the gate said. Everywhere
  // else the gate's word comes first and the user's decision is the
  // fallback: a row the user accepted and the trust level flagged is
  // still flagged, because the flag is the safety fact and the decision
  // is the user's.
  const gateBadge = (
    row: { decision: string },
    evaluation: RowEvaluation,
  ): GateBadge | null => {
    if (row.decision === 'drop') {
      return { label: t('Dropped'), tone: 'muted', Icon: SvgClose };
    }
    // An override that is in EFFECT. A hard-blocked row the user tried to
    // override is still blocked, so it is badged as blocked, the same way
    // the summary counts it.
    if (evaluation.overridden && evaluation.willImport) {
      return { label: t('Overridden'), tone: 'warning', Icon: SvgFlag };
    }
    if (evaluation.gate === 'block') {
      return {
        label: gateLabel(evaluation.gate),
        tone: 'error',
        Icon: SvgBlock,
      };
    }
    if (evaluation.gate === 'skip') {
      return {
        label: gateLabel(evaluation.gate),
        tone: 'error',
        Icon: SvgPause,
      };
    }
    if (evaluation.gate === 'warn') {
      return {
        label: gateLabel(evaluation.gate),
        tone: 'warning',
        Icon: SvgFlag,
      };
    }
    // The user's own decision, on a row the gate has nothing to say about.
    if (row.decision === 'accept') {
      return { label: t('Accepted'), tone: 'success', Icon: SvgCheckmark };
    }
    return null;
  };

  /**
   * The badge in the status column.
   *
   * An icon and a word. The icon is the state at a glance — a shape the
   * user can see without reading — and the word says it exactly.
   */
  const renderStatusBadge = (badge: GateBadge | null) => {
    if (!badge) return null;
    const { Icon } = badge;
    const colour = badgeColour(badge.tone);
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 4,
        }}
      >
        {/* The icon is DECORATIVE: the word beside it says the state,
            and a screen reader should not be offered a nameless
            graphic as well. */}
        <Icon
          width={14}
          height={14}
          aria-hidden="true"
          style={{ color: colour }}
        />
        <TextOneLine
          style={{
            color: colour,
            // A dropped row is struck through: the word says it, and the
            // strike says it without needing a colour to say it with.
            textDecoration: badge.tone === 'muted' ? 'line-through' : undefined,
          }}
          title={badge.label}
        >
          {badge.label}
        </TextOneLine>
      </View>
    );
  };

  // The payee names, for the same reason as the category names: a rule
  // that sets the payee sets an ID, and the cell shows the NAME.
  const payeeNames = useMemo(
    () => new Map(review.payees.map(payee => [payee.id, payee.name])),
    [review.payees],
  );

  // The category names, looked up once: the table renders a cell for
  // every row, and finding the name in a list each time is a search per
  // row per render.
  const categoryNames = useMemo(
    () =>
      new Map(review.categories.map(category => [category.id, category.name])),
    [review.categories],
  );

  // The category groups, for the same reason. Two categories with the
  // same name in different groups are indistinguishable in the table,
  // so the cell carries the group with the name.
  const categoryGroupNames = useMemo(
    () =>
      new Map(
        review.categories
          .filter(
            (category): category is ReviewCategory & { groupName: string } =>
              typeof category.groupName === 'string' &&
              category.groupName !== '',
          )
          .map(category => [category.id, category.groupName]),
      ),
    [review.categories],
  );

  // The account names, for the same reason: a transfer row shows the
  // account it transfers to.
  const accountNames = useMemo(
    () => new Map(review.accounts.map(account => [account.id, account.name])),
    [review.accounts],
  );

  /**
   * What the row's payee cell says.
   *
   * A transfer row says the ACCOUNT the money goes to, the way Actual's
   * own transactions table does: the payee of a transfer is the other
   * account, not the vendor the bank file named.
   *
   * The cell is MUTED when the payee is not SETTLED: either there is no
   * payee behind it at all, or the resolver only guessed one. The
   * category cell has always worked this way — "Categorize" is muted —
   * and a payee cell that shows a guess in normal ink looks like a fact
   * the user can rely on. It is not.
   *
   * The muted colour is the app's own secondary-text token, the same one
   * the category cell's "Categorize" wears. It does not clear WCAG AA on
   * the modal's background in the light theme — no muted grey in the
   * palette does — and the ITALIC is the other cue: the cell says
   * "not settled" in two ways rather than one.
   */
  const payeeCell = (
    row: PreviewRow,
  ): {
    label: string;
    ruled: boolean;
    cleared: boolean;
    muted: boolean;
  } => {
    // A rule that sets the payee OWNS the cell: the engine's value is
    // what lands, so that is what the cell says.
    const effect = visibleEffectFor(review.ruleEffects, row, 'payee');
    //
    // A rule that CLEARED the payee leaves the row with none, so the
    // cell says nothing — the user's old payee would be a lie, because
    // it is not what lands.
    if (effect) {
      const name =
        effect.value === null
          ? undefined
          : payeeNames.get(String(effect.value));
      return {
        // A rule that set a payee the budget does not have — it was
        // deleted, or the list is stale — falls back to the raw id.
        // The field must never be EMPTY: an empty blue field says the
        // rule cleared the payee, which is a different thing.
        label: name ?? (effect.value === null ? '' : String(effect.value)),
        ruled: true,
        cleared: effect.value === null,
        muted: false,
      };
    }
    // The user chose the payee. It is settled, whatever the resolver
    // thought. An empty or blank choice is not a choice — the same rule
    // the gate's own flags use.
    const chosen = row.edits.payeeCanonical?.trim();

    // A transfer row says the ACCOUNT the money goes to, the way Actual's
    // own transactions table does: the payee of a transfer is the other
    // account, not the vendor the bank file named.
    //
    // A transfer the user has TAKEN AWAY is not a transfer any more, and
    // `effectiveTransferAccountId` says so — the row falls through to the
    // file's string below, which is right: there is no payee behind it.
    const transferAccountId = effectiveTransferAccountId(row);
    if (!chosen && transferAccountId !== undefined) {
      return {
        label: accountNames.get(transferAccountId) ?? t('Transfer'),
        ruled: false,
        cleared: false,
        muted: false,
      };
    }

    // A FUZZY match is a guess: the resolver found a budget payee it
    // thinks is close enough, and the review says so.
    if (!chosen && row.payeeMatchSource === 'fuzzy') {
      return {
        label: row.payeeCanonical,
        ruled: false,
        cleared: false,
        muted: true,
      };
    }

    // A payee the budget HAS is settled.
    //
    // The resolver's sources that mean "the budget has it" are the
    // prefix match and the vendor map. The others — a fuzzy match, the
    // strip fallback's made-up name, nothing at all — do not.
    if (
      chosen ||
      row.payeeMatchSource === 'existing-prefix' ||
      row.payeeMatchSource === 'vendor-map'
    ) {
      return {
        label: chosen ?? row.payeeCanonical,
        ruled: false,
        cleared: false,
        muted: false,
      };
    }

    // And when there is no payee behind the cell at all — the resolver
    // found nothing, or made a name up out of the vendor string — the
    // cell shows the FILE's own string. That is what the file said, and
    // it is what the user would be choosing from; the name the resolver
    // made up ("PURCHASE", out of "POS PURCHASE 4251") is the less
    // recognisable of the two.
    return {
      label: row.payeeRaw,
      ruled: false,
      cleared: false,
      muted: true,
    };
  };

  /**
   * What the row's category cell says.
   *
   * A split row says "Split (N)", the way Actual's own transactions
   * table does: the categories of a split live on its legs, and the
   * parent has none.
   *
   * An ordinary row says its category, or "Categorize" when it has none
   * — the word Actual uses for a transaction that still needs one.
   *
   * The cell is MUTED when it says something other than a category name:
   * a split is a shape, not a place for money to go, and a row that
   * needs a category is a row that is not finished.
   */
  const categoryCell = (
    row: PreviewRow,
  ): {
    label: string;
    group?: string;
    muted: boolean;
    ruled: boolean;
    cleared: boolean;
  } => {
    // A rule that sets the category OWNS the cell: the engine's value is
    // what lands, so that is what the cell says.
    const effect = visibleEffectFor(review.ruleEffects, row, 'category');
    // A rule that CLEARED the category leaves the row with none, so the
    // cell says so — the user's old category would be a lie, because it
    // is not what lands.
    if (effect && !isSplitRow(row.edits)) {
      const id = effect.value === null ? undefined : String(effect.value);
      const name = id ? categoryNames.get(id) : undefined;
      return {
        // A rule that set a category the budget does not have falls back
        // to the raw id, for the same reason the payee does: the field
        // must never be empty, and it must never say "Categorize" as
        // though that were the rule's value.
        label: name ?? id ?? '',
        group: id && name ? categoryGroupNames.get(id) : undefined,
        muted: !name,
        ruled: true,
        // A cleared field has no value at all, so the cell says THAT
        // rather than "Categorize" — which would ask the user for a
        // category the rule has already decided there is none of.
        cleared: effect.value === null,
      };
    }
    if (isSplitRow(row.edits) || row.existingSplitLegs) {
      return {
        // The count is NOT named `count`: i18next reads that as a
        // plural, and this is a number of legs, not a number of
        // something countable. A row that MATCHED a split in the budget
        // says so too: its legs are display context, not edits, but the
        // cell must not claim "Categorize" for a transaction that is a
        // split.
        label: t('Split ({{legs}})', {
          legs: row.edits.splits?.length ?? row.existingSplitLegs?.length ?? 0,
        }),
        muted: true,
        ruled: false,
        cleared: false,
      };
    }
    // A transfer's category is the transfer pseudo-category, not a
    // budget category, so it says "Transfer" the way Actual's own
    // transactions table does.
    if (effectiveTransferAccountId(row) !== undefined) {
      return {
        label: t('Transfer'),
        muted: true,
        ruled: false,
        cleared: false,
      };
    }
    const categoryId = row.edits.categoryId;
    if (!categoryId) {
      return {
        label: t('Categorize'),
        muted: true,
        ruled: false,
        cleared: false,
      };
    }
    const name = categoryNames.get(categoryId);
    // A category that no longer exists is dropped at the apply step, so
    // the row is imported without one: "Categorize" says so.
    if (!name) {
      return {
        label: t('Categorize'),
        muted: true,
        ruled: false,
        cleared: false,
      };
    }
    return {
      label: name,
      group: categoryGroupNames.get(categoryId),
      muted: false,
      ruled: false,
      cleared: false,
    };
  };

  /**
   * What the row's amount cell says.
   *
   * A rule that sets the amount owns the cell: the engine's value is
   * what lands, so that is what the cell says.
   */
  const amountCell = (
    row: PreviewRow,
  ): {
    amount: ReturnType<typeof integerToAmount>;
    /** The raw IntegerAmount, for formatting with the budget's currency. */
    cents: number;
    ruled: boolean;
    cleared: boolean;
  } => {
    const effect = visibleEffectFor(review.ruleEffects, row, 'amount');
    // A rule that sets the amount changes the PARENT, split row or not:
    // the engine writes the rule's amount, and the legs then no longer
    // add up to it. The cell shows what will land.
    if (effect) {
      if (typeof effect.value === 'number') {
        return {
          amount: integerToAmount(effect.value),
          cents: effect.value,
          ruled: true,
          cleared: false,
        };
      }
      // The rule CONTROLLED the amount and left it empty. The cell says
      // so rather than falling through to the row's own amount, which
      // would be a lie: the rule owns the field.
      return {
        amount: integerToAmount(0),
        cents: 0,
        ruled: true,
        cleared: true,
      };
    }
    const cents = row.edits.amountCents ?? row.amountCents;
    return {
      amount: integerToAmount(cents),
      cents,
      ruled: false,
      cleared: false,
    };
  };

  /**
   * What the row's date cell says.
   *
   * A rule that sets the date owns the cell, the same way the payee and
   * the category do.
   */
  const dateCell = (
    row: PreviewRow,
  ): {
    date: string;
    /** The effective raw `yyyy-MM-dd`, for the detail's long format. */
    raw: string;
    ruled: boolean;
    cleared: boolean;
  } => {
    const effect = visibleEffectFor(review.ruleEffects, row, 'date');
    if (effect) {
      if (typeof effect.value === 'string') {
        return {
          date: reviewDate(effect.value),
          raw: effect.value,
          ruled: true,
          cleared: false,
        };
      }
      // The rule CONTROLLED the date and left it empty. The cell says so
      // rather than falling through to the row's own date, which would be
      // a lie: the rule owns the field.
      return { date: '', raw: '', ruled: true, cleared: true };
    }
    const raw = row.edits.date ?? row.date;
    return {
      date: reviewDate(raw),
      raw,
      ruled: false,
      cleared: false,
    };
  };

  // Why a row is flagged, in the user's terms. The code beside it is the
  // greppable one, for support.
  const flagReason = (kind: FlagKind): string => {
    switch (kind) {
      case 'unknown-payee':
        return t('No payee in your budget matches this vendor');
      case 'amount-mismatch':
        // The reason describes the ROW, not where the problem came from:
        // the flag is derived from the value that would be sent, so it may
        // be the file's fault or an edit's.
        return t('This row has no usable amount');
      case 'date-out-of-range':
        return t('This row has no usable date');
      case 'duplicate':
        return t('This transaction repeats an earlier one');
      case 'fuzzy-payee-match':
        return t('The payee was a fuzzy match, not an exact one');
      case 'would-create-payee':
        return t('This import will create a new payee');
      case 'transfer-detected':
        return t('This looks like a transfer');
      case 'transfer-suspected':
        return t('This looks like a transfer from another account');
      case 'transfer-ambiguous':
        return t(
          'Several transfers of this amount recently went to this account. This row may already be here — check before importing.',
        );
      default:
        return t('This row needs a look');
    }
  };

  const rows = review.state?.rows ?? [];

  // A layout effect reads the boxes BEFORE the first paint, so a short
  // screen never flashes an oversized list. Watching the grid catches zoom
  // and font changes; the row-count dependency re-reads when a new first
  // row is mounted. A row that re-resolves to a different size is observed
  // too.
  useLayoutEffect(() => {
    const measure = () => {
      const nextHeader =
        headerElRef.current?.getBoundingClientRect().height ?? 0;
      const nextCaption =
        captionElRef.current?.getBoundingClientRect().height ?? 0;
      const nextRow = rowRefs.current[0]?.getBoundingClientRect().height ?? 0;
      setHeaderHeight(previous =>
        previous === nextHeader ? previous : nextHeader,
      );
      setCaptionHeight(previous =>
        previous === nextCaption ? previous : nextCaption,
      );
      setRowHeight(previous => (previous === nextRow ? previous : nextRow));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (gridRef.current) observer.observe(gridRef.current);
    if (headerElRef.current) observer.observe(headerElRef.current);
    if (captionElRef.current) observer.observe(captionElRef.current);
    if (rowRefs.current[0]) observer.observe(rowRefs.current[0]);
    return () => observer.disconnect();
  }, [rows.length]);

  const listMinHeight =
    headerHeight > 0 && rowHeight > 0 ? headerHeight + 3 * rowHeight : 0;
  // The panel must not shrink below its caption plus that floor. Without
  // this, `minHeight: 0` lets it collapse and clip the whole list on a
  // short screen, leaving the detail painted in its place.
  const tableMinHeight =
    captionHeight > 0 && listMinHeight > 0 ? captionHeight + listMinHeight : 0;

  // The cursor can move by j/k, g/G, a decision that advances, undo, or
  // a restored session. All of them change `focusedIndex`, so one effect
  // here covers them all instead of each key handler scrolling by hand.
  //
  // Adjust the list's own scrollTop directly rather than calling
  // scrollIntoView: that would also scroll the modal above it, and it
  // knows nothing about the sticky header covering the top of the list.
  // A layout effect keeps a fast j/k from flashing a clipped selection.
  const focusedRowKey =
    rows[review.focusedIndex]?.previewKey ??
    rows[review.focusedIndex]?.importedId ??
    review.focusedIndex;
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const row = rowRefs.current[review.focusedIndex];
    if (!grid || !row) return;

    const rowBox = row.getBoundingClientRect();
    const top = rowBox.top - grid.getBoundingClientRect().top;
    const bottom = top + rowBox.height;
    // The sticky header sits over the top of the scrolling area. The
    // grid has no border or padding, so clientHeight is its visible box.
    const visibleTop = headerHeight;
    const visibleBottom = grid.clientHeight;
    if (top < visibleTop) {
      grid.scrollTop -= visibleTop - top;
    } else if (bottom > visibleBottom) {
      grid.scrollTop += bottom - visibleBottom;
    }

    // The review body scrolls on short screens. If it was scrolled down
    // (to reach the detail's actions, say), moving the cursor must also
    // bring the row back into view — otherwise the selection is still
    // invisible even though the list itself scrolled correctly.
    const body = bodyRef.current;
    if (body) {
      const bodyBox = body.getBoundingClientRect();
      const rowNow = row.getBoundingClientRect();
      if (rowNow.top < bodyBox.top) {
        body.scrollTop -= bodyBox.top - rowNow.top;
      } else if (rowNow.bottom > bodyBox.bottom) {
        body.scrollTop += rowNow.bottom - bodyBox.bottom;
      }
    }
    // A replaced row with the same index is still a new row to reveal.
  }, [review.focusedIndex, rows.length, headerHeight, focusedRowKey]);

  const accountName = (id: string) =>
    accountNames.get(id) ?? t('Unknown account');
  const focused = rows[review.focusedIndex];

  // The facts the EVIDENCE zone shows: the amount that will land, in
  // full (the list's column can truncate it), and the category's group.
  //
  // The amount is the money format the rest of the review uses, so the
  // detail section and the list's column say the same number the same
  // way.
  const focusedAmount = focused ? amountCell(focused) : undefined;
  const clearedByRule = useClearedByRuleLabel();
  // The detail spells the money the way the rest of Actual does: with the
  // budget's symbol and sign rules, rather than the list's bare number.
  const focusedAmountLabel = focusedAmount
    ? focusedAmount.cleared
      ? clearedByRule
      : format(focusedAmount.cents, 'financial')
    : undefined;
  const focusedAmountColor = focusedAmount?.cleared
    ? undefined
    : focusedAmount
      ? focusedAmount.cents > 0
        ? theme.numberPositive
        : focusedAmount.cents < 0
          ? theme.numberNegative
          : theme.pageTextSubdued
      : undefined;
  // The rest of the Evidence zone: the facts the LIST has already shown,
  // collected here so the row can be read in one place. The group is not
  // its own fact — it belongs to the category, the way the mockup writes
  // "Food · Usual Expenses" — so it is folded into that field's value.
  const focusedDateCell = focused ? dateCell(focused) : undefined;
  // The detail's date spells the month out where the list stays compact.
  const focusedDateLabel = focusedDateCell
    ? focusedDateCell.cleared
      ? clearedByRule
      : reviewDateLong(focusedDateCell.raw)
    : '';
  const focusedPayeeCellValue = focused ? payeeCell(focused) : undefined;
  const focusedCategoryValue = focused ? categoryCell(focused) : undefined;
  // A category that a rule CLEARED says so; otherwise its name shows. The
  // group is folded in by the JSX below, where the separator lives, so
  // there is only one place that writes "Food · Usual Expenses".
  const focusedCategoryLabel = focusedCategoryValue
    ? focusedCategoryValue.cleared
      ? clearedByRule
      : focusedCategoryValue.label
    : '';

  const focusedEvaluation = focused
    ? review.evaluations.get(rowKey(focused))
    : undefined;

  /**
   * Whether the row is flagged about its AMOUNT.
   *
   * The amount is the last field of the chain, and it is only worth a
   * stop when something is wrong with it — so the chain includes it
   * only when the row carries this flag.
   *
   * These are the EFFECTIVE flags: the ones the gate acts on, after the
   * user's own edits, not the ones the file came with.
   */
  const hasAmountFlag = useMemo(
    () =>
      focusedEvaluation?.flags.some(flag => flag.kind === 'amount-mismatch') ??
      false,
    [focusedEvaluation],
  );

  // The notes the row would be imported with. An empty string means the
  // user cleared them, so there is nothing to show.
  const focusedMemo = focused ? (focused.edits.memo ?? focused.memo ?? '') : '';

  /**
   * The rule effects that apply to a row.
   *
   * The review asks the engine what the rules did, so this is the
   * engine's answer, not the fork's guess. A field in here is one the
   * user cannot change: the rule's value lands whatever they type.
   *
   * A SPLIT row's CATEGORY is the exception, and that rule lives in ONE
   * place — `visibleEffectsFor` — so the cells and the pane cannot drift
   * apart.
   */
  const effectsForRow = useCallback(
    (row: PreviewRow): RuleEffect[] =>
      visibleEffectsFor(review.ruleEffects, row),
    [review.ruleEffects],
  );

  /**
   * The rules that control a field of the FOCUSED row.
   */
  const focusedEffects = useMemo<readonly RuleEffect[]>(
    () => (focused ? effectsForRow(focused) : []),
    [effectsForRow, focused],
  );

  // One line per field a rule controls. Shared by the two and the "more"
  // halves of the Rules zone so both render the same sentence.
  const renderRuleLine = (effect: RuleEffect) => {
    const rule = review.rules.find(candidate => candidate.id === effect.ruleId);
    const described = rule
      ? describeRule(rule, { payeeNames, categoryNames })
      : undefined;
    return (
      <OwnershipRow
        key={effect.field}
        field={effect.field}
        label={ruledFieldName(effect.field)}
        fieldTestId="import-review-ruled-field"
        fieldNameTestId="import-review-ruled-field-name"
        description={t('set by {{rule}}', {
          rule: described
            ? t('rule "{{description}}"', {
                description: `${described.from} → ${described.to}`,
              })
            : t('a rule in this budget'),
        })}
      />
    );
  };

  /**
   * The rule that controls the field the editor is open on.
   *
   * `undefined` when no rule controls it, and when there is no editor
   * open at all.
   */
  const focusedLockedEffect = useMemo<RuleEffect | undefined>(() => {
    if (!focused || pane?.kind !== 'editor') return undefined;
    return visibleEffectFor(
      review.ruleEffects,
      focused,
      RULED_FIELD_FOR_MODE[pane.field],
    );
  }, [focused, pane, review.ruleEffects]);

  /**
   * The id of the payee the user's edit names.
   *
   * The picker gives the id of the payee it matched. When it matched
   * none — the user typed the name — the budget's payee list is asked
   * instead: the user may have typed the name of a payee that IS in the
   * budget, and that is not a change.
   */
  const editedPayeeId = (
    edits: PreviewEdits,
    chosenPayeeId: string | undefined,
  ): string | undefined => {
    if (chosenPayeeId) return chosenPayeeId;
    const name = edits.payeeCanonical;
    if (!name) return undefined;
    const wanted = name.trim().toLowerCase();
    return review.payees.find(
      payee =>
        !payee.transferAcct && payee.name.trim().toLowerCase() === wanted,
    )?.id;
  };

  /**
   * The rule effects on the focused row, by field.
   *
   * The details pane uses this to decide which of its rule-creation
   * buttons to offer: a field a rule already controls is not offered a
   * new rule, because the rule is already there — Shift+E opens it in
   * the rule picker.
   */
  const focusedRuledFields = useMemo(() => {
    const fields = new Set<RuledField>();
    for (const effect of focusedEffects) {
      fields.add(effect.field);
    }
    return fields;
  }, [focusedEffects]);

  /**
   * The chain's next field, and the plan it belongs to.
   *
   * The plan is rebuilt from the row as it is NOW: a commit can change
   * what the row needs — giving a transfer row a payee makes it an
   * ordinary transaction, and an ordinary transaction needs a category.
   *
   * `undefined` means the chain is over: the field the user is on is the
   * last one.
   */
  const advanceChain = useCallback(
    (current: EditorMode, row: PreviewRow) => {
      const chain = initialChainContext(row, focusedRuledFields, hasAmountFlag);
      const next = nextChainField(current, chain, row, focusedRuledFields);
      return next ? { field: next, chain } : undefined;
    },
    [focusedRuledFields, hasAmountFlag],
  );

  /**
   * The rules that control a field of the focused row, by id.
   *
   * Two rules can control two fields of the same row, and each of them
   * has to be openable in its own right.
   */
  const focusedRuleIds = useMemo(
    () => [...new Set(focusedEffects.map(effect => effect.ruleId))],
    [focusedEffects],
  );

  /**
   * The amount a rule controls on the focused row, if one does.
   *
   * The split pane's legs have to add up to the amount the row will
   * hold, and a rule's amount is that amount.
   */
  const focusedRuledAmount = useMemo(() => {
    if (!focused) return undefined;
    const effect = visibleEffectFor(review.ruleEffects, focused, 'amount');
    return typeof effect?.value === 'number' ? effect.value : undefined;
  }, [focused, review.ruleEffects]);

  /**
   * The name of a field, in the user's words.
   *
   * The review edits the MEMO; the transaction calls it `notes`. The
   * details panel speaks the review's language.
   */
  function ruledFieldName(field: RuledField): string {
    switch (field) {
      case 'payee':
        return t('payee');
      case 'category':
        return t('category');
      case 'amount':
        return t('amount');
      case 'date':
        return t('date');
      case 'notes':
        return t('notes');
      default:
        return field;
    }
  }

  // Shared by the picker's create item and the inline button: both write
  // the same transfer rule, so both say the same thing when it lands.
  const transferRuleCreatedMessage = t(
    'Rule created. This vendor will be a transfer from now on when imported into this account.',
  );

  // The rules the focused row could have.
  //
  // A rule is offered only when it can be written truthfully: the
  // vendor rule needs a vendor string and a payee, and the category
  // rule needs a payee BY ID — that is what its condition matches on.
  const focusedRules = useMemo(
    () =>
      focused
        ? rulesForRow(focused, review.payees, review.categories)
        : undefined,
    [focused, review.categories, review.payees],
  );

  /**
   * What the rule picker offers.
   *
   * The rules that touched this row, each with the field it owns, and the
   * rules the row could grow.
   *
   * **The field is the rule's identity on this row.** Per field there is
   * exactly one owner — the last rule to act wins — so the field is what
   * tells two rules on one row apart.
   */
  const rulePickerItems: readonly RulePickerItem[] = (() => {
    if (!focused) return [];
    const items: RulePickerItem[] = [];

    for (const ruleId of focusedRuleIds) {
      const rule = review.rules.find(candidate => candidate.id === ruleId);
      // The rule is not in the budget's list — it was made on another
      // device, or the list is stale. There is nothing to open.
      if (!rule) continue;
      const field = focusedEffects.find(
        effect => effect.ruleId === ruleId,
      )?.field;
      const described = describeRule(rule, { payeeNames, categoryNames });
      items.push({
        kind: 'edit',
        id: `rule-${ruleId}`,
        field,
        fieldLabel:
          focusedEffects
            .filter(effect => effect.ruleId === ruleId)
            .map(effect => ruledFieldName(effect.field))
            .join(', ') || undefined,
        description: described
          ? `${described.from} → ${described.to}`
          : t('a rule in this budget'),
        ruleId,
      });
    }

    if (focusedRules?.toTransfer) {
      // The rule sets the target account's hidden transfer payee id. That
      // payee's NAME is empty, so the human-readable target comes from the
      // accounts list, looked up through the transfer account id on the
      // matching payee.
      const transferPayeeId = focusedRules.toTransfer.actions.find(
        action => action.op === 'set' && action.field === 'payee',
      )?.value;
      const transferAccountId = review.payees.find(
        payee => payee.id === transferPayeeId,
      )?.transferAcct;
      const targetName = review.accounts.find(
        account => account.id === transferAccountId,
      )?.name;
      items.push({
        kind: 'create',
        id: 'new-transfer-rule',
        description: targetName
          ? t('always transfer to {{account}} in this account', {
              account: targetName,
            })
          : t('always transfer this vendor in this account'),
        rule: focusedRules.toTransfer,
        message: transferRuleCreatedMessage,
      });
    }
    if (focusedRules?.vendorToPayee) {
      items.push({
        kind: 'create',
        id: 'new-vendor-to-payee',
        description: t('always this payee for this vendor'),
        rule: focusedRules.vendorToPayee,
        message: t(
          'Rule created. This vendor will always use this payee, from now on.',
        ),
      });
    }
    if (focusedRules?.payeeToCategory) {
      items.push({
        kind: 'create',
        id: 'new-payee-to-category',
        description: t('always this category for this payee'),
        rule: focusedRules.payeeToCategory,
        message: t(
          'Rule created. This payee will always use this category, from now on.',
        ),
      });
    }
    // The escape hatch, on every focused row even when neither of the
    // row-derived rules can be offered. It is last so the picker opens on
    // the rules that touched the row, not on a blank editor.
    items.push({
      kind: 'new',
      id: 'create-new-rule',
      description: t('Add new rule'),
    });

    return items;
  })();

  /**
   * Open a rule in upstream's own editor.
   *
   * Both an existing rule and a blank one go through here, so the review
   * keeps one way of stacking the editor and one way of hearing about its
   * save. When the rule lands, the review asks the engine again so the row
   * shows the rule's NEW effect.
   */
  const openRuleInModal = (rule: RuleEntity | NewRuleEntity) => {
    dispatchModal(
      pushModal({
        modal: {
          name: 'edit-rule',
          options: {
            rule,
            onSave: async () => {
              await review.refreshRuleEffects();
            },
          },
        },
      }),
    );
  };

  const openRuleEditor = (ruleId: string) => {
    const rule = review.rules.find(candidate => candidate.id === ruleId);
    // The rule is not in the budget's list — it was made on another
    // device, or the list is stale. There is nothing to open.
    if (!rule) {
      setNotice(t('That rule is not in this budget any more.'));
      return;
    }
    openRuleInModal(rule);
  };

  // A rule the review cannot prefill: hand the user upstream's editor with
  // a blank seed. This deliberately does NOT go through `review.createRule`
  // — that path amends a rule with the same conditions, which would silently
  // rewrite an existing rule of the user's instead of making a new one.
  const openNewRuleEditor = () => openRuleInModal(newRuleSeed());

  // A rule is being written. The buttons are disabled while it is, so a
  // second click cannot write the same rule twice.
  const [creatingRule, setCreatingRule] = useState(false);

  /**
   * Write a rule, and say what it does.
   *
   * There is no confirmation. The fork never confirms a durable action
   * — not accept-all, not drop-all, not routing a row into another
   * account — and a rule is no more destructive than any of those: it
   * says exactly what it does, the details pane says so before the
   * click, and the notice says it again after.
   */
  const createRule = async (rule: ReviewRule | undefined, message: string) => {
    if (!rule || creatingRule) return;
    setCreatingRule(true);
    try {
      const outcome = await review.createRule(rule);
      setNotice(
        outcome === 'created'
          ? message
          : outcome === 'created-stale'
            ? t(
                'The rule was created, but the review could not be refreshed. It will show the change the next time it opens.',
              )
            : outcome === 'unchanged'
              ? t('That rule already says this. Nothing was changed.')
              : outcome === 'busy'
                ? t('Another rule is being written. Nothing was changed.')
                : t('The rule could not be created. Nothing was changed.'),
      );
    } finally {
      setCreatingRule(false);
    }
  };

  /**
   * What the user chose in the rule picker.
   *
   * An existing rule, or a blank one, opens upstream's editor; one of the
   * row-derived rules is written here, and the review says what it did.
   */
  const pickRuleItem = (item: RulePickerItem) => {
    // The write is guarded in `createRule`, but closing the pane first
    // would leave the user with a closed pane and no word about why
    // nothing happened. Say it here, and leave the pane open.
    if (item.kind === 'create' && creatingRule) {
      setNotice(t('Another rule is being written. Nothing was changed.'));
      return;
    }
    openPane(null);
    if (item.kind === 'new') {
      openNewRuleEditor();
      return;
    }
    if (item.kind === 'create') {
      void createRule(item.rule, item.message);
      return;
    }
    openRuleEditor(item.ruleId);
  };

  // The live payee names, so the trust-level chips below agree with the
  // badges: both have to answer the same question about the same row.
  const livePayeeNames = useMemo(
    () => new Set(review.payees.map(p => normalizePayeeName(p.name))),
    [review.payees],
  );

  // What the gate does to the focused row at the CURRENT trust level. The
  // detail says this in words; the header says it as a control.
  const currentGate = focused
    ? gateRow(focused, review.trustLevel, { livePayeeNames })
    : undefined;

  // The verdict wears the TEXT token for its outcome — a coloured word,
  // not a coloured surface. Red means "will not import", amber "look at
  // this", green "goes through". The word itself always says the same
  // thing, so colour is reinforcement rather than the only signal.
  const verdictColor = (gate: RowGate | undefined) => {
    switch (gate) {
      case 'block':
        return theme.errorText;
      case 'skip':
      case 'warn':
        return theme.warningTextDark;
      case 'allow':
        return theme.numberPositive;
      default:
        return undefined;
    }
  };

  /**
   * Close the review for good, throwing away whatever is in it.
   *
   * This is the only way to close the review WITHOUT applying it: the
   * escape binding and the X button both come through `requestClose`, so
   * both ask first when there is something to ask about.
   */
  const confirmClose = () => {
    review.close();
    closeReview();
  };

  /** Persist the review, then leave the page. Returns false on failure. */
  const saveAndLeave = (): boolean => {
    // saveSession refuses an oversized session; in that case it is better
    // to stay on the page and say so than to leave with nothing saved.
    if (!review.saveSession()) {
      setNotice(
        t('This review is too big to save. Apply it, or throw it away.'),
      );
      return false;
    }
    setLeaveModalOpen(false);
    closeReview();
    return true;
  };

  /** Throw the review away, clear any saved copy, then leave. */
  const discardAndLeave = (): boolean => {
    review.close();
    clearSession();
    setLeaveModalOpen(false);
    closeReview();
    return true;
  };

  /**
   * Open a pane, clearing whatever notice was showing.
   *
   * A notice belongs to the thing that was refused, so it does not
   * survive into the next thing the user asks for.
   */
  const openPane = (next: PaneMode) => {
    setNotice(null);
    setPane(next);
  };

  /**
   * Close the review, asking first if there is anything to lose.
   *
   * A review the user has not touched has nothing to lose, so it closes
   * straight away; one they have worked on asks first.
   *
   * A draft in the editor does not count: it was never committed, so the
   * review does not know it exists. That is the same rule that makes
   * escape in the editor cancel the edit rather than ask about it.
   */
  const requestClose = () => {
    if (review.unsavedWork.hasWork) {
      setLeaveModalOpen(true);
      return;
    }
    confirmClose();
  };

  /**
   * Do what an action does.
   *
   * The button in the ACTIONS zone and the key do the same thing, the
   * cursor included: the mouse user is working through the queue too.
   */
  const dispatch = (action: ReviewAction) => {
    // A notice belongs to the thing that was refused. It does not
    // survive into the next thing the user does — a refusal about one
    // row must not sit under the cursor while the cursor is on
    // another row.
    setNotice(null);

    switch (action) {
      case 'move-next':
        review.moveFocus(1);
        break;
      case 'move-prev':
        review.moveFocus(-1);
        break;
      case 'move-first':
        review.focus(0);
        break;
      case 'move-last':
        review.focus(Math.max(0, rows.length - 1));
        break;
      case 'accept':
        if (focused) {
          review.decide(review.focusedIndex, 'accept');
          review.moveFocus(1);
        }
        break;
      case 'accept-confirm':
        // Confirms the FOCUSED row. It must not fall through to
        // `accept-all`: the two are different bindings, and bulk-accepting
        // the whole file when the user meant to confirm one row would be
        // very destructive.
        if (focused) {
          review.decide(review.focusedIndex, 'accept');
        }
        break;
      case 'accept-override':
        // Accepts the focused row DESPITE its flags. This is the only
        // decision that survives a stricter trust level, and the only way
        // past a soft block.
        //
        // A hard-blocked row cannot be overridden: its data is broken, and
        // the import would reject it or write it wrong. The row stays
        // where it is — and the user is told, because a keypress that
        // does nothing at all looks like the review is broken.
        if (!focused) break;
        if (!focusedEvaluation?.overridable) {
          setNotice(
            t(
              'This row cannot be accepted: its data is wrong, so it has to be fixed first.',
            ),
          );
          break;
        }
        review.decide(review.focusedIndex, 'accept-override');
        break;
      case 'accept-all':
        review.decideAll('accept');
        break;
      case 'drop':
        if (focused) {
          review.decide(review.focusedIndex, 'drop');
          review.moveFocus(1);
        }
        break;
      case 'drop-all':
        review.decideAll('drop');
        break;
      case 'undo':
        review.undo();
        break;
      case 'trust-paranoid':
      case 'trust-cautious':
      case 'trust-trusted':
        review.setTrustLevel(
          action === 'trust-paranoid'
            ? 'paranoid'
            : action === 'trust-cautious'
              ? 'cautious'
              : 'trusted',
        );
        break;
      case 'save-session': {
        // The rows are set only after the rules have reported their
        // effects, and there is a window before that where there is
        // nothing to save. "Too big to save" would be a lie there.
        if (review.state === null) {
          setNotice(t('The review is still loading.'));
          break;
        }
        // The review is put aside, not thrown away: the decisions and the
        // edits are saved on this device, and the command bar brings the
        // review back.
        if (!review.saveSession()) {
          setNotice(
            t('This review is too big to save. Apply it, or throw it away.'),
          );
          break;
        }
        closeReview();
        break;
      }
      case 'apply':
        // A rule is being written: the import would race the write, and
        // the rule the user just made might or might not be in the
        // import. The Import button is off for the same reason.
        if (creatingRule) break;
        void review.apply().then(afterApply);
        break;
      case 'close':
        requestClose();
        break;
      case 'edit-rules': {
        // There is no row to look at — the review is still loading, or
        // the list is empty. Either way there is nothing to say.
        if (!focused) break;
        // The blank-rule item is on every focused row, so the picker
        // always has something to offer. A rule that touched the row but
        // is no longer in the budget still deserves a word — but it must
        // not stop the user from making a rule.
        if (
          focusedRuleIds.length > 0 &&
          !rulePickerItems.some(item => item.kind === 'edit')
        ) {
          setNotice(t('That rule is not in this budget any more.'));
        }
        // ONE thing to choose, and it is a rule to EDIT: open it, rather
        // than showing a picker with a single item in it.
        //
        // Rules to CREATE — the row-derived ones and the blank one — never
        // open on their own. Making a rule is a durable act, and the user
        // asked to edit the rules, so only edit items count toward this
        // shortcut. The picker still carries the full list.
        const actionable = rulePickerItems.filter(item => item.kind !== 'new');
        const only = actionable.length === 1 ? actionable[0] : null;
        if (only && only.kind === 'edit') {
          pickRuleItem(only);
          break;
        }
        setPane({ kind: 'rules', items: rulePickerItems });
        break;
      }
      case 'edit-split': {
        // A row is EITHER a transfer OR a split, never both.
        //
        // The check uses `effectiveTransferAccountId`, NOT
        // `edits.transferAccountId`, because the resolver's account-name
        // auto-detect sets `matchedTransferAccountId` without the user
        // confirming it: a row whose vendor string happens to equal a
        // budget account name would otherwise become a split here, and
        // then fail the apply step's transfer/split check.
        if (!focused) break;
        if (effectiveTransferAccountId(focused) !== undefined) {
          setNotice(t('This row is a transfer, so it cannot be split'));
          break;
        }
        // A row that is already in the budget can be split: the apply
        // step rewrites the legs of the transaction it matched, the same
        // way upstream's own UI does when a split is edited.
        openPane({ kind: 'split' });
        break;
      }
      case 'edit-transfer': {
        // A row is EITHER a transfer OR a split, never both.
        //
        // `withTransfer` clears the split, so allowing the edit would
        // silently un-split the user's work — the exact failure the
        // split editor exists to prevent. The way out is the split
        // pane's "Remove split".
        if (!focused) break;
        if (isSplitRow(focused.edits)) {
          setNotice(
            t(
              'This row is split, so it cannot be transferred. Remove the split first.',
            ),
          );
          break;
        }
        // A row that is already in the budget is NOT refused here, the
        // way the split editor refuses it. A transfer is a COLUMN: the
        // update path writes the transfer payee, and upstream's
        // `transfer.onUpdate` keeps the mirror in step. The split
        // editor refuses it because that path cannot create legs.
        openPane({ kind: 'transfer' });
        break;
      }
      case 'help':
        setNotice(null);
        setPane(current =>
          current?.kind === 'help' ? null : { kind: 'help' },
        );
        break;
      case 'edit-chain': {
        // The chain: the payee, then the category, then the notes, then
        // the amount if the row is flagged about it.
        //
        // It has its own case because it is NOT one of the single-field
        // editors: `EDITOR_FOR_ACTION` maps the five actions that open
        // ONE field, and the chain opens several in a row.
        if (!focused) break;
        const chain = initialChainContext(
          focused,
          focusedRuledFields,
          hasAmountFlag,
        );
        const first = chain.remaining[0];
        if (!first) {
          // Every field is ruled, or the row has none to edit. There is
          // nothing to walk.
          setNotice(t('There is nothing on this row to edit.'));
          break;
        }
        openPane({ kind: 'editor', field: first, chain });
        break;
      }
      case 'edit-payee':
      case 'edit-category':
      case 'edit-memo':
      case 'edit-amount':
      case 'edit-date': {
        // The field editors. Each one opens the pane for the field the
        // action names.
        const field = EDITOR_FOR_ACTION[action];
        if (focused) {
          openPane({ kind: 'editor', field });
        }
        break;
      }
      default: {
        // Every action has a case above.
        //
        // The assignment does not compile if an action is added without
        // one: the switch would leave it in this branch, and `action`
        // would not be `never`. An action nobody handled would otherwise
        // do nothing at all, and the keypress would look like the review
        // is broken.
        const unhandled: never = action;
        void unhandled;
        break;
      }
    }
  };

  // Whether the press that is about to happen is the SECOND of a
  // double-click.
  //
  // A double-click would accept the row the cursor moved to as well:
  // the first press accepts the row and the cursor moves on, and the
  // second press lands on the same button — which now acts on the NEXT
  // row.
  //
  // The mouse's own click count says a press is the second of a pair,
  // and the second press is swallowed. A keyboard's double-Enter is
  // NOT swallowed: two Enters in a row is the keyboard user accepting
  // two rows, which is what the queue is for.
  const multiClick = useRef(false);

  /**
   * Do what a button in the ACTIONS zone does, once.
   */
  const pressOnce = (event: PressEvent, action: ReviewAction) => {
    const isSecondOfAPair = multiClick.current;
    // The flag is consumed either way, so a press that did not come
    // from the mouse cannot inherit it.
    multiClick.current = false;
    // A MOUSE is what a double-click is. A keyboard's double-Enter is
    // not swallowed: two Enters in a row is the keyboard user accepting
    // two rows, which is what the queue is for. And a touch is not
    // swallowed either: the flag can only be set by a mousedown, and a
    // touch screen has no reason to have set it.
    if (
      isSecondOfAPair &&
      (event.pointerType === 'mouse' || event.pointerType === 'pen')
    ) {
      return;
    }
    dispatch(action);
    // The GRID owns the keyboard. A button that acted hands it back, so
    // the row keys work again straight away — a user who clicked Accept
    // with the mouse can carry on with the keyboard.
    //
    // The payee editor and the edit chain are the exceptions that hand the
    // keyboard straight to a pane without giving it back here: their pane
    // autofocuses. For every other action — including the transfer, split
    // and rules buttons — focusGrid() runs first and the pane's own
    // autofocus takes over after it mounts.
    if (action !== 'edit-payee' && action !== 'edit-chain') focusGrid();
  };

  // One binding for the whole keymap. `react-hotkeys-hook` reports the
  // hotkey that matched, and the action is resolved from it.
  const allKeys = KEYMAP.map(binding => binding.keys).join(', ');

  useHotkeys(
    allKeys,
    (event, handler) => {
      // The matched hotkey, not the parsed key list: for `ctrl+a` and `a`
      // the parsed key list is `['a']` in both cases.
      const action = actionForHotkey(handler.hotkey);
      if (!action) return;

      let inControl = false;
      if (event.target instanceof HTMLElement) {
        const target = event.target;
        // Typing always wins: a letter typed into a field is text, not a
        // command. A field is a pane here, so this is mostly belt and
        // braces, but the handler listens on the document.
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        // Row keys belong to the grid, not to the button the user has
        // tabbed to. With the close button focused, `a` used to accept
        // the focused row; with a trust chip focused, `r` would drop it.
        // The GLOBAL actions are exempt: Escape and Ctrl+S must work
        // wherever the focus is, or the dialog becomes a trap.
        inControl =
          target.closest(
            'button,[role="button"],[role="switch"],[role="checkbox"],[role="textbox"],[role="combobox"],[role="listbox"],select,a[href]',
          ) !== null;
        if (inControl && !GLOBAL_ACTIONS.includes(action)) return;
      }

      event.preventDefault();
      dispatch(action);
      // A command that fired while a CONTROL had the focus hands the
      // keyboard back to the grid. Otherwise the focus stays on the
      // control, and the row keys — which a focused control swallows —
      // would stay swallowed: tab to the trust chip, press `3`, and `a`
      // would do nothing.
      if (inControl && !CLOSING_ACTIONS.includes(action)) {
        focusGrid();
      }
    },
    {
      scopes: [REVIEW_SCOPE],
      // While the pane is open it OWNS the keyboard, and the review's own
      // bindings are switched off entirely.
      //
      // The `enabled` option does that work, not the scope. Switching a
      // scope off happens in the provider, and the provider's state change
      // reaches this hook only after React has flushed the passive effects
      // that made it — one scheduler task after the commit that opened the
      // pane. A keypress in that window still hits the review's `escape`,
      // which discards the whole review.
      //
      // `enabled` is local to the hook and is part of its options, so the
      // binding is torn down in the LAYOUT phase of the very same commit
      // that opened the pane — before the browser can deliver another key.
      //
      // A guard inside the handler would not do either. The arrow keys
      // would still move the row focus, letters would still decide rows,
      // and `escape` would still discard the whole review — and
      // `react-hotkeys-hook` listens on the document, so a child
      // component calling `preventDefault()` does not stop any of them.
      //
      // The rule editor counts as a pane: it is a modal on top of the
      // review, and the review's own keys must not fire while the user
      // is typing a condition into it.
      // The Leave dialog is a modal on top of the review, like the rule
      // editor: its own keys must be the only ones firing while it is up,
      // or a letter would still decide a row behind the dialog.
      enabled:
        pane === null && !isEditingRule && !leaveModalOpen && !hideAfterApply,
    },
  );

  // The pane's own keys.
  //
  // Escape closes the pane. It has to fire while the field has the focus,
  // which the library does not do by default: a hotkey is skipped when
  // the key is pressed in an input.
  useHotkeys(
    'escape',
    () => {
      openPane(null);
    },
    { enabled: pane !== null, enableOnFormTags: true },
  );

  // `?` closes the help. The review's own binding for `?` is off while
  // the pane is open, so this is the only one that can fire.
  useHotkeys(
    'shift+slash',
    () => {
      setNotice(null);
      setPane(current => (current?.kind === 'help' ? null : current));
    },
    { enabled: pane?.kind === 'help' },
  );

  // A pane hands the keyboard back to the grid when it closes. Without
  // this, Escape leaves the focus on a button that has just unmounted and
  // the next key goes to the browser instead of the review.
  useEffect(() => {
    const wasOpen = paneWasOpenRef.current;
    paneWasOpenRef.current = pane !== null;
    // Upstream's rule editor opens where a pane closed. Do not pull the
    // focus back into the review from the modal the user just opened —
    // remember it instead, and hand the focus back when that modal is
    // gone. Otherwise a keyboard user loses their place silently.
    if (wasOpen && pane === null) {
      if (isEditingRule) pendingGridRefocusRef.current = true;
      else focusGrid();
    }
    if (!isEditingRule && pane === null && pendingGridRefocusRef.current) {
      pendingGridRefocusRef.current = false;
      focusGrid();
    }
  }, [pane, isEditingRule]);

  // The review owns the keyboard while it is open: the app's own hotkeys
  // must not fire under it.
  //
  // The app binds plain letters too — `t` adds a transaction, `ctrl+a`
  // selects every transaction — and this review binds the same keys. The
  // upstream Modal's own comment says it deactivates the "app" scope while
  // a modal is open, but the code only enables the scope named after the
  // modal, so the feature does it itself.
  //
  // The app scope is the provider's initial scope, so it is always active
  // while the review is open and putting it back on close restores what
  // was there.
  useEffect(() => {
    // The setup screen is an ordinary page: the app's own shortcuts should
    // keep working there. Only the review itself owns the keyboard.
    if (needsSetup || hideAfterApply) return;
    disableScope('app');
    return () => {
      enableScope('app');
    };
  }, [enableScope, disableScope, needsSetup, hideAfterApply]);

  const isLoading = review.status === 'parsing' || review.status === 'applying';

  // As a modal the review started with focus inside the dialog. On a page,
  // nothing focuses the grid on mount, so a keyboard user's first key would
  // go to the browser chrome. Give the grid focus once the rows are there.
  const didFocusOnMount = useRef(false);
  useEffect(() => {
    if (
      !didFocusOnMount.current &&
      !needsSetup &&
      !isLoading &&
      rows.length > 0
    ) {
      didFocusOnMount.current = true;
      focusGrid();
    }
  });
  const summary = review.summary;

  // The rows a rule touched. The rule lock's own colour, so the status
  // line and the ruled cells speak the same language.
  //
  // It counts the rows the LIST shows as locked, which is not quite the
  // same as the rows the rules touched: a rule that sets a split
  // parent's category says nothing about what will land, and the cell
  // does not show it.
  const ruledRowCount = rows.filter(
    row => visibleEffectsFor(review.ruleEffects, row).length > 0,
  ).length;

  if (hideAfterApply) {
    // The review is done and a modal it raised is still open. Do not paint
    // the review behind it; the route stays put so the modal is not closed
    // by `Modals.tsx`'s route-change handler.
    return null;
  }

  if (needsSetup) {
    return (
      <View
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: 760,
          margin: '24px auto',
          padding: 24,
          border: `1px solid ${theme.tableBorder}`,
          borderRadius: 6,
          backgroundColor: theme.tableBackground,
          gap: 16,
        }}
      >
        <Text
          role="heading"
          aria-level={1}
          style={{ fontSize: 22, fontWeight: 700 }}
        >
          <Trans>Import transactions</Trans>
        </Text>
        <Text style={{ color: theme.tableHeaderText }}>
          <Trans>
            Choose the account to import into, then pick a file. You can review
            every transaction before anything is added to your budget.
          </Trans>
        </Text>
        <View style={{ flexDirection: 'column', gap: 6 }}>
          <Text style={{ fontWeight: 600 }}>
            <Trans>Import into account</Trans>
          </Text>
          <select
            value={setupAccount}
            onChange={event => setSetupAccount(event.target.value)}
            style={{
              fontFamily: 'inherit',
              fontSize: 14,
              padding: 7,
              borderRadius: 4,
              border: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableBackground,
              color: theme.pageText,
            }}
          >
            {openAccounts.map(acc => (
              <option key={acc.id} value={acc.id}>
                {acc.name}
              </option>
            ))}
          </select>
        </View>
        {openAccounts.length === 0 ? (
          <Text style={{ color: theme.errorText }}>
            <Trans>Add an account before importing a file.</Trans>
          </Text>
        ) : null}
        <View>
          <Button
            variant="primary"
            isDisabled={openAccounts.length === 0}
            onPress={() => void chooseFile()}
          >
            <SvgUpload width={14} height={14} style={{ marginRight: 8 }} />
            <Trans>Choose a file</Trans>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <>
      <View
        ref={shellRef}
        data-testid="import-review-shell"
        role="region"
        aria-labelledby={REVIEW_TITLE_ID}
        onKeyDownCapture={onShellKeyDown}
        style={{
          // The page fills the route container, so the table can grow to
          // the full viewport height instead of the modal's 90vh cap.
          // Clipping here and scrolling the body below keeps the footer
          // pinned at the bottom rather than pushing it into the page's
          // scrollport.
          position: 'relative',
          // The modal used to paint a white surface; keep the same surface
          // on the page so the status text keeps its contrast against it.
          backgroundColor: theme.tableBackground,
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: 900,
          margin: '0 auto',
          height: '100%',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {isLoading && (
          <View
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: theme.pageBackground,
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1000,
            }}
          >
            <AnimatedLoading
              style={{ width: 20, height: 20 }}
              color={theme.pageText}
            />
          </View>
        )}
        {/*
              The review's own header, not the app's `ModalHeader`.

              `ModalHeader` centres its title and positions its
              `rightContent` absolutely at `right: 0`. Every other modal
              puts one small close button there; this review put the trust
              level there, and it reached the title — the two painted over
              each other and the header read "Review impor-t-paranoid".

              The review's header is one flex row instead, so nothing is
              positioned over anything else.
          */}
        <ReviewHeader
          trustLevel={review.trustLevel}
          // A pane owns the keyboard: the confirmation's outcomes are
          // Keep and Discard, and changing the trust level under it
          // would change what they mean.
          isTrustDisabled={pane !== null || creatingRule}
          onTrustLevelChange={level => {
            review.setTrustLevel(level);
            // The grid takes the keyboard back, so the row keys work
            // again after a chip is clicked.
            focusGrid();
          }}
          willImport={summary.willImport}
          // The Import button is off while a pane owns the keyboard:
          // the confirmation's outcomes are Keep and Discard, and a
          // split the user has not saved would be applied without.
          isImportDisabled={
            isLoading ||
            rows.length === 0 ||
            // A rule is being written: the import would race the
            // write, and the rule the user just made might or might
            // not be in the import.
            creatingRule ||
            leaveModalOpen ||
            pane?.kind === 'rules' ||
            pane?.kind === 'split' ||
            pane?.kind === 'transfer'
          }
          onApply={() => {
            void review.apply().then(afterApply);
          }}
          onClose={requestClose}
        />

        <View
          data-testid="import-review-body"
          style={{
            // The footer is a sibling below this column now, so its
            // own padding supplies the bottom inset. Leaving 16px here
            // would double the gap above the strip.
            padding: '16px 16px 0',
            gap: 12,
            // Shrink with the wrapper, but only the table panel inside
            // is allowed to give up space. Everything else keeps its
            // size so the list is the first thing to compress.
            flex: '0 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            // Once the list has shrunk to its floor, the rest of the
            // review scrolls HERE — the header and footer stay put.
            overflowY: 'auto',
          }}
          innerRef={bodyRef}
        >
          {review.error ? (
            <Text
              style={{ color: theme.errorText }}
              data-testid="import-review-error"
            >
              {review.error}
            </Text>
          ) : null}

          {/* The status line: where the review is.

                ONE line, and the numbers that matter come first — how far
                along the user is, what needs attention, and what will
                land.

                The line carries the mockup's six items: progress,
                reviewed, flagged, will import, set by rules and the
                in/out split. Skipped and blocked are not counters here —
                the list's Status column badges each row with its own
                outcome, which is where a person looks for one. A second
                count of them here would be noise.

                The trust level is not here: it is a CONTROL, and it
                lives in the header with the other controls. */}
          <View
            data-testid="import-review-status"
            style={{
              flexDirection: 'row',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
              flexShrink: 0,
            }}
          >
            {/* How far through the file the user is. The bar is
                  decorative: the chip beside it says the same thing in
                  words. */}
            <ReviewProgress
              reviewed={summary.total - summary.pending}
              total={summary.total}
            />
            <StatusChip tone="neutral">
              {t('{{reviewed}} of {{total}} reviewed', {
                reviewed: summary.total - summary.pending,
                total: summary.total,
              })}
            </StatusChip>
            <StatusChip
              tone="warning"
              icon={<SvgFlag width={12} height={12} />}
            >
              {t('{{count}} flagged', { count: summary.warned })}
            </StatusChip>
            <StatusChip
              tone="success"
              icon={<SvgCheckmark width={12} height={12} />}
            >
              {t('{{count}} will import', { count: summary.willImport })}
            </StatusChip>
            {ruledRowCount > 0 ? (
              <StatusChip tone="rule" icon={<SvgTag width={12} height={12} />}>
                {t('{{count}} set by rules', { count: ruledRowCount })}
              </StatusChip>
            ) : null}
            {/* A hairline closes the chips before the two money pairs:
                  how many rows will land, and how much money moves. */}
            <StatusSeparator />
            <Text style={{ ...styles.tnum, color: theme.tableHeaderText }}>
              {t('{{in}} in · {{out}} out', {
                in: summary.inflowCount,
                out: summary.outflowCount,
              })}
            </Text>
            <StatusSeparator />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
              }}
            >
              <FinancialText
                data-testid="import-review-sum-in"
                style={{ color: theme.numberPositive }}
              >
                {format(summary.inflowCents, 'financial-with-sign')}
              </FinancialText>
              <Text style={{ color: theme.tableHeaderText }}>·</Text>
              <FinancialText
                data-testid="import-review-sum-out"
                style={{ color: theme.numberNegative }}
              >
                {format(summary.outflowCents, 'financial-with-sign')}
              </FinancialText>
            </View>
          </View>

          <View
            style={{
              border: `1px solid ${theme.tableBorder}`,
              borderRadius: 6,
              overflow: 'hidden',
              // The only region that gives up space when the viewport
              // is short. Its grid below carries the measured floor.
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 1,
              minHeight: tableMinHeight || undefined,
            }}
          >
            {/* Where the file is going. It is the table's CAPTION, not a
                  row: it says where everything below it lands, so it sits
                  inside the panel above the sticky header. */}
            <View
              innerRef={captionElRef}
              id="import-review-destination"
              data-testid="import-review-destination"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
                padding: '6px 10px',
                backgroundColor: theme.tableRowHeaderBackground,
                borderBottom: `1px solid ${theme.tableBorder}`,
              }}
            >
              <BankIcon
                width={12}
                height={12}
                style={{ color: theme.tableHeaderText }}
              />
              <Text
                style={{
                  // The band is the row-header token, but its ink is the
                  // same secondary text the mockup's caption uses.
                  color: theme.tableHeaderText,
                  fontWeight: 500,
                  fontSize: 12,
                }}
              >
                {t('Importing into {{account}}', {
                  account: accountName(accountId),
                })}
              </Text>
            </View>

            <View
              ref={gridRef}
              role="table"
              aria-labelledby="import-review-destination"
              tabIndex={0}
              data-testid="import-review-grid"
              style={{
                // The list grows with its content and stops at half the
                // screen: the modal sizes to what it has to show, and
                // the table scrolls only when there is something to
                // scroll.
                maxHeight: 'min(50vh, 640px)',
                // A short screen squeezes the list before it scrolls the
                // dialog, but never below three rows and the header. The
                // floor is measured from the rendered elements, so it
                // follows font size and zoom instead of a pixel guess.
                // Until the measurement lands, do not shrink at all.
                minHeight: listMinHeight || undefined,
                flexShrink: listMinHeight > 0 ? 1 : 0,
                // The cursor effect owns this scroll position; browser
                // scroll anchoring has no say in where the row lands.
                overflowAnchor: 'none',
                // ONE scroll context for the whole table, so the header
                // and the rows move together and the columns cannot
                // drift apart. It used to be on each row, which meant
                // every row had its own scrollbar and the header did
                // not follow the body sideways.
                overflow: 'auto',
              }}
            >
              {/* The header.
                    It is INSIDE the scrolling list, so it stays above the
                    rows as they scroll down, and it goes through the same
                    column template as they do, so it cannot drift out of
                    line with them. */}
              <View
                innerRef={headerElRef}
                role="row"
                data-testid="import-review-header"
                style={{
                  flexDirection: 'row',
                  gap: 12,
                  padding: '6px 10px',
                  // The header is the only item in this column that
                  // could shrink — every row says `flexShrink: 0` — so
                  // without this it would take ALL the negative free
                  // space and disappear the moment the list was full.
                  flexShrink: 0,
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  backgroundColor: theme.tableHeaderBackground,
                  borderBottom: `1px solid ${theme.tableBorder}`,
                }}
              >
                <ReviewColumns
                  date={{
                    testId: 'import-review-header-date',
                    role: 'columnheader',
                    children: (
                      <Text
                        style={{
                          color: theme.tableHeaderText,
                          fontWeight: 500,
                        }}
                      >
                        <Trans>Date</Trans>
                      </Text>
                    ),
                  }}
                  payee={{
                    testId: 'import-review-header-payee',
                    role: 'columnheader',
                    children: (
                      <Text
                        style={{
                          color: theme.tableHeaderText,
                          fontWeight: 500,
                        }}
                      >
                        <Trans>Payee</Trans>
                      </Text>
                    ),
                  }}
                  category={{
                    testId: 'import-review-header-category',
                    role: 'columnheader',
                    children: (
                      <Text
                        style={{
                          color: theme.tableHeaderText,
                          fontWeight: 500,
                        }}
                      >
                        <Trans>Category</Trans>
                      </Text>
                    ),
                  }}
                  amount={{
                    testId: 'import-review-header-amount',
                    role: 'columnheader',
                    children: (
                      <Text
                        style={{
                          color: theme.tableHeaderText,
                          fontWeight: 500,
                          textAlign: 'right',
                        }}
                      >
                        {format.currency.symbol
                          ? t('Amount ({{symbol}})', {
                              symbol: format.currency.symbol,
                            })
                          : t('Amount')}
                      </Text>
                    ),
                  }}
                  status={{
                    testId: 'import-review-header-status',
                    role: 'columnheader',
                    children: (
                      <Text
                        style={{
                          color: theme.tableHeaderText,
                          fontWeight: 500,
                          textAlign: 'right',
                        }}
                      >
                        <Trans>Status</Trans>
                      </Text>
                    ),
                  }}
                />
              </View>
              {rows.map((row, index) => {
                const isFocused = index === review.focusedIndex;
                const isLast = index === rows.length - 1;
                const evaluation = review.evaluations.get(rowKey(row));
                const badge = evaluation ? gateBadge(row, evaluation) : null;
                const category = categoryCell(row);
                const payee = payeeCell(row);
                const amountCellValue = amountCell(row);
                const dateCellValue = dateCell(row);
                return (
                  <View
                    innerRef={element => {
                      rowRefs.current[index] = element;
                    }}
                    role="row"
                    key={row.previewKey ?? row.importedId ?? String(index)}
                    data-testid="import-review-row"
                    data-focused={isFocused ? 'true' : 'false'}
                    data-decision={row.decision}
                    data-gate={evaluation?.gate ?? 'allow'}
                    data-held={evaluation?.held ? 'true' : 'false'}
                    style={{
                      flexDirection: 'row',
                      gap: 12,
                      padding: '6px 10px',
                      // A row does not get shorter because there are more
                      // rows.
                      //
                      // The list is a column flex box with a `maxHeight`,
                      // so the flex algorithm shrinks its rows to fit
                      // instead of letting the list scroll. A flex item's
                      // automatic minimum size is its content's height —
                      // but `View` sets `min-height: 0` on every
                      // instance, which REPLACES that automatic size with
                      // zero, so the row can be shrunk to nothing and
                      // its text is clipped away.
                      //
                      // `flexShrink: 0` says the row keeps its height and
                      // the list scrolls. One property, and it cannot be
                      // overridden by the `min-height: 0` above.
                      flexShrink: 0,
                      // The row is as wide as its content needs it to
                      // be, so a narrow viewport scrolls the TABLE —
                      // once, with the header on it — rather than
                      // squashing a column or giving every row its own
                      // scrollbar.
                      minWidth: 'max-content',
                      backgroundColor: isFocused
                        ? theme.tableRowHeaderBackground
                        : 'transparent',
                      // The hairline between the rows, and the hover.
                      //
                      // Both are the app's own: the transactions table
                      // separates its rows with the same border and
                      // washes them with the same colour on hover.
                      //
                      // The LAST row's hairline goes, because the list
                      // is in a bordered box and two borders would
                      // make a seam along the bottom.
                      borderBottom: isLast
                        ? 'none'
                        : `1px solid ${theme.tableBorder}`,
                      // The focused row is the row the detail section is
                      // about, so it has to be findable at a glance —
                      // and it has to be findable when the mouse is
                      // over another row, because the hover wash and
                      // the focused wash are the same colour.
                      //
                      // So the focused row gets an ACCENT down its
                      // leading edge, in the app's own colour for a
                      // selected row.
                      boxShadow: isFocused
                        ? `inset 2px 0 0 ${theme.tableBorderSelected}`
                        : undefined,
                      ...(isFocused
                        ? {}
                        : {
                            ':hover': {
                              backgroundColor: theme.tableRowBackgroundHover,
                            },
                          }),
                    }}
                  >
                    <ReviewColumns
                      date={{
                        testId: 'import-review-row-date',
                        role: 'cell',
                        ruled: dateCellValue.ruled,
                        children: dateCellValue.ruled ? (
                          <RuledCell
                            label={dateCellValue.date}
                            cleared={dateCellValue.cleared}
                            title={dateCellValue.date}
                          />
                        ) : (
                          <TextOneLine title={dateCellValue.date}>
                            {dateCellValue.date}
                          </TextOneLine>
                        ),
                      }}
                      payee={{
                        testId: 'import-review-row-payee',
                        role: 'cell',
                        ruled: payee.ruled,
                        children: payee.ruled ? (
                          <RuledCell
                            label={payee.label}
                            cleared={payee.cleared}
                            title={payee.label}
                          />
                        ) : (
                          /* A payee that is not settled — a guess, or
                               nothing at all — is MUTED, the way the
                               category's "Categorize" is. It looks like a
                               fact in normal ink, and it is not one. */
                          <TextOneLine
                            title={payee.label}
                            style={{
                              fontStyle: payee.muted ? 'italic' : undefined,
                              color: payee.muted
                                ? theme.tableHeaderText
                                : undefined,
                            }}
                          >
                            {payee.label}
                          </TextOneLine>
                        ),
                      }}
                      category={{
                        testId: 'import-review-row-category',
                        role: 'cell',
                        ruled: category.ruled,
                        children: category.ruled ? (
                          <RuledCell
                            label={category.label}
                            cleared={category.cleared}
                            title={category.label}
                          />
                        ) : (
                          /* One line, always: a category name that
                               wraps makes the row grow, and the rows are
                               the thing the user is scanning. */
                          <TextOneLine
                            title={category.label}
                            style={{
                              fontStyle: category.muted ? 'italic' : undefined,
                              color: category.muted
                                ? theme.tableHeaderText
                                : undefined,
                            }}
                          >
                            {category.label}
                          </TextOneLine>
                        ),
                      }}
                      amount={{
                        testId: 'import-review-row-amount',
                        role: 'cell',
                        ruled: amountCellValue.ruled,
                        children: amountCellValue.ruled ? (
                          <RuledCell
                            label={amountCellValue.amount.toFixed(2)}
                            cleared={amountCellValue.cleared}
                            // A CLEARED field has no amount, so it has
                            // no amount to put in the tooltip.
                            title={
                              amountCellValue.cleared
                                ? undefined
                                : amountCellValue.amount.toFixed(2)
                            }
                            align="right"
                          />
                        ) : (
                          <FinancialText
                            title={amountCellValue.amount.toFixed(2)}
                            style={{
                              textAlign: 'right',
                              // A wide amount would otherwise paint
                              // over the gap and under the badge. The
                              // box is right-aligned, so the overflow
                              // is at the LEADING edge — the
                              // significant digits are what get cut —
                              // hence the title.
                              overflow: 'hidden',
                            }}
                          >
                            {amountCellValue.amount.toFixed(2)}
                          </FinancialText>
                        ),
                      }}
                      status={{
                        role: 'cell',
                        testId: 'import-review-row-status',
                        children: renderStatusBadge(badge),
                      }}
                    />
                  </View>
                );
              })}
            </View>
          </View>

          {focused ? (
            <View
              style={{
                gap: 12,
                height: DETAIL_HEIGHT,
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 6,
                overflow: 'hidden',
                // Fixed by design: the list gives up space first.
                flexShrink: 0,
              }}
              data-testid="import-review-details"
            >
              {/* The two columns scroll independently; the ACTIONS stay
                    put, because the actions are what the user came for.
                    On a narrow window they stack and the pair scrolls as
                    one, so neither column is squeezed into a sliver. */}
              <View
                style={{
                  flex: 1,
                  minHeight: 0,
                  flexDirection: atLeastMediumWidth ? 'row' : 'column',
                  gap: atLeastMediumWidth ? 24 : 6,
                  paddingLeft: 14,
                  paddingRight: 14,
                  ...(atLeastMediumWidth ? {} : { overflowY: 'auto' as const }),
                }}
                data-testid="import-review-zones"
              >
                <View
                  style={detailColumnStyle}
                  data-testid="import-review-zone-left"
                >
                  {/* ZONE 1 — TRANSACTION: the facts about this row.

                      The list carries the date, the payee, the category
                      and the amount for the row the user is on. What it
                      does not carry is the file's own vendor string, the
                      notes, the amount in full and the category's group
                      — and those are exactly the things that get
                      truncated or left out.

                      The fields are split by WHERE they come from: the
                      bank's facts first, then what will land in the
                      budget. The group is here rather than in the list
                      because it only matters when two categories share
                      a name, and it matters for the row the user is ON. */}
                  <View
                    style={{ gap: 2, flexShrink: 0 }}
                    data-testid="import-review-transaction"
                  >
                    <ZoneLabel>
                      <Trans>Transaction</Trans>
                    </ZoneLabel>
                    <ZoneSubhead>
                      <Trans>From the bank</Trans>
                    </ZoneSubhead>
                    <DetailField
                      label={<Trans>Description</Trans>}
                      testId="import-review-vendor"
                    >
                      {focused.payeeRaw?.trim() || '—'}
                    </DetailField>
                    <DetailField
                      label={<Trans>Date</Trans>}
                      testId="import-review-date"
                    >
                      {focusedDateLabel}
                    </DetailField>
                    <DetailField
                      label={<Trans>Amount</Trans>}
                      testId="import-review-amount"
                      numeric
                      valueStyle={
                        focusedAmountColor
                          ? { color: focusedAmountColor }
                          : undefined
                      }
                    >
                      {focusedAmountLabel}
                    </DetailField>
                    <ZoneSubhead>
                      <Trans>In your budget</Trans>
                    </ZoneSubhead>
                    <DetailField
                      label={<Trans>Payee</Trans>}
                      testId="import-review-payee"
                    >
                      {focusedPayeeCellValue?.cleared
                        ? clearedByRule
                        : focusedPayeeCellValue?.label.trim() || '—'}
                    </DetailField>
                    <DetailField
                      label={<Trans>Category</Trans>}
                      testId="import-review-category"
                    >
                      {focusedCategoryValue?.group ? (
                        <>
                          {focusedCategoryValue.label} ·{' '}
                          <Text data-testid="import-review-category-group">
                            {focusedCategoryValue.group}
                          </Text>
                        </>
                      ) : (
                        focusedCategoryLabel
                      )}
                    </DetailField>
                    <DetailField
                      label={<Trans>Notes</Trans>}
                      testId="import-review-notes"
                    >
                      {focusedMemo || '—'}
                    </DetailField>
                    {review.isAlreadyImported(rowKey(focused)) ? (
                      <Text
                        data-testid="import-review-already-imported"
                        style={{ color: theme.tableHeaderText }}
                      >
                        <Trans>This transaction is already in the budget</Trans>
                      </Text>
                    ) : null}
                  </View>
                </View>

                <View
                  style={detailColumnStyle}
                  data-testid="import-review-zone-right"
                >
                  {/* ZONE 2 — REVIEW STATUS: what the gate decided about
                      this row and why. The verdict leads, the explanation
                      follows, and the code is a tertiary detail beside the
                      `Why?` link — useful when something goes wrong, but
                      not a headline.

                      The zone is ALWAYS here. A clean row has a status
                      too: nothing was flagged, and the gate will let it
                      through at every level. */}
                  <View
                    style={{
                      gap: 2,
                      flexShrink: 0,
                      borderTop: `1px solid ${theme.tableBorder}`,
                      paddingTop: 10,
                    }}
                    data-testid="import-review-verdict"
                  >
                    <ZoneLabel>
                      <Trans>Review status</Trans>
                    </ZoneLabel>

                    {/* The verdict leads: what the gate will do with this
                        row at THIS trust level, coloured by outcome. */}
                    {currentGate ? (
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          flexShrink: 0,
                        }}
                        data-testid="import-review-verdict-line"
                      >
                        <SvgFlag
                          width={13}
                          height={13}
                          aria-hidden="true"
                          style={{
                            flexShrink: 0,
                            color: verdictColor(currentGate),
                          }}
                        />
                        <Text
                          style={{
                            minWidth: 0,
                            fontWeight: 600,
                            color: verdictColor(currentGate),
                          }}
                        >
                          {t('{{outcome}} at {{level}}', {
                            outcome: gateLabel(currentGate),
                            level: trustLevelLabel(t, review.trustLevel),
                          })}
                        </Text>
                      </View>
                    ) : null}

                    {/* The explanation: what the gate actually saw. A row
                        with nothing to flag says so instead. */}
                    <Text
                      style={{
                        flexShrink: 0,
                        color: focusedEvaluation?.flags.length
                          ? undefined
                          : theme.tableHeaderText,
                      }}
                    >
                      {focusedEvaluation?.flags.length
                        ? focusedEvaluation.flags
                            .map(flag => flagReason(flag.kind))
                            .join(' · ')
                        : t('Nothing to flag on this row.')}
                    </Text>

                    {focusedEvaluation?.held ? (
                      <Text style={{ flexShrink: 0, color: theme.errorText }}>
                        {focusedEvaluation.overridable
                          ? t(
                              'Held back by the trust level. Press Ctrl+Shift+A to accept it anyway.',
                            )
                          : t(
                              'Held back: this row cannot be imported until its date or amount is fixed.',
                            )}
                      </Text>
                    ) : null}

                    {/* `Why?` and the machine code share one tertiary row:
                        the link on the left, the greppable code on the
                        right. The three-level breakdown is disclosed on
                        demand, so the default surface stays small. */}
                    {focusedEvaluation?.flags.length ? (
                      <View
                        style={{
                          flexShrink: 0,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <Button
                          variant="bare"
                          // The visible word stays in the accessible name,
                          // so a voice-control user saying "click Why?"
                          // still matches the control.
                          aria-label={t('Why is this flagged? Why?')}
                          aria-expanded={whyOpen}
                          aria-controls="import-review-why-detail"
                          data-testid="import-review-why"
                          onPress={() => {
                            setWhyOpen(open => !open);
                            // Acting on a button must hand `j`/`k` back to
                            // the grid or the user is stuck on the link.
                            focusGrid();
                          }}
                          style={{
                            padding: 0,
                            fontSize: 12,
                            color: theme.ruleLockText,
                            textDecoration: 'underline',
                          }}
                        >
                          <Trans>Why?</Trans>
                        </Button>
                        <Text
                          data-testid="import-review-flag-codes"
                          style={{
                            fontSize: 11,
                            fontFamily: 'monospace',
                            color: theme.tableHeaderText,
                            border: `1px solid ${theme.tableBorder}`,
                            borderRadius: 3,
                            padding: '0 4px',
                          }}
                        >
                          {focusedEvaluation.flags
                            .map(flag => flag.code)
                            .join(' · ')}
                        </Text>
                      </View>
                    ) : null}

                    {whyOpen ? (
                      <View
                        id="import-review-why-detail"
                        data-testid="import-review-why-detail"
                        style={{
                          // `View` carries `min-height: 0`, so a flex child
                          // that can shrink collapses to nothing here even
                          // though its text has height.
                          flexShrink: 0,
                          flexDirection: 'row',
                          gap: 12,
                          flexWrap: 'wrap',
                        }}
                      >
                        {TRUST_LEVELS.map(level => (
                          <Text
                            key={level}
                            style={
                              level === review.trustLevel
                                ? { fontWeight: 600 }
                                : undefined
                            }
                          >
                            {trustLevelLabel(t, level)}:{' '}
                            {gateLabel(
                              gateRow(focused, level, { livePayeeNames }),
                            )}
                          </Text>
                        ))}
                      </View>
                    ) : null}
                  </View>

                  {/* ZONE 3 — RULES: what the rules did to this row.

                      The field a rule owns is the rule's identity on this
                      row: two rules can touch one row, and each gets its
                      own line. Opening a rule happens in the rule picker
                      (Shift+E), so no per-rule button is repeated here.

                      The zone is ALWAYS here, like the other three. A
                      row no rule touched says so instead of vanishing. */}
                  <View
                    style={{
                      gap: 2,
                      flexShrink: 0,
                      borderTop: `1px solid ${theme.tableBorder}`,
                      paddingTop: 10,
                    }}
                    data-testid="import-review-rules-zone"
                  >
                    <ZoneLabel>
                      {/* The number is `ruleCount`, not `count`: i18next
                          treats a `count` as a plural and the generated
                          catalogue would split each sentence into `_one`
                          and `_other`, with the singular copy in the
                          plural slot. Two literal keys, like the Import
                          button's, keep both sentences correct. */}
                      {focusedRuleIds.length === 0 ? (
                        <Trans>Rules</Trans>
                      ) : focusedRuleIds.length === 1 ? (
                        t('Rules — {{ruleCount}} rule', {
                          ruleCount: focusedRuleIds.length,
                        })
                      ) : (
                        t('Rules — {{ruleCount}} rules', {
                          ruleCount: focusedRuleIds.length,
                        })
                      )}
                    </ZoneLabel>
                    {focusedEffects.length ? (
                      <>
                        {focusedEffects.slice(0, 2).map(renderRuleLine)}
                        {rulesOpen ? (
                          <View
                            id="import-review-rules-more-detail"
                            data-testid="import-review-rules-more-detail"
                            style={{ gap: 2, flexShrink: 0 }}
                          >
                            {focusedEffects.slice(2).map(renderRuleLine)}
                          </View>
                        ) : null}
                        {focusedEffects.length > 2 ? (
                          <Button
                            variant="bare"
                            aria-expanded={rulesOpen}
                            aria-controls="import-review-rules-more-detail"
                            data-testid="import-review-rules-more"
                            onPress={() => {
                              setRulesOpen(open => !open);
                              // Keep `j`/`k` working after the click.
                              focusGrid();
                            }}
                            style={{
                              padding: 0,
                              fontSize: 12,
                              color: theme.ruleLockText,
                              textDecoration: 'underline',
                            }}
                          >
                            {rulesOpen ? (
                              <Trans>Show less</Trans>
                            ) : (
                              t('Show {{moreCount}} more', {
                                moreCount: focusedEffects.length - 2,
                              })
                            )}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Text style={{ color: theme.tableHeaderText }}>
                        <Trans>No rule touched this row.</Trans>
                      </Text>
                    )}
                  </View>
                </View>
              </View>

              <View
                style={{
                  flexShrink: 0,
                  paddingLeft: 14,
                  paddingRight: 14,
                }}
              >
                {/* The rule offer is a contextual ACTION: it rides
                    along with a correction and never interrupts the
                    accept rhythm. It stays beside the actions, out of
                    the scroll. */}
                {focusedRules &&
                ((focusedRules.vendorToPayee &&
                  !focusedRuledFields.has('payee')) ||
                  (focusedRules.toTransfer &&
                    !focusedRuledFields.has('payee')) ||
                  (focusedRules.payeeToCategory &&
                    !focusedRuledFields.has('category'))) ? (
                  <View style={{ gap: 4 }}>
                    <View
                      style={{ flexDirection: 'row', gap: 8 }}
                      data-testid="import-review-rules"
                    >
                      {focusedRules.toTransfer &&
                      !focusedRuledFields.has('payee') ? (
                        <Button
                          className={actionButtonClass}
                          data-testid="import-review-rule-to-transfer"
                          isDisabled={creatingRule}
                          onPress={() => {
                            const rule = focusedRules.toTransfer;
                            if (!rule) return;
                            void createRule(rule, transferRuleCreatedMessage);
                            focusGrid();
                          }}
                        >
                          <Trans>
                            Always transfer this vendor in this account
                          </Trans>
                        </Button>
                      ) : null}
                      {focusedRules.vendorToPayee &&
                      !focusedRuledFields.has('payee') ? (
                        <Button
                          className={actionButtonClass}
                          data-testid="import-review-rule-vendor-to-payee"
                          isDisabled={creatingRule}
                          onPress={() => {
                            void createRule(
                              focusedRules.vendorToPayee,
                              t(
                                'Rule created. This vendor will always use this payee, from now on.',
                              ),
                            );
                            focusGrid();
                          }}
                        >
                          <Trans>Always this payee for this vendor</Trans>
                        </Button>
                      ) : null}
                      {focusedRules.payeeToCategory &&
                      !focusedRuledFields.has('category') ? (
                        <Button
                          className={actionButtonClass}
                          data-testid="import-review-rule-payee-to-category"
                          isDisabled={creatingRule}
                          onPress={() => {
                            void createRule(
                              focusedRules.payeeToCategory,
                              t(
                                'Rule created. This payee will always use this category, from now on.',
                              ),
                            );
                            focusGrid();
                          }}
                        >
                          <Trans>Always this category for this payee</Trans>
                        </Button>
                      ) : null}
                    </View>
                    <Text data-testid="import-review-rules-note">
                      <Trans>
                        A rule applies to every transaction with that vendor,
                        from now on. It does not change the transactions you
                        already have.
                      </Trans>
                    </Text>
                  </View>
                ) : null}
              </View>

              {/* ZONE 4 — ACTIONS: what the user can do with this row.

                    Every button says the key that does it, so the row is
                    driveable without reading the key list. */}
              <View
                style={{
                  gap: 8,
                  // The zones above are the scroll; these siblings must
                  // never be the ones that get squeezed.
                  flexShrink: 0,
                  marginTop: 8,
                  borderTop: `1px solid ${theme.tableBorder}`,
                  paddingTop: 10,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  paddingRight: 14,
                }}
                data-testid="import-review-actions"
              >
                <ZoneLabel>
                  <Trans>Actions</Trans>
                </ZoneLabel>
                <View
                  style={{
                    flexDirection: 'row',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                  // The click count: 1 for the first click of a
                  // sequence, 2 for the second. The buttons use it to
                  // swallow the second press of a double-click.
                  // The CAPTURE phase, and that is not an accident: the
                  // capture phase always runs before the button's own
                  // handlers, and react-aria stops the pointer event's
                  // propagation on the button — so a handler on the
                  // bubble phase would never see the mousedown at all.
                  onMouseDownCapture={event => {
                    multiClick.current = event.detail > 1;
                  }}
                >
                  <Button
                    variant="normal"
                    className={actionButtonClass}
                    data-testid="import-review-edit-row"
                    onPress={event => pressOnce(event, 'edit-chain')}
                  >
                    {/* The CHAIN, not the payee alone: `e` walks the
                        row's fields. The payee on its own is `p`, and
                        the single-field editors are `c`, `m` and `d` —
                        the help overlay lists them all. */}
                    <Trans>Edit transaction</Trans>
                    <KeyCap>e</KeyCap>
                  </Button>
                  {/*
                      `t` is bound and explained in the help, but it had no
                      button: a transfer whose bank string is not an account
                      name is never auto-detected, so the only way to find
                      the editor was to read the key list. The button is the
                      discoverability half of transfer handling.
                    */}
                  <Button
                    variant="normal"
                    className={actionButtonClass}
                    data-testid="import-review-edit-transfer"
                    onPress={event => pressOnce(event, 'edit-transfer')}
                  >
                    <Trans>Make transfer</Trans>
                    <KeyCap>t</KeyCap>
                  </Button>
                  <Button
                    variant="normal"
                    className={actionButtonClass}
                    data-testid="import-review-accept"
                    onPress={event => pressOnce(event, 'accept')}
                  >
                    <Trans>Accept</Trans>
                    <KeyCap>a</KeyCap>
                  </Button>
                  <Button
                    variant="normal"
                    className={actionButtonClass}
                    data-testid="import-review-drop"
                    onPress={event => pressOnce(event, 'drop')}
                  >
                    <Trans>Drop</Trans>
                    <KeyCap>r</KeyCap>
                  </Button>
                  {/* The override is for a row the gate is HOLDING.
                      `overridable` on its own is not that: it says the
                      row is not hard-blocked, which is true of almost
                      every row. A clean row would get a second accept
                      button that means nothing. */}
                  {focusedEvaluation && isOverridableHeld(focusedEvaluation) ? (
                    <Button
                      variant="normal"
                      className={actionButtonClass}
                      data-testid="import-review-accept-anyway"
                      onPress={event => pressOnce(event, 'accept-override')}
                    >
                      <Trans>Accept anyway</Trans>
                      <KeyCap>Ctrl+Shift+A</KeyCap>
                    </Button>
                  ) : null}
                  <Button
                    variant="normal"
                    className={actionButtonClass}
                    data-testid="import-review-edit-rules"
                    onPress={event => pressOnce(event, 'edit-rules')}
                  >
                    <Trans>Rules</Trans>
                    <KeyCap>Shift+E</KeyCap>
                  </Button>
                </View>
              </View>
            </View>
          ) : null}

          <View
            style={{
              flexShrink: 0,
              // These were direct children of the gapped column before
              // this wrapper existed, so keep their spacing.
              gap: 12,
              // An idle pane is not a flex item: an empty one would add
              // a gap and make the whole layout taller for nothing.
              display: pane === null ? 'none' : undefined,
            }}
          >
            {pane?.kind === 'editor' && focused ? (
              <RowEditor
                // The chain reuses this editor for the next field, and
                // two fields can start out showing the SAME text — an
                // empty payee and an empty category, say. Without a key
                // the second field would inherit the first one's
                // refusal, its highlighted suggestion and its open list.
                // The key makes each field a fresh editor.
                key={pane.field}
                row={focused}
                mode={pane.field}
                payees={review.payees}
                categories={review.categories}
                lockedByRule={focusedLockedEffect}
                onCommit={(edits: PreviewEdits, chosenPayeeId?: string) => {
                  // A field a rule controls is not the user's to change:
                  // the rule's value lands whatever they type, so the
                  // edit is REFUSED rather than accepted and dropped
                  // later without a word.
                  //
                  // An edit that sets the field to the value the rule
                  // already sets is allowed: the user is not fighting
                  // the rule, they agree with it.
                  if (
                    focusedLockedEffect &&
                    editChangesRuledField(
                      focusedLockedEffect,
                      edits,
                      editedPayeeId(edits, chosenPayeeId),
                    )
                  ) {
                    const message = t(
                      "This row's {{field}} is set by a rule. Edit the rule to change it.",
                      { field: ruledFieldName(focusedLockedEffect.field) },
                    );
                    // The chain does not stand on a field the user
                    // cannot change: a rule can start owning a field
                    // while the chain is running — the user's own payee
                    // edit can make one fire — so the chain moves on and
                    // says what it refused.
                    //
                    // The rules' effects are refreshed asynchronously, so
                    // a rule that fires while the editor is ALREADY open
                    // is caught by the editor's own refusal, which says
                    // the same thing and leaves the editor where it is.
                    if (pane?.kind === 'editor' && pane.chain && focused) {
                      const advanced = advanceChain(pane.field, {
                        ...focused,
                        edits: { ...focused.edits, ...edits },
                      });
                      if (advanced) {
                        openPane({
                          kind: 'editor',
                          field: advanced.field,
                          chain: advanced.chain,
                        });
                        setNotice(message);
                        return;
                      }
                    }
                    setNotice(message);
                    return;
                  }

                  // A split is only valid against the row's EFFECTIVE
                  // amount, so changing the amount would silently
                  // unbalance it. The edit is refused rather than
                  // accepted: the legs are not rescaled, because
                  // inventing amounts the user never typed is worse
                  // than refusing the edit.
                  //
                  // Only an edit that CHANGES the amount is refused. An
                  // edit of the payee or the notes says nothing about
                  // the amount, and refusing it would leave the row's
                  // other fields uneditable while the message talked
                  // about the amount.
                  //
                  // The way out is the split pane's "Remove split".
                  if (
                    focused &&
                    isSplitRow(focused.edits) &&
                    edits.amountCents !== undefined &&
                    edits.amountCents !== effectiveAmountCents(focused)
                  ) {
                    setNotice(
                      t(
                        'This row is split, so its amount cannot be changed here. Remove the split first.',
                      ),
                    );
                    return;
                  }

                  // A row with no payee NAME is not a payee row. Actual
                  // creates a payee per account for transfers, with an
                  // empty name, so an empty name would land the row on
                  // one of them and turn it into a transfer to an
                  // arbitrary account.
                  if (
                    edits.payeeCanonical !== undefined &&
                    edits.payeeCanonical.trim() === ''
                  ) {
                    setNotice(
                      t('A payee needs a name. Pick one from the list.'),
                    );
                    return;
                  }

                  // Giving a row a payee takes the transfer away: a
                  // transfer row is not a payee row, its payee IS the
                  // transfer. The user is told, because the row's shape
                  // changes in a way they may not have meant.
                  if (
                    focused &&
                    effectiveTransferAccountId(focused) !== undefined &&
                    edits.payeeCanonical !== undefined
                  ) {
                    setNotice(
                      t(
                        'This row was a transfer. Giving it a payee makes it an ordinary transaction.',
                      ),
                    );
                  }

                  review.edit(review.focusedIndex, edits, { chosenPayeeId });

                  // The chain. The editor does not close: it moves on to
                  // the next field, and the LAST field's commit closes it
                  // AND moves the cursor on — the row is finished.
                  //
                  // A single-field editor has no chain, so it closes and
                  // leaves the cursor where it was.
                  if (pane?.kind === 'editor' && pane.chain) {
                    // The row AS IT WILL BE after this commit: the next
                    // field depends on what the row is now, not on what
                    // it was.
                    const nextRow: PreviewRow = {
                      ...focused,
                      edits: { ...focused.edits, ...edits },
                    };
                    const advanced = advanceChain(pane.field, nextRow);
                    if (advanced) {
                      openPane({
                        kind: 'editor',
                        field: advanced.field,
                        chain: advanced.chain,
                      });
                      return;
                    }
                    openPane(null);
                    // Finishing the chain finishes the row: it is a plain
                    // accept, just like `a`, so the trust gate still has
                    // the last word on whether it imports. This must come
                    // BEFORE moveFocus — that advances focusedIndexRef,
                    // which `decide` reads for the undo cursor.
                    review.decide(review.focusedIndex, 'accept');
                    review.moveFocus(1);
                    return;
                  }

                  openPane(null);
                }}
              />
            ) : null}

            {notice ? (
              <Text
                data-testid="import-review-notice"
                style={{ color: theme.warningText }}
              >
                {notice}
              </Text>
            ) : null}

            {pane?.kind === 'split' && focused ? (
              <SplitPane
                row={focused}
                categories={review.categories}
                // A rule that controls the amount changes what the row
                // will hold, so the legs have to add up to THAT.
                targetAmountCents={focusedRuledAmount}
                onCommit={(edits: PreviewEdits) => {
                  // A row that is already in the budget can be split:
                  // the apply step rewrites the legs of the transaction
                  // it matched, the same way upstream's own UI does when
                  // a split is edited.
                  review.edit(review.focusedIndex, edits);
                  openPane(null);
                }}
              />
            ) : null}

            {pane?.kind === 'transfer' && focused ? (
              <TransferPane
                row={focused}
                accounts={review.accounts}
                payees={review.payees}
                // The transfer target cannot be the account the row is
                // IN: a transaction cannot transfer to the account it is
                // in. The row's account is the one that counts.
                sourceAccountId={focused.accountId}
                onCommit={(edits: PreviewEdits) => {
                  review.edit(review.focusedIndex, edits);
                  openPane(null);
                }}
              />
            ) : null}

            {pane?.kind === 'help' ? <HelpOverlay /> : null}

            {pane?.kind === 'rules' ? (
              <RulePicker items={pane.items} onPick={pickRuleItem} />
            ) : null}
          </View>

          {/* The footer: the bulk actions on the left, and the keys
                that drive the list on the right.

                The bulk actions used to exist only as keys — they were
                in the help overlay and nowhere else — and a button that
                says what it does, with the key that does it, is the
                difference between a feature and a secret.

                A pane that is open already says its own keys where they
                matter, so the strip keeps quiet while one is. */}
        </View>
        <View
          style={{
            flexShrink: 0,
            // These were inherited from the content column when the
            // strip lived inside it: the inset, and the gap above the
            // pane or detail region it used to follow.
            padding: '0 16px 16px',
            marginTop: 12,
            display: pane === null ? undefined : 'none',
          }}
        >
          {pane === null ? (
            <HintStrip
              actions={
                <View
                  style={{
                    flexDirection: 'row',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <Button
                    variant="bare"
                    data-testid="import-review-accept-all"
                    // Nothing to decide is nothing to do.
                    isDisabled={summary.pending === 0}
                    onPress={() => {
                      review.decideAll('accept');
                      focusGrid();
                    }}
                  >
                    <Trans>Accept all</Trans>
                    <KeyCap>Shift+A</KeyCap>
                  </Button>
                  <Button
                    variant="bare"
                    data-testid="import-review-drop-all"
                    isDisabled={summary.pending === 0}
                    onPress={() => {
                      review.decideAll('drop');
                      focusGrid();
                    }}
                  >
                    <Trans>Drop all</Trans>
                    <KeyCap>Shift+R</KeyCap>
                  </Button>
                  <Button
                    variant="bare"
                    data-testid="import-review-undo"
                    // The undo stack is not reactive, so this is the
                    // closest signal there is: there is nothing to undo
                    // exactly when there is no unsaved work.
                    isDisabled={!review.unsavedWork.hasWork}
                    onPress={() => {
                      review.undo();
                      focusGrid();
                    }}
                  >
                    <Trans>Undo</Trans>
                    <KeyCap>u</KeyCap>
                  </Button>
                </View>
              }
            />
          ) : null}
        </View>
      </View>
      {leaveModalOpen ? (
        <LeaveImportModal
          decided={review.unsavedWork.decided}
          edited={review.unsavedWork.edited}
          onKeep={() => setLeaveModalOpen(false)}
          onSaveAndLeave={saveAndLeave}
          onDiscardAndLeave={discardAndLeave}
        />
      ) : null}
    </>
  );
}

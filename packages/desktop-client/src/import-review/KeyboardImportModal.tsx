import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PressEvent } from 'react-aria-components';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import {
  SvgBlock,
  SvgCheckmark,
  SvgClose,
  SvgFlag,
  SvgPause,
  SvgTag,
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
  TrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';
import { format as formatDate, parseISO } from 'date-fns';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useDateFormat } from '#hooks/useDateFormat';
import { pushModal, removeModal } from '#modals/modalsSlice';
import { useDispatch, useSelector } from '#redux';

import { ConfirmPane } from './ConfirmPane';
import { EDITOR_FOR_ACTION } from './editor-mode';
import type { EditorMode } from './editor-mode';
import { hasOverridableHeldRow, isOverridableHeld } from './held-rows';
import { HelpOverlay } from './HelpOverlay';
import { HintStrip } from './HintStrip';
import { KeyCap } from './KeyCap';
import { actionForHotkey, KEYMAP, REVIEW_SCOPE, TRUST_LEVELS } from './keymap';
import type { ReviewAction } from './keymap';
import { ReviewColumns } from './review-columns';
import { RowEditor } from './RowEditor';
import {
  editChangesRuledField,
  RULED_FIELD_FOR_MODE,
  visibleEffectFor,
  visibleEffectsFor,
} from './rule-effects';
import type { RuledField, RuleEffect } from './rule-effects';
import { RuledCell, useClearedByRuleLabel } from './RuledCell';
import { rulesForRow } from './rules';
import type { ReviewRule } from './rules';
import type { ImportReviewSession } from './session';
import { SplitPane } from './SplitPane';
import { TransferPane } from './TransferPane';
import { useImportReview } from './use-import-review';
import { ZoneLabel } from './ZoneLabel';

export type KeyboardImportModalProps = {
  accountId: string;
  filename: string;
  /**
   * The saved review to pick up, instead of a file.
   *
   * A session holds the rows that were already parsed, so there is no
   * file to read: the review continues where it was left.
   */
  session?: ImportReviewSession | undefined;
  onImported: (didChange: boolean) => void;
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
  | { kind: 'editor'; field: EditorMode }
  | { kind: 'split' }
  | { kind: 'transfer' }
  | { kind: 'help' }
  | { kind: 'confirm' }
  | null;

/**
 * The keyboard-driven import review.
 *
 * The modal owns its own hotkey scope (Actual's `Modal` component enables a
 * scope named after the modal and disables the `app` scope while it is
 * open), so the bindings below never fire the app-level shortcuts.
 */
export function KeyboardImportModal({
  accountId,
  filename,
  session,
  onImported,
}: KeyboardImportModalProps) {
  const { t } = useTranslation();
  const dispatchModal = useDispatch();
  /**
   * Close the review, by name.
   *
   * The review removes ITSELF from the modal stack rather than popping the
   * top of it. The difference matters: an apply can push another modal on
   * top of the review — Actual offers to merge an unused payee when the
   * review gives a transaction a new one — and popping the top would close
   * THAT modal and leave the review on screen, with the import finished and
   * no sign of it.
   *
   * Removing the review by name leaves the other modal alone, which is what
   * the user expects: the import is done, and the question about the payee
   * is still theirs to answer.
   */
  const closeReview = useCallback(() => {
    dispatchModal(removeModal({ name: REVIEW_SCOPE }));
  }, [dispatchModal]);
  const review = useImportReview({
    accountId,
    filename,
    session,
    onImported,
  });
  const { enableScope, disableScope } = useHotkeysContext();

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

  // Why the last thing the user asked for did not happen.
  //
  // It is shown next to the pane rather than in it, because the pane it
  // belongs to may not even be open: a row that cannot be split is
  // refused before the pane opens.
  const [notice, setNotice] = useState<string | null>(null);

  // The trust level is a domain value, so it is translated at the point it
  // is shown rather than translated inside the domain layer.
  const trustLevelLabel = (level: TrustLevel): string => {
    switch (level) {
      case 'paranoid':
        return t('paranoid');
      case 'cautious':
        return t('cautious');
      case 'trusted':
        return t('trusted');
      default:
        return t('cautious');
    }
  };

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
      return { label: t('Blocked'), tone: 'error', Icon: SvgBlock };
    }
    if (evaluation.gate === 'skip') {
      return { label: t('Skipped'), tone: 'error', Icon: SvgPause };
    }
    if (evaluation.gate === 'warn') {
      return { label: t('Flagged'), tone: 'warning', Icon: SvgFlag };
    }
    // The user's own decision, on a row the gate has nothing to say about.
    if (row.decision === 'accept') {
      return { label: t('Accepted'), tone: 'success', Icon: SvgCheckmark };
    }
    return null;
  };

  /**
   * One number in the status line: an icon, a count, and a word.
   *
   * The icon is the same one the status column wears for the same
   * state, so the line and the column read as one vocabulary.
   */
  const statusCount = (icon: ReactNode, children: ReactNode) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <View style={{ width: 13, height: 13 }}>{icon}</View>
      <Text style={styles.tnum}>{children}</Text>
    </View>
  );

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
    if (isSplitRow(row.edits)) {
      return {
        // The count is NOT named `count`: i18next reads that as a
        // plural, and this is a number of legs, not a number of
        // something countable.
        label: t('Split ({{legs}})', { legs: row.edits.splits?.length ?? 0 }),
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
          ruled: true,
          cleared: false,
        };
      }
      // The rule CONTROLLED the amount and left it empty. The cell says
      // so rather than falling through to the row's own amount, which
      // would be a lie: the rule owns the field.
      return {
        amount: integerToAmount(0),
        ruled: true,
        cleared: true,
      };
    }
    return {
      amount: integerToAmount(row.edits.amountCents ?? row.amountCents),
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
  ): { date: string; ruled: boolean; cleared: boolean } => {
    const effect = visibleEffectFor(review.ruleEffects, row, 'date');
    if (effect) {
      if (typeof effect.value === 'string') {
        return {
          date: reviewDate(effect.value),
          ruled: true,
          cleared: false,
        };
      }
      // The rule CONTROLLED the date and left it empty. The cell says so
      // rather than falling through to the row's own date, which would be
      // a lie: the rule owns the field.
      return { date: '', ruled: true, cleared: true };
    }
    return {
      date: reviewDate(row.edits.date ?? row.date),
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
      default:
        return t('This row needs a look');
    }
  };

  const rows = review.state?.rows ?? [];

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
  const focusedAmountLabel = focusedAmount
    ? focusedAmount.cleared
      ? clearedByRule
      : focusedAmount.amount.toFixed(2)
    : undefined;
  const focusedCategoryGroup = focused
    ? categoryCell(focused).group
    : undefined;

  const focusedEvaluation = focused
    ? review.evaluations.get(rowKey(focused))
    : undefined;

  const anyHeldRowOverridable = useMemo(
    () => hasOverridableHeldRow(review.evaluations),
    [review.evaluations],
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
   * new rule, because the rule is already there — "Edit this rule" is
   * the way out.
   */
  const focusedRuledFields = useMemo(() => {
    const fields = new Set<RuledField>();
    for (const effect of focusedEffects) {
      fields.add(effect.field);
    }
    return fields;
  }, [focusedEffects]);

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
  const ruledFieldName = (field: RuledField): string => {
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
  };

  /**
   * What a rule set on a field, as the details panel says it.
   *
   * The VALUE matters as much as the field: the user has to see what
   * the rule will do, not merely that something will.
   *
   * It agrees with the CELL, because a panel that says one thing and a
   * cell that says another is worse than either.
   */
  const ruledValueLabel = (effect: RuleEffect): string => {
    if (effect.field === 'payee') {
      if (effect.value === null) return t('no payee');
      // A payee the budget does not have — deleted, or a stale list — is
      // shown as its id, so the panel and the cell say the same thing.
      return payeeNames.get(String(effect.value)) ?? String(effect.value);
    }
    if (effect.field === 'category') {
      if (effect.value === null) return t('no category');
      return categoryNames.get(String(effect.value)) ?? String(effect.value);
    }
    if (effect.field === 'amount') {
      if (effect.value === null) return t('no amount');
      return typeof effect.value === 'number'
        ? String(integerToAmount(effect.value))
        : t('an amount');
    }
    if (effect.field === 'date') {
      if (effect.value === null) return t('no date');
      return typeof effect.value === 'string' ? effect.value : t('a date');
    }
    return typeof effect.value === 'string' ? effect.value : t('some notes');
  };

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

  // The live payee names, so the trust-level chips below agree with the
  // badges: both have to answer the same question about the same row.
  const livePayeeNames = useMemo(
    () => new Set(review.payees.map(p => normalizePayeeName(p.name))),
    [review.payees],
  );

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
      setPane({ kind: 'confirm' });
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
      case 'cycle-flag':
        review.cycleTrustLevel();
        break;
      case 'save-session':
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
      case 'apply':
        // A rule is being written: the import would race the write, and
        // the rule the user just made might or might not be in the
        // import. The Import button is off for the same reason.
        if (creatingRule) break;
        void review.apply().then(didChange => {
          if (didChange) closeReview();
        });
        break;
      case 'close':
        requestClose();
        break;
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
  };

  // One binding for the whole keymap. `react-hotkeys-hook` reports the
  // hotkey that matched, and the action is resolved from it.
  const allKeys = KEYMAP.map(binding => binding.keys).join(', ');

  useHotkeys(
    allKeys,
    (event, handler) => {
      // The letter bindings must not fire while the user is typing.
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      }
      // The matched hotkey, not the parsed key list: for `ctrl+a` and `a`
      // the parsed key list is `['a']` in both cases.
      const action = actionForHotkey(handler.hotkey);
      if (!action) return;
      event.preventDefault();
      dispatch(action);
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
      // A guard inside the handler would not do either. `tab` would still
      // cycle the trust level, the arrow keys would still move the row
      // focus, and `escape` would still discard the whole review — and
      // `react-hotkeys-hook` listens on the document, so a child
      // component calling `preventDefault()` does not stop any of them.
      //
      // The rule editor counts as a pane: it is a modal on top of the
      // review, and the review's own keys must not fire while the user
      // is typing a condition into it.
      enabled: pane === null && !isEditingRule,
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
    disableScope('app');
    return () => {
      enableScope('app');
    };
  }, [enableScope, disableScope]);

  const isLoading = review.status === 'parsing' || review.status === 'applying';
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

  return (
    <Modal
      name={REVIEW_SCOPE}
      isLoading={isLoading}
      // The review owns the escape key, always.
      //
      // React Aria dismisses the dialog on escape on its own, which would
      // throw the review away — every decision and edit in it — without
      // asking. So the dialog is told never to dismiss itself, and the
      // review's own escape binding is the only escape there is. It asks
      // before it throws anything away.
      isKeyboardDismissDisabled
      // A click outside the modal used to dismiss it the same way, so it
      // is turned off: the ways out of the review are the escape key and
      // the X button, and both of them ask first.
      //
      // The prop wins because upstream's `Modal` spreads the caller's
      // props over the overlay's own AFTER it sets `isDismissable`, so
      // this one replaces it.
      isDismissable={false}
      containerProps={{ style: { width: 900, maxWidth: '100%' } }}
    >
      {() => (
        <>
          <ModalHeader
            title={t('Review import')}
            leftContent={<ModalCloseButton onPress={requestClose} />}
            rightContent={
              <Button
                variant="primary"
                onPress={() => {
                  void review.apply().then(didChange => {
                    if (didChange) closeReview();
                  });
                }}
                // The Import button is off while a pane owns the
                // keyboard: the confirmation's outcomes are Keep and
                // Discard, and a split the user has not saved would be
                // applied without.
                isDisabled={
                  isLoading ||
                  rows.length === 0 ||
                  // A rule is being written: the import would race the
                  // write, and the rule the user just made might or
                  // might not be in the import.
                  creatingRule ||
                  pane?.kind === 'confirm' ||
                  pane?.kind === 'split' ||
                  pane?.kind === 'transfer'
                }
              >
                <Trans>Import</Trans>
              </Button>
            }
          />

          <View style={{ padding: 16, gap: 12 }}>
            {review.error ? (
              <Text style={{ color: theme.errorText }}>{review.error}</Text>
            ) : null}

            {/* The status line: where the review is.

                ONE line, and the numbers that matter come first — how far
                along the user is, what needs attention, and what will
                land.

                The gate's counts are ALWAYS there, zero included: "0
                flagged" is a signal — nothing needs a look. The counts
                that are quiet in most imports — the overrides, the rows a
                rule touched — only appear when they are not zero,
                because a count of nothing is noise there.

                The trust level is not here: it is a CONTROL, and it
                lives in the header with the other controls. */}
            <View
              data-testid="import-review-status"
              style={{
                flexDirection: 'row',
                gap: 14,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Text style={styles.tnum}>
                {t('{{reviewed}} of {{total}} reviewed', {
                  reviewed: summary.total - summary.pending,
                  total: summary.total,
                })}
              </Text>
              {statusCount(
                <SvgFlag
                  width={13}
                  height={13}
                  style={{ color: badgeColour('warning') }}
                />,
                t('{{count}} flagged', { count: summary.warned }),
              )}
              {statusCount(
                <SvgPause
                  width={13}
                  height={13}
                  style={{ color: badgeColour('error') }}
                />,
                t('{{count}} skipped', { count: summary.skipped }),
              )}
              {statusCount(
                <SvgBlock
                  width={13}
                  height={13}
                  style={{ color: badgeColour('error') }}
                />,
                t('{{count}} blocked', { count: summary.blocked }),
              )}
              {summary.overridden > 0
                ? statusCount(
                    <SvgFlag
                      width={13}
                      height={13}
                      style={{ color: badgeColour('warning') }}
                    />,
                    t('{{count}} overridden', { count: summary.overridden }),
                  )
                : null}
              {statusCount(
                <SvgCheckmark
                  width={13}
                  height={13}
                  style={{ color: badgeColour('success') }}
                />,
                t('{{count}} will import', { count: summary.willImport }),
              )}
              {ruledRowCount > 0
                ? statusCount(
                    <SvgTag
                      width={13}
                      height={13}
                      style={{ color: theme.ruleLockText }}
                    />,
                    t('{{count}} set by rules', { count: ruledRowCount }),
                  )
                : null}
              <Text style={{ ...styles.tnum, color: theme.pageTextSubdued }}>
                {t('{{in}} in · {{out}} out', {
                  in: summary.inflowCount,
                  out: summary.outflowCount,
                })}
              </Text>
            </View>

            {/* Where the file is going. It is the table's CAPTION, not a
                row: it says where everything below it lands. */}
            <View data-testid="import-review-destination">
              <Text
                style={{
                  color: theme.pageTextSubdued,
                  fontWeight: 500,
                }}
              >
                {t('Importing into {{account}}', {
                  account: accountName(accountId),
                })}
              </Text>
            </View>

            <View
              style={{
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <View
                role="table"
                style={{
                  // The list grows with its content and stops at half the
                  // screen: the modal sizes to what it has to show, and
                  // the table scrolls only when there is something to
                  // scroll.
                  maxHeight: 'min(50vh, 640px)',
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
                            color: theme.pageTextSubdued,
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
                            color: theme.pageTextSubdued,
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
                            color: theme.pageTextSubdued,
                            fontWeight: 500,
                          }}
                        >
                          <Trans>Category</Trans>
                        </Text>
                      ),
                    }}
                    group={{
                      testId: 'import-review-header-group',
                      role: 'columnheader',
                      children: (
                        <Text
                          style={{
                            color: theme.pageTextSubdued,
                            fontWeight: 500,
                          }}
                        >
                          <Trans>Group</Trans>
                        </Text>
                      ),
                    }}
                    amount={{
                      testId: 'import-review-header-amount',
                      role: 'columnheader',
                      children: (
                        <Text
                          style={{
                            color: theme.pageTextSubdued,
                            fontWeight: 500,
                            textAlign: 'right',
                          }}
                        >
                          <Trans>Amount</Trans>
                        </Text>
                      ),
                    }}
                    status={{
                      testId: 'import-review-header-status',
                      role: 'columnheader',
                      children: (
                        <Text
                          style={{
                            color: theme.pageTextSubdued,
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
                  const evaluation = review.evaluations.get(rowKey(row));
                  const badge = evaluation ? gateBadge(row, evaluation) : null;
                  const category = categoryCell(row);
                  const payee = payeeCell(row);
                  const amountCellValue = amountCell(row);
                  const dateCellValue = dateCell(row);
                  return (
                    <View
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
                                  ? theme.pageTextSubdued
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
                                fontStyle: category.muted
                                  ? 'italic'
                                  : undefined,
                                color: category.muted
                                  ? theme.pageTextSubdued
                                  : undefined,
                              }}
                            >
                              {category.label}
                            </TextOneLine>
                          ),
                        }}
                        group={{
                          testId: 'import-review-row-category-group',
                          role: 'cell',
                          children: (
                            /* The group, so two categories with the
                               same name are distinguishable. It is
                               subdued: the name is what the user is
                               looking for. */
                            <TextOneLine
                              size="small"
                              title={category.group}
                              style={{ color: theme.pageTextSubdued }}
                            >
                              {category.group}
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
                style={{ gap: 12, maxHeight: 260 }}
                data-testid="import-review-details"
              >
                {/* The zones scroll; the ACTIONS stay put, because the
                    actions are what the user came for. */}
                <View
                  style={{ gap: 12, flex: 1, overflowY: 'auto' }}
                  data-testid="import-review-zones"
                >
                  {/* ZONE 1 — EVIDENCE: the facts about this row.

                      The list carries the date, the payee, the category
                      and the amount for the row the user is on. What it
                      does not carry is the file's own vendor string, the
                      notes, the amount in full and the category's group
                      — and those are exactly the things that get
                      truncated or left out. */}
                  <View style={{ gap: 4 }} data-testid="import-review-evidence">
                    <ZoneLabel>
                      <Trans>Evidence</Trans>
                    </ZoneLabel>
                    {focused.payeeRaw ? (
                      <Text data-testid="import-review-vendor">
                        <Trans>Vendor</Trans>: {focused.payeeRaw}
                      </Text>
                    ) : null}
                    <Text
                      data-testid="import-review-amount"
                      style={styles.tnum}
                    >
                      <Trans>Amount</Trans>: {focusedAmountLabel}
                    </Text>
                    {focusedCategoryGroup ? (
                      <Text data-testid="import-review-category-group">
                        <Trans>Group</Trans>: {focusedCategoryGroup}
                      </Text>
                    ) : null}
                    {focusedMemo ? (
                      <Text data-testid="import-review-notes">
                        <Trans>Notes</Trans>: {focusedMemo}
                      </Text>
                    ) : null}
                    {review.isAlreadyImported(rowKey(focused)) ? (
                      <Text data-testid="import-review-already-imported">
                        <Trans>This transaction is already in the budget</Trans>
                      </Text>
                    ) : null}
                  </View>

                  {/* ZONE 2 — REASON: why the gate is doing what it is
                      doing with this row.

                      The plain sentence first, then the outcome at each
                      trust level, then the machine code — which is
                      useful when something goes wrong and is not a
                      headline. */}
                  {focusedEvaluation?.flags.length ? (
                    <View style={{ gap: 4 }} data-testid="import-review-reason">
                      <ZoneLabel>
                        <Trans>Reason</Trans>
                      </ZoneLabel>
                      <Text>
                        {focusedEvaluation.flags
                          .map(flag => flagReason(flag.kind))
                          .join(' · ')}
                      </Text>
                      {focusedEvaluation.held ? (
                        <Text style={{ color: theme.errorText }}>
                          {focusedEvaluation.overridable
                            ? t(
                                'Held back by the trust level. Press Ctrl+Shift+A to accept it anyway.',
                              )
                            : t(
                                'Held back: this row cannot be imported until its date or amount is fixed.',
                              )}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', gap: 12 }}>
                        {TRUST_LEVELS.map(level => {
                          const gate = gateRow(focused, level, {
                            livePayeeNames,
                          });
                          const label =
                            gate === 'block'
                              ? t('Blocked')
                              : gate === 'skip'
                                ? t('Skipped')
                                : gate === 'warn'
                                  ? t('Flagged')
                                  : t('Allowed');
                          const isCurrent = level === review.trustLevel;
                          return (
                            <Text
                              key={level}
                              style={
                                isCurrent ? { fontWeight: 'bold' } : undefined
                              }
                            >
                              {trustLevelLabel(level)}: {label}
                            </Text>
                          );
                        })}
                      </View>
                      <Text
                        data-testid="import-review-flag-codes"
                        style={{
                          fontSize: 11,
                          fontFamily: 'monospace',
                          color: theme.pageTextSubdued,
                          border: `1px solid ${theme.tableBorder}`,
                          borderRadius: 3,
                          padding: '0 4px',
                          alignSelf: 'flex-start',
                        }}
                      >
                        {focusedEvaluation.flags
                          .map(flag => flag.code)
                          .join(' · ')}
                      </Text>
                    </View>
                  ) : null}

                  {/* ZONE 3 — OWNERSHIP: what the rules did to this row.

                      The field a rule owns is the rule's identity on this
                      row: two rules can touch one row, and each of them
                      has to be openable in its own right. */}
                  {focusedEffects.length > 0 ? (
                    <View style={{ gap: 4 }} data-testid="import-review-ruled">
                      <ZoneLabel>
                        <Trans>Ownership</Trans>
                      </ZoneLabel>
                      {focusedEffects.map(effect => (
                        <Text
                          key={effect.field}
                          data-testid="import-review-ruled-field"
                          data-field={effect.field}
                          style={{ color: theme.ruleLockText }}
                        >
                          {t('A rule sets the {{field}} to {{value}}.', {
                            field: ruledFieldName(effect.field),
                            value: ruledValueLabel(effect),
                          })}
                        </Text>
                      ))}
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {/* One button per rule. Two rules can control two
                            fields of the same row, and the button has to
                            open the rule the user means. */}
                        {focusedRuleIds.map(ruleId => (
                          <Button
                            key={ruleId}
                            data-testid="import-review-edit-rule"
                            onPress={() => {
                              const rule = review.rules.find(
                                candidate => candidate.id === ruleId,
                              );
                              // The rule is not in the budget's list — it
                              // was made on another device, or the list is
                              // stale. There is nothing to open.
                              if (!rule) {
                                setNotice(
                                  t(
                                    'That rule is not in this budget any more.',
                                  ),
                                );
                                return;
                              }
                              dispatchModal(
                                pushModal({
                                  modal: {
                                    name: 'edit-rule',
                                    options: {
                                      rule,
                                      // The rule is saved in upstream's own
                                      // editor. When it lands, the review
                                      // asks the engine again, so the row
                                      // shows the rule's NEW effect.
                                      onSave: async () => {
                                        await review.refreshRuleEffects();
                                      },
                                    },
                                  },
                                }),
                              );
                            }}
                          >
                            <Trans>Edit this rule</Trans>
                          </Button>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {focusedRules &&
                  ((focusedRules.vendorToPayee &&
                    !focusedRuledFields.has('payee')) ||
                    (focusedRules.payeeToCategory &&
                      !focusedRuledFields.has('category'))) ? (
                    <View style={{ gap: 4 }}>
                      <View
                        style={{ flexDirection: 'row', gap: 8 }}
                        data-testid="import-review-rules"
                      >
                        {focusedRules.vendorToPayee &&
                        !focusedRuledFields.has('payee') ? (
                          <Button
                            data-testid="import-review-rule-vendor-to-payee"
                            isDisabled={creatingRule}
                            onPress={() => {
                              void createRule(
                                focusedRules.vendorToPayee,
                                t(
                                  'Rule created. This vendor will always use this payee, from now on.',
                                ),
                              );
                            }}
                          >
                            <Trans>Always this payee for this vendor</Trans>
                          </Button>
                        ) : null}
                        {focusedRules.payeeToCategory &&
                        !focusedRuledFields.has('category') ? (
                          <Button
                            data-testid="import-review-rule-payee-to-category"
                            isDisabled={creatingRule}
                            onPress={() => {
                              void createRule(
                                focusedRules.payeeToCategory,
                                t(
                                  'Rule created. This payee will always use this category, from now on.',
                                ),
                              );
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
                  style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}
                  data-testid="import-review-actions"
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
                    variant="bare"
                    data-testid="import-review-edit-payee"
                    onPress={event => pressOnce(event, 'edit-payee')}
                  >
                    <Trans>Edit payee</Trans>
                    <KeyCap>e</KeyCap>
                  </Button>
                  <Button
                    variant="bare"
                    data-testid="import-review-accept"
                    onPress={event => pressOnce(event, 'accept')}
                  >
                    <Trans>Accept</Trans>
                    <KeyCap>a</KeyCap>
                  </Button>
                  <Button
                    variant="bare"
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
                      variant="bare"
                      data-testid="import-review-accept-anyway"
                      onPress={event => pressOnce(event, 'accept-override')}
                    >
                      <Trans>Accept anyway</Trans>
                      <KeyCap>Ctrl+Shift+A</KeyCap>
                    </Button>
                  ) : null}
                </View>
              </View>
            ) : null}

            {pane?.kind === 'editor' && focused ? (
              <RowEditor
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
                    setNotice(
                      t(
                        "This row's {{field}} is set by a rule. Edit the rule to change it.",
                        { field: ruledFieldName(focusedLockedEffect.field) },
                      ),
                    );
                    return;
                  }

                  // A split is only valid against the row's EFFECTIVE
                  // amount, so changing the amount would silently
                  // unbalance it. The edit is refused rather than
                  // accepted: the legs are not rescaled, because
                  // inventing amounts the user never typed is worse
                  // than refusing the edit.
                  //
                  // The way out is the split pane's "Remove split".
                  if (
                    focused &&
                    isSplitRow(focused.edits) &&
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

            {pane?.kind === 'confirm' ? (
              <ConfirmPane
                decided={review.unsavedWork.decided}
                edited={review.unsavedWork.edited}
                onKeep={() => openPane(null)}
                onDiscard={confirmClose}
              />
            ) : null}

            {/* The footer: the bulk actions on the left, and the keys
                that drive the list on the right.

                The bulk actions used to exist only as keys — they were
                in the help overlay and nowhere else — and a button that
                says what it does, with the key that does it, is the
                difference between a feature and a secret.

                A pane that is open already says its own keys where they
                matter, so the strip keeps quiet while one is. */}
            {pane === null ? (
              <HintStrip
                hasOverridableHeldRow={anyHeldRowOverridable}
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
                      onPress={() => review.decideAll('accept')}
                    >
                      <Trans>Accept all</Trans>
                      <KeyCap>Shift+A</KeyCap>
                    </Button>
                    <Button
                      variant="bare"
                      data-testid="import-review-drop-all"
                      isDisabled={summary.pending === 0}
                      onPress={() => review.decideAll('drop')}
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
                      onPress={() => review.undo()}
                    >
                      <Trans>Undo</Trans>
                      <KeyCap>u</KeyCap>
                    </Button>
                  </View>
                }
              />
            ) : null}
          </View>
        </>
      )}
    </Modal>
  );
}

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useHotkeys, useHotkeysContext } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  effectiveAmountCents,
  effectiveTransferAccountId,
  gateRow,
  groupRanges,
  isSplitRow,
  normalizePayeeName,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  FlagKind,
  PreviewEdits,
  PreviewRow,
  RowEvaluation,
  TrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { removeModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { ConfirmPane } from './ConfirmPane';
import { EDITOR_FOR_ACTION } from './editor-mode';
import type { EditorMode } from './editor-mode';
import { HelpOverlay } from './HelpOverlay';
import { actionForHotkey, KEYMAP, REVIEW_SCOPE, TRUST_LEVELS } from './keymap';
import type { ReviewAction } from './keymap';
import { RoutePane } from './RoutePane';
import { RowEditor } from './RowEditor';
import type { ImportReviewSession } from './session';
import { SplitPane } from './SplitPane';
import { TransferPane } from './TransferPane';
import { useImportReview } from './use-import-review';

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
  | { kind: 'route'; scope: 'row' | 'all' }
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

  // The badge says what the gate is doing with the row. A row the gate
  // holds back is badged with the reason it is held back, not with a
  // generic "problem", because the two need different things from the
  // user: a held row can be overridden, a flagged one only needs a look.
  //
  // A dropped row is badged as dropped: the user threw it away, which is a
  // stronger statement than the gate, and badging it "Blocked" would say
  // the opposite of what happened to it.
  const gateBadge = (
    row: { decision: string },
    evaluation: RowEvaluation,
  ): string | null => {
    if (row.decision === 'drop') return t('Dropped');
    // An override that is in EFFECT. A hard-blocked row the user tried to
    // override is still blocked, so it is badged as blocked, the same way
    // the summary counts it.
    if (evaluation.overridden && evaluation.willImport) return t('Overridden');
    if (evaluation.gate === 'block') return t('Blocked');
    if (evaluation.gate === 'skip') return t('Skipped');
    if (evaluation.gate === 'warn') return t('Flagged');
    return null;
  };

  // The category names, looked up once: the table renders a cell for
  // every row, and finding the name in a list each time is a search per
  // row per render.
  const categoryNames = useMemo(
    () =>
      new Map(review.categories.map(category => [category.id, category.name])),
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
   */
  const payeeCell = (row: PreviewRow): { label: string } => {
    // A split keeps the vendor: the categories live on the legs, and
    // the parent still carries the payee.
    if (isSplitRow(row.edits)) {
      return { label: row.edits.payeeCanonical ?? row.payeeCanonical };
    }
    const transferAccountId = effectiveTransferAccountId(row);
    if (transferAccountId !== undefined) {
      return {
        label: accountNames.get(transferAccountId) ?? t('Transfer'),
      };
    }
    return { label: row.edits.payeeCanonical ?? row.payeeCanonical };
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
  const categoryCell = (row: PreviewRow): { label: string; muted: boolean } => {
    if (isSplitRow(row.edits)) {
      return {
        // The count is NOT named `count`: i18next reads that as a
        // plural, and this is a number of legs, not a number of
        // something countable.
        label: t('Split ({{legs}})', { legs: row.edits.splits?.length ?? 0 }),
        muted: true,
      };
    }
    // A transfer's category is the transfer pseudo-category, not a
    // budget category, so it says "Transfer" the way Actual's own
    // transactions table does.
    if (effectiveTransferAccountId(row) !== undefined) {
      return { label: t('Transfer'), muted: true };
    }
    const categoryId = row.edits.categoryId ?? row.matchedCategoryId;
    if (!categoryId) return { label: t('Categorize'), muted: true };
    const name = categoryNames.get(categoryId);
    // A category that no longer exists is dropped at the apply step, so
    // the row is imported without one: "Categorize" says so.
    if (!name) return { label: t('Categorize'), muted: true };
    return { label: name, muted: false };
  };

  // Why a row is flagged, in the user's terms. The code beside it is the
  // greppable one, for support.
  const flagReason = (kind: FlagKind): string => {
    switch (kind) {
      case 'unknown-payee':
        return t('No payee in your budget matches this vendor');
      case 'payee-rule-conflict':
        return t('A rule disagrees with the payee for this row');
      case 'amount-mismatch':
        // The reason describes the ROW, not where the problem came from:
        // the flag is derived from the value that would be sent, so it may
        // be the file's fault or an edit's.
        return t('This row has no usable amount');
      case 'date-out-of-range':
        return t('This row has no usable date');
      case 'needs-review':
        return t('This row needs a look');
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

  // The heading of each group of rows: the account its rows go into, and
  // the rows it covers.
  //
  // The heading is what makes the routing visible: the review cannot
  // tell where one bank statement ends and the next begins, so the
  // partition is the user's to make, and the user has to be able to SEE
  // it.
  const groupHeadings = useMemo(() => {
    const headings = new Map<number, { accountId: string; to: number }>();
    for (const range of groupRanges(review.groups, rows.length)) {
      headings.set(range.start, {
        accountId: range.group.accountId,
        to: range.end,
      });
    }
    return headings;
  }, [review.groups, rows.length]);

  const accountName = (id: string) =>
    accountNames.get(id) ?? t('Unknown account');
  const focused = rows[review.focusedIndex];

  // The rows the routing choice covers. The pane covers the table, so
  // the user cannot see them while the pane is open.
  //
  // No manual memo: the React Compiler memoizes this for us.
  const focusedRange = (() => {
    if (!focused) return undefined;
    for (const range of groupRanges(review.groups, rows.length)) {
      if (review.focusedIndex < range.start) continue;
      if (review.focusedIndex > range.end) continue;
      // The rows are numbered from one, the way a person counts them.
      return { from: range.start + 1, to: range.end + 1 };
    }
    return undefined;
  })();
  const focusedEvaluation = focused
    ? review.evaluations.get(rowKey(focused))
    : undefined;

  // The notes the row would be imported with. An empty string means the
  // user cleared them, so there is nothing to show.
  const focusedMemo = focused ? (focused.edits.memo ?? focused.memo ?? '') : '';

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
        void review.apply().then(didChange => {
          if (didChange) closeReview();
        });
        break;
      case 'close':
        requestClose();
        break;
      case 'route-row':
        // The routing is a partition of the rows, and the boundary is
        // the user's to place: the review cannot tell where one bank
        // statement ends and the next begins.
        if (!focused) break;
        openPane({ kind: 'route', scope: 'row' });
        break;
      case 'route-all':
        openPane({ kind: 'route', scope: 'all' });
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
      enabled: pane === null,
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
                  pane?.kind === 'confirm' ||
                  pane?.kind === 'route' ||
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

            <View
              style={{
                flexDirection: 'row',
                gap: 16,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Text style={styles.tnum}>
                <Trans>Trust level</Trans>: {trustLevelLabel(review.trustLevel)}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Accepted</Trans>: {summary.accepted}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Dropped</Trans>: {summary.dropped}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Unreviewed</Trans>: {summary.pending}
              </Text>
            </View>

            <View
              style={{
                flexDirection: 'row',
                gap: 16,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <Text style={styles.tnum}>
                <Trans>Blocked</Trans>: {summary.blocked}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Skipped</Trans>: {summary.skipped}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Flagged</Trans>: {summary.warned}
              </Text>
              {summary.overridden > 0 ? (
                <Text style={styles.tnum}>
                  <Trans>Overridden</Trans>: {summary.overridden}
                </Text>
              ) : null}
              <Text style={styles.tnum}>
                <Trans>Will import</Trans>: {summary.willImport}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Incoming</Trans>: {summary.inflowCount}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Outgoing</Trans>: {summary.outflowCount}
              </Text>
            </View>

            <View
              style={{
                border: `1px solid ${theme.tableBorder}`,
                borderRadius: 6,
                maxHeight: 420,
                overflowY: 'auto',
              }}
            >
              {rows.map((row, index) => {
                const heading = groupHeadings.get(index);
                const isFocused = index === review.focusedIndex;
                const amount = integerToAmount(
                  row.edits.amountCents ?? row.amountCents,
                );
                const evaluation = review.evaluations.get(rowKey(row));
                const badge = evaluation ? gateBadge(row, evaluation) : null;
                const category = categoryCell(row);
                const payee = payeeCell(row);
                return (
                  <Fragment
                    key={row.previewKey ?? row.importedId ?? String(index)}
                  >
                    {heading ? (
                      <View
                        data-testid="import-review-group"
                        data-account={heading.accountId}
                        style={{
                          padding: '6px 10px 2px 10px',
                          borderBottom: `1px solid ${theme.tableBorder}`,
                          marginBottom: 2,
                        }}
                      >
                        <Text
                          style={{
                            color: theme.pageTextSubdued,
                            fontWeight: 500,
                          }}
                        >
                          {t('Rows {{from}}–{{to}} of {{account}}', {
                            account: accountName(heading.accountId),
                            // The rows are numbered from one, the way a
                            // person counts them.
                            from: index + 1,
                            to: heading.to + 1,
                          })}
                        </Text>
                      </View>
                    ) : null}
                    <View
                      data-testid="import-review-row"
                      data-focused={isFocused ? 'true' : 'false'}
                      data-decision={row.decision}
                      data-gate={evaluation?.gate ?? 'allow'}
                      data-held={evaluation?.held ? 'true' : 'false'}
                      style={{
                        flexDirection: 'row',
                        gap: 12,
                        padding: '6px 10px',
                        backgroundColor: isFocused
                          ? theme.tableRowHeaderBackground
                          : 'transparent',
                      }}
                    >
                      <Text style={{ width: 90 }}>
                        {row.edits.date ?? row.date}
                      </Text>
                      <Text style={{ flex: 1 }}>{row.payeeRaw}</Text>
                      <Text style={{ width: 120 }}>{payee.label}</Text>
                      <Text
                        style={{
                          width: 130,
                          fontStyle: category.muted ? 'italic' : undefined,
                          color: category.muted
                            ? theme.pageTextSubdued
                            : undefined,
                        }}
                      >
                        {category.label}
                      </Text>
                      <FinancialText style={{ width: 100, textAlign: 'right' }}>
                        {amount}
                      </FinancialText>
                      <Text
                        style={{
                          width: 90,
                          textAlign: 'right',
                          color:
                            evaluation?.gate === 'block'
                              ? theme.errorText
                              : theme.warningText,
                        }}
                      >
                        {badge}
                      </Text>
                    </View>
                  </Fragment>
                );
              })}
            </View>

            {focused ? (
              <View style={{ gap: 4 }} data-testid="import-review-details">
                {focusedEvaluation && focusedEvaluation.flags.length > 0 ? (
                  <>
                    <Text>
                      {focusedEvaluation.flags
                        .map(flag => flagReason(flag.kind))
                        .join(' · ')}
                    </Text>
                    <Text style={styles.tnum}>
                      {focusedEvaluation.flags
                        .map(flag => flag.code)
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
                  </>
                ) : null}

                {focused && review.isAlreadyImported(rowKey(focused)) ? (
                  <Text data-testid="import-review-already-imported">
                    <Trans>This transaction is already in the budget</Trans>
                  </Text>
                ) : null}

                {focusedMemo ? (
                  <Text data-testid="import-review-notes">
                    <Trans>Notes</Trans>: {focusedMemo}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {pane?.kind === 'editor' && focused ? (
              <RowEditor
                row={focused}
                mode={pane.field}
                payees={review.payees}
                categories={review.categories}
                onCommit={(edits: PreviewEdits, chosenPayeeId?: string) => {
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

            {pane?.kind === 'route' ? (
              <RoutePane
                scope={pane.scope}
                accounts={review.accounts}
                currentAccountId={
                  pane.scope === 'row'
                    ? (focused?.accountId ?? accountId)
                    : (review.groups[0]?.accountId ?? accountId)
                }
                from={focusedRange?.from}
                to={focusedRange?.to}
                onCommit={nextAccountId => {
                  const index = review.focusedIndex;
                  const scope = pane.scope;
                  openPane(null);
                  void (
                    scope === 'all'
                      ? review.routeAll(nextAccountId)
                      : review.routeRow(index, nextAccountId)
                  ).catch(() => {
                    // The routing could not be made: the budget could
                    // not be asked, or it refused. The review says so
                    // rather than the keypress looking like it did
                    // nothing.
                    setNotice(t('The rows could not be moved to that account'));
                  });
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
                // in. The row's account is the one that counts, and it
                // changes when the user routes the row.
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
          </View>
        </>
      )}
    </Modal>
  );
}

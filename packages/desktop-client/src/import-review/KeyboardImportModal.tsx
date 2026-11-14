import { useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  gateRow,
  normalizePayeeName,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';
import type {
  FlagKind,
  RowEvaluation,
  TrustLevel,
} from '@actual-app/core/server/transactions/import/review/index';
import { integerToAmount } from '@actual-app/core/shared/util';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useModalState } from '#hooks/useModalState';

import { actionForHotkey, KEYMAP, TRUST_LEVELS } from './keymap';
import type { ReviewAction } from './keymap';
import { useImportReview } from './use-import-review';

export type KeyboardImportModalProps = {
  accountId: string;
  filename: string;
  onImported: (didChange: boolean) => void;
};

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
  onImported,
}: KeyboardImportModalProps) {
  const { t } = useTranslation();
  const { onClose } = useModalState();
  const review = useImportReview({ accountId, filename, onImported });

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

  // Why a row is flagged, in the user's terms. The code beside it is the
  // greppable one, for support.
  const flagReason = (kind: FlagKind): string => {
    switch (kind) {
      case 'unknown-payee':
        return t('No payee in your budget matches this vendor');
      case 'payee-rule-conflict':
        return t('A rule disagrees with the payee for this row');
      case 'amount-mismatch':
        return t('The file did not supply a usable amount');
      case 'date-out-of-range':
        return t('The file did not supply a usable date');
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
  const focused = rows[review.focusedIndex];
  const focusedEvaluation = focused
    ? review.evaluations.get(rowKey(focused))
    : undefined;

  // The live payee names, so the trust-level chips below agree with the
  // badges: both have to answer the same question about the same row.
  const livePayeeNames = useMemo(
    () => new Set(review.payees.map(p => normalizePayeeName(p.name))),
    [review.payees],
  );

  const dispatch = (action: ReviewAction) => {
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
        // where it is.
        if (focused && focusedEvaluation?.overridable) {
          review.decide(review.focusedIndex, 'accept-override');
        }
        break;
      case 'accept-all':
        review.state?.rows.forEach((row, index) => {
          if (row.decision === 'pending') review.decide(index, 'accept');
        });
        break;
      case 'drop':
        if (focused) {
          review.decide(review.focusedIndex, 'drop');
          review.moveFocus(1);
        }
        break;
      case 'drop-all':
        review.state?.rows.forEach((row, index) => {
          if (row.decision === 'pending') review.decide(index, 'drop');
        });
        break;
      case 'undo':
        review.undo();
        break;
      case 'cycle-flag':
        review.cycleTrustLevel();
        break;
      case 'apply':
        void review.apply().then(didChange => {
          if (didChange) onClose();
        });
        break;
      case 'close':
        review.close();
        onClose();
        break;
      case 'help':
      case 'edit-payee':
      case 'edit-category':
      case 'edit-memo':
      case 'edit-amount':
      case 'edit-transfer':
      case 'edit-split':
        // The editing chain and the help overlay are not part of v1.
        break;
      default:
        break;
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
    { scopes: ['keyboard-import-transactions'] },
  );

  const isLoading = review.status === 'parsing' || review.status === 'applying';
  const summary = review.summary;

  return (
    <Modal
      name="keyboard-import-transactions"
      isLoading={isLoading}
      containerProps={{ style: { width: 900, maxWidth: '100%' } }}
    >
      {() => (
        <>
          <ModalHeader
            title={t('Review import')}
            leftContent={<ModalCloseButton onPress={review.close} />}
            rightContent={
              <Button
                variant="primary"
                onPress={() => {
                  void review.apply().then(didChange => {
                    if (didChange) onClose();
                  });
                }}
                isDisabled={isLoading || rows.length === 0}
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
                <Trans>Pending</Trans>: {summary.pending}
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
                const isFocused = index === review.focusedIndex;
                const amount = integerToAmount(
                  row.edits.amountCents ?? row.amountCents,
                );
                const evaluation = review.evaluations.get(rowKey(row));
                const badge = evaluation ? gateBadge(row, evaluation) : null;
                return (
                  <View
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
                      backgroundColor: isFocused
                        ? theme.tableRowHeaderBackground
                        : 'transparent',
                    }}
                  >
                    <Text style={{ width: 90 }}>{row.date}</Text>
                    <Text style={{ flex: 1 }}>{row.payeeRaw}</Text>
                    <Text style={{ width: 120 }}>
                      {row.edits.payeeCanonical ?? row.payeeCanonical}
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
                );
              })}
            </View>

            {focused &&
            focusedEvaluation &&
            focusedEvaluation.flags.length > 0 ? (
              <View style={{ gap: 4 }}>
                <Text>
                  {focusedEvaluation.flags
                    .map(flag => flagReason(flag.kind))
                    .join(' · ')}
                </Text>
                <Text style={styles.tnum}>
                  {focusedEvaluation.flags.map(flag => flag.code).join(' · ')}
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
                    const gate = gateRow(focused, level, { livePayeeNames });
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
                        style={isCurrent ? { fontWeight: 'bold' } : undefined}
                      >
                        {trustLevelLabel(level)}: {label}
                      </Text>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>
        </>
      )}
    </Modal>
  );
}

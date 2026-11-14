import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { integerToAmount } from '@actual-app/core/shared/util';

import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useModalState } from '#hooks/useModalState';

import { KEYMAP } from './keymap';
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

  const rows = review.state?.rows ?? [];
  const focused = rows[review.focusedIndex];

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

  // One binding for the whole keymap. `react-hotkeys-hook` matches the key
  // list it is given and hands the callback the keys that matched, so the
  // action is resolved from the keymap rather than guessed.
  const allKeys = KEYMAP.map(binding => binding.keys).join(', ');

  useHotkeys(
    allKeys,
    (event, handler) => {
      // The letter bindings must not fire while the user is typing.
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      }
      event.preventDefault();
      // `react-hotkeys-hook` reports the matched keys as an array.
      const matchedKey = handler.keys?.[0];
      if (!matchedKey) return;
      const matched = KEYMAP.find(binding =>
        binding.keys.split(', ').some(keys => keys === matchedKey),
      );
      if (matched) dispatch(matched.action);
    },
    { scopes: ['keyboard-import-transactions'] },
  );

  const isLoading = review.status === 'parsing' || review.status === 'applying';

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
              style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}
            >
              <Text style={styles.tnum}>
                <Trans>Trust level</Trans>: {review.trustLevel}
              </Text>
              <Text style={styles.tnum}>
                <Trans>Rows</Trans>: {rows.length}
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
                return (
                  <View
                    key={row.importedId ?? row.previewKey ?? String(index)}
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
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}

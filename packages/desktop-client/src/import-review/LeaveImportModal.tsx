import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { InitialFocus } from '@actual-app/components/initial-focus';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { Modal, ModalHeader } from '#components/common/Modal';

export type LeaveImportModalProps = {
  /** How many rows the user decided. */
  decided: number;
  /** How many rows the user edited. */
  edited: number;
  /** Stay on the review. */
  onKeep: () => void;
  /** Persist the review to the session, then leave. */
  onSaveAndLeave: () => void;
  /** Throw the review away, then leave. */
  onDiscardAndLeave: () => void;
};

/**
 * The confirmation shown when the user tries to leave an import review.
 *
 * This is a modal, not the review's own `ConfirmPane`: leaving takes the
 * user out of the review entirely, so it needs the app's own overlay and
 * focus containment. The safe choice — staying — is focused by default,
 * the way `ConfirmPane` does it, so Enter never throws work away.
 */
export function LeaveImportModal({
  decided,
  edited,
  onKeep,
  onSaveAndLeave,
  onDiscardAndLeave,
}: LeaveImportModalProps) {
  const { t } = useTranslation();
  const keepRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);

  // The old in-page confirmation moved between its two choices with the
  // arrow keys. Keep that here: the safe choice starts focused, and arrows
  // step through the three in order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const order = [keepRef.current, saveRef.current, discardRef.current];
    const current = order.indexOf(document.activeElement as HTMLButtonElement);
    const next = forward
      ? Math.min(current + 1, order.length - 1)
      : Math.max(current - 1, 0);
    order[next]?.focus();
  };

  // The review used to show its confirmation as an in-page pane whose own
  // Escape binding went back to the review. Keep that behaviour: Escape
  // here means "keep reviewing", never "discard".
  useHotkeys('escape', onKeep, { enableOnFormTags: true });

  return (
    <Modal
      name="leave-import-review"
      isKeyboardDismissDisabled
      isDismissable={false}
      onClose={onKeep}
    >
      {() => (
        <>
          <ModalHeader title={t('Leave this import?')} />
          <View
            data-testid="import-review-leave-confirm"
            onKeyDown={onKeyDown}
            style={{ lineHeight: 1.5, gap: 12 }}
          >
            <Text style={{ color: theme.tableHeaderText }}>
              {t('Rows decided: {{decided}} · Rows edited: {{edited}}', {
                decided,
                edited,
              })}
            </Text>
            <Paragraph>
              <Trans>
                Your in-progress decisions will be lost unless you save the
                review first.
              </Trans>
            </Paragraph>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <InitialFocus>
                <Button
                  ref={keepRef}
                  data-testid="import-review-leave-keep"
                  onPress={onKeep}
                >
                  <Trans>Keep reviewing</Trans>
                </Button>
              </InitialFocus>
              <Button
                ref={saveRef}
                data-testid="import-review-leave-save"
                onPress={onSaveAndLeave}
              >
                <Trans>Save &amp; leave</Trans>
              </Button>
              <Button
                ref={discardRef}
                data-testid="import-review-leave-discard"
                style={{ color: theme.errorText }}
                onPress={onDiscardAndLeave}
              >
                <Trans>Discard &amp; leave</Trans>
              </Button>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}

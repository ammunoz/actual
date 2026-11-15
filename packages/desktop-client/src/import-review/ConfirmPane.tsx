import { useEffect, useId, useRef } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

export type ConfirmPaneProps = {
  /** How many rows the user decided. */
  decided: number;
  /** How many rows the user edited. */
  edited: number;
  /** Throw the review away. */
  onDiscard: () => void;
  /** Keep the review and carry on. */
  onKeep: () => void;
};

/**
 * The confirmation shown before the review throws its work away.
 *
 * It is a pane, like the editor and the help overlay: there is one
 * keyboard and one surface may have it. A nested modal would need a second
 * one, and the review's own bindings are switched off by a single flag.
 *
 * The SAFE choice is the one that starts focused. Enter activates whatever
 * is focused, so a user who reaches for the keyboard without reading the
 * pane keeps their work rather than losing it.
 */
export function ConfirmPane({
  decided,
  edited,
  onDiscard,
  onKeep,
}: ConfirmPaneProps) {
  const { t } = useTranslation();

  const paneRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLButtonElement>(null);

  const titleId = useId();
  const warningId = useId();
  const countsId = useId();

  // The confirmation owns the keyboard while it is open.
  //
  // The arrow keys only reach the pane when the focus is inside it, and
  // the browser focuses whatever was clicked — so clicking the X button
  // would leave the focus outside the pane with the arrow keys going
  // nowhere. The focus is taken when the pane opens, and re-asserted after
  // every render in case something else took it.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof Node && paneRef.current?.contains(active)) return;
    keepRef.current?.focus();
  });

  // Take the focus back when it LEAVES the pane, which a render does not
  // cover: clicking the warning text blurs the button without focusing
  // anything else, and the arrow keys would go nowhere.
  //
  // The focus moving to the OTHER button is not leaving: that is what the
  // arrow keys do. `relatedTarget` is the element the focus is going to,
  // so it tells the two apart.
  //
  // `document.hasFocus()` tells a blur apart from the user leaving the
  // window, which must not pull the focus back, and a pane that is being
  // unmounted must not pull the focus back either.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && paneRef.current?.contains(next)) return;
    if (!document.hasFocus()) return;
    if (!paneRef.current?.isConnected) return;
    keepRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const isForward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const isBackward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!isForward && !isBackward) return;

    // The arrow keys choose between the two buttons, so the caret must not
    // move and the page must not scroll.
    event.preventDefault();

    // The arrows move the focus to the OTHER button, wrapping around: on
    // two buttons in a row, that is what left and right do in a radio
    // group. With neither button focused, both arrows land on the safe
    // choice: an unexpected keypress should land where it cannot destroy
    // anything.
    const active = document.activeElement;
    const target =
      active === keepRef.current ? discardRef.current : keepRef.current;
    target?.focus();
  };

  return (
    <View
      ref={paneRef}
      data-testid="import-review-confirm"
      // The confirmation interrupts: the review's other keys are off while
      // it is open. Naming it and describing it means a screen reader
      // announces what is about to happen, not just the focused button.
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={warningId}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
    >
      <Text id={titleId}>
        <Trans>Discard this import?</Trans>
      </Text>

      <Text id={countsId} style={styles.tnum}>
        {t('Rows decided: {{decided}} · Rows edited: {{edited}}', {
          decided,
          edited,
        })}
      </Text>

      <Text id={warningId} style={{ color: theme.errorText }}>
        <Trans>Your decisions and edits will be lost.</Trans>
      </Text>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          ref={keepRef}
          variant="primary"
          autoFocus
          onPress={onKeep}
          // Some screen readers announce only the focused control, so the
          // button says what is about to happen as well as what it does.
          aria-describedby={`${warningId} ${countsId}`}
          data-testid="import-review-confirm-keep"
        >
          <Trans>Keep reviewing</Trans>
        </Button>
        <Button
          ref={discardRef}
          variant="normal"
          style={{ color: theme.errorText }}
          onPress={onDiscard}
          data-testid="import-review-confirm-discard"
        >
          <Trans>Discard</Trans>
        </Button>
      </View>

      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>Arrow keys to move · Enter to choose · Escape to go back</Trans>
      </Text>
    </View>
  );
}

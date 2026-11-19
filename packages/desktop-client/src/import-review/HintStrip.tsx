import type { ReactNode } from 'react';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { HINT } from './hint-labels';

type HintStripProps = {
  /**
   * The strip's actions.
   *
   * They live on the LEFT, and the keys on the right: the buttons are
   * what the user does, and the keys are what the list is driven with.
   */
  actions?: ReactNode;
};

/**
 * The footer: the bulk actions, and the keys that are not on any button.
 *
 * The help overlay has every key the review understands, but it is only
 * reachable with `?` and it is a flat list — it does not know what the
 * user is doing. The strip does: it names the two keys a person needs
 * that the Actions zone cannot show for them.
 *
 * **It says nothing when a pane is open**, because every pane already
 * says its own keys where they matter: the field editor says "Enter to
 * confirm · Escape to cancel", the split and the transfer say "Ctrl+Enter
 * to save · Escape to cancel", and the confirmation says "Arrow keys to
 * move · Enter to choose · Escape to go back". Saying them twice would
 * be noise.
 */
export function HintStrip({ actions }: HintStripProps) {
  return (
    <View
      data-testid="import-review-hints"
      // A note is a static, readable aside — it is not a live region.
      // The repo uses no `aria-live` anywhere, and the strip does not
      // need one: the keys are reference text, not a status that changes
      // without the user doing anything.
      role="note"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: '6px 10px',
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        backgroundColor: theme.tableRowHeaderBackground,
      }}
    >
      {actions}
      <Text
        data-testid="import-review-hint-text"
        style={{
          color: theme.pageTextSubdued,
          flex: 1,
          textAlign: 'right',
        }}
      >
        {HINT}
      </Text>
    </View>
  );
}

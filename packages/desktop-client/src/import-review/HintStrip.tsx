import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { HELD_HINT, LIST_HINT } from './hint-labels';

type HintStripProps = {
  /**
   * Whether a row is held back that the user can override.
   *
   * Not "a row is blocked": a hard-blocked row cannot be overridden, and
   * a skipped one can be even though it is not counted as blocked. The
   * caller asks the evaluation, not the summary.
   */
  hasOverridableHeldRow: boolean;
};

/**
 * The hint strip: the keys that matter right now.
 *
 * The help overlay has every key the review understands, but it is only
 * reachable with `?` and it is a flat list — it does not know what the
 * user is doing. The strip does: while the list has the keyboard, it
 * says the keys that drive it.
 *
 * **It says nothing when a pane is open**, because every pane already
 * says its own keys where they matter: the field editor says "Enter to
 * confirm · Escape to cancel", the split and the transfer say "Ctrl+Enter
 * to save · Escape to cancel", and the confirmation says "Arrow keys to
 * move · Enter to choose · Escape to go back". Saying them twice would
 * be noise.
 *
 * It is rendered only while the list has the keyboard, so it cannot
 * claim a fixed height: the two variants have different lengths, and a
 * row becoming held changes which one is shown.
 */
export function HintStrip({ hasOverridableHeldRow }: HintStripProps) {
  return (
    <View
      data-testid="import-review-hints"
      // A note is a static, readable aside — it is not a live region.
      // The repo uses no `aria-live` anywhere, and the strip does not
      // need one: the keys are reference text, not a status that changes
      // without the user doing anything.
      role="note"
      style={{
        padding: '6px 10px',
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        backgroundColor: theme.tableRowHeaderBackground,
      }}
    >
      <Text style={{ color: theme.pageTextSubdued }}>
        {hasOverridableHeldRow ? HELD_HINT : LIST_HINT}
      </Text>
    </View>
  );
}

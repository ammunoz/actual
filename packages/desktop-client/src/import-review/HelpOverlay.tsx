import { Trans, useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { HELP_LABELS } from './help-labels';
import { HELP_LIMITATIONS } from './help-limitations';
import { KEYMAP } from './keymap';

/**
 * The keys as they are shown to the user.
 *
 * The keymap spells a binding the way `react-hotkeys-hook` wants it
 * (`'j, down'`); the user reads it as two keys. The shifted keys are
 * spelled the way the strip spells them, so the two surfaces agree on
 * what a key is called.
 */
const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'shift+slash': '?',
  'shift+e': 'Shift+E',
});

export function formatKeys(keys: string): string {
  return keys
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => KEY_NAMES[part] ?? part)
    .join(' / ');
}

/**
 * The help overlay: every key the review understands.
 *
 * It is rendered from the KEYMAP, so a binding cannot be added without
 * showing up here.
 */
export function HelpOverlay() {
  const { t } = useTranslation();

  const bindings = KEYMAP.filter(binding => binding.showInHelp !== false);

  return (
    <View
      data-testid="import-review-help"
      style={{
        gap: 4,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {bindings.map(binding => (
        <View
          key={binding.keys}
          data-testid="import-review-help-row"
          style={{
            flexDirection: 'row',
            gap: 12,
            alignItems: 'baseline',
            // The same reason as the review's rows: `View` sets
            // `min-height: 0` on every instance, so a row in this column
            // flex box can be shrunk to nothing and its text is clipped
            // away. A key that cannot be read is a key that does not
            // exist.
            flexShrink: 0,
          }}
        >
          <Text style={{ width: 150, flexShrink: 0 }}>
            {formatKeys(binding.keys)}
          </Text>
          <Text>{HELP_LABELS[binding.action]}</Text>
        </View>
      ))}
      <View
        style={{
          gap: 4,
          marginTop: 8,
          paddingTop: 8,
          borderTop: `1px solid ${theme.tableBorder}`,
        }}
      >
        <Text style={{ fontWeight: 500 }}>
          <Trans>Limitations</Trans>
        </Text>
        {HELP_LIMITATIONS.map((limitation, index) => (
          <Text key={index} style={{ color: theme.pageTextSubdued }}>
            {limitation}
          </Text>
        ))}
      </View>

      <Text style={{ color: theme.pageTextSubdued }}>
        {t('Press ? again or Escape to close')}
      </Text>
    </View>
  );
}

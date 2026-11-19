import type { ReactNode } from 'react';

import { styles } from '@actual-app/components/styles';
import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

export type DetailFieldProps = {
  /** The field's name — "Vendor", "Date", "Amount", … */
  label: ReactNode;
  /** The field's value. */
  children: ReactNode;
  /** A hook for the tests that read a field's value. */
  testId?: string;
  /** Money gets the app's tabular figures, so it lines up with the list. */
  numeric?: boolean;
  /**
   * Extra style for the value — money, for instance, colours by its sign.
   * Tabular figures are applied after this so numeric values still align.
   * The value's weight defaults to 500; pass `fontWeight` here to override,
   * since this style is spread over that default.
   */
  valueStyle?: CSSProperties;
};

/**
 * One fact in the detail section's Transaction zone.
 *
 * The label sits in a fixed-width column and the value starts after it, so
 * a person can scan the names on the left and read the facts on the right.
 * A `Label: value` line does neither: the eye has to find each colon and
 * the values never line up.
 *
 * The width and the alignment are the mockup's — an 84px label column with
 * a 10px gap — and the colours are the app's own tokens, so the field reads
 * in every theme.
 */
export function DetailField({
  label,
  children,
  testId,
  numeric,
  valueStyle,
}: DetailFieldProps) {
  return (
    <View
      style={{
        // View carries min-height: 0, so a field inside the detail's
        // flex column would otherwise shrink into the field below it.
        flexShrink: 0,
        flexDirection: 'row',
        gap: 10,
        alignItems: 'baseline',
      }}
      data-testid={testId}
    >
      <Text
        data-testid={testId ? `${testId}-label` : undefined}
        style={{
          color: theme.tableHeaderText,
          fontWeight: 400,
          // 84px fits the longest name ("Description" measures 74px at
          // 13px) with room to spare. At 72px it overran the column and
          // left only a 4px visual gap before the value.
          flex: '0 0 84px',
          minWidth: 84,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontWeight: 500,
          ...(numeric ? { ...valueStyle, ...styles.tnum } : valueStyle),
        }}
      >
        {children}
      </Text>
    </View>
  );
}

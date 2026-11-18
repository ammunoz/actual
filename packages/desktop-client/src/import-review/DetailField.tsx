import type { ReactNode } from 'react';

import { styles } from '@actual-app/components/styles';
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
};

/**
 * One fact in the detail section's Evidence zone.
 *
 * The label sits in a fixed-width column and the value starts after it, so
 * a person can scan the names on the left and read the facts on the right.
 * A `Label: value` line does neither: the eye has to find each colon and
 * the values never line up.
 *
 * The width and the alignment are the mockup's — a 72px label column — and
 * the colours are the app's own tokens, so the field reads in every theme.
 */
export function DetailField({
  label,
  children,
  testId,
  numeric,
}: DetailFieldProps) {
  return (
    <View
      style={{ flexDirection: 'row', gap: 6, alignItems: 'baseline' }}
      data-testid={testId}
    >
      <Text
        data-testid={testId ? `${testId}-label` : undefined}
        style={{
          color: theme.pageTextSubdued,
          fontWeight: 400,
          flex: '0 0 72px',
          minWidth: 72,
        }}
      >
        {label}
      </Text>
      <Text style={numeric ? styles.tnum : undefined}>{children}</Text>
    </View>
  );
}

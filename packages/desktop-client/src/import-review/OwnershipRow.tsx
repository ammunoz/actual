import type { ReactNode } from 'react';

import { SvgTag } from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import type { RuledField } from './rule-effects';

export type OwnershipRowProps = {
  /** The field's key, for the tests: "payee", "category", … */
  field: RuledField;
  /** The field's name, as the user reads it: "Payee", "Category", … */
  label: string;
  /** The rule, quoted: `rule "Kroger → Food"`. */
  description: ReactNode;
  /** A hook for the tests that read which field this line is about. */
  fieldTestId?: string;
  fieldNameTestId?: string;
};

/**
 * One field owned by a rule, in the detail section's Rules zone.
 *
 * The field is the rule's identity on this row: two rules can touch one
 * row, and each needs its own line. The name sits in the same 72px column
 * the Transaction zone uses, in the rule's own blue, with the glyph inside
 * that column the way the mockup draws it. The description names the rule
 * in a single translated sentence, so locales can order it as they need.
 */
export function OwnershipRow({
  field,
  label,
  description,
  fieldTestId,
  fieldNameTestId,
}: OwnershipRowProps) {
  return (
    <View
      style={{
        flexShrink: 0,
        flexDirection: 'row',
        gap: 6,
        alignItems: 'center',
      }}
      data-testid={fieldTestId}
      data-field={field}
    >
      <View
        style={{
          color: theme.ruleLockText,
          minWidth: 72,
          flex: '0 0 72px',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
        data-testid={fieldNameTestId}
      >
        <SvgTag
          width={11}
          height={11}
          style={{ color: theme.ruleLockText, opacity: 0.8 }}
        />
        <Text style={{ color: theme.ruleLockText }}>{label}</Text>
      </View>
      <Text style={{ color: theme.pageText, fontWeight: 500 }}>
        {description}
      </Text>
    </View>
  );
}

import type { ReactNode } from 'react';

import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

/**
 * The tones a count can have. The pairs are borrowed from the app's own
 * badges (`StatusBadge` in the schedules) so the status line and the app
 * speak one vocabulary.
 *
 * The rule pair is special: `ruleLockText` is only AA against the field's
 * own surface, `formInputBackground`, and not against the table's header
 * band in the dark theme. The chip wears the field's surface for that
 * reason.
 */
export const STATUS_TONES = {
  neutral: {
    color: theme.pageText,
    background: theme.tableRowHeaderBackground,
  },
  warning: {
    color: theme.warningTextDark,
    background: theme.warningBackground,
  },
  error: {
    color: theme.errorTextDarker,
    background: theme.errorBackground,
  },
  success: {
    color: theme.noticeText,
    background: theme.noticeBackgroundLight,
  },
  rule: {
    color: theme.ruleLockText,
    background: theme.formInputBackground,
  },
} as const;

export type StatusTone = keyof typeof STATUS_TONES;

export type StatusChipProps = {
  /** The state's icon, if it has one. The chip colours it. */
  icon?: ReactNode;
  /** The count and its word: "3 flagged". */
  children: ReactNode;
  /** Which state this count is about. */
  tone: StatusTone;
};

/**
 * One number in the status line.
 *
 * A count that matters says so by being BOXED. Eleven bare numbers in two
 * lines of text were what the review used to show; the boxes give the
 * numbers hierarchy and say which ones to look at.
 *
 * The icon is the same one the status column wears for the same state, so
 * the line and the column read as one vocabulary.
 */
export function StatusChip({ icon, children, tone }: StatusChipProps) {
  const colours = STATUS_TONES[tone];

  return (
    <View
      data-testid="import-review-status-chip"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 10,
        backgroundColor: colours.background,
        color: colours.color,
      }}
    >
      {icon ? <View style={{ width: 12, height: 12 }}>{icon}</View> : null}
      <Text
        style={{
          ...styles.tnum,
          fontSize: 12,
          lineHeight: '16px',
        }}
      >
        {children}
      </Text>
    </View>
  );
}

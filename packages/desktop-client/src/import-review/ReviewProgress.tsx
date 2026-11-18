import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

export type ReviewProgressProps = {
  /** How many rows the user has decided about. */
  reviewed: number;
  /** How many rows there are in all. */
  total: number;
};

/**
 * How far through the review the user is.
 *
 * The count beside it says the same thing in words — "4 of 18 reviewed" —
 * so the bar itself is decorative and is hidden from a screen reader.
 *
 * The shape is the app's own linear progress: a track and a fill. The
 * fill is in the rule lock's colour, so the status line and the ruled
 * cells speak one vocabulary.
 */
export function ReviewProgress({ reviewed, total }: ReviewProgressProps) {
  const percent = total > 0 ? (reviewed / total) * 100 : 0;

  return (
    <View
      aria-hidden
      data-testid="import-review-progress"
      style={{
        width: 64,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.pillBackground,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <View
        data-testid="import-review-progress-fill"
        style={{
          height: '100%',
          width: `${percent}%`,
          // The track rounds the ends; a rounded fill would put a
          // corner in the middle of it at partial widths.
          backgroundColor: theme.ruleLockText,
        }}
      />
    </View>
  );
}

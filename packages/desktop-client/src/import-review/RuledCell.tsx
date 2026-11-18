import { useTranslation } from 'react-i18next';

import { SvgTag } from '@actual-app/components/icons/v1';
import { TextOneLine } from '@actual-app/components/text-one-line';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

/**
 * What a ruled field says when the rule CLEARED it.
 *
 * One string for one fact: the cell in the list and the detail section
 * both say it, so they cannot drift apart.
 */
export function useClearedByRuleLabel(): string {
  const { t } = useTranslation();
  return t('Cleared by rule');
}

/**
 * A field a budget rule controls.
 *
 * The review shows the rule's value and says it is not the user's to
 * change. The treatment is the app's own read-only input — a grey field
 * with an inset edge — with the value in the rule lock's colour and a
 * tag glyph beside it.
 *
 * **The value is not dimmed.** Dimming it failed WCAG AA on the real
 * background in every theme (2.05:1 in the light theme), and a value the
 * user has to read keeps its contrast: the AFFORDANCE is removed, not
 * the information. The grey field and the glyph say "not yours"; the
 * colour says "this is what will land".
 */
export type RuledCellProps = {
  /** The rule's value, as the user reads it. */
  label: string;
  /**
   * The rule CLEARED the field.
   *
   * A cleared field has no value, and an empty blue string would be
   * invisible — so the cell says so instead.
   */
  cleared?: boolean;
  /** The tooltip, for a value too long to show. */
  title?: string;
  /**
   * Which way the value sits in the column.
   *
   * A number is right-aligned, so its column reads as a column; without
   * this a ruled amount would sit at the LEFT of its column while every
   * other amount sat at the right.
   */
  align?: 'left' | 'right';
};

export function RuledCell({
  label,
  cleared = false,
  title,
  align = 'left',
}: RuledCellProps) {
  const clearedLabel = useClearedByRuleLabel();

  return (
    <View
      data-ruled-field="true"
      title={title}
      style={{
        // The field hugs its text. Its column is a `View`, which is a
        // COLUMN flex box, so `alignSelf` is the horizontal axis here:
        // the field takes its content's width instead of stretching to
        // the column.
        //
        // `maxWidth` keeps it inside the column when the value is longer
        // than the column has room for — the text truncates with an
        // ellipsis rather than the field spilling into the next one.
        //
        // A right-aligned field sits at the RIGHT of its column, the
        // way the plain cell's text does.
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        padding: '0 5px',
        borderRadius: 3,
        backgroundColor: theme.formInputBackground,
        // An INSET shadow, not a border: a border would shift the text
        // by a pixel inside a fixed-width cell, and would need
        // `boxSizing: 'border-box'` to avoid changing the column's
        // width.
        boxShadow: `inset 0 0 0 1px ${theme.ruleLockBorder}`,
        // The glyph is `fill="currentColor"`, so this paints it too.
        color: theme.ruleLockText,
      }}
    >
      <SvgTag
        width={11}
        height={11}
        // The glyph is a marker, not the message: at full strength it
        // crowds the word it sits beside.
        style={{ opacity: 0.8, flexShrink: 0 }}
      />
      <TextOneLine
        style={{
          color: theme.ruleLockText,
          fontStyle: cleared ? 'italic' : undefined,
        }}
      >
        {cleared ? clearedLabel : label}
      </TextOneLine>
    </View>
  );
}

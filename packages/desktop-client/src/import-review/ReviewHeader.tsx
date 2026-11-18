import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { TrustLevel } from '@actual-app/core/server/transactions/import/review/index';
import { css } from '@emotion/css';
import type { TFunction } from 'i18next';

import { ModalCloseButton } from '#components/common/Modal';

import { KeyCap } from './KeyCap';
import { TRUST_LEVEL_KEYS, TRUST_LEVELS } from './keymap';

/**
 * The id of the review's title.
 *
 * The modal is labelled by its title, so a screen reader says what the
 * dialog is instead of the app's generic "Modal dialog".
 */
export const REVIEW_TITLE_ID = 'import-review-title';

/**
 * The id of the trust level control's label.
 *
 * The control is labelled BY its visible label, so a screen reader reads
 * it once and reads the same words the user sees.
 */
const TRUST_LABEL_ID = 'import-review-trust-label';

export type ReviewHeaderProps = {
  /** The trust level the review is at. */
  trustLevel: TrustLevel;
  /** Whether the trust control can be changed right now. */
  isTrustDisabled: boolean;
  /** Change the trust level. */
  onTrustLevelChange: (level: TrustLevel) => void;
  /** How many transactions the import will write. */
  willImport: number;
  /** Whether the Import button is available. */
  isImportDisabled: boolean;
  /** Apply the import. */
  onApply: () => void;
  /** Close the review. */
  onClose: () => void;
};

/**
 * The trust level's name, in the user's words.
 *
 * The trust level is a domain value, so it is translated at the point it
 * is shown rather than translated inside the domain layer.
 */
export function trustLevelLabel(t: TFunction, level: TrustLevel): string {
  switch (level) {
    case 'paranoid':
      return t('Paranoid');
    case 'cautious':
      return t('Cautious');
    case 'trusted':
      return t('Trusted');
    default:
      return t('Cautious');
  }
}

/**
 * The review's header.
 *
 * **It is not the app's `ModalHeader`, and that is the point.**
 *
 * `ModalHeader` centres its title in `calc(100% - 60px)` and positions its
 * `rightContent` absolutely at `right: 0`. Every other modal in the app puts
 * a single ~30px close button there, so nothing ever reached the title. This
 * review puts the trust level there — three buttons, a segmented control and
 * three key caps — and it reached: the title's glyphs and the first trust
 * level painted over each other, and the header read "Review impor**t**paranoid".
 *
 * So the review builds its own header: one flex row, with the things that
 * belong together next to each other. Nothing is positioned over anything
 * else, and the next person to add a control cannot reintroduce the
 * collision.
 */
export function ReviewHeader({
  trustLevel,
  isTrustDisabled,
  onTrustLevelChange,
  willImport,
  isImportDisabled,
  onApply,
  onClose,
}: ReviewHeaderProps) {
  const { t } = useTranslation();

  /**
   * The Import button's label.
   *
   * The count is in the label, because the label is the thing the user is
   * about to click, and "how much" is part of what it means.
   *
   * The singular and the plural are TWO keys, not one key with a plural
   * suffix. The app's English catalogue is generated, and the generator
   * cannot derive "transaction" from "transactions" — so a `count` leaves
   * both forms saying "transactions". The app has this problem already
   * ("1 associated rules"), and this string does not want to join it.
   */
  const importLabel =
    willImport === 1
      ? t('Import {{willImport}} transaction', { willImport })
      : t('Import {{willImport}} transactions', { willImport });

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        // The header wraps rather than overflowing: the modal is 900px
        // wide, but it is capped at the viewport, and a narrow window
        // must not push the Import button off the screen.
        flexWrap: 'wrap',
        columnGap: 16,
        rowGap: 8,
        minHeight: 60,
        flex: 'none',
      }}
    >
      {/* The X closes the review, and so does Escape. The button says
          which key does the same thing. */}
      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
        <ModalCloseButton onPress={onClose} />
        <KeyCap>
          <Trans>Escape</Trans>
        </KeyCap>
      </View>

      {/* The title. It is the dialog's heading, and the modal is labelled
          by it — see `REVIEW_TITLE_ID`. */}
      <Text
        id={REVIEW_TITLE_ID}
        role="heading"
        aria-level={1}
        style={{
          fontSize: 25,
          fontWeight: 700,
          whiteSpace: 'nowrap',
        }}
      >
        <Trans>Review import</Trans>
      </Text>

      {/* The trust level is a CONTROL with three options, not a line of
          text in the status strip. The keys are on the buttons, so a
          mouse user and a keyboard user are doing the same thing. */}
      <Text
        id={TRUST_LABEL_ID}
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: theme.pageTextSubdued,
          whiteSpace: 'nowrap',
        }}
      >
        <Trans>Trust level</Trans>
      </Text>
      <View
        role="group"
        aria-labelledby={TRUST_LABEL_ID}
        style={{
          flexDirection: 'row',
          border: `1px solid ${theme.tableBorder}`,
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        {TRUST_LEVELS.map(level => {
          const isCurrent = level === trustLevel;
          return (
            <Button
              key={level}
              variant="bare"
              aria-pressed={isCurrent}
              data-testid={`import-review-trust-${level}`}
              isDisabled={isTrustDisabled}
              onPress={() => onTrustLevelChange(level)}
              className={css({
                padding: '5px 10px',
                borderRadius: 0,
                // The edge between the segments is drawn with a shadow,
                // not a border: a border would push the label a pixel to
                // the right of the ones above and below it.
                boxShadow: `inset 1px 0 0 ${theme.tableBorder}`,
                '&:first-of-type': { boxShadow: 'none' },
                ...(isCurrent
                  ? {
                      backgroundColor: theme.formInputBackground,
                      color: theme.ruleLockText,
                      fontWeight: 'bold',
                    }
                  : { color: theme.pageTextSubdued }),
                // The colours are in a CLASS and not in an inline style,
                // so the button's own hover and pressed rules still
                // apply — an inline style beats them — and a disabled
                // control looks disabled.
                '&[data-disabled]': {
                  backgroundColor: theme.buttonBareDisabledBackground,
                  color: theme.buttonBareDisabledText,
                },
              })}
            >
              {trustLevelLabel(t, level)}
              <KeyCap>{TRUST_LEVEL_KEYS[level]}</KeyCap>
            </Button>
          );
        })}
      </View>

      {/* The Import button is the review's one primary action, and it
          says how much it will do. */}
      <View style={{ marginLeft: 'auto', flexDirection: 'row', gap: 8 }}>
        <Button
          variant="primary"
          data-testid="import-review-import"
          isDisabled={isImportDisabled}
          onPress={onApply}
        >
          {importLabel}
          <KeyCap>Ctrl+S</KeyCap>
        </Button>
      </View>
    </View>
  );
}

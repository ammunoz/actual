/**
 * The command-bar entry that turns the keyboard import review on and off.
 *
 * The feature is opt-in, and this is how a user turns it on. The command
 * bar is the natural home for it: it is the power-user surface, and it
 * already hosts the other "jump to a thing" commands.
 *
 * The state lives in a synced preference, so it follows the user to their
 * other devices.
 */

import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SvgKeyboard } from '@actual-app/components/icons/v1';

import { KEYBOARD_MODE_PREF } from './types';
import { useCustomSyncedPref } from './use-custom-synced-pref';

export type ImportReviewCommandItem = {
  id: string;
  name: string;
  Icon: typeof SvgKeyboard;
};

export type UseImportReviewCommand = {
  /** The command-bar item. */
  item: ImportReviewCommandItem;
  /** Whether the keyboard review is currently on. */
  isEnabled: boolean;
  /** Turn the keyboard review on or off. */
  toggle: () => void;
};

/**
 * Read the preference and build the command-bar item.
 */
export function useImportReviewCommand(): UseImportReviewCommand {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useCustomSyncedPref(KEYBOARD_MODE_PREF);

  const isEnabled = enabled === 'true';

  const toggle = useCallback(() => {
    setEnabled(isEnabled ? 'false' : 'true');
  }, [isEnabled, setEnabled]);

  const item = useMemo<ImportReviewCommandItem>(
    () => ({
      id: 'import-review-keyboard-mode',
      name: isEnabled
        ? t('Keyboard import review: on')
        : t('Keyboard import review: off'),
      Icon: SvgKeyboard,
    }),
    [isEnabled, t],
  );

  return { item, isEnabled, toggle };
}

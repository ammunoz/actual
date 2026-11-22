/**
 * Decides which import experience to open.
 *
 * This is the single seam between Actual's own import flow and ours. It
 * lives in our code so that the decision — which experience, for which
 * file, under which preference — is ours, and upstream's `Account.tsx`
 * only has to ask for "an import".
 *
 * When the feature is off, or the file is not an OFX/QFX file, this returns
 * Actual's own modal descriptor, byte-for-byte identical to what upstream
 * would have pushed. That is what makes the feature safe to ship opt-in:
 * an upstream user's experience does not change at all.
 *
 * With the feature on, it returns a NAVIGATION descriptor for the standalone
 * `/import` page instead of a modal descriptor.
 */

import { useCallback } from 'react';

import { KEYBOARD_MODE_PREF } from './types';
import { useCustomSyncedPref } from './use-custom-synced-pref';

/** The file extensions the keyboard review handles. */
const OFX_EXTENSIONS = ['.ofx', '.qfx'];

/**
 * The import destination: either a navigation to the standalone review
 * page, or Actual's own import modal.
 */
export type ImportModalDescriptor =
  | {
      kind: 'page';
      path: string;
    }
  | {
      kind: 'modal';
      modal: {
        name: 'import-transactions';
        options: {
          accountId: string;
          filename: string;
          onImported: (didChange: boolean) => void;
        };
      };
    };

/**
 * Pure: whether the keyboard review should handle this file.
 *
 * The extension check is independent of the preference: an OFX file is what
 * the review is built for, and a CSV/QIF/CAMT file is not, whatever the
 * preference says.
 */
export function isKeyboardReviewFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return OFX_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Build the import descriptor.
 *
 * `keyboardMode` is the value of the opt-in preference. When it is off, or
 * the file is not an OFX file, Actual's own modal is used.
 */
export function buildImportModal(
  accountId: string,
  filename: string,
  onImported: (didChange: boolean) => void,
  keyboardMode: boolean,
): ImportModalDescriptor {
  if (keyboardMode && isKeyboardReviewFile(filename)) {
    return {
      kind: 'page',
      path: `/import?account=${encodeURIComponent(accountId)}&file=${encodeURIComponent(filename)}`,
    };
  }
  return {
    kind: 'modal',
    modal: {
      name: 'import-transactions',
      options: { accountId, filename, onImported },
    },
  };
}

/**
 * The hook form: reads the opt-in preference and returns the descriptor.
 */
export function useOpenImportModalFor(): (
  accountId: string,
  filename: string,
  onImported: (didChange: boolean) => void,
) => ImportModalDescriptor {
  const [keyboardMode] = useCustomSyncedPref(KEYBOARD_MODE_PREF);

  return useCallback(
    (
      accountId: string,
      filename: string,
      onImported: (didChange: boolean) => void,
    ) =>
      buildImportModal(
        accountId,
        filename,
        onImported,
        keyboardMode === 'true',
      ),
    [keyboardMode],
  );
}

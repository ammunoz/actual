import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';

import type { ReviewAction } from './keymap';

/**
 * The help overlay's labels.
 *
 * They live here, and not in the KEYMAP, because they are TRANSLATED TEXT
 * while the KEYMAP is data: a dynamic `t(binding.labelKey)` is invisible to
 * the extractor, so the strings would never reach the translations and the
 * overlay would be English-only forever.
 *
 * Here they are literal, so the extractor finds them. The record is
 * exhaustive over the actions, so a binding cannot be added without a label
 * for it: the compiler says so.
 */
export const HELP_LABELS: Readonly<Record<ReviewAction, ReactNode>> =
  Object.freeze({
    'move-next': <Trans>Next row</Trans>,
    'move-prev': <Trans>Previous row</Trans>,
    'move-first': <Trans>First row</Trans>,
    'move-last': <Trans>Last row</Trans>,
    accept: <Trans>Accept row and advance</Trans>,
    'accept-confirm': <Trans>Accept row (confirm)</Trans>,
    'accept-override': <Trans>Accept row despite its flags</Trans>,
    drop: <Trans>Drop row and advance</Trans>,
    undo: <Trans>Undo last decision</Trans>,
    'edit-payee': <Trans>Edit payee</Trans>,
    'edit-category': <Trans>Edit category</Trans>,
    'edit-memo': <Trans>Edit notes</Trans>,
    'edit-amount': <Trans>Edit amount</Trans>,
    'edit-date': <Trans>Edit date</Trans>,
    'edit-transfer': <Trans>Set transfer target</Trans>,
    'edit-split': <Trans>Edit split</Trans>,
    'cycle-flag': <Trans>Cycle trust level</Trans>,
    'save-session': <Trans>Save this review and close</Trans>,
    'accept-all': <Trans>Accept every row</Trans>,
    'drop-all': <Trans>Drop every row</Trans>,
    apply: <Trans>Apply the import</Trans>,
    close: <Trans>Discard and close</Trans>,
    help: <Trans>Show this help</Trans>,
  });

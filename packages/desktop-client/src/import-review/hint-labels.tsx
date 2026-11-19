import { Trans } from 'react-i18next';

/**
 * The hint strip's label.
 *
 * The strip is the one thing the user sees without asking for it, so it
 * has to say what is worth saying NOW. The row's own commands sit on the
 * buttons in the Actions zone, each with its key; repeating them here
 * would say the same thing twice and crowd the footer. What is left is
 * the two keys that are not on any button: how to move, and how to ask
 * for the rest.
 *
 * The string lives here, and not next to the code that knows it, because
 * it is TRANSLATED TEXT while the code is data: a dynamic `t(kind)` is
 * invisible to the extractor, so the string would never reach the
 * translations and the strip would be English-only forever.
 *
 * **The keys are part of the translatable string.** A translator can
 * change them, and nothing stops them from being wrong. The unit test
 * beside this file checks the English text against the KEYMAP; the
 * translations are trusted.
 */
export const HINT = <Trans>j/k move · ? help</Trans>;

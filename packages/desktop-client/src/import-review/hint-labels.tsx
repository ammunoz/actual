import { Trans } from 'react-i18next';

/**
 * The hint strip's labels.
 *
 * The strip is the one thing the user sees without asking for it, so it
 * has to say what is worth saying NOW — the keys that matter, and
 * nothing else.
 *
 * The strings live here, and not next to the code that knows them,
 * because they are TRANSLATED TEXT while the code is data: a dynamic
 * `t(kind)` is invisible to the extractor, so the strings would never
 * reach the translations and the strip would be English-only forever.
 * Here they are literal, so the extractor finds them.
 *
 * The same reason `help-labels.tsx` exists.
 */

/**
 * What the strip says when the list has the keyboard.
 *
 * This is the common case, and the one that says nothing anywhere else:
 * the help overlay lists every key the review has, but it is only
 * reachable with `?` and it does not know what the user is doing.
 *
 * The keys here are the ones a person drives the review with. The
 * editing keys (`e` the chain, `p` the payee, `c`, `m`, `d`) are named
 * rather than spelled out, because there are five of them and the line is
 * already long.
 *
 * **The strip says the LIVE set, not everything.** The keys that are
 * rare — the transfer and the split — are in the help overlay and not
 * here: the strip shares its line with the bulk actions, and a hint
 * that wraps onto a second line is a hint that is read less. The strip
 * says where the rest is: `Shift+/`.
 *
 * The keys are written the way a person reads them — `Shift+/` for the
 * help, `Ctrl+Shift+A` for the override — and in Title Case, like every
 * other key the review shows. The KEYMAP says `shift+slash` and
 * `ctrl+shift+a`, because those are what `react-hotkeys-hook` wants.
 *
 * **The keys are part of the translatable string.** A translator can
 * change them, and nothing stops them from being wrong. The unit test
 * beside this file checks the English text against the KEYMAP; the
 * translations are trusted.
 */
export const LIST_HINT = (
  <Trans>
    j/k move · a accept · r drop · e/p/c/m/d edit · w save & close · Shift+/
    help
  </Trans>
);

/**
 * What the strip says when a row is held back.
 *
 * `Ctrl+Shift+A` is the only way to import a held-back row, and it is
 * discoverable only by reading the error message in the details pane or
 * by opening `?` and finding it. The strip says it at the moment it
 * matters — which is while the user is looking at a row they cannot
 * accept.
 *
 * It ADDS the override to the list rather than replacing it: a held row
 * is usually one the user wants to fix, not one they want to force
 * through, so the editing keys still matter.
 */
export const HELD_HINT = (
  <Trans>
    Ctrl+Shift+A accept anyway · j/k move · a accept · r drop · e/p/c/m/d edit ·
    w save & close · Shift+/ help
  </Trans>
);

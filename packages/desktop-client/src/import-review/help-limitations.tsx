import { Trans } from 'react-i18next';

/**
 * What the review cannot do.
 *
 * These are the things a person would otherwise find out the hard way —
 * after the import, when the transactions are already in the budget and
 * nothing can be done about it. So they are said plainly, up front.
 *
 * The strings live here, and not next to the code that knows them,
 * because they are TRANSLATED TEXT while the code is data: a dynamic
 * `t(code)` is invisible to the extractor, so the strings would never
 * reach the translations. Here they are literal, so the extractor finds
 * them.
 */
export const HELP_LIMITATIONS = [
  <Trans key="accounts">
    One file can hold several bank accounts, but Actual&apos;s parser drops the
    bank&apos;s account id. Put the boundaries yourself with o.
  </Trans>,
  <Trans key="vendor-map">
    The payee names you remember are remembered for the whole budget, not for
    one account. The same vendor name in two accounts keeps only the last
    choice.
  </Trans>,
  <Trans key="splits">
    A split that was imported before is matched to the old one by the
    bank&apos;s id. Its legs are matched by position, so a leg you added by hand
    may be overwritten or deleted.
  </Trans>,
  <Trans key="atomic">
    The import is not all-or-nothing. Rows are updated first and imported
    second, so a failure can leave the updates behind.
  </Trans>,
];

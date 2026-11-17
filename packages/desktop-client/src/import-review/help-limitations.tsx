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
    A file is imported into the account you opened the review for. If your bank
    put two accounts in one file, they all come here: Actual&apos;s parser drops
    the bank&apos;s account id, so the review cannot tell one statement from the
    next.
  </Trans>,
  <Trans key="vendor-map">
    The payee names you remember are remembered for the whole budget, not for
    one account. The same vendor name in two accounts keeps only the last
    choice.
  </Trans>,
  <Trans key="rules">
    A rule you create here applies to every transaction with that vendor, from
    now on. It does not change the transactions you already have.
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

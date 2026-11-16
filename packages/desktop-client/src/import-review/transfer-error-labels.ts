import type { TransferErrorCode } from '@actual-app/core/server/transactions/import/review/index';
import type { TFunction } from 'i18next';

/**
 * The transfer validation errors, in the user's words.
 *
 * The domain's error messages carry a CODE — never an account id or a
 * payee name. They are for logs and for tests, not for a person to read,
 * so the codes are turned into sentences here.
 *
 * The sentences live here, and not next to the code that produces them,
 * because they are TRANSLATED TEXT while the codes are data: a dynamic
 * `t(code)` is invisible to the extractor, so the strings would never
 * reach the translations. Here they are literal, so the extractor finds
 * them.
 *
 * The `t` is passed in rather than imported so that the transfer pane and
 * the apply step can use the same sentences.
 */
export function transferErrorMessage(
  code: TransferErrorCode,
  t: TFunction,
): string {
  switch (code) {
    case 'TRANSFER-001':
      return t(
        'This row transfers to an account that has no transfer payee, so it cannot be imported as a transfer',
      );
    case 'TRANSFER-002':
      return t(
        'This row transfers to the account it is in, so it cannot be imported as a transfer',
      );
    default: {
      // The compiler says so when a code is added without a sentence.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

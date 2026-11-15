import { MAX_SPLIT_LEGS } from '@actual-app/core/server/transactions/import/review/index';
import type { SplitErrorCode } from '@actual-app/core/server/transactions/import/review/index';
import type { TFunction } from 'i18next';

/**
 * The split validation errors, in the user's words.
 *
 * The domain's error messages carry a CODE, an index and a count — never
 * a category name, a payee, or an amount the user typed. They are for
 * logs and for tests, not for a person to read, so the codes are turned
 * into sentences here.
 *
 * The sentences live here, and not next to the code that produces them,
 * because they are TRANSLATED TEXT while the codes are data: a dynamic
 * `t(code)` is invisible to the extractor, so the strings would never
 * reach the translations. Here they are literal, so the extractor finds
 * them.
 *
 * The `t` is passed in rather than imported so that both the split pane
 * and the apply step can use the same sentences: the apply step reports
 * a failure as a plain string, and the pane reports it as one.
 */
export function splitErrorMessage(code: SplitErrorCode, t: TFunction): string {
  switch (code) {
    case 'SPLIT-001':
      return t('A split needs at least two legs');
    case 'SPLIT-002':
      return t('A split may have at most {{max}} legs', {
        max: MAX_SPLIT_LEGS,
      });
    case 'SPLIT-003':
      return t('A leg amount has to be a whole number of cents');
    case 'SPLIT-004':
      return t('The legs do not add up to the row amount');
    case 'SPLIT-005':
      return t('Every leg needs a category');
    case 'SPLIT-006':
      return t('A row cannot be both a transfer and a split');
    default: {
      // The compiler says so when a code is added without a sentence.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * The editing chain's pure parts.
 *
 * The editor pane is deliberately dumb: it collects what the user typed and
 * hands it over. Everything that can be decided without a DOM is decided
 * here, so it can be tested without one:
 *
 *   - which field each key opens,
 *   - what the field starts out showing,
 *   - how the text the user typed is read back (an amount, a date),
 *   - how the suggestion list is filtered and navigated.
 *
 * Nothing here talks to Actual's server or to React.
 */

import { isUsableDate } from '@actual-app/core/server/transactions/import/review/index';
import type { PreviewRow } from '@actual-app/core/server/transactions/import/review/index';
import { amountToInteger, integerToAmount } from '@actual-app/core/shared/util';

import type { ReviewAction } from './keymap';

/**
 * The field the editor pane is editing.
 *
 * The transfer and split editors are NOT here: they are different surfaces
 * (an account picker and a multi-leg editor with its own keys), and they
 * get their own slice. Their keymap entries stay declared and inert.
 */
export type EditorMode = 'payee' | 'category' | 'memo' | 'amount' | 'date';

/**
 * The editor each edit action opens.
 */
export const EDITOR_FOR_ACTION: Readonly<
  Partial<Record<ReviewAction, EditorMode>>
> = Object.freeze({
  'edit-payee': 'payee',
  'edit-category': 'category',
  'edit-memo': 'memo',
  'edit-amount': 'amount',
  'edit-date': 'date',
});

/**
 * A thing the user can pick from a list.
 */
export type EditorSuggestion = {
  id: string;
  name: string;
};

/**
 * What the editor needs to know beyond the row itself.
 */
export type InitialTextContext = {
  /**
   * The NAME of the row's category.
   *
   * The row carries category IDS, not names, so the editor has to resolve
   * the name from the budget's category list.
   */
  categoryName?: string;
};

/**
 * Pure: the text the editor for a field starts out showing.
 *
 * The field starts out showing the value the row would be imported with, so
 * the user edits what they see rather than retyping it.
 *
 * The record is exhaustive over the fields, so a new field cannot be added
 * without saying what it starts out showing.
 */
const INITIAL_TEXT: Readonly<
  Record<EditorMode, (row: PreviewRow, ctx: InitialTextContext) => string>
> = Object.freeze({
  payee: row => row.edits.payeeCanonical ?? row.payeeCanonical ?? '',
  category: (_row, ctx) => ctx.categoryName ?? '',
  memo: row => row.edits.memo ?? row.memo ?? '',
  amount: row =>
    integerToAmount(row.edits.amountCents ?? row.amountCents).toFixed(2),
  date: row => row.edits.date ?? row.date,
});

export function initialTextForMode(
  mode: EditorMode,
  row: PreviewRow,
  ctx: InitialTextContext = {},
): string {
  return INITIAL_TEXT[mode](row, ctx);
}

/**
 * A plain decimal amount: an optional sign, digits, and at most two
 * decimals.
 *
 * `Number()` would also accept `0x10` and `1e3`, and `amountToInteger`
 * rounds, so `25.555` would silently become `25.56`. An amount the user
 * typed is either an amount or it is a mistake, and a mistake should say
 * so rather than be quietly rounded.
 */
const AMOUNT_PATTERN = /^-?(\d+(\.\d{1,2})?|\.\d{1,2})$/;

/**
 * Pure: read the amount the user typed, in integer cents.
 *
 * `null` means the text is not an amount. An empty field is NOT an amount:
 * clearing the field and confirming it would silently write a $0
 * transaction.
 *
 * The amount is read the way the parse step reads the file's amounts
 * (`amountToInteger`), so the amount the user types and the amount the
 * file supplied mean the same thing.
 */
export function parseAmountText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!AMOUNT_PATTERN.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;

  return amountToInteger(value);
}

/**
 * Pure: read the date the user typed.
 *
 * `null` means the text is not a date the import would accept. The check is
 * the same one the gate uses, so a shaped-but-impossible date (`2026-02-31`)
 * is rejected here rather than being committed and re-flagged a moment
 * later.
 */
export function parseDateText(text: string): string | null {
  const trimmed = text.trim();
  return isUsableDate(trimmed) ? trimmed : null;
}

/**
 * Pure: the suggestions that match what the user typed.
 *
 * An empty filter matches everything: the list opens showing the whole
 * budget rather than nothing.
 */
export function filterSuggestions(
  suggestions: readonly EditorSuggestion[],
  text: string,
): readonly EditorSuggestion[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return suggestions;
  return suggestions.filter(suggestion =>
    suggestion.name.toLowerCase().includes(needle),
  );
}

/**
 * Pure: the index of the suggestion whose name IS the text, ignoring case.
 *
 * `-1` when there is none.
 *
 * The picker highlights the exact match and nothing else. A name the
 * budget does not have must stay unhighlighted: if the first fuzzy match
 * were highlighted instead, confirming a NEW payee's name would pick some
 * other payee — the one the user did not ask for.
 */
export function exactMatchIndex(
  suggestions: readonly EditorSuggestion[],
  text: string,
): number {
  const needle = text.trim().toLowerCase();
  if (needle === '') return -1;
  return suggestions.findIndex(
    suggestion => suggestion.name.trim().toLowerCase() === needle,
  );
}

/**
 * Pure: the highlighted suggestion after a move, wrapping around.
 *
 * `-1` means "nothing is highlighted", which is the state a field is in when
 * the user has typed something that matches no suggestion.
 */
export function nextHighlightIndex(
  count: number,
  current: number,
  delta: number,
): number {
  if (count === 0) return -1;
  const next = current + delta;
  if (next < 0) return count - 1;
  if (next >= count) return 0;
  return next;
}

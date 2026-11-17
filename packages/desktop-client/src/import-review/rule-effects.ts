import {
  isSplitRow,
  rowKey,
} from '@actual-app/core/server/transactions/import/review/index';
import type { PreviewEdits } from '@actual-app/core/server/transactions/import/review/index';
import type { PreviewTransaction } from '@actual-app/core/types/models/transaction';

/**
 * What a rule does to a row.
 *
 * The review does not re-implement the rule engine: the import preview
 * reports what the rules did to each row, and this turns that report into
 * the fields the review locks.
 *
 * **The fields are the rule's ACTIONS' fields**, not the ones whose value
 * happened to change. A rule that sets the category to the value the row
 * already had still CONTROLS the category — an edit to it would be
 * discarded when the rule runs again — so the review has to lock it.
 *
 * **The fields are named as the TRANSACTION names them.** A rule that sets
 * the payee by NAME sets the PAYEE: the engine resolves the name to an id,
 * and the transaction that comes back has no `payee_name` at all.
 */

/**
 * The fields of a transaction the review edits, and the ones a rule can
 * control.
 *
 * These are the review's own field names, not the transaction's column
 * names: the review edits the MEMO, and the transaction calls it `notes`.
 */
export type RuledField = 'payee' | 'category' | 'amount' | 'date' | 'notes';

/**
 * What a rule does to one field of one row.
 */
export type RuleEffect = {
  /** The field the rule controls. */
  field: RuledField;
  /**
   * The rule that controls it.
   *
   * The LAST rule to act wins, because upstream applies the rules in order
   * and the last action is the one that lands.
   */
  ruleId: string;
  /**
   * The value the rule set, as the transaction carries it: a payee id, a
   * category id, an amount in cents, a date, or the notes.
   */
  value: string | number | null;
};

/**
 * The rule effects for one row, keyed by the field.
 */
export type RowRuleEffects = ReadonlyMap<RuledField, RuleEffect>;

/**
 * The rule effects for the review, keyed by the row's key.
 */
export type RuleEffects = ReadonlyMap<string, RowRuleEffects>;

/**
 * A transaction as the preview reported it.
 *
 * The transient preview key is the fork's own: it rides on the payload so
 * the preview can echo it back, and it is how a reported row is lined up
 * with the review's row.
 */
export type ReportedRow = PreviewTransaction & { _previewKey?: string };

/**
 * The transaction columns a rule can control that the review shows.
 *
 * A rule can set other things — `imported_payee`, `cleared`, `schedule` —
 * and those are not fields the review edits, so they are not locked.
 */
const RULED_FIELDS: ReadonlySet<string> = new Set([
  'payee',
  'category',
  'amount',
  'date',
  'notes',
]);

/**
 * The value a rule set on a field, as the transaction carries it.
 *
 * A field the transaction does not have is `null`: the rule cleared it.
 */
function valueFor(trans: ReportedRow, field: string): string | number | null {
  switch (field) {
    case 'amount': {
      const amount = trans.amount;
      return typeof amount === 'number' ? amount : null;
    }
    case 'payee':
      return trans.payee ?? null;
    case 'category':
      return trans.category ?? null;
    case 'date':
      return trans.date ?? null;
    case 'notes':
      return trans.notes ?? null;
    default:
      return null;
  }
}

/**
 * Pure: the rule effects of the rows the preview reported.
 *
 * **Only the rows the import ADDS get effects.** A row that matched a
 * transaction already in the budget takes the import's UPDATE path, where
 * the EXISTING value wins (`existing.category || trans.category`) — so a
 * rule cannot change it, and locking it would be a lie. A row the user
 * edited goes through `transaction-update`, which does not run the rules
 * at all.
 *
 * The matched rows are named by their key, which is the transient preview
 * key the fork puts on the payload.
 */
export function ruleEffectsFor(
  reported: readonly ReportedRow[],
  opts: { matchedRowKeys: ReadonlySet<string> },
): RuleEffects {
  const effects = new Map<string, RowRuleEffects>();

  for (const trans of reported) {
    const key = trans._previewKey;
    // A row with no key cannot be lined up with the review's row, so its
    // effects cannot be shown.
    if (!key) continue;
    // A row that is already in the budget is not changed by a rule.
    if (opts.matchedRowKeys.has(key)) continue;

    const applied = trans._appliedRules ?? [];
    if (applied.length === 0) continue;

    const rowEffects = new Map<RuledField, RuleEffect>();
    for (const rule of applied) {
      for (const field of rule.fields) {
        if (!RULED_FIELDS.has(field)) continue;
        // The LAST rule to act wins, so a later rule replaces an
        // earlier one's effect on the same field.
        rowEffects.set(field as RuledField, {
          field: field as RuledField,
          ruleId: rule.id,
          value: valueFor(trans, field),
        });
      }
    }

    if (rowEffects.size > 0) {
      effects.set(key, rowEffects);
    }
  }

  return effects;
}

/**
 * Pure: the effect a rule has on one field of a row, if it has one.
 */
export function effectFor(
  effects: RuleEffects,
  rowKey: string,
  field: RuledField,
): RuleEffect | undefined {
  return effects.get(rowKey)?.get(field);
}

/**
 * The rule effects that apply to a row.
 *
 * **A SPLIT row's CATEGORY is the exception.** Its categories live on the
 * legs, and a category is not written on a split parent, so a rule that
 * sets one says nothing about what the row will import. The engine still
 * reports the rule — it did fire on the parent — but the row does not
 * show it, because the row would be lying.
 *
 * Its AMOUNT is not an exception: a rule that sets the amount DOES change
 * the parent, and the legs then no longer add up to it. That is
 * something the user has to know, so the row says so.
 */
export function visibleEffectsFor(
  effects: RuleEffects,
  row: { previewKey?: string; importedId?: string; edits: PreviewEdits },
): RuleEffect[] {
  const rowEffects = effects.get(rowKey(row));
  if (!rowEffects) return [];
  const visible = [...rowEffects.values()];
  if (!isSplitRow(row.edits)) return visible;
  return visible.filter(effect => effect.field !== 'category');
}

/**
 * Pure: the effect a rule has on one field of a row, if it applies.
 *
 * The same rule as `visibleEffectsFor`, for one field.
 */
export function visibleEffectFor(
  effects: RuleEffects,
  row: { previewKey?: string; importedId?: string; edits: PreviewEdits },
  field: RuledField,
): RuleEffect | undefined {
  const effect = effects.get(rowKey(row))?.get(field);
  if (!effect) return undefined;
  if (field === 'category' && isSplitRow(row.edits)) return undefined;
  return effect;
}

/**
 * The field the editor edits, in the review's own words.
 *
 * The editor edits the MEMO; the transaction calls it `notes`.
 */
export const RULED_FIELD_FOR_MODE = {
  payee: 'payee',
  category: 'category',
  memo: 'notes',
  amount: 'amount',
  date: 'date',
} as const satisfies Record<string, RuledField>;

/**
 * Pure: whether an edit CHANGES a field a rule controls.
 *
 * An edit that sets the field to the value the rule ALREADY sets is not
 * a change: the user is not fighting the rule, they agree with it. So it
 * is allowed — the rule would have set the same thing.
 *
 * The payee is the awkward one: the user edits it by NAME and the rule
 * sets an ID. The comparison needs the id, so the caller resolves the
 * name to one — from the payee the picker matched, or from the payee the
 * budget has with that name. When there is no id at all, the user named
 * a payee the budget does not have, which is a change: a new payee is
 * not the rule's.
 */
export function editChangesRuledField(
  effect: RuleEffect,
  edits: PreviewEdits,
  editedPayeeId?: string,
): boolean {
  switch (effect.field) {
    case 'category':
      // An absent field is a field the user did not touch — that is what
      // `undefined` means in the edits, and it is not a change.
      if (edits.categoryId === undefined) return false;
      // An EMPTY one is a field the user CLEARED, and the rule cleared it
      // too, so they agree.
      return emptied(edits.categoryId) !== emptied(effect.value);
    case 'payee':
      // The payee is the exception: an absent id is a payee the budget
      // does not have — a NEW payee, which is not the rule's.
      return (editedPayeeId ?? null) !== effect.value;
    case 'amount':
      if (edits.amountCents === undefined) return false;
      return edits.amountCents !== effect.value;
    case 'date':
      if (edits.date === undefined) return false;
      return edits.date !== effect.value;
    case 'notes':
      if (edits.memo === undefined) return false;
      return emptied(edits.memo) !== emptied(effect.value);
    default:
      // The union is exhaustive, so this is unreachable. It is a
      // fail-safe: a field the review does not know about is treated as
      // changed, so the edit is refused rather than silently discarded.
      return true;
  }
}

/**
 * A value with "nothing" normalised.
 *
 * The edits say "the user cleared this" with an empty string, and the
 * engine says "the rule cleared this" with nothing at all. They are the
 * same thing, so they are compared the same way: a user who clears the
 * field a rule already clears agrees with the rule.
 */
function emptied(
  value: string | number | null | undefined,
): string | number | null {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

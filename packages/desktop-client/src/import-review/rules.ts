import type {
  PreviewRow,
  ReviewCategory,
  ReviewPayee,
} from '@actual-app/core/server/transactions/import/review/index';
import { effectiveTransferAccountId } from '@actual-app/core/server/transactions/import/review/index';
import type {
  NewRuleEntity,
  RuleEntity,
} from '@actual-app/core/types/models/rule';

/**
 * The rules the review creates.
 *
 * **This is the ONLY path that creates a rule.** The vendor map it
 * replaces learned wholesale — pick a payee once and every future
 * import of that vendor was resolved with it, with no way to
 * intervene. A rule is created here ONLY when the user asks for one,
 * and it says exactly what it does.
 *
 * The shapes below are upstream's own:
 *
 * - `imported_payee` is the file's raw vendor string. It is a STRING,
 *   so `is` compares it exactly — the rule applies to this vendor and
 *   to no other.
 * - `payee` is the budget payee's ID. It is an ID, so `is` compares it
 *   exactly.
 * - `stage: 'pre'` is the stage upstream's own `updateCategoryRules`
 *   writes, and the stage the import runs.
 */
export type ReviewRule = Omit<NewRuleEntity, 'id'>;

/**
 * Where a rule puts the payee.
 *
 * Two shapes, because the payee may or may not exist yet:
 *
 * - an existing payee, by id. The rule sets `payee`, and the id is
 *   stable.
 * - a name. The rule sets `payee_name`, and upstream creates the
 *   payee the first time the rule fires.
 */
export type PayeeTarget =
  | { kind: 'id'; id: string }
  | { kind: 'name'; name: string };

/**
 * The rule that says: this vendor string is this payee.
 *
 * The condition is on the file's RAW vendor string, not on the payee:
 * the vendor string is what the file carries, and it is what the rule
 * will see on every future import of that vendor.
 */
export function vendorToPayeeRule(
  vendorRaw: string,
  target: PayeeTarget,
): ReviewRule {
  return {
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ op: 'is', field: 'imported_payee', value: vendorRaw }],
    actions: [
      target.kind === 'id'
        ? { op: 'set', field: 'payee', value: target.id }
        : { op: 'set', field: 'payee_name', value: target.name },
    ],
  };
}

/**
 * The rule that says: this payee is this category.
 *
 * The condition is on the PAYEE, not on the vendor string, so it
 * applies to every transaction with that payee — however the file
 * spelled the vendor.
 */
export function payeeToCategoryRule(
  payeeId: string,
  categoryId: string,
): ReviewRule {
  return {
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ op: 'is', field: 'payee', value: payeeId }],
    actions: [{ op: 'set', field: 'category', value: categoryId }],
  };
}

/**
 * Whether two rules have the same conditions.
 *
 * Two rules with the same conditions are a TIE, and upstream breaks a
 * tie on the rule id — which is a random UUID. So two of them means
 * the winner is decided at random, and the review cannot tell the user
 * which one applied. That is why a rule is AMENDED rather than added.
 *
 * **The conditions are compared in order.** Every rule this module
 * writes has exactly one condition, so the order cannot matter today.
 * If the shapes ever grow a second one, a reordered duplicate would
 * slip past this check — and would reintroduce the exact tie the
 * amend exists to prevent.
 *
 * The STAGE is not compared, and it is not part of the tie either: two
 * rules with the same conditions at different stages are ordered by
 * the stage, not by their ids. Upstream's own `updateCategoryRules`
 * writes its rules at stage `null`, so a rule the user made through
 * the review (`stage: 'pre'`) and one upstream made on its own can
 * share a condition.
 *
 * **The amend reaches across the stages on purpose.** Every stage runs
 * during the import — upstream ranks the rules `pre`, then the ordinary
 * ones, then `post`, and the LAST one to act wins. So a rule at
 * `post` beats a rule at `pre`, and leaving both would mean the
 * review's rule could be overridden by a rule it never saw. Amending
 * the one that is there keeps one rule saying one thing, and it keeps
 * it saying the thing the user just asked for.
 */
export function sameConditions(
  a: Pick<NewRuleEntity, 'conditions' | 'conditionsOp'>,
  b: Pick<NewRuleEntity, 'conditions' | 'conditionsOp'>,
): boolean {
  if (a.conditionsOp !== b.conditionsOp) return false;
  if (a.conditions.length !== b.conditions.length) return false;
  return a.conditions.every((condition, index) => {
    const other = b.conditions[index];
    if (!other) return false;
    if (condition.op !== other.op) return false;
    if (condition.field !== other.field) return false;
    return JSON.stringify(condition.value) === JSON.stringify(other.value);
  });
}

/**
 * Whether two action values are the same.
 *
 * A rule action's value is `unknown` — upstream's type says so — so
 * the comparison cannot assume a string.
 *
 * The fallback compares the JSON, which depends on the KEY ORDER for
 * an object value. That is the wrong answer for two objects with the
 * same keys in a different order, and it is the right answer for
 * everything this module writes — a payee id, a payee name, a category
 * id, all of them strings.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a rule already sets a field to a value.
 *
 * A rule that already does the thing is not amended with the same
 * thing again — the second action would be dead weight, and upstream
 * shows every action in the rule's list.
 */
export function alreadySets(
  rule: Pick<NewRuleEntity, 'actions'>,
  field: string,
  value: unknown,
): boolean {
  return rule.actions.some(
    action =>
      action.op === 'set' &&
      action.field === field &&
      sameValue(action.value, value),
  );
}

/**
 * Whether a rule sets a field exactly once.
 *
 * A rule that sets the same field twice says two different things,
 * and the last action wins. So "the rule already says this" is only
 * true when there is one action on the field.
 */
function setsOnce(
  rule: Pick<NewRuleEntity, 'actions'>,
  field: string,
): boolean {
  return (
    rule.actions.filter(action => action.op === 'set' && action.field === field)
      .length === 1
  );
}

/**
 * The rule to write, and whether it is a new one.
 *
 * **A rule is AMENDED when one with the same conditions already
 * exists** (F8.2). Two rules with the same conditions are a tie, and
 * upstream breaks a tie on the rule id — a random UUID — so the winner
 * would be decided at random, and the review could not tell the user
 * which rule applied.
 *
 * The amendment keeps the existing rule's id, its conditions and the
 * actions on OTHER fields, and **replaces** the action on the field
 * the new rule sets. Replacing rather than adding is what upstream's
 * own `updateCategoryRules` does — it rewrites the action — and it is
 * what stops the amended rule from contradicting itself: two actions
 * on one field would say two different things, and the rule would
 * apply whichever came last.
 *
 * **A rule that already says exactly this is not written at all.**
 * `rule-update` is wrapped in upstream's undo, so a write that changes
 * nothing still takes a step in the undo history and still syncs. The
 * outcome is `'none'`, and the review says the rule was already there.
 */
export function ruleToWrite(
  rules: readonly RuleEntity[],
  rule: ReviewRule,
): {
  method: 'rule-add' | 'rule-update' | 'none';
  rule: ReviewRule | RuleEntity;
} {
  const existing = rules.find(candidate => sameConditions(candidate, rule));

  if (existing === undefined) {
    return { method: 'rule-add', rule };
  }

  // The rule already says exactly this: there is nothing to change.
  //
  // "Says exactly this" means the rule sets the field ONCE, to this
  // value. A rule that sets the same field twice says two different
  // things, and the last one wins — so the review must not answer
  // "already says this" when the rule also says something else.
  const unchanged = rule.actions.every(
    action =>
      action.op === 'set' &&
      alreadySets(existing, action.field, action.value) &&
      setsOnce(existing, action.field),
  );
  if (unchanged) {
    return { method: 'none', rule: existing };
  }

  // The fields the new rule sets. The existing actions on those fields
  // are the ones being replaced.
  const fields = rule.actions
    .filter(action => action.op === 'set')
    .map(action => action.field);
  const kept = existing.actions.filter(
    action => action.op !== 'set' || !fields.includes(action.field),
  );

  return {
    method: 'rule-update',
    rule: {
      ...existing,
      actions: [...kept, ...rule.actions],
    },
  };
}

/**
 * The payee the row would be imported with.
 *
 * The precedence is the payload builder's, so the rule says the same
 * thing the import will do:
 *
 *   1. the payee the USER chose, by name
 *   2. the payee the resolver matched
 *
 * A transfer is not a payee: its "payee" is the hidden payee Actual
 * keeps for one account, and a rule that named it would be about
 * transfers rather than about a vendor.
 */
export function rowPayeeTarget(
  row: PreviewRow,
  payees: readonly ReviewPayee[],
): PayeeTarget | undefined {
  if (effectiveTransferAccountId(row)) return undefined;

  const chosen = row.edits.payeeCanonical;
  if (chosen !== undefined) {
    // A name of nothing but spaces is not a payee.
    if (chosen.trim() === '') return undefined;
    const existing = payees.find(
      payee =>
        payee.transferAcct == null &&
        payee.name.trim().toLowerCase() === chosen.trim().toLowerCase(),
    );
    // The name is NOT trimmed when the rule names it: the payload
    // builder sends the name the user typed as it is, and upstream
    // creates a payee called exactly that. A trimmed rule would name a
    // payee the import does not make.
    return existing
      ? { kind: 'id', id: existing.id }
      : { kind: 'name', name: chosen };
  }

  if (row.matchedPayeeId) {
    // The resolver's match can be a transfer payee, which the payee list
    // holds but which is not an ordinary payee.
    const matched = payees.find(payee => payee.id === row.matchedPayeeId);
    if (matched && matched.transferAcct == null) {
      return { kind: 'id', id: matched.id };
    }
  }

  return undefined;
}

/**
 * The rules a row can offer.
 *
 * A rule is offered only when it can be written truthfully:
 *
 * - "this vendor is this payee" needs a vendor string and a payee. The
 *   payee may be one the budget does not have yet, in which case the
 *   rule names it and upstream creates it.
 * - "this payee is this category" needs a payee BY ID — that is what
 *   the condition matches on — and a category.
 */
export function rulesForRow(
  row: PreviewRow,
  payees: readonly ReviewPayee[],
  categories: readonly ReviewCategory[],
): { vendorToPayee?: ReviewRule; payeeToCategory?: ReviewRule } {
  const out: { vendorToPayee?: ReviewRule; payeeToCategory?: ReviewRule } = {};

  const target = rowPayeeTarget(row, payees);
  if (target && row.payeeRaw.trim() !== '') {
    out.vendorToPayee = vendorToPayeeRule(row.payeeRaw, target);
  }

  // The category the row would be imported with: the user's pick. The
  // resolver does not pick a category, and a category the budget no
  // longer has is dropped by the payload builder, so a stale id would
  // make a rule that never fires.
  const categoryId = row.edits.categoryId;
  if (target?.kind === 'id' && categoryId && categoryId !== '') {
    const live = categories.some(category => category.id === categoryId);
    if (live) {
      out.payeeToCategory = payeeToCategoryRule(target.id, categoryId);
    }
  }

  return out;
}

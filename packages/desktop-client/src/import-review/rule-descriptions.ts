import type { RuleEntity } from '@actual-app/core/types/models/rule';

/**
 * The names the review knows, for describing a rule in words.
 */
export type RuleNames = {
  /** The payee's name, by id. */
  payeeNames: ReadonlyMap<string, string>;
  /** The category's name, by id. */
  categoryNames: ReadonlyMap<string, string>;
};

/**
 * What a rule matches, and what it does with it.
 */
export type RuleDescription = {
  /** What the rule matches: the thing it looks for. */
  from: string;
  /** What the rule does with it. */
  to: string;
};

/**
 * A value a rule carries, as the user reads it.
 *
 * A rule's values are `unknown` — upstream's type says so — so the
 * description cannot assume a string. A value that is not a string is
 * shown as it is, because a rule the review cannot describe is better
 * described badly than not at all.
 */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * What a rule matches, as the user reads it.
 *
 * The CONDITION is what the rule looks for, and the fields the review
 * knows are resolved to the NAMES the user knows: a rule that matches a
 * payee by id means "this payee", not "payee-8f3a…".
 *
 * The vendor string is NOT resolved: it is the file's own string, and the
 * user needs to see it exactly as the file spells it — it is what the
 * rule will see on every future import of that vendor.
 */
function describeCondition(
  condition: RuleEntity['conditions'][number],
  names: RuleNames,
): string {
  const value = valueText(condition.value);
  switch (condition.field) {
    case 'payee':
      return names.payeeNames.get(value) ?? value;
    case 'category':
      return names.categoryNames.get(value) ?? value;
    default:
      return value;
  }
}

/**
 * What a rule does, as the user reads it.
 *
 * The ACTION sets a field, and the fields the review knows are resolved
 * to the names the user knows. A rule that sets the payee by NAME says
 * the name, because that is what it will create.
 */
function describeAction(
  action: Extract<RuleEntity['actions'][number], { op: 'set' }>,
  names: RuleNames,
): string {
  const value = valueText(action.value);
  switch (action.field) {
    case 'payee':
      return names.payeeNames.get(value) ?? value;
    case 'category':
      return names.categoryNames.get(value) ?? value;
    default:
      return value;
  }
}

/**
 * Pure: what a rule says, in the user's words.
 *
 * **A rule with more than one condition or more than one action is not
 * described.** The "from → to" form says one thing matching one thing,
 * and a rule that matches three things and sets two cannot be said that
 * way without lying. Neither can a "contains" condition or a "prepend
 * notes" action: those are not "is → set". The caller shows the rule's
 * field instead, which is the truth the review knows for certain.
 *
 * The rules the review writes have exactly one condition and one action,
 * so they are always described.
 */
export function describeRule(
  rule: RuleEntity,
  names: RuleNames,
): RuleDescription | undefined {
  if (rule.conditions.length !== 1 || rule.actions.length !== 1) {
    return undefined;
  }
  const [condition] = rule.conditions;
  const [action] = rule.actions;
  if (!condition || !action) return undefined;

  // Only "is X → set Y" is a from → to sentence. "contains X" would read
  // as an exact match, and "prepend notes" would read as a replacement;
  // both would describe a rule the review does not understand. The
  // caller falls back to the field it knows the rule owns.
  if (condition.op !== 'is' || action.op !== 'set') return undefined;

  return {
    from: describeCondition(condition, names),
    to: describeAction(action, names),
  };
}

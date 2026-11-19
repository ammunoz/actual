import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import type { RuledField } from './rule-effects';
import type { ReviewRule } from './rules';

export type RulePickerItem =
  | {
      /** Open this rule in upstream's own editor. */
      kind: 'edit';
      /** A stable id for the item. */
      id: string;
      /**
       * The field the rule owns.
       *
       * The field is the rule's identity on this row: per field there is
       * exactly one owner, because the last rule to act wins.
       */
      field?: RuledField;
      /** The field's name, translated at the call site. */
      fieldLabel?: string;
      /** What the rule does, in the user's words. */
      description: string;
      /** The rule to open. */
      ruleId: string;
    }
  | {
      /** Write this rule. */
      kind: 'create';
      /** A stable id for the item. */
      id: string;
      /** What the rule would do, in the user's words. */
      description: string;
      /** The rule to write. */
      rule: ReviewRule;
      /** What to say once it is written. */
      message: string;
    };

export type RulePickerProps = {
  /** What the user can choose. */
  items: readonly RulePickerItem[];
  /** Called with the chosen item. */
  onPick: (item: RulePickerItem) => void;
};

/**
 * The picker over the rules that touched a row.
 *
 * It is a PANE, like the editor and the confirmation: there is one
 * keyboard and one surface may have it. A nested modal would need a
 * second one, and the review's own bindings are switched off by a single
 * flag.
 *
 * **The items are the rules, and the field each one owns.** Two rules
 * can touch one row — one sets the payee, the other the category — and
 * the field is what tells them apart: per field there is exactly one
 * owner, because the last rule to act wins.
 *
 * The items that CREATE a rule are below a divider: making a rule is a
 * different kind of thing from editing one, and the user should not have
 * to read carefully to tell them apart.
 */
export function RulePicker({ items, onPick }: RulePickerProps) {
  const { t } = useTranslation();

  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The picker takes the focus when it opens, so the keyboard is
  // somewhere the user can see. The pane holds the items as a snapshot
  // taken when it opened, so this list cannot change under the indices
  // the key handler uses while the pane is up.
  useEffect(() => {
    buttonRefs.current[0]?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const isForward = event.key === 'j' || event.key === 'ArrowDown';
    const isBackward = event.key === 'k' || event.key === 'ArrowUp';
    if (!isForward && !isBackward) return;
    if (items.length === 0) return;

    // The keys move between the items, so the page must not scroll and
    // the caret must not move.
    event.preventDefault();

    const active = document.activeElement;
    const current = buttonRefs.current.findIndex(button => button === active);
    // With nothing focused, `j` lands on the first item and `k` on the
    // last. Wrapping from -1 would land `k` one short of the end.
    const next =
      current === -1
        ? isForward
          ? 0
          : items.length - 1
        : (current + (isForward ? 1 : -1) + items.length) % items.length;
    buttonRefs.current[next]?.focus();
  };

  // Predicates, so the branches below keep the item's kind: the field
  // and the rule id belong to the EDIT items alone.
  const edits = items.filter(
    (item): item is Extract<RulePickerItem, { kind: 'edit' }> =>
      item.kind === 'edit',
  );
  const creates = items.filter(
    (item): item is Extract<RulePickerItem, { kind: 'create' }> =>
      item.kind === 'create',
  );

  return (
    <View
      data-testid="import-review-rule-picker"
      style={{
        gap: 8,
        padding: 8,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 6,
      }}
      onKeyDown={onKeyDown}
    >
      <Text>
        <Trans>Rules on this row</Trans>
      </Text>

      {edits.map((item, index) => (
        <Button
          key={item.id}
          ref={button => {
            buttonRefs.current[index] = button;
          }}
          variant="bare"
          // The field name and the rule's description are two flex items
          // in the button; without a gap they paint flush ("categoryFood").
          style={{ gap: 6 }}
          data-testid="import-review-rule-item"
          data-rule-id={item.ruleId}
          data-field={item.field}
          onPress={() => onPick(item)}
        >
          {item.fieldLabel ? (
            <Text
              data-testid="import-review-rule-field"
              style={{ color: theme.ruleLockText }}
            >
              {item.fieldLabel}
            </Text>
          ) : null}
          <Text data-testid="import-review-rule-description">
            {item.description}
          </Text>
        </Button>
      ))}

      {creates.length > 0 ? (
        <>
          <View
            style={{
              height: 1,
              backgroundColor: theme.tableBorder,
            }}
          />
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>Or make a new rule</Trans>
          </Text>
          {creates.map((item, index) => (
            <Button
              key={item.id}
              ref={button => {
                buttonRefs.current[edits.length + index] = button;
              }}
              variant="bare"
              data-testid="import-review-rule-new"
              onPress={() => onPick(item)}
            >
              <Text>{item.description}</Text>
            </Button>
          ))}
        </>
      ) : null}

      <Text style={{ color: theme.pageTextSubdued }}>
        {t('j/k to move · Enter to choose · Escape to go back')}
      </Text>
    </View>
  );
}

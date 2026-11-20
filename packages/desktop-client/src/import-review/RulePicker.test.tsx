import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RulePicker } from './RulePicker';
import type { RulePickerItem } from './RulePicker';

const items: readonly RulePickerItem[] = [
  {
    kind: 'edit',
    id: 'rule-1',
    field: 'payee',
    fieldLabel: 'payee',
    description: 'SQ *BLUE BOTTLE → Kroger',
    ruleId: 'rule-1',
  },
  {
    kind: 'edit',
    id: 'rule-2',
    field: 'category',
    fieldLabel: 'category',
    description: 'Kroger → Food',
    ruleId: 'rule-2',
  },
];

const withNew: readonly RulePickerItem[] = [
  ...items,
  { kind: 'new', id: 'create-new-rule', description: 'Add new rule' },
];

function renderPicker() {
  const onPick = vi.fn();
  render(<RulePicker items={items} onPick={onPick} />);
  const buttons = screen.getAllByTestId('import-review-rule-item');
  const picker = screen.getByTestId('import-review-rule-picker');
  return { onPick, buttons, picker };
}

function renderPickerWithNew() {
  const onPick = vi.fn();
  render(<RulePicker items={withNew} onPick={onPick} />);
  const buttons = screen.getAllByTestId('import-review-rule-item');
  const newButton = screen.getByTestId('import-review-rule-create-new');
  const picker = screen.getByTestId('import-review-rule-picker');
  return { onPick, buttons, newButton, picker };
}

describe('the rule picker', () => {
  it('takes the focus on the first item when it opens', () => {
    const { buttons } = renderPicker();

    expect(document.activeElement).toBe(buttons[0]);
  });

  it('moves with j and k, and wraps at both ends', () => {
    const { buttons, picker } = renderPicker();

    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(buttons[1]);

    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.keyDown(picker, { key: 'k' });
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('lands k on the last item when nothing is focused', () => {
    const { buttons, picker } = renderPicker();
    // The pane focuses its first item on open. A click elsewhere in the
    // dialog can take that focus away; the next `k` must not land one
    // short of the end.
    (document.activeElement as HTMLElement).blur();

    fireEvent.keyDown(picker, { key: 'k' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("names the field each rule owns on the rule's own button", () => {
    const { buttons } = renderPicker();

    expect(within(buttons[0]).getByText('payee')).toBeInTheDocument();
    expect(within(buttons[1]).getByText('category')).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute('data-field', 'payee');
    expect(buttons[1]).toHaveAttribute('data-field', 'category');
  });

  it('offers a blank rule below the rule-derived ones', () => {
    const { newButton, onPick } = renderPickerWithNew();

    expect(newButton).toHaveTextContent('Add new rule');
    expect(screen.getByText('Or make a new rule')).toBeInTheDocument();

    newButton.click();
    expect(onPick).toHaveBeenCalledWith({
      kind: 'new',
      id: 'create-new-rule',
      description: 'Add new rule',
    });
  });

  it('keeps the first rule focused when a blank rule is offered', () => {
    const { buttons, newButton } = renderPickerWithNew();

    // Opening on the blank item would put a durable action one Enter away.
    expect(document.activeElement).toBe(buttons[0]);
    expect(document.activeElement).not.toBe(newButton);
  });

  it('reaches the blank rule with j and wraps back to the first', () => {
    const { buttons, newButton, picker } = renderPickerWithNew();

    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(newButton);
    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(picker, { key: 'k' });
    expect(document.activeElement).toBe(newButton);
  });

  it('walks an edit, a rule-derived offer and the blank rule together', () => {
    const mixed: readonly RulePickerItem[] = [
      {
        kind: 'edit',
        id: 'rule-1',
        field: 'payee',
        fieldLabel: 'payee',
        description: 'SQ *BLUE BOTTLE → Kroger',
        ruleId: 'rule-1',
      },
      {
        kind: 'create',
        id: 'new-vendor-to-payee',
        description: 'always this payee for this vendor',
        rule: {
          stage: 'pre',
          conditionsOp: 'and',
          conditions: [
            { field: 'imported_payee', op: 'is', value: 'POS PURCHASE 4251' },
          ],
          actions: [{ op: 'set', field: 'payee_name', value: 'Kroger' }],
        },
        message: 'Rule created.',
      },
      { kind: 'new', id: 'create-new-rule', description: 'Add new rule' },
    ];
    render(<RulePicker items={mixed} onPick={vi.fn()} />);
    const edit = screen.getAllByTestId('import-review-rule-item')[0];
    const create = screen.getByTestId('import-review-rule-new');
    const blank = screen.getByTestId('import-review-rule-create-new');
    const picker = screen.getByTestId('import-review-rule-picker');

    // The three kinds share one flat index array; an off-by-one would
    // send `j` back to an already-visited item instead of the next one.
    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(create);
    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(blank);
    fireEvent.keyDown(picker, { key: 'j' });
    expect(document.activeElement).toBe(edit);
  });
});

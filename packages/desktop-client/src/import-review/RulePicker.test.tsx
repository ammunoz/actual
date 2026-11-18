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

function renderPicker() {
  const onPick = vi.fn();
  render(<RulePicker items={items} onPick={onPick} />);
  const buttons = screen.getAllByTestId('import-review-rule-item');
  const picker = screen.getByTestId('import-review-rule-picker');
  return { onPick, buttons, picker };
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
});

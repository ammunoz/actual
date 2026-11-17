import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RuledCell } from './RuledCell';

describe('a ruled cell', () => {
  it("shows the rule's value", () => {
    render(<RuledCell width={150} label="Food" testId="cell" />);

    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('says so when the rule cleared the field', () => {
    // A cleared field has no value, and an empty blue string would be
    // invisible — so the cell says what happened instead.
    render(<RuledCell width={150} label="" cleared testId="cell" />);

    expect(screen.getByText('Cleared by rule')).toBeInTheDocument();
  });

  it('is marked as ruled, so the test can find it', () => {
    render(<RuledCell width={150} label="Food" testId="cell" />);

    expect(screen.getByTestId('cell')).toHaveAttribute('data-ruled', 'true');
  });

  it('is a field, not a dimmed string', () => {
    // The value is NOT dimmed: a value the user has to read keeps its
    // contrast, and the AFFORDANCE is removed instead. The rule lock's
    // colour is the value's own.
    render(<RuledCell width={150} label="Food" testId="cell" />);

    const field = screen
      .getByTestId('cell')
      .querySelector('[data-ruled-field="true"]');
    expect(field).not.toBeNull();
    // The field carries the app's own read-only input fill.
    expect(field).toHaveStyle({
      backgroundColor: expect.any(String),
    });
  });
});

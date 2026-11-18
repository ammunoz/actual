import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RuledCell } from './RuledCell';

describe('a ruled cell', () => {
  it("shows the rule's value", () => {
    render(<RuledCell label="Food" />);

    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('says so when the rule cleared the field', () => {
    // A cleared field has no value, and an empty blue string would be
    // invisible — so the cell says what happened instead.
    render(<RuledCell label="" cleared />);

    expect(screen.getByText('Cleared by rule')).toBeInTheDocument();
  });

  it('puts the value inside the field', () => {
    // The value is NOT dimmed: a value the user has to read keeps its
    // contrast, and the AFFORDANCE is removed instead. The rule lock's
    // colour is the value's own.
    //
    // The colours themselves are asserted in the e2e test, which reads
    // the RUNTIME colours — jsdom does not resolve the theme's CSS
    // variables, so a colour assertion here would prove nothing.
    const { container } = render(<RuledCell label="Food" />);

    const field = container.querySelector('[data-ruled-field="true"]');
    expect(field).not.toBeNull();
    expect(field).toContainElement(screen.getByText('Food'));
  });
});

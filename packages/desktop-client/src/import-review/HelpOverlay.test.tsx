import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HelpOverlay } from './HelpOverlay';

describe('the help overlay', () => {
  it('says what the review cannot do', () => {
    // These are the things a person would otherwise find out the hard
    // way: after the import, when the transactions are already in the
    // budget.
    render(<HelpOverlay />);

    expect(screen.getByText('Limitations')).toBeInTheDocument();
    expect(screen.getByText(/Actual's parser drops/)).toBeInTheDocument();
    expect(
      screen.getByText(/remembered for the whole budget/),
    ).toBeInTheDocument();
    expect(screen.getByText(/not all-or-nothing/)).toBeInTheDocument();
  });

  it('lists every key the review understands', () => {
    render(<HelpOverlay />);

    // The overlay is rendered from the keymap, so a binding cannot be
    // added without showing up here.
    expect(screen.getByText('Next row')).toBeInTheDocument();
    expect(
      screen.getByText('Import these rows into another account'),
    ).toBeInTheDocument();
  });
});

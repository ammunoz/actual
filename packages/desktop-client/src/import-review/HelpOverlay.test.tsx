import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatKeys, HelpOverlay } from './HelpOverlay';
import { KEYMAP } from './keymap';

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
    expect(screen.getByText('Edit split')).toBeInTheDocument();
  });

  it('shows EVERY binding the keymap has', () => {
    // The hint strip says the LIVE set — the keys that drive the list —
    // and the rare ones are in the overlay instead. So the overlay is
    // where "every key is discoverable" is kept honest, and this is the
    // guard that says so.
    render(<HelpOverlay />);

    for (const binding of KEYMAP) {
      // The keys, spelled the way the overlay spells them — the same
      // function the overlay uses, so the two cannot drift apart.
      expect(screen.getByText(formatKeys(binding.keys))).toBeInTheDocument();
    }
  });
});

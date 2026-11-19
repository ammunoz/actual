import type { ReactNode } from 'react';
import { isValidElement } from 'react';

import { HINT } from './hint-labels';
import { KEYMAP } from './keymap';

/**
 * The text of a `<Trans>` element.
 *
 * The label is a React element, so the string has to be read out of it
 * rather than imported. `Trans` renders its children into the string when
 * it has no interpolation, which is the case here.
 */
function textOf(element: ReactNode): string {
  if (typeof element === 'string') return element;
  if (typeof element === 'number') return String(element);
  if (Array.isArray(element)) return element.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(element)) {
    return textOf(element.props.children);
  }
  return '';
}

/**
 * The strip's text, split into the items it lists.
 *
 * The items are separated by `·`. `j/k` names two keys but stays one
 * item, because it describes one action.
 */
function tokensOf(hint: ReactNode): string[] {
  return textOf(hint)
    .split('·')
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/**
 * The keys one of the strip's items names.
 *
 * `?` is written for the shift+slash binding — the character on the cap.
 */
function keysIn(token: string): string[] {
  const first = token.split(/\s+/)[0];
  return first.split('/').filter(key => key.length > 0);
}

function namesKey(tokens: string[], key: string): boolean {
  const wanted = key.toLowerCase();
  return tokens.some(token =>
    keysIn(token).some(named => named.toLowerCase() === wanted),
  );
}

/**
 * The key the strip writes for a KEYMAP binding.
 *
 * The KEYMAP spells a binding the way `react-hotkeys-hook` wants it
 * (`shift+slash`); the strip spells it the way a person reads it (`?`).
 */
function writtenKey(keys: string): string {
  const key = keys.split(',')[0].trim();
  if (key === 'shift+slash') return '?';
  return key;
}

describe('the hint strip', () => {
  const tokens = tokensOf(HINT);

  it('only says keys the review actually has', () => {
    const bound = new Set(
      KEYMAP.flatMap(binding =>
        binding.keys.split(',').map(part => part.trim()),
      ),
    );
    const asKeymap = (key: string): string[] =>
      key === '?' ? ['shift+slash'] : [key];

    const missing = tokens
      .flatMap(token => keysIn(token))
      .filter(key => !asKeymap(key).some(form => bound.has(form)));
    expect(missing).toEqual([]);
  });

  it('says the keys for the actions it names', () => {
    for (const action of ['move-next', 'move-prev', 'help']) {
      const binding = KEYMAP.find(entry => entry.action === action);
      if (binding === undefined) {
        throw new Error(`the KEYMAP has no binding for ${action}`);
      }
      expect(namesKey(tokens, writtenKey(binding.keys))).toBe(true);
    }
  });

  it('names each key once, so the strip cannot be ambiguous', () => {
    const named = tokens.flatMap(token => keysIn(token));
    expect(new Set(named).size).toBe(named.length);
  });

  it('says only what is not on a button', () => {
    // Every row command has its own labelled button in the Actions zone.
    // The footer is not the place to say them again.
    for (const key of ['a', 'r', 'e', 'Shift+E', 'Ctrl+Shift+A']) {
      expect(namesKey(tokens, key)).toBe(false);
    }
    expect(tokens).toEqual(['j/k move', '? help']);
  });
});

import type { ReactNode } from 'react';
import { isValidElement } from 'react';

import { HELD_HINT, LIST_HINT } from './hint-labels';
import { KEYMAP } from './keymap';

/**
 * The text of a `<Trans>` element.
 *
 * The labels are React elements, so the strings have to be read out of
 * them rather than imported. `Trans` renders its children into the
 * string when it has no interpolation, which is the case here.
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
 * The strip is a list of "key words" separated by `·`. Some of the
 * words carry SEVERAL keys — `j/k` is two, `e/c/m/d` is four — and
 * those stay together, because they are one item of the list.
 *
 * Splitting on the separator alone turns the line into the tokens it is
 * made of, so an assertion can ask "does the strip name THIS key"
 * rather than "does the strip contain this letter somewhere".
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
 * An item names a key when the key IS the item (`a accept` names `a`)
 * or when the key is one of several the item groups (`j/k move` names
 * both `j` and `k`).
 *
 * `Shift+/` is ONE key — the slash, with shift. Splitting it on the
 * slash would leave `Shift+` and an empty piece, so the modifier form
 * is matched whole before the group is split.
 */
function keysIn(token: string): string[] {
  const first = token.split(/\s+/)[0];
  if (first.endsWith('+/')) return [first];
  return first.split('/').filter(key => key.length > 0);
}

/**
 * The item that names a key, if any.
 */
function itemNaming(tokens: string[], key: string): string | undefined {
  return tokens.find(token => keysIn(token).includes(key));
}

/**
 * Whether one of the strip's items names a key.
 */
function namesKey(tokens: string[], key: string): boolean {
  return itemNaming(tokens, key) !== undefined;
}

/**
 * The key the strip writes for a KEYMAP binding.
 *
 * The KEYMAP spells a binding the way `react-hotkeys-hook` wants it
 * (`shift+slash`); the strip spells it the way a person reads it
 * (`Shift+/`). This maps between the two, so the test can ask whether
 * the strip names the right key.
 */
function writtenKey(keys: string): string {
  const key = keys.split(',')[0].trim();
  // `shift+slash` is the `?` key — the character on the cap.
  if (key === 'shift+slash') return '?';
  // A lone letter stays lowercase: `a` is `a`, not `A`. Only the
  // modifier names are capitalised, the way the repo writes them.
  if (key.length === 1) return key;
  return key.replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

/**
 * The hint strip's labels.
 *
 * The strip says the keys that drive the review, so the keys it says
 * have to be REAL keys. A key that the KEYMAP does not have is a lie
 * the user discovers by pressing it.
 */
describe('the hint strip', () => {
  const listTokens = tokensOf(LIST_HINT);
  const heldTokens = tokensOf(HELD_HINT);

  it('only says keys the review actually has', () => {
    // Every key the strip names has to be a binding in the KEYMAP: a
    // key the review does not have is a lie the user discovers by
    // pressing it.
    const bound = new Set(
      KEYMAP.flatMap(binding =>
        binding.keys.split(',').map(part => part.trim()),
      ),
    );

    // The strip spells the modifier keys the way a person reads them,
    // so they are matched against their KEYMAP form.
    const asKeymap = (key: string): string[] => {
      if (key === '?') return ['shift+slash'];
      if (key === 'Shift+E') return ['shift+e'];
      if (key === 'Ctrl+Shift+A') return ['ctrl+shift+a'];
      return [key];
    };

    const named = listTokens.flatMap(token => keysIn(token));
    const missing = named.filter(
      key => !asKeymap(key).some(form => bound.has(form)),
    );
    expect(missing).toEqual([]);
  });

  it('says the keys the KEYMAP binds for the actions it names', () => {
    const actions = [
      'move-next',
      'move-prev',
      'accept',
      'drop',
      'edit-chain',
      'edit-rules',
      'help',
    ];

    for (const action of actions) {
      const binding = KEYMAP.find(entry => entry.action === action);
      if (binding === undefined) {
        throw new Error(`the KEYMAP has no binding for ${action}`);
      }
      const key = writtenKey(binding.keys);

      // The key has to BE one of the keys the token names, not merely
      // a letter somewhere in it: a strip that said "r drop" would
      // satisfy a naive "does it contain r" check for the wrong key.
      expect(namesKey(listTokens, key)).toBe(true);
    }
  });

  it('names each key once, so the strip cannot be ambiguous', () => {
    // If two items named the same key, the strip would be saying two
    // things about one key, and a rebinding could swap them without
    // anything failing. Each key belongs to exactly one item.
    const namedTwice = new Map<string, string[]>();
    for (const token of listTokens) {
      for (const key of keysIn(token)) {
        const items = namedTwice.get(key) ?? [];
        items.push(token);
        namedTwice.set(key, items);
      }
    }

    const ambiguous = [...namedTwice.entries()].filter(
      ([, items]) => items.length > 1,
    );
    expect(ambiguous).toEqual([]);
  });

  it('says the same keys in both variants, plus the override', () => {
    // The held variant is hand-maintained, so a key can drift there
    // without the first test noticing.
    const withoutOverride = heldTokens.filter(
      token => !token.startsWith('Ctrl+Shift+A'),
    );
    expect(withoutOverride).toEqual(listTokens);
  });

  it('says the override only in the held variant', () => {
    // The override is the one key that releases a held row, so it is
    // worth saying exactly when a row is held.
    expect(namesKey(listTokens, 'Ctrl+Shift+A')).toBe(false);
    expect(namesKey(heldTokens, 'Ctrl+Shift+A')).toBe(true);
  });

  it('keeps the list keys in the held variant', () => {
    // A held row is usually one the user wants to FIX, so the editing
    // keys still matter while it is held.
    expect(namesKey(heldTokens, 'e')).toBe(true);
    expect(namesKey(heldTokens, 'j')).toBe(true);
    expect(namesKey(heldTokens, 'k')).toBe(true);
    expect(namesKey(heldTokens, 'a')).toBe(true);
  });
});

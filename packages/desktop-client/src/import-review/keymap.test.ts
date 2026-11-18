import { HELP_LABELS } from './help-labels';
import {
  actionForHotkey,
  GLOBAL_ACTIONS,
  KEYMAP,
  REVIEW_ACTIONS,
  REVIEW_ACTIONS_COVER_EVERY_ACTION,
  ROW_ACTIONS,
  TRUST_LEVEL_KEYS,
  TRUST_LEVELS,
} from './keymap';

describe('KEYMAP', () => {
  it('has no duplicate key combinations', () => {
    const combos = KEYMAP.map(binding => binding.keys);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('has no duplicate actions', () => {
    const actions = KEYMAP.map(binding => binding.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('binds every action the review has', () => {
    // An action nobody bound would fall into the dispatch's default
    // branch and do nothing: the keypress would look like the review is
    // broken, and nothing would say why.
    const bound = new Set(KEYMAP.map(binding => binding.action));
    const unbound = REVIEW_ACTIONS.filter(action => !bound.has(action));
    expect(unbound).toEqual([]);
  });

  it('lists every action once', () => {
    // A duplicate would satisfy every check and hide an action: the
    // list would look complete while one of the actions was never
    // really there.
    expect(new Set(REVIEW_ACTIONS).size).toBe(REVIEW_ACTIONS.length);
    // The compiler checks that the list covers the union; this is the
    // same check, said out loud.
    expect(REVIEW_ACTIONS_COVER_EVERY_ACTION).toBe(true);
  });

  it('has a label for every action the review has', () => {
    // The help overlay says what every key does. An action with no label
    // would be a key the overlay does not mention.
    const unlabelled = REVIEW_ACTIONS.filter(
      action => HELP_LABELS[action] === undefined,
    );
    expect(unlabelled).toEqual([]);
  });

  it('does NOT bind h/l (Actual OFX parser drops ACCTID)', () => {
    const keys = KEYMAP.map(binding => binding.keys);
    expect(keys).not.toContain('h');
    expect(keys).not.toContain('l');
  });

  it('does not bind tab, so the dialog is tabbable', () => {
    // `tab` used to cycle the trust level, and the handler prevented the
    // browser's own focus move. No button in the review was reachable
    // with the keyboard. Direct trust keys subsume the cycle.
    const keys = KEYMAP.map(binding => binding.keys);
    expect(keys).not.toContain('tab');
    // A shifted tab would swallow the focus move just the same.
    expect(keys.filter(key => key.endsWith('tab'))).toEqual([]);
    expect(REVIEW_ACTIONS).not.toContain('cycle-flag');
  });

  it('classifies every action as row-scoped or review-scoped', () => {
    // The two lists together are every action the review has. An action
    // nobody classified would be a row action by default, which is the
    // safe way round: a row action that should have been a review action
    // is swallowed by a focused control, not the other way about.
    const classified = [...ROW_ACTIONS, ...GLOBAL_ACTIONS];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...REVIEW_ACTIONS].sort());
  });

  it('binds the trust levels directly, one key each', () => {
    for (const [key, action] of [
      ['1', 'trust-paranoid'],
      ['2', 'trust-cautious'],
      ['3', 'trust-trusted'],
    ] as const) {
      expect(KEYMAP.find(binding => binding.keys === key)?.action).toBe(action);
    }
  });

  it('binds w, which puts the review aside', () => {
    // The session lives on the device, in the browser's own storage, so
    // it needs no change to upstream's preferences.
    expect(KEYMAP.map(binding => binding.keys)).toContain('w');
  });

  it('binds the movement keys', () => {
    const actions = KEYMAP.map(binding => binding.action);
    expect(actions).toContain('move-next');
    expect(actions).toContain('move-prev');
    expect(actions).toContain('move-first');
    expect(actions).toContain('move-last');
  });

  it('binds the decision keys', () => {
    const actions = KEYMAP.map(binding => binding.action);
    expect(actions).toContain('accept');
    expect(actions).toContain('drop');
    expect(actions).toContain('undo');
    expect(actions).toContain('accept-all');
    expect(actions).toContain('drop-all');
  });

  it('binds the override key', () => {
    // The override has a binding of its own: `ctrl+a` already means "accept
    // this row without moving on", and a binding whose meaning depends on
    // the row under the cursor is one the user cannot predict.
    const actions = KEYMAP.map(binding => binding.action);
    expect(actions).toContain('accept-override');
    expect(
      KEYMAP.find(binding => binding.action === 'accept-override')?.keys,
    ).toBe('ctrl+shift+a');
  });

  it('binds the apply and close keys', () => {
    const actions = KEYMAP.map(binding => binding.action);
    expect(actions).toContain('apply');
    expect(actions).toContain('close');
  });

  it('every key list is comma-space separated', () => {
    for (const binding of KEYMAP) {
      expect(binding.keys).toBe(binding.keys.split(', ').join(', '));
    }
  });

  it('spells the uppercase variants with the shift modifier', () => {
    // `react-hotkeys-hook` lowercases the whole key string, so `'A'` and
    // `'a'` are the SAME hotkey to it. The uppercase variants have to be
    // spelled with the shift modifier or they would silently behave as
    // their lowercase counterparts.
    const keys = KEYMAP.map(binding => binding.keys);
    expect(keys).toContain('shift+a');
    expect(keys).toContain('shift+r');
    expect(keys).not.toContain('A');
    expect(keys).not.toContain('R');
  });

  it('does not bind a plain uppercase letter', () => {
    for (const binding of KEYMAP) {
      for (const key of binding.keys.split(', ')) {
        expect(key).toBe(key.toLowerCase());
      }
    }
  });

  it('does not bind a character the library cannot match', () => {
    // The library matches on the NORMALIZED key code — `Digit4` becomes
    // `4` — so a character like `$` can never fire.
    const keys = KEYMAP.map(binding => binding.keys);
    expect(keys).not.toContain('$');
    expect(keys).toContain('shift+4');
  });
});

describe('actionForHotkey', () => {
  it('resolves a plain key', () => {
    expect(actionForHotkey('a')).toBe('accept');
    expect(actionForHotkey('r')).toBe('drop');
  });

  it('tells a modifier binding from its plain counterpart', () => {
    // The parsed key list is `['a']` for both of these, so the lookup has
    // to be on the hotkey string.
    expect(actionForHotkey('ctrl+a')).toBe('accept-confirm');
    expect(actionForHotkey('a')).toBe('accept');
    expect(actionForHotkey('ctrl+s')).toBe('apply');
    expect(actionForHotkey('s')).toBe('edit-split');
  });

  it('tells a shift binding from its plain counterpart', () => {
    expect(actionForHotkey('shift+a')).toBe('accept-all');
    expect(actionForHotkey('shift+r')).toBe('drop-all');
  });

  it('tells accept-confirm from accept-all', () => {
    // They are different bindings: one confirms the focused row, the other
    // accepts every row. `ctrl+a` must not resolve to the bulk action.
    expect(actionForHotkey('ctrl+a')).toBe('accept-confirm');
    expect(actionForHotkey('shift+a')).toBe('accept-all');
    expect(actionForHotkey('ctrl+a')).not.toBe(actionForHotkey('shift+a'));
  });

  it('tells the override from every other accept', () => {
    // The override is its own binding, so it is never confused with the
    // plain accept, the confirm, or the bulk accept.
    expect(actionForHotkey('ctrl+shift+a')).toBe('accept-override');
    expect(actionForHotkey('a')).toBe('accept');
    expect(actionForHotkey('ctrl+a')).toBe('accept-confirm');
    expect(actionForHotkey('shift+a')).toBe('accept-all');
  });

  it('does not bind a character the library cannot match', () => {
    // The library matches on the normalized key code, so `Slash` becomes
    // `slash` and `?` can never fire.
    expect(actionForHotkey('?')).toBeUndefined();
    expect(actionForHotkey('shift+slash')).toBe('help');
  });

  it('resolves each key of a multi-key binding', () => {
    expect(actionForHotkey('j')).toBe('move-next');
    expect(actionForHotkey('down')).toBe('move-next');
    expect(actionForHotkey('k')).toBe('move-prev');
    expect(actionForHotkey('up')).toBe('move-prev');
  });

  it('is case-insensitive, because the library lowercases the key string', () => {
    expect(actionForHotkey('CTRL+A')).toBe('accept-confirm');
    expect(actionForHotkey('Shift+A')).toBe('accept-all');
  });

  it('returns undefined for an unknown key', () => {
    expect(actionForHotkey('q')).toBeUndefined();
    expect(actionForHotkey('')).toBeUndefined();
  });
});

describe('the trust levels', () => {
  it('covers every level, with one key each', () => {
    for (const level of TRUST_LEVELS) {
      expect(TRUST_LEVEL_KEYS[level]).toMatch(/^[123]$/);
    }
    expect(TRUST_LEVELS.map(level => TRUST_LEVEL_KEYS[level])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });
});

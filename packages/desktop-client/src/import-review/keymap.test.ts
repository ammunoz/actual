import {
  actionForHotkey,
  KEYMAP,
  nextTrustLevel,
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

  it('every binding has a label', () => {
    expect(KEYMAP.every(binding => binding.label.length > 0)).toBe(true);
  });

  it('does NOT bind h/l (Actual OFX parser drops ACCTID)', () => {
    const keys = KEYMAP.map(binding => binding.keys);
    expect(keys).not.toContain('h');
    expect(keys).not.toContain('l');
  });

  it('does NOT bind w (session storage needs an upstream prefs change)', () => {
    expect(KEYMAP.map(binding => binding.keys)).not.toContain('w');
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

describe('nextTrustLevel', () => {
  it('cycles paranoid -> cautious -> trusted -> paranoid', () => {
    expect(nextTrustLevel('paranoid')).toBe('cautious');
    expect(nextTrustLevel('cautious')).toBe('trusted');
    expect(nextTrustLevel('trusted')).toBe('paranoid');
  });

  it('covers every trust level', () => {
    expect(TRUST_LEVELS).toContain('paranoid');
    expect(TRUST_LEVELS).toContain('cautious');
    expect(TRUST_LEVELS).toContain('trusted');
  });
});

import { KEYMAP, nextTrustLevel, TRUST_LEVELS } from './keymap';

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

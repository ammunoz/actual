import {
  fuzzyMatchPayees,
  fuzzyScore,
  lcsLength,
  lcsRatio,
  partialRatio,
  tokenSetRatio,
} from './fuzzy';

describe('lcsLength', () => {
  it('is 0 for an empty string', () => {
    expect(lcsLength('', 'abc')).toBe(0);
    expect(lcsLength('abc', '')).toBe(0);
  });

  it('is the full length for identical strings', () => {
    expect(lcsLength('Demo', 'Demo')).toBe(4);
  });

  it('finds the longest common subsequence', () => {
    expect(lcsLength('Demo Vendor', 'Demo Vendor Co')).toBe(11);
    expect(lcsLength('abcbdab', 'bdcaba')).toBe(4);
  });

  it('is symmetric', () => {
    expect(lcsLength('Demo Vendor', 'Vendor Demo')).toBe(
      lcsLength('Vendor Demo', 'Demo Vendor'),
    );
  });
});

describe('lcsRatio', () => {
  it('is 1 for two empty strings', () => {
    expect(lcsRatio('', '')).toBe(1);
  });

  it('is 0 when either side is empty', () => {
    expect(lcsRatio('', 'Demo')).toBe(0);
    expect(lcsRatio('Demo', '')).toBe(0);
  });

  it('is 1 for identical strings', () => {
    expect(lcsRatio('Demo', 'Demo')).toBe(1);
  });

  it('is between 0 and 1 otherwise', () => {
    const r = lcsRatio('Demo Vendor', 'Demo Coffie');
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
  });
});

describe('tokenSetRatio', () => {
  it('is 1 for the same tokens in a different order', () => {
    expect(tokenSetRatio('Coffee Shop Demo', 'Demo Coffee Shop')).toBe(1);
  });

  it('tolerates additive noise', () => {
    // `tokenSetRatio` works on the raw strings - it does NOT canonicalize.
    // An extra token dilutes the score by the token-set ratio, but the
    // shared tokens still dominate. The canonicalizing path is
    // `fuzzyMatchPayees`, which strips the trailing store number first.
    expect(tokenSetRatio('DEMO COFFEE SHOP 1234', 'Demo Coffee Shop')).toBe(
      0.75,
    );
  });

  it('a non-strippable extra token dilutes the token set the same way', () => {
    // "#" is bank-specific and stays, so it contributes to the union.
    expect(tokenSetRatio('DEMO COFFEE SHOP #1234', 'Demo Coffee Shop')).toBe(
      0.75,
    );
  });

  it('does not tolerate a typo', () => {
    expect(tokenSetRatio('Demo Cofee', 'Demo Coffee')).toBeLessThan(1);
  });

  it('is 0 for an empty string', () => {
    expect(tokenSetRatio('', 'Demo')).toBe(0);
  });
});

describe('partialRatio', () => {
  it('catches a single-word typo', () => {
    const r = partialRatio('Demo Cofee Shop', 'Demo Coffee Shop');
    expect(r).toBeGreaterThan(0.7);
  });

  it('returns 0 when the length ratio is below the guard', () => {
    expect(partialRatio('Demo', 'Demo Coffee Shop International')).toBe(0);
  });

  it('is 0 for an empty string', () => {
    expect(partialRatio('', 'Demo')).toBe(0);
  });
});

describe('fuzzyScore', () => {
  it('is the max of the three signals', () => {
    const a = 'Demo Cofee Shop';
    const b = 'Demo Coffee Shop';
    expect(fuzzyScore(a, b)).toBe(
      Math.max(tokenSetRatio(a, b), partialRatio(a, b), lcsRatio(a, b)),
    );
  });

  it('scores identical strings at 1', () => {
    expect(fuzzyScore('Demo', 'Demo')).toBe(1);
  });
});

describe('fuzzyMatchPayees', () => {
  const candidates = [
    { id: 'p-coffee', name: 'Demo Coffee Shop' },
    { id: 'p-grocery', name: 'Demo Grocery' },
    { id: 'p-subs', name: 'Demo Subscriptions' },
  ];

  it('returns [] for an empty raw', () => {
    expect(fuzzyMatchPayees('', candidates)).toEqual([]);
  });

  it('ranks candidates by score descending', () => {
    const out = fuzzyMatchPayees('Demo Cofee Shop', candidates, {
      minScore: 0.5,
      maxResults: 5,
    });
    expect(out[0].candidate.id).toBe('p-coffee');
    expect(out[0].score).toBeGreaterThanOrEqual(out[1]?.score ?? 0);
  });

  it('drops candidates below the threshold', () => {
    const out = fuzzyMatchPayees('Demo Cofee Shop', candidates, {
      minScore: 0.99,
      maxResults: 5,
    });
    expect(out).toEqual([]);
  });

  it('caps the number of results', () => {
    const out = fuzzyMatchPayees('Demo', candidates, {
      minScore: 0.1,
      maxResults: 1,
    });
    expect(out.length).toBeLessThanOrEqual(1);
  });

  it('breaks ties deterministically by candidate id', () => {
    const tied = [
      { id: 'p-b', name: 'Demo Same' },
      { id: 'p-a', name: 'Demo Same' },
    ];
    const out = fuzzyMatchPayees('Demo Same', tied, {
      minScore: 0.5,
      maxResults: 5,
    });
    expect(out.map(m => m.candidate.id)).toEqual(['p-a', 'p-b']);
  });

  it('canonicalizes the raw before matching', () => {
    // The trailing store number is stripped, so the match is against the
    // canonical shape the user's budget payees use.
    const out = fuzzyMatchPayees('POS PURCHASE 4251', [
      { id: 'p-purchase', name: 'PURCHASE' },
    ]);
    expect(out[0].candidate.id).toBe('p-purchase');
  });
});

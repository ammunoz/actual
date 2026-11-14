import {
  addLeg,
  MAX_SPLIT_LEGS,
  removeLeg,
  replaceLeg,
  seedSplit,
  splitResidualCents,
  splitResidualDirection,
  splitTotalCents,
  uncategorizedLegCount,
  validateSplit,
} from './split-primitives';
import type { PreviewSplitLeg } from './split-primitives';

describe('splitTotalCents', () => {
  it('sums the legs', () => {
    expect(
      splitTotalCents([{ amountCents: -1500 }, { amountCents: -1000 }]),
    ).toBe(-2500);
  });

  it('an empty list sums to 0', () => {
    expect(splitTotalCents([])).toBe(0);
  });
});

describe('splitResidualCents', () => {
  it('is zero when balanced', () => {
    const legs: PreviewSplitLeg[] = [
      { amountCents: -1500 },
      { amountCents: -1000 },
    ];
    expect(splitResidualCents(legs, -2500)).toBe(0);
  });

  it('is negative when the legs under-allocate a debit', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: -2000 }];
    expect(splitResidualCents(legs, -2500)).toBe(-500);
  });

  it('is positive when the legs over-allocate a debit', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: -3000 }];
    expect(splitResidualCents(legs, -2500)).toBe(500);
  });
});

describe('splitResidualDirection', () => {
  it('reports balanced when the legs sum to the target', () => {
    const legs: PreviewSplitLeg[] = [
      { amountCents: -1500 },
      { amountCents: -1000 },
    ];
    expect(splitResidualDirection(legs, -2500)).toBe('balanced');
  });

  it('reports exceed when the legs overshoot in the row direction', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: -3000 }];
    expect(splitResidualDirection(legs, -2500)).toBe('exceed');
  });

  it('reports unallocated when the legs undershoot', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: -2000 }];
    expect(splitResidualDirection(legs, -2500)).toBe('unallocated');
  });

  it('an inflow shortfall reads unallocated, not exceed', () => {
    // The residual's sign alone would say "exceed" here; the direction is
    // derived from the leg total against the target instead.
    const legs: PreviewSplitLeg[] = [{ amountCents: 7000 }];
    expect(splitResidualDirection(legs, 10000)).toBe('unallocated');
  });

  it('a zero target with a non-zero leg total reads exceed', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: 100 }];
    expect(splitResidualDirection(legs, 0)).toBe('exceed');
  });
});

describe('uncategorizedLegCount', () => {
  it('counts legs without a category', () => {
    const legs: PreviewSplitLeg[] = [
      { amountCents: -100, categoryId: 'c-1' },
      { amountCents: -100 },
    ];
    expect(uncategorizedLegCount(legs)).toBe(1);
  });
});

describe('seedSplit', () => {
  it('seeds two legs that already sum to the amount', () => {
    const legs = seedSplit(-2500);
    expect(legs).toHaveLength(2);
    expect(splitTotalCents(legs)).toBe(-2500);
  });

  it('preserves the sign on both legs', () => {
    const legs = seedSplit(-2500);
    expect(legs.every(l => l.amountCents < 0)).toBe(true);
  });

  it('puts odd cents on the first leg', () => {
    const legs = seedSplit(-2501);
    expect(legs[0].amountCents).toBe(-1251);
    expect(legs[1].amountCents).toBe(-1250);
  });

  it('seeds the category on both legs when given', () => {
    const legs = seedSplit(-2500, 'c-1');
    expect(legs.every(l => l.categoryId === 'c-1')).toBe(true);
  });

  it('handles a positive amount', () => {
    const legs = seedSplit(2500);
    expect(splitTotalCents(legs)).toBe(2500);
    expect(legs.every(l => l.amountCents > 0)).toBe(true);
  });
});

describe('addLeg', () => {
  it('appends a leg sized at the residual', () => {
    const legs = seedSplit(-2500);
    const next = addLeg(legs, -500);
    expect(next).toHaveLength(3);
    expect(next[2].amountCents).toBe(-500);
  });

  it('is a no-op at MAX_SPLIT_LEGS', () => {
    const legs: PreviewSplitLeg[] = Array.from(
      { length: MAX_SPLIT_LEGS },
      () => ({
        amountCents: -100,
      }),
    );
    expect(addLeg(legs, -100)).toBe(legs);
  });

  it('does not mutate the input', () => {
    const legs = seedSplit(-2500);
    addLeg(legs, -500);
    expect(legs).toHaveLength(2);
  });
});

describe('removeLeg', () => {
  it('removes the leg at the index', () => {
    const legs = seedSplit(-2500);
    const next = removeLeg(legs, 0);
    expect(next).toHaveLength(1);
    expect(next[0].amountCents).toBe(-1250);
  });

  it('clamps at one remaining leg', () => {
    const legs: PreviewSplitLeg[] = [{ amountCents: -100 }];
    expect(removeLeg(legs, 0)).toBe(legs);
  });

  it('is a no-op for an out-of-range index', () => {
    const legs = seedSplit(-2500);
    expect(removeLeg(legs, 9)).toBe(legs);
    expect(removeLeg(legs, -1)).toBe(legs);
  });
});

describe('replaceLeg', () => {
  it('replaces the leg at the index', () => {
    const legs = seedSplit(-2500);
    const next = replaceLeg(legs, 0, { amountCents: -2000 });
    expect(next[0].amountCents).toBe(-2000);
    expect(next[1].amountCents).toBe(-1250);
  });

  it('is a no-op for an out-of-range index', () => {
    const legs = seedSplit(-2500);
    expect(replaceLeg(legs, 9, { amountCents: -1 })).toBe(legs);
  });

  it('does not mutate the input', () => {
    const legs = seedSplit(-2500);
    replaceLeg(legs, 0, { amountCents: -2000 });
    expect(legs[0].amountCents).toBe(-1250);
  });
});

describe('validateSplit', () => {
  it('returns null for a valid split', () => {
    const legs = seedSplit(-2500, 'c-1');
    expect(validateSplit(legs, -2500)).toBeNull();
  });

  it('SPLIT-001 for fewer than 2 legs', () => {
    const err = validateSplit([{ amountCents: -2500 }], -2500);
    expect(err?.code).toBe('SPLIT-001');
  });

  it('SPLIT-002 for more than MAX_SPLIT_LEGS legs', () => {
    const legs: PreviewSplitLeg[] = Array.from(
      { length: MAX_SPLIT_LEGS + 1 },
      () => ({ amountCents: -100, categoryId: 'c-1' }),
    );
    const err = validateSplit(legs, -100 * (MAX_SPLIT_LEGS + 1));
    expect(err?.code).toBe('SPLIT-002');
  });

  it('SPLIT-003 for a non-integer leg amount', () => {
    const legs: PreviewSplitLeg[] = [
      { amountCents: -1250.5, categoryId: 'c-1' },
      { amountCents: -1249.5, categoryId: 'c-1' },
    ];
    const err = validateSplit(legs, -2500);
    expect(err?.code).toBe('SPLIT-003');
  });

  it('SPLIT-004 when the legs do not sum to the target', () => {
    const legs = seedSplit(-2000, 'c-1');
    const err = validateSplit(legs, -2500);
    expect(err?.code).toBe('SPLIT-004');
  });

  it('SPLIT-005 when a leg has no category', () => {
    const legs = seedSplit(-2500);
    const err = validateSplit(legs, -2500);
    expect(err?.code).toBe('SPLIT-005');
  });

  it('treats an empty-string categoryId as set', () => {
    const legs: PreviewSplitLeg[] = [
      { amountCents: -1500, categoryId: '' },
      { amountCents: -1000, categoryId: '' },
    ];
    expect(validateSplit(legs, -2500)).toBeNull();
  });

  it('the message carries the code and never a category name', () => {
    // A leg with a category but a bad sum trips SPLIT-004. The category
    // name must not leak into the message.
    const legs: PreviewSplitLeg[] = [
      { amountCents: -1500, categoryId: 'Demo Groceries' },
      { amountCents: -1000, categoryId: 'Demo Groceries' },
    ];
    const err = validateSplit(legs, -9999);
    expect(err?.code).toBe('SPLIT-004');
    expect(err?.message).toContain('SPLIT-004');
    expect(err?.message).not.toContain('Demo Groceries');
  });
});

import type { PreviewSplitLeg } from '@actual-app/core/server/transactions/import/review/index';

import {
  addBalancedLeg,
  distributeResidual,
  legAmountText,
  splitResidual,
} from './split-mode';

function mkLeg(amountCents: number, categoryId?: string): PreviewSplitLeg {
  return {
    amountCents,
    ...(categoryId !== undefined && { categoryId }),
  };
}

describe('splitResidual', () => {
  it('is balanced when the legs add up to the row', () => {
    const residual = splitResidual([mkLeg(-500), mkLeg(-500)], -1000);
    expect(residual.direction).toBe('balanced');
    expect(residual.cents).toBe(0);
  });

  it('is unallocated when the legs allocate less than the row', () => {
    const residual = splitResidual([mkLeg(-500)], -1000);
    expect(residual.direction).toBe('unallocated');
    expect(residual.cents).toBe(-500);
  });

  it('is an overshoot when the legs allocate more than the row', () => {
    const residual = splitResidual([mkLeg(-1500)], -1000);
    expect(residual.direction).toBe('exceed');
    // The residual's SIGN does not say which way the legs are off: on a
    // debit row, a positive residual is an overshoot.
    expect(residual.cents).toBe(500);
  });
});

describe('legAmountText', () => {
  it('shows the amount with two decimals', () => {
    expect(legAmountText(-1250)).toBe('-12.50');
    expect(legAmountText(0)).toBe('0.00');
    expect(legAmountText(500)).toBe('5.00');
  });
});

describe('distributeResidual', () => {
  it('does nothing when the split already balances', () => {
    const legs = [mkLeg(-500), mkLeg(-500)];
    expect(distributeResidual(legs, -1000)).toBe(legs);
  });

  it('fills the empty legs evenly', () => {
    // Upstream's rule: an empty leg is the one that is missing money.
    const legs = [mkLeg(-500), mkLeg(0)];
    const result = distributeResidual(legs, -1000);
    expect(result.map(leg => leg.amountCents)).toEqual([-500, -500]);
  });

  it('adds up to the row even when the remainder does not divide', () => {
    // The share is FLOORED and the extra cents are handed to the
    // earliest legs, so the last leg carries the odd cent — the same
    // rule Actual's own "Distribute" button uses.
    const legs = [mkLeg(0), mkLeg(0), mkLeg(0)];
    const result = distributeResidual(legs, -1000);
    expect(result.map(leg => leg.amountCents)).toEqual([-333, -333, -334]);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(-1000);
  });

  it('spreads the remainder over the legs in proportion when none is empty', () => {
    const legs = [mkLeg(-750), mkLeg(-250)];
    const result = distributeResidual(legs, -1000);
    expect(result.map(leg => leg.amountCents)).toEqual([-750, -250]);
  });

  it('always adds up to the row exactly', () => {
    // 3 legs, 1000 cents, and a remainder that does not divide evenly.
    const legs = [mkLeg(-300), mkLeg(-300), mkLeg(-300)];
    const result = distributeResidual(legs, -1000);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(-1000);
  });

  it('adds up to the row exactly when the remainder is more than a cent', () => {
    // Three legs that do not divide the target evenly: the rounding
    // loses more than a cent, and the lost cents have to go somewhere.
    const legs = [mkLeg(-333), mkLeg(-333), mkLeg(-334)];
    const result = distributeResidual(legs, -1000);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(-1000);
  });

  it('does not mutate the legs it was given', () => {
    const legs = [mkLeg(-500), mkLeg(0)];
    distributeResidual(legs, -1000);
    expect(legs.map(leg => leg.amountCents)).toEqual([-500, 0]);
  });

  it('keeps the categories on the legs', () => {
    const legs = [mkLeg(-500, 'c-1'), mkLeg(0, 'c-2')];
    const result = distributeResidual(legs, -1000);
    expect(result.map(leg => leg.categoryId)).toEqual(['c-1', 'c-2']);
  });
});

describe('addBalancedLeg', () => {
  it('funds a new leg from a balanced split without leaving it at zero', () => {
    const legs = [mkLeg(-1250, 'c-1'), mkLeg(-1250, 'c-2')];
    const result = addBalancedLeg(legs, -2500);
    expect(result).toHaveLength(3);
    expect(result.map(leg => leg.amountCents)).toEqual([-834, -833, -833]);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(-2500);
    expect(result.every(leg => leg.amountCents !== 0)).toBe(true);
    expect(result.map(leg => leg.categoryId)).toEqual([
      'c-1',
      'c-2',
      undefined,
    ]);
  });

  it('gives the odd cent to the earliest existing leg', () => {
    // -2501 / 3 floors at 833 with two cents over: the first two legs
    // carry -834 each, the new leg keeps -833.
    const legs = [mkLeg(-1251), mkLeg(-1250)];
    const result = addBalancedLeg(legs, -2501);
    expect(result.map(leg => leg.amountCents)).toEqual([-834, -834, -833]);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(-2501);
  });

  it('works for a positive row', () => {
    const result = addBalancedLeg([mkLeg(1250), mkLeg(1250)], 2500);
    expect(result.map(leg => leg.amountCents)).toEqual([834, 833, 833]);
    expect(result.reduce((sum, leg) => sum + leg.amountCents, 0)).toBe(2500);
  });

  it('does nothing when the split is not balanced', () => {
    // An unbalanced split already has a residual to fund the new leg.
    const legs = [mkLeg(-750), mkLeg(-1250)];
    expect(addBalancedLeg(legs, -2500)).toBe(legs);
  });

  it('does not mutate the legs it was given', () => {
    const legs = [mkLeg(-1250), mkLeg(-1250)];
    addBalancedLeg(legs, -2500);
    expect(legs.map(leg => leg.amountCents)).toEqual([-1250, -1250]);
  });

  it('leaves canceling legs alone on a zero target', () => {
    // -500 and +500 balance at zero. There is no share to take: the
    // domain's plain append keeps both amounts and adds a zero leg.
    const legs = [mkLeg(-500), mkLeg(500)];
    const result = addBalancedLeg(legs, 0);
    expect(result.map(leg => leg.amountCents)).toEqual([-500, 500, 0]);
  });
});

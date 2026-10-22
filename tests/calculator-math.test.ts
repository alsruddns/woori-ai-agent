import { describe, expect, it } from 'vitest';
import { compoundInterest, percentageOf, simpleInterest } from '../apps/cli/src/calculator-math.js';

describe('independent calculator expectations', () => {
  it('calculates compound interest with monthly periods and fractional years', () => {
    expect(compoundInterest(12345.67, 6.25, 3.5, 12)).toBeCloseTo(15355.71, 2);
  });

  it('calculates simple interest', () => {
    expect(simpleInterest(12345.67, 6.25, 3.5)).toBeCloseTo(15046.29, 2);
  });

  it('calculates a percentage', () => {
    expect(percentageOf(271, 17)).toBeCloseTo(46.07, 2);
  });
});

export function compoundInterest(principal: number, annualPercent: number, years: number, periodsPerYear: number): number {
  return principal * (1 + annualPercent / 100 / periodsPerYear) ** (periodsPerYear * years);
}

export function simpleInterest(principal: number, annualPercent: number, years: number): number {
  return principal * (1 + annualPercent / 100 * years);
}

export function percentageOf(amount: number, percent: number): number {
  return amount * percent / 100;
}

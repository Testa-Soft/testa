/**
 * Round like Python's `round(x, digits)` (the reference oracle rounds row sums
 * with it): to the nearest representable decimal based on the double's EXACT
 * value, ties to even. `toFixed` alone rounds exact ties (e.g. 0.125) up.
 */
const EXACT_DIGITS = 100;

export function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) return x === 0 ? 0 : x;
  if (Math.abs(x) >= 1e21) return x;
  const exact = Math.abs(x).toFixed(EXACT_DIGITS); // exact decimal expansion of the double
  const [intPart = '0', frac = ''] = exact.split('.');
  const kept = frac.slice(0, digits);
  const rest = frac.slice(digits);
  const half = `5${'0'.repeat(rest.length - 1)}`;
  const base = BigInt(intPart + kept);
  const lastEven = base % 2n === 0n;
  const up = rest > half || (rest === half && !lastEven);
  const scaled = up ? base + 1n : base;
  const value = Number(scaled) / 10 ** digits;
  return x < 0 ? -value : value;
}

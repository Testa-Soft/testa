/**
 * Planning and health helpers (PRD-006 §6.4): the two-proportion sample size
 * behind "planned sample / MDE", and the χ² goodness-of-fit SRM check.
 * Closed-form, no simulation.
 */

export interface SampleSizeInput {
  /** Control conversion rate, 0 < baseline < 1. */
  baseline: number;
  /** Relative minimum detectable effect, e.g. 0.15 for +15%. */
  mde: number;
  /** Two-sided significance level, e.g. 0.05. */
  alpha: number;
  /** Power, e.g. 0.8. */
  power: number;
}

/**
 * Visitors per variation for a two-sided two-proportion z-test, unpooled
 * variance: (z₁₋α/₂ + z_power)² · (p₁q₁ + p₂q₂) / (p₂ − p₁)², rounded up.
 * F3 golden: baseline 0.024277, mde 0.15, α 0.05, power 0.8 → 30,084.
 */
export function sampleSizeTwoProportion(a: SampleSizeInput): number {
  const p1 = a.baseline;
  const p2 = p1 * (1 + a.mde);
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && p1 !== p2)) {
    throw new RangeError(
      'sampleSizeTwoProportion: baseline and mde must give two distinct rates in (0, 1)',
    );
  }
  if (!(a.alpha > 0 && a.alpha < 1 && a.power > 0 && a.power < 1)) {
    throw new RangeError('sampleSizeTwoProportion: alpha and power must be in (0, 1)');
  }
  const z = inverseNormalCdf(1 - a.alpha / 2) + inverseNormalCdf(a.power);
  const variance = p1 * (1 - p1) + p2 * (1 - p2);
  return Math.ceil((z * z * variance) / ((p2 - p1) * (p2 - p1)));
}

/** χ² goodness-of-fit of observed counts against weights (normalised here). */
export function srmChiSquare(
  observed: number[],
  weights: number[],
): { chi2: number; p_value: number } {
  if (observed.length !== weights.length || observed.length < 2) {
    throw new RangeError('srmChiSquare: need ≥ 2 groups and one weight per group');
  }
  const total = observed.reduce((s, o) => s + o, 0);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || weightSum <= 0 || weights.some((w) => w <= 0)) {
    throw new RangeError('srmChiSquare: counts and weights must be positive');
  }
  const chi2 = observed.reduce((s, o, i) => {
    const expected = (total * (weights[i] ?? 0)) / weightSum;
    return s + ((o - expected) * (o - expected)) / expected;
  }, 0);
  return { chi2, p_value: upperRegularizedGamma((observed.length - 1) / 2, chi2 / 2) };
}

/** Acklam's rational approximation, refined with one Halley step (~1e-15). */
export function inverseNormalCdf(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
      (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Complementary error function: Taylor series for |x| < 2, Q(½, x²) beyond. */
function erfc(x: number): number {
  const z = Math.abs(x);
  if (z < 2) {
    // erf series: accurate to double precision for |x| < 2.
    let term = z;
    let sum = z;
    for (let n = 1; n < 100; n++) {
      term *= (-z * z) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    const erf = (2 / Math.sqrt(Math.PI)) * sum;
    return x >= 0 ? 1 - erf : 1 + erf;
  }
  // Continued fraction for the tail.
  const q = upperRegularizedGamma(0.5, z * z);
  return x >= 0 ? q : 2 - q;
}

/** ln Γ(x), Lanczos (g = 7, n = 9). */
function lnGamma(x: number): number {
  const g = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xm = x - 1;
  let sum = g[0] ?? 0;
  for (let i = 1; i < g.length; i++) sum += (g[i] ?? 0) / (xm + i);
  const t = xm + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(sum);
}

const EPS = 1e-15;
const MAX_ITER = 500;

/** Q(s, x) = Γ(s, x) / Γ(s): series below s + 1, Lentz continued fraction above. */
export function upperRegularizedGamma(s: number, x: number): number {
  if (x <= 0) return 1;
  const prefix = Math.exp(-x + s * Math.log(x) - lnGamma(s));
  if (x < s + 1) {
    let term = 1 / s;
    let sum = term;
    for (let n = 1; n < MAX_ITER; n++) {
      term *= x / (s + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * prefix;
  }
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return prefix * h;
}

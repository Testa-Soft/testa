/**
 * Welch's t-test (unequal variances) + AOV confidence interval.
 *
 * t-distribution CDF: regularized incomplete beta function via Lentz's
 * continued-fraction method (Numerical Recipes §6.4 — betai / betacf).
 * lnΓ via the Lanczos approximation (g=7, NR3 coefficients).
 */

// Lanczos approximation for ln Γ(z), valid for z > 0.
function lnGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ] as const;
  const zz = z - 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += (c[i] ?? 0) / (zz + i);
  }
  const t = zz + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

// Continued fraction for incomplete beta — Lentz's method (NR §6.4).
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta function I_x(a, b).
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

// Binary search for the t-critical value: P(T > t_c | df) = alpha (one-sided).
function tCritical(alpha: number, df: number): number {
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const p = betai(df / 2, 0.5, df / (df + mid * mid));
    if (p > 2 * alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WelchInput {
  meanA: number;
  varA: number;
  nA: number;
  meanB: number;
  varB: number;
  nB: number;
}

export interface WelchResult {
  /** Welch t statistic (signed). */
  t: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  /** Two-tailed p-value. */
  pValue: number;
}

/**
 * Welch's t-test for two independent samples with potentially unequal variances.
 * `varA`/`varB` are sample variances (denominator n-1).
 * Returns a two-tailed p-value.
 */
export function welchTTest({ meanA, varA, nA, meanB, varB, nB }: WelchInput): WelchResult {
  const seA = varA / nA;
  const seB = varB / nB;
  const t = (meanA - meanB) / Math.sqrt(seA + seB);
  const df = (seA + seB) ** 2 / (seA ** 2 / (nA - 1) + seB ** 2 / (nB - 1));
  const pValue = betai(df / 2, 0.5, df / (df + t * t));
  return { t, df, pValue };
}

/**
 * Symmetric t-distribution confidence interval for an AOV estimate.
 * `variance` is the sample variance of per-order values; `n` is the order count.
 */
export function aovConfidenceInterval(
  mean: number,
  variance: number,
  n: number,
  level = 0.95,
): { low: number; high: number } {
  const alpha = (1 - level) / 2;
  const df = n - 1;
  const se = Math.sqrt(variance / n);
  const tc = tCritical(alpha, df);
  return { low: mean - tc * se, high: mean + tc * se };
}

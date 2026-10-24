/**
 * Python / numpy numeric semantics the PRD-006 oracle (`generate.py`) relies
 * on, reproduced bit-for-bit where the goldens depend on them:
 * `round(x, nd)`, the compensated float `sum()` (CPython ≥ 3.12),
 * `np.percentile` (linear), `math.erfc`, truthiness and `parse_ts`.
 */

/** Digits `toFixed` may produce; enough to expose any binary tie for |x| ≥ 1e-80. */
const MAX_FIXED_DIGITS = 100;

/**
 * Python `round(x, nd)`: the exact binary value rounded to `nd` decimals,
 * half-to-even only on exact ties (0.125 → 0.12, 0.375 → 0.38, 2.675 → 2.67).
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  // toFixed is exact (spec: closest n, larger n on a tie) — only ties need fixing.
  let fixed = ax.toFixed(nd);
  const exact = ax.toFixed(MAX_FIXED_DIGITS);
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + nd);
  const isTie = tail.startsWith('5') && /^0*$/.test(tail.slice(1));
  if (isTie) {
    const lastDigit = Number(fixed.charAt(fixed.length - 1));
    if (lastDigit % 2 === 1) {
      // toFixed rounded up to an odd digit: the even neighbour is one ulp-of-decimal below.
      fixed = exact.slice(0, nd === 0 ? dot : dot + 1 + nd);
    }
  }
  const out = Number(fixed);
  return neg ? -out : out;
}

/** CPython ≥ 3.12 `sum()` over numbers: Neumaier-compensated accumulation. */
export function pySum(values: Iterable<number>): number {
  let total = 0;
  let comp = 0;
  for (const x of values) {
    const t = total + x;
    comp += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return comp !== 0 && Number.isFinite(comp) ? total + comp : total;
}

/** `np.percentile(values, q)` with the default `linear` method. */
export function npPercentile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error('npPercentile: empty input');
  const arr = [...values].sort((a, b) => a - b);
  const n = arr.length;
  const virtualIndex = (n - 1) * (q / 100);
  if (virtualIndex >= n - 1) return at(arr, n - 1);
  const prevIndex = Math.max(0, Math.floor(virtualIndex));
  const gamma = virtualIndex - prevIndex;
  const a = at(arr, prevIndex);
  const b = at(arr, prevIndex + 1);
  // numpy `_lerp`: a + d·t, except b − d·(1 − t) when t ≥ 0.5.
  const diff = b - a;
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

function at(arr: readonly number[], i: number): number {
  const v = arr[i];
  if (v === undefined) throw new Error(`index ${i} out of range`);
  return v;
}

/** `math.erfc` (|error| ≪ 1e-12 — the oracle rounds it to 4 decimals). */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 3) return 1 - erfSeries(x);
  return erfcContinuedFraction(x);
}

function erfSeries(x: number): number {
  // erf(x) = 2/√π · e^{-x²} · Σ 2ⁿ x^{2n+1} / (1·3·…·(2n+1)) — all terms positive.
  let term = x;
  let sum = x;
  for (let n = 1; n < 200 && term > sum * 1e-17; n++) {
    term *= (2 * x * x) / (2 * n + 1);
    sum += term;
  }
  return (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
}

function erfcContinuedFraction(x: number): number {
  // erfc(x) = e^{-x²}/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + …)))), Lentz.
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let k = 1; k < 500; k++) {
    const a = k / 2;
    d = x + a * d;
    d = d === 0 ? tiny : d;
    c = x + a / c;
    c = c === 0 ? tiny : c;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}

/** Python truthiness for the scalar values the oracle tests (`x or "(none)"`). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Python `str()` for the scalars used as group keys. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  return String(v);
}

/** generate.py `ratio`: `None` when the denominator is falsy. */
export function ratio(a: number, b: number | null): number | null {
  return b === null || b === 0 ? null : a / b;
}

/** generate.py `r6`: round to 6 decimals, `None` passes through. */
export function r6(x: number | null): number | null {
  return x === null ? null : pyRound(x, 6);
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{1,6})$/;

/** generate.py `parse_ts(...).timestamp()` in seconds (UTC). */
export function parseTs(s: string): number {
  const m = TS_RE.exec(s);
  if (!m) throw new Error(`parseTs: bad timestamp ${JSON.stringify(s)}`);
  const [, y, mo, d, h, mi, se, frac] = m.map((p) => p ?? '');
  const micros = Number((frac ?? '').padEnd(6, '0'));
  const wholeSecs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)) / 1000;
  // timedelta.total_seconds(): exact integer microseconds / 10**6, correctly rounded.
  return (wholeSecs * 1_000_000 + micros) / 1_000_000;
}

/** `datetime.strptime(day, "%Y-%m-%d")` as epoch seconds (UTC). */
export function parseDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`parseDay: bad date ${JSON.stringify(day)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}

/**
 * Distribution samplers over a seeded {@link Rng} (PRD-006 §5.5): Normal via
 * Box–Muller, Gamma via Marsaglia–Tsang, Beta as a ratio of two Gammas,
 * Student-t as Normal / √(χ²/ν).
 */
import type { Rng } from './rng.ts';

export interface Samplers {
  normal(): number;
  gamma(shape: number): number;
  beta(a: number, b: number): number;
  studentT(df: number): number;
}

export function createSamplers(rng: Rng): Samplers {
  let spare: number | undefined;

  const normal = (): number => {
    if (spare !== undefined) {
      const z = spare;
      spare = undefined;
      return z;
    }
    const r = Math.sqrt(-2 * Math.log(rng.next()));
    const theta = 2 * Math.PI * rng.next();
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };

  const gamma = (shape: number): number => {
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a + 1) · U^(1/a).
      return gamma(shape + 1) * rng.next() ** (1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rng.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };

  const beta = (a: number, b: number): number => {
    const x = gamma(a);
    return x / (x + gamma(b));
  };

  const studentT = (df: number): number => normal() / Math.sqrt((2 * gamma(df / 2)) / df);

  return { normal, gamma, beta, studentT };
}

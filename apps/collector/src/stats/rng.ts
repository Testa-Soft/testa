/**
 * Seeded PRNG for the stats module (PRD-006 §5.5): `xoshiro128**`, its 128-bit
 * state expanded with splitmix32 from the xxhash32 of a seed string, so
 * identical input gives identical draws.
 */

/** A source of uniform floats in the open interval (0, 1). */
export interface Rng {
  next(): number;
}

// The collector has no experiment-core dependency; Bun ships the same
// xxhash32. Its typing is missing from @types/bun 1.1, hence the narrow cast.
const bunHash = Bun.hash as unknown as { xxHash32(data: string, seed?: number): number };

export function hashSeed(key: string): number {
  return bunHash.xxHash32(key, 0) >>> 0;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

const TWO_POW_31 = 2_147_483_648;
const TWO_POW_32 = 4_294_967_296;

/** `xoshiro128**` seeded from the xxhash32 of `key`. */
export function createRng(key: string): Rng {
  return new Xoshiro128(splitmix32(hashSeed(key)));
}

class Xoshiro128 implements Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(init: () => number) {
    this.s0 = init();
    this.s1 = init();
    this.s2 = init();
    this.s3 = init();
  }

  /** Uniform in (0, 1); 32-bit resolution, half-step offset so log() is safe. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9);
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    // `result` is a signed int32; shift it to [0, 2³²) without `>>> 0`.
    return (result + TWO_POW_31 + 0.5) / TWO_POW_32;
  }
}

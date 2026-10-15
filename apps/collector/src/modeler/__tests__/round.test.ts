import { describe, expect, it } from 'bun:test';
import { roundHalfEven } from '../round.ts';

describe('roundHalfEven (Python round parity)', () => {
  it.each([
    [0.125, 0.12], // exact tie → even
    [0.375, 0.38], // exact tie → even
    [2.675, 2.67], // 2.675 is 2.67499999… in binary
    [1.005, 1], // 1.00499999…
    [145.00000000000003, 145],
    [-0.125, -0.12],
    [10000, 10000],
    [213004.1, 213004.1],
    [0, 0],
  ])('round(%p, 2) = %p', (x, want) => {
    expect(roundHalfEven(x, 2)).toBe(want);
  });
});

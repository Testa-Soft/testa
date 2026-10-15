/**
 * F3 expected values — literal, from docs/prds/006-validation.md ("F3 expected:
 * planning + SRM", V7) and PRD-006 §4.4. Inputs are in shared/f3-wire.ts.
 */

/** `POST /api/v1/stats` body with the F3 sums (PRD-006 §4.5 shape). */
export const F3_STATS_REQUEST = {
  control: 100,
  confidence: 0.95,
  metrics: [
    {
      key: 'cr',
      model: 'beta',
      variations: [
        { variation: 100, n: 4737, x: 115 },
        { variation: 101, n: 4790, x: 137 },
        { variation: 102, n: 4702, x: 109 },
      ],
    },
  ],
} as const;

export const F3_EXPECTED = {
  chanceToBeatControl101: [0.902, 0.912],
  chanceToBeBest101: [0.871, 0.881],
  srm: { chi2: 0.8277, p: 0.6611, tol: 0.001 },
  plannedSamplePerVariation: 30084,
  /** < 100 visitors per variation → insufficient_data. */
  insufficientRequest: {
    control: 100,
    confidence: 0.95,
    metrics: [
      {
        key: 'cr',
        model: 'beta',
        variations: [
          { variation: 100, n: 50, x: 5 },
          { variation: 101, n: 60, x: 9 },
        ],
      },
    ],
  },
} as const;

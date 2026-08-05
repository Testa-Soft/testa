import { describe, expect, it } from 'vitest';
import { decodeCrossDomain, encodeCrossDomainData } from '../cross-domain.ts';

describe('cross-domain encode/decode (shared wire format)', () => {
  it('round-trips the multi-experiment payload', () => {
    const encoded = encodeCrossDomainData(
      [
        { experimentId: 12, variationId: 3 },
        { experimentId: 'exp-b', variationId: 'v2' },
      ],
      'uuid-abc',
    );
    expect(decodeCrossDomain(encoded)).toEqual({
      uuid: 'uuid-abc',
      assignments: [
        { experimentId: 12, variationId: 3 },
        { experimentId: 'exp-b', variationId: 'v2' },
      ],
    });
  });

  it('emits the exact base64 wire format (3.3.3-compatible)', () => {
    expect(encodeCrossDomainData([{ experimentId: 12, variationId: 3 }], 'u1')).toBe(
      btoa(JSON.stringify({ u: 'u1', exps: [{ e: 12, v: 3 }] })),
    );
  });

  it('decodes the single-experiment format { e, v, u }', () => {
    expect(decodeCrossDomain(btoa(JSON.stringify({ e: 7, v: 1, u: 'uuid-legacy' })))).toEqual({
      uuid: 'uuid-legacy',
      assignments: [{ experimentId: 7, variationId: 1 }],
    });
  });

  it('decodes a URI-encoded fallback payload', () => {
    const payload = JSON.stringify({ u: 'uuid-x', exps: [{ e: 1, v: 0 }] });
    expect(decodeCrossDomain(encodeURIComponent(payload))).toEqual({
      uuid: 'uuid-x',
      assignments: [{ experimentId: 1, variationId: 0 }],
    });
  });

  it('returns null on garbage', () => {
    expect(decodeCrossDomain('%%%not-base64%%%')).toBeNull();
    expect(decodeCrossDomain(btoa('not json'))).toBeNull();
  });

  it('drops malformed entries from the payload', () => {
    const raw = btoa(JSON.stringify({ u: 'u', exps: [{ e: 1, v: 2 }, { e: null }, 'bad'] }));
    expect(decodeCrossDomain(raw)).toEqual({
      uuid: 'u',
      assignments: [{ experimentId: 1, variationId: 2 }],
    });
  });
});

/**
 * Debug tracing — the opt-in `debug: true` / `TESTA_DEBUG=1` facility that
 * emits one compact JSON decision trace per request (console + response header).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEBUG_HEADER, createDebugEmitter, envDebugEnabled } from '../debug.ts';

describe('createDebugEmitter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns undefined when disabled (zero overhead on the hot path)', () => {
    expect(createDebugEmitter(false)).toBeUndefined();
  });

  it('sets the x-testa-debug response header AND logs one [testa] line', () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const emit = createDebugEmitter(true);
    const res = { headers: new Headers() };
    emit?.(res, { url: 'https://acme.com/pricing', urlSource: 'host', redirect: '/pricing-v2' });

    const header = res.headers.get(DEBUG_HEADER);
    expect(header).toBeTruthy();
    expect(JSON.parse(header as string)).toMatchObject({
      url: 'https://acme.com/pricing',
      redirect: '/pricing-v2',
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('[testa]');
    expect(log.mock.calls[0]?.[0]).toContain('"urlSource":"host"');
  });

  it('still logs when the response headers are immutable', () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const emit = createDebugEmitter(true);
    const frozen = {
      headers: {
        set() {
          throw new TypeError('immutable');
        },
      } as unknown as Headers,
    };
    expect(() => emit?.(frozen, { url: 'https://acme.com/' })).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('envDebugEnabled', () => {
  it('accepts 1/true (case-insensitive), rejects everything else', () => {
    expect(envDebugEnabled('1')).toBe(true);
    expect(envDebugEnabled('true')).toBe(true);
    expect(envDebugEnabled('TRUE')).toBe(true);
    expect(envDebugEnabled('0')).toBe(false);
    expect(envDebugEnabled('false')).toBe(false);
    expect(envDebugEnabled('')).toBe(false);
    expect(envDebugEnabled(undefined)).toBe(false);
  });
});

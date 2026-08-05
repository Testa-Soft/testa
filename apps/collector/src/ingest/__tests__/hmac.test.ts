import { describe, expect, it } from 'bun:test';
import { sign, verify } from '../hmac.ts';

const SECRET = 'test-secret-at-least-16-chars';
const BODY = '{"signed_at":1730902400123,"events":[]}';
const NOW = 1730902400123;
const WINDOW = 5 * 60 * 1000;

function ok(): ReturnType<typeof verify> {
  return verify({
    rawBody: BODY,
    signature: sign(BODY, SECRET),
    secret: SECRET,
    signedAtMs: NOW,
    nowMs: NOW,
    replayWindowMs: WINDOW,
  });
}

describe('verify — happy path', () => {
  it('accepts a freshly signed body', () => {
    expect(ok()).toEqual({ valid: true });
  });
});

describe('verify — signature failures', () => {
  it.each([
    { name: 'missing', signature: undefined, reason: 'missing_signature' as const },
    { name: 'null', signature: null, reason: 'missing_signature' as const },
    { name: 'empty string', signature: '', reason: 'missing_signature' as const },
    { name: 'too short', signature: 'abc', reason: 'bad_signature_format' as const },
    {
      name: 'wrong length (63 hex)',
      signature: 'a'.repeat(63),
      reason: 'bad_signature_format' as const,
    },
    {
      name: 'wrong length (65 hex)',
      signature: 'a'.repeat(65),
      reason: 'bad_signature_format' as const,
    },
    {
      name: 'non-hex characters',
      signature: 'g'.repeat(64),
      reason: 'bad_signature_format' as const,
    },
    {
      name: 'uppercase hex (we normalize to lowercase)',
      signature: 'A'.repeat(64),
      reason: 'bad_signature_format' as const,
    },
  ])('rejects $name', ({ signature, reason }) => {
    const r = verify({
      rawBody: BODY,
      signature,
      secret: SECRET,
      signedAtMs: NOW,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason });
  });

  it('rejects a valid-format but wrong signature', () => {
    const r = verify({
      rawBody: BODY,
      signature: '0'.repeat(64),
      secret: SECRET,
      signedAtMs: NOW,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects when body has been tampered with', () => {
    const sig = sign(BODY, SECRET);
    const r = verify({
      rawBody: `${BODY} `,
      signature: sig,
      secret: SECRET,
      signedAtMs: NOW,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects when secret is wrong', () => {
    const r = verify({
      rawBody: BODY,
      signature: sign(BODY, SECRET),
      secret: 'a-different-secret-of-some-length',
      signedAtMs: NOW,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});

describe('verify — replay window', () => {
  it('accepts at exactly the boundary (now - signed = window)', () => {
    const r = verify({
      rawBody: BODY,
      signature: sign(BODY, SECRET),
      secret: SECRET,
      signedAtMs: NOW - WINDOW,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: true });
  });

  it('rejects when signed_at is too old', () => {
    const r = verify({
      rawBody: BODY,
      signature: sign(BODY, SECRET),
      secret: SECRET,
      signedAtMs: NOW - WINDOW - 1,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason: 'replay_window_exceeded' });
  });

  it('rejects when signed_at is in the future beyond the window', () => {
    const r = verify({
      rawBody: BODY,
      signature: sign(BODY, SECRET),
      secret: SECRET,
      signedAtMs: NOW + WINDOW + 1,
      nowMs: NOW,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: false, reason: 'replay_window_exceeded' });
  });
});

describe('sign — pairs with edge signer', () => {
  it('produces stable lowercase 64-char hex', () => {
    const out = sign('hello', 'world-of-secrets-1234567');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
    expect(sign('hello', 'world-of-secrets-1234567')).toBe(out);
  });

  // Pinned vectors — the expected hex is generated OUTSIDE this codebase so a
  // silent change to the signing algorithm (digest, encoding, secret handling)
  // is caught, not masked by sign()/verify() agreeing with each other.
  // Reproduce:  printf '%s' "<body>" | openssl dgst -sha256 -hmac "<secret>" -r
  it.each([
    {
      body: '{"signed_at":1730902400123,"events":[]}',
      secret: 'test-secret-at-least-16-chars',
      expected: 'b47aa2549805eec3a63adadfc87dbd7d3568e2931cf35afc74e0d046bdd263f0',
    },
    {
      body: 'hello',
      secret: 'world-of-secrets-1234567',
      expected: 'a501bdc3bdcd709ffc55e7250b5127771bf5500fd96adf7d9687ba393f48e4e9',
    },
  ])('matches the openssl-pinned HMAC for $body', ({ body, secret, expected }) => {
    expect(sign(body, secret)).toBe(expected);
  });

  it('verify accepts a body signed to the pinned vector', () => {
    const body = '{"signed_at":1730902400123,"events":[]}';
    const r = verify({
      rawBody: body,
      signature: 'b47aa2549805eec3a63adadfc87dbd7d3568e2931cf35afc74e0d046bdd263f0',
      secret: 'test-secret-at-least-16-chars',
      signedAtMs: 1730902400123,
      nowMs: 1730902400123,
      replayWindowMs: WINDOW,
    });
    expect(r).toEqual({ valid: true });
  });
});

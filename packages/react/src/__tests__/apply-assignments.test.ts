import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAssignedExperiments,
  resolveAssignedExperiments,
  revealShield,
} from '../apply-assignments.ts';
import { domConfig, setWindowUrl, splitUrlConfig } from './helpers.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

// domConfig's experiment page rule is `exact https://acme.com/pricing`.
const PAGE = 'https://acme.com/pricing';
const OFF_PAGE = 'https://acme.com/';

describe('resolveAssignedExperiments', () => {
  it('returns the assigned DOM variant from the cookie on the experiment page', () => {
    const out = resolveAssignedExperiments(domConfig(), '101.2.0.0', PAGE);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ experimentId: 101, variationId: 2 });
    expect(out[0]?.changes[0]?.type).toBe('change_html');
  });

  it('does NOT apply on a page that fails the experiment page rule', () => {
    // Assigned in the cookie, but we're on '/', not '/pricing' → no leak.
    expect(resolveAssignedExperiments(domConfig(), '101.2.0.0', OFF_PAGE)).toHaveLength(0);
  });

  it('drops redirect-only variations (no DOM changes)', () => {
    // splitUrlConfig variant 2 is redirect-only → nothing to apply on the client.
    expect(resolveAssignedExperiments(splitUrlConfig(), '101.2.0.0', PAGE)).toHaveLength(0);
  });

  it('drops excluded assignments', () => {
    expect(resolveAssignedExperiments(domConfig(), '101.-1.1.0', PAGE)).toHaveLength(0);
  });

  it('returns [] for an empty cookie', () => {
    expect(resolveAssignedExperiments(domConfig(), null, PAGE)).toHaveLength(0);
  });
});

describe('applyAssignedExperiments', () => {
  it('applies the variant changes to the DOM on the experiment page', () => {
    setWindowUrl(PAGE); // the apply guard reads the LIVE location
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const teardowns = applyAssignedExperiments(domConfig(), '101.2.0.0', PAGE);
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
    expect(Array.isArray(teardowns)).toBe(true);
  });

  it('applies NOTHING off the experiment page (control content stays)', () => {
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    applyAssignedExperiments(domConfig(), '101.2.0.0', OFF_PAGE);
    expect(document.querySelector('#hero')?.innerHTML).toBe('CONTROL');
  });
});

describe('revealShield', () => {
  it('is a no-op when no shield is present', () => {
    expect(() => revealShield()).not.toThrow();
  });

  it('calls the shield reveal when present', () => {
    let revealed = false;
    (window as unknown as { __testa_shield?: { reveal: () => void } }).__testa_shield = {
      reveal: () => {
        revealed = true;
      },
    };
    revealShield();
    expect(revealed).toBe(true);
    (window as unknown as { __testa_shield?: unknown }).__testa_shield = undefined;
  });
});

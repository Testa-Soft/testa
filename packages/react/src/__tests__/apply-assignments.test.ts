import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAssignedExperiments,
  resolveAssignedExperiments,
  revealShield,
} from '../apply-assignments.ts';
import { domConfig, splitUrlConfig } from './helpers.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveAssignedExperiments', () => {
  it('returns the assigned DOM variant from the cookie', () => {
    const out = resolveAssignedExperiments(domConfig(), '101.2.0.0');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ experimentId: 101, variationId: 2 });
    expect(out[0]?.changes[0]?.type).toBe('change_html');
  });

  it('drops redirect-only variations (no DOM changes)', () => {
    // splitUrlConfig variant 2 is redirect-only → nothing to apply on the client.
    expect(resolveAssignedExperiments(splitUrlConfig(), '101.2.0.0')).toHaveLength(0);
  });

  it('drops excluded assignments', () => {
    expect(resolveAssignedExperiments(domConfig(), '101.-1.1.0')).toHaveLength(0);
  });

  it('returns [] for an empty cookie', () => {
    expect(resolveAssignedExperiments(domConfig(), null)).toHaveLength(0);
  });
});

describe('applyAssignedExperiments', () => {
  it('applies the variant changes to the DOM and returns teardowns', () => {
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const teardowns = applyAssignedExperiments(domConfig(), '101.2.0.0');
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
    expect(Array.isArray(teardowns)).toBe(true);
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

import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHIELD_HINT_KEY,
  configNeedsShield,
  readShieldHint,
  writeShieldHint,
} from '../shield-hint.ts';
import { domConfig, splitUrlConfig } from './helpers.ts';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('readShieldHint / writeShieldHint', () => {
  it('round-trips true', () => {
    writeShieldHint(true);
    expect(localStorage.getItem(SHIELD_HINT_KEY)).toBe('1');
    expect(readShieldHint()).toBe(true);
  });

  it('round-trips false', () => {
    writeShieldHint(false);
    expect(localStorage.getItem(SHIELD_HINT_KEY)).toBe('0');
    expect(readShieldHint()).toBe(false);
  });

  it('returns null when absent', () => {
    expect(readShieldHint()).toBeNull();
  });

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    expect(readShieldHint()).toBeNull();
  });

  it('never throws when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => writeShieldHint(true)).not.toThrow();
  });
});

describe('configNeedsShield', () => {
  it('true — active experiment with a DOM change', () => {
    expect(configNeedsShield(domConfig())).toBe(true);
  });

  it('true — active experiment with only a redirect change', () => {
    expect(configNeedsShield(splitUrlConfig())).toBe(true);
  });

  it('false — inactive experiment even with changes', () => {
    const active = domConfig();
    const paused: ProjectConfig = {
      ...active,
      experiments: [{ ...firstExp(active), status: 'paused' }],
    };
    expect(configNeedsShield(paused)).toBe(false);
  });

  it('false — active experiment with zero changes in all variations', () => {
    expect(configNeedsShield(noChangeConfig())).toBe(false);
  });

  it('false — empty experiments', () => {
    const config: ProjectConfig = { ...splitUrlConfig(), experiments: [] };
    expect(configNeedsShield(config)).toBe(false);
  });
});

/** An active experiment whose every variation has an empty `changes` array. */
function noChangeConfig(): ProjectConfig {
  const config = splitUrlConfig();
  const experiment = firstExp(config);
  return {
    ...config,
    experiments: [
      {
        ...experiment,
        variations: experiment.variations.map((v) => ({ ...v, changes: [] })),
      },
    ],
  };
}

function firstExp(config: ProjectConfig): ExperimentConfig {
  const exp = config.experiments[0];
  if (!exp) throw new Error('fixture has no experiments');
  return exp;
}

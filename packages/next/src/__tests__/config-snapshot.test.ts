import { afterEach, describe, expect, it } from 'vitest';
import {
  clearConfigSnapshot,
  configSnapshotAgeMs,
  readConfigSnapshot,
  writeConfigSnapshot,
} from '../config-snapshot.ts';
import { splitUrlConfig } from './helpers.ts';

afterEach(() => {
  clearConfigSnapshot();
});

describe('config snapshot (globalThis store)', () => {
  it('reads back a written snapshot by projectId', () => {
    const config = splitUrlConfig();
    writeConfigSnapshot('acme', config, 1_000);
    expect(readConfigSnapshot('acme')).toBe(config);
    expect(readConfigSnapshot('other')).toBeNull();
  });

  it('replaces a previous snapshot for the same project', () => {
    writeConfigSnapshot('acme', splitUrlConfig(), 1_000);
    const next = splitUrlConfig({ to: 'https://acme.com/pricing-v3' });
    writeConfigSnapshot('acme', next, 2_000);
    expect(readConfigSnapshot('acme')).toBe(next);
  });

  it('reports snapshot age against the writer clock', () => {
    writeConfigSnapshot('acme', splitUrlConfig(), 1_000);
    expect(configSnapshotAgeMs('acme', 61_000)).toBe(60_000);
    expect(configSnapshotAgeMs('missing', 61_000)).toBeNull();
  });

  it('survives module boundaries — the store lives on globalThis, not module scope', () => {
    writeConfigSnapshot('acme', splitUrlConfig(), 1_000);
    const raw = (globalThis as Record<string, unknown>).__TESTA_CONFIG_SNAPSHOTS__;
    expect(raw).toBeTruthy();
    expect((raw as Record<string, { fetchedAtMs: number }>).acme?.fetchedAtMs).toBe(1_000);
  });

  it('clears one project or everything', () => {
    writeConfigSnapshot('a', splitUrlConfig(), 0);
    writeConfigSnapshot('b', splitUrlConfig(), 0);
    clearConfigSnapshot('a');
    expect(readConfigSnapshot('a')).toBeNull();
    expect(readConfigSnapshot('b')).not.toBeNull();
    clearConfigSnapshot();
    expect(readConfigSnapshot('b')).toBeNull();
  });
});

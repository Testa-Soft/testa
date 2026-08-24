/**
 * `ConfigClient.getSync` (the sync proxy's config path) + the poller-snapshot
 * precedence shared by both `get` flavors.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigClient } from '../config.ts';
import { clearConfigSnapshot, writeConfigSnapshot } from '../config-snapshot.ts';
import { splitUrlConfig } from './helpers.ts';

afterEach(() => {
  clearConfigSnapshot();
});

describe('ConfigClient.getSync', () => {
  it('returns a static config without touching anything', () => {
    const config = splitUrlConfig();
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ config, loadConfig });
    expect(client.getSync('acme', 0)).toBe(config);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('cold instance: fails open to null and warms the cache in the background', async () => {
    const config = splitUrlConfig();
    const loadConfig = vi.fn(async () => config);
    const client = new ConfigClient({ loadConfig });
    const kept: Promise<unknown>[] = [];

    expect(client.getSync('acme', 0, (p) => kept.push(p))).toBeNull();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(kept).toHaveLength(1);

    await Promise.all(kept);
    expect(client.getSync('acme', 100)).toBe(config); // warm now
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it('past the fresh window: serves the stale entry and kicks a background refresh', async () => {
    let version = 0;
    const loadConfig = vi.fn(async () => {
      version += 1;
      return { ...splitUrlConfig(), config_hash: `v${version}` };
    });
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });

    client.getSync('acme', 0); // cold → kicks v1
    await vi.waitFor(() => expect(client.getSync('acme', 100)?.config_hash).toBe('v1'));

    const stale = client.getSync('acme', 1500); // past ttl → stale + refresh
    expect(stale?.config_hash).toBe('v1');
    expect(loadConfig).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(client.getSync('acme', 1600)?.config_hash).toBe('v2'));
  });

  it('keeps serving last-known-good beyond the async max-stale bound (sync never blocks)', async () => {
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig, cacheTtlMs: 1000 });
    client.getSync('acme', 0);
    await vi.waitFor(() => expect(client.getSync('acme', 100)).not.toBeNull());

    // Way past MAX_STALE (5 min): async get would block; sync serves stale.
    expect(client.getSync('acme', 10_000_000)).not.toBeNull();
  });
});

describe('poller-snapshot precedence', () => {
  it('getSync: the snapshot beats fetch-based sources', () => {
    const snapshot = splitUrlConfig({ to: 'https://acme.com/from-snapshot' });
    writeConfigSnapshot('acme', snapshot, 0);
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig });

    expect(client.getSync('acme', 0)).toBe(snapshot);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('async get: the snapshot beats fetch-based sources too (single source per process)', async () => {
    const snapshot = splitUrlConfig({ to: 'https://acme.com/from-snapshot' });
    writeConfigSnapshot('acme', snapshot, 0);
    const loadConfig = vi.fn(async () => splitUrlConfig());
    const client = new ConfigClient({ loadConfig });

    expect(await client.get('acme', 0)).toBe(snapshot);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('an explicit static `config` option still wins over the snapshot', async () => {
    const staticConfig = splitUrlConfig();
    writeConfigSnapshot('acme', splitUrlConfig({ to: 'https://acme.com/other' }), 0);
    const client = new ConfigClient({ config: staticConfig });

    expect(client.getSync('acme', 0)).toBe(staticConfig);
    expect(await client.get('acme', 0)).toBe(staticConfig);
  });
});

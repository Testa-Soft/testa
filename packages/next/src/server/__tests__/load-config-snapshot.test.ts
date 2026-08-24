/**
 * `loadTestaConfig` × the instrumentation snapshot: a polled deployment never
 * fetches from the render path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearConfigSnapshot, writeConfigSnapshot } from '../../config-snapshot.ts';
import { loadTestaConfig } from '../load-config.ts';

const CONFIG = {
  project_id: 1,
  slug: 'acme',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'hash-1',
  experiments: [],
  // biome-ignore lint/suspicious/noExplicitAny: fixture cast, shape-checked by the loader
} as any;

afterEach(() => {
  clearConfigSnapshot();
});

describe('loadTestaConfig + snapshot', () => {
  it('returns the snapshot without fetching', async () => {
    writeConfigSnapshot('abc123', CONFIG, Date.now());
    const fetchImpl = vi.fn();
    const result = await loadTestaConfig({ projectId: 'abc123', fetchImpl });
    expect(result).toBe(CONFIG);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to fetching when no snapshot exists for the project', async () => {
    writeConfigSnapshot('someone-else', CONFIG, Date.now());
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => CONFIG }) as Response);
    const result = await loadTestaConfig({ projectId: 'abc123', fetchImpl });
    expect(result).toEqual(CONFIG);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

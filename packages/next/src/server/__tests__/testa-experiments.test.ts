import type { ProjectConfig } from '@testa-platform/shared-types';
import { TestaExperiments as TestaExperimentsClient } from '@testa-soft/next/experiments';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestaExperiments } from '../TestaExperiments.tsx';

const CONFIG: ProjectConfig = {
  project_id: 1,
  slug: 'acme',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'hash-1',
  experiments: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('TestaExperiments (server component)', () => {
  it('renders the client component with an inline config and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaExperiments({ config: CONFIG });
    expect(el).not.toBeNull();
    expect((el as { type: unknown }).type).toBe(TestaExperimentsClient);
    expect((el as { props: { config: ProjectConfig } }).props.config).toBe(CONFIG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches by projectId and renders with the fetched config', async () => {
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => CONFIG }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaExperiments({ projectId: 'abc', host: 'https://cfg.example' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((el as { type: unknown }).type).toBe(TestaExperimentsClient);
    expect((el as { props: { config: ProjectConfig } }).props.config).toEqual(CONFIG);
  });

  it('returns null when the projectId fetch fails (fail open)', async () => {
    const fetchSpy = vi.fn(
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
    expect(await TestaExperiments({ projectId: 'abc', host: 'https://cfg.example' })).toBeNull();
  });

  it('passes previewApiUrl through to the client component', async () => {
    const el = await TestaExperiments({ config: CONFIG, previewApiUrl: 'https://preview.example' });
    expect((el as { props: { previewApiUrl?: string } }).props.previewApiUrl).toBe(
      'https://preview.example',
    );
  });

  it('omits previewApiUrl when not supplied', async () => {
    const el = await TestaExperiments({ config: CONFIG });
    expect('previewApiUrl' in (el as { props: object }).props).toBe(false);
  });

  it('returns null when neither config nor projectId is given at runtime', async () => {
    // Cast around the union type — a caller can still violate it at runtime.
    expect(await TestaExperiments({} as never)).toBeNull();
  });
});

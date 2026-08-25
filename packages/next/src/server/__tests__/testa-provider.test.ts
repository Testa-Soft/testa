import type { ProjectConfig } from '@testa-platform/shared-types';
import { TestaProvider as TestaProviderClient } from '@testa-soft/next/_internal/experiments';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestaProvider } from '../TestaProvider.tsx';

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

describe('TestaProvider (server component)', () => {
  it('renders the client component with an inline config and never fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaProvider({ config: CONFIG });
    expect(el).not.toBeNull();
    expect((el as { type: unknown }).type).toBe(TestaProviderClient);
    expect((el as { props: { config: ProjectConfig } }).props.config).toBe(CONFIG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches by projectId and renders with the fetched config', async () => {
    const fetchSpy = vi.fn(
      async () => ({ ok: true, json: async () => CONFIG }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaProvider({ projectId: 'abc', host: 'https://cfg.example' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((el as { type: unknown }).type).toBe(TestaProviderClient);
    expect((el as { props: { config: ProjectConfig } }).props.config).toEqual(CONFIG);
  });

  it('still renders the client when the server-side fetch fails, so it can fetch itself', async () => {
    // Rendering nothing here used to mean NO experiments on the page for as long
    // as the server-side failure lasted (unreachable from the server, a null
    // baked into a static prerender, the fetch budget) — the client had no way
    // to recover. It gets the projectId instead and owns the pageview.
    const fetchSpy = vi.fn(
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaProvider({ projectId: 'abc', host: 'https://cfg.example' });
    expect((el as { type: unknown }).type).toBe(TestaProviderClient);
    const props = (el as { props: { config?: ProjectConfig; projectId?: string; host?: string } })
      .props;
    expect(props.config).toBeUndefined();
    expect(props.projectId).toBe('abc');
    expect(props.host).toBe('https://cfg.example');
  });

  it('strips a SERVER-fetched config’s geo — it is the datacenter’s, not the visitor’s', async () => {
    const fetchSpy = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ ...CONFIG, geo: { country: 'US' } }),
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
    const el = await TestaProvider({ projectId: 'abc' });
    const config = (el as { props: { config: ProjectConfig } }).props.config;
    expect(config.geo).toBeUndefined();
    expect(config.config_hash).toBe(CONFIG.config_hash);
  });

  it('passes previewApiUrl through to the client component', async () => {
    const el = await TestaProvider({ config: CONFIG, previewApiUrl: 'https://preview.example' });
    expect((el as { props: { previewApiUrl?: string } }).props.previewApiUrl).toBe(
      'https://preview.example',
    );
  });

  it('omits previewApiUrl when not supplied', async () => {
    const el = await TestaProvider({ config: CONFIG });
    expect('previewApiUrl' in (el as { props: object }).props).toBe(false);
  });

  it('returns null when neither config nor projectId is given at runtime', async () => {
    // Cast around the union type — a caller can still violate it at runtime.
    expect(await TestaProvider({} as never)).toBeNull();
  });
});

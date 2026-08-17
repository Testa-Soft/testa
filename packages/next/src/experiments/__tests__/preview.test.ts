import type { VariationChange } from '@testa-platform/shared-types';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchPreviewChanges,
  getPreviewToken,
  isPreviewRequested,
  normalizeChanges,
} from '../preview.ts';

describe('isPreviewRequested', () => {
  it('true only when testa_preview=true', () => {
    expect(isPreviewRequested('?testa_preview=true&testa_preview_token=abc')).toBe(true);
    expect(isPreviewRequested('?testa_preview=false')).toBe(false);
    expect(isPreviewRequested('?foo=bar')).toBe(false);
    expect(isPreviewRequested('')).toBe(false);
  });
});

describe('getPreviewToken', () => {
  it('extracts the token or null', () => {
    expect(getPreviewToken('?testa_preview=true&testa_preview_token=tok123')).toBe('tok123');
    expect(getPreviewToken('?testa_preview=true')).toBeNull();
  });
});

describe('normalizeChanges', () => {
  it('keeps well-formed change objects, drops the rest', () => {
    const raw = [
      { type: 'change_html', selector: '#h', content: 'x' },
      { type: 'css', content: '#h{color:red}' },
      { nope: 1 },
      'garbage',
      null,
    ];
    const out = normalizeChanges(raw);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.type)).toEqual(['change_html', 'css']);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeChanges({ changes: 'nope' })).toEqual([]);
    expect(normalizeChanges(null)).toEqual([]);
  });
});

describe('fetchPreviewChanges', () => {
  const changes: VariationChange[] = [{ type: 'change_html', selector: '#h', content: 'variant' }];

  it('fetches + normalizes draft changes from /api/preview/{token}', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ changes }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchPreviewChanges('https://app.testa-soft.tech/', 'tok/1', fetchImpl);
    expect(out).toEqual(changes);
    // Trailing slash trimmed + token url-encoded.
    expect(calledUrl).toBe('https://app.testa-soft.tech/api/preview/tok%2F1');
  });

  it('returns [] on a non-ok response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchPreviewChanges('https://x', 'tok', fetchImpl)).toEqual([]);
  });

  it('returns [] and never throws on a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchPreviewChanges('https://x', 'tok', fetchImpl)).resolves.toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPreviewRequested, maybeEnterPreviewMode } from '../preview.ts';

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`);
}

afterEach(() => {
  setUrl('');
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('isPreviewRequested', () => {
  it('is true only when testa_preview=true', () => {
    setUrl('?testa_preview=true&testa_preview_token=abc');
    expect(isPreviewRequested()).toBe(true);
    setUrl('?foo=bar');
    expect(isPreviewRequested()).toBe(false);
  });
});

describe('maybeEnterPreviewMode', () => {
  it('returns false and does nothing when not in preview', () => {
    setUrl('?foo=bar');
    const fetchImpl = vi.fn();
    const apply = vi.fn();
    expect(
      maybeEnterPreviewMode({ apiUrl: 'https://api.example', project: 4, apply, fetchImpl }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches the preview session and applies the returned changes', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok-9');
    const changes = [{ type: 'hide', selector: '.x' }];
    const fetchImpl = vi.fn(async () => jsonResponse({ changes }));
    const apply = vi.fn();

    const handled = maybeEnterPreviewMode({
      apiUrl: 'https://api.example/',
      project: 4,
      apply,
      fetchImpl,
    });
    expect(handled).toBe(true);
    // let the fetch promise + apply microtasks settle
    await new Promise<void>((r) => setTimeout(r, 0));

    // crobot binds the token to a project: the request must name it.
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/api/preview/tok-9?project=4');
    expect(apply).toHaveBeenCalledWith(-1, changes);
  });

  it('skips the normal cycle but applies nothing when token is missing', () => {
    setUrl('?testa_preview=true');
    const fetchImpl = vi.fn();
    const apply = vi.fn();
    expect(
      maybeEnterPreviewMode({ apiUrl: 'https://api.example', project: 4, apply, fetchImpl }),
    ).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applies nothing when the response is not ok', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok');
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ changes: [{ type: 'hide', selector: '.x' }] }, false),
    );
    const apply = vi.fn();
    maybeEnterPreviewMode({ apiUrl: 'https://api.example', project: 4, apply, fetchImpl });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(apply).not.toHaveBeenCalled();
  });

  it('names a uuid project url-encoded', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok');
    const fetchImpl = vi.fn(async () => jsonResponse({ changes: [] }));
    maybeEnterPreviewMode({
      apiUrl: 'https://api.example',
      project: 'ab c',
      apply: vi.fn(),
      fetchImpl,
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example/api/preview/tok?project=ab%20c');
  });

  it('skips the normal cycle but fetches nothing when the project is unknown', () => {
    setUrl('?testa_preview=true&testa_preview_token=tok');
    const fetchImpl = vi.fn();
    const apply = vi.fn();
    expect(
      maybeEnterPreviewMode({
        apiUrl: 'https://api.example',
        project: undefined,
        apply,
        fetchImpl,
      }),
    ).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies nothing on a 404 (token bound to another project)', async () => {
    setUrl('?testa_preview=true&testa_preview_token=tok');
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Not Found' }, false));
    const apply = vi.fn();
    maybeEnterPreviewMode({ apiUrl: 'https://api.example', project: 999, apply, fetchImpl });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

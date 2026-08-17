/**
 * Preview mode for the client SDK — parity with the pixel's `?testa_preview`
 * flow, framework-agnostic core.
 *
 * When the page is opened with `?testa_preview=true&testa_preview_token=<t>`,
 * the SDK does NOT run the normal cookie-first assignment. Instead it fetches
 * the draft changes for that preview session from the backend
 * (`GET {apiUrl}/api/preview/{token}` → `{ changes: VariationChange[] }`) and
 * applies them, so an editor can see un-published variation changes live.
 *
 * The fetched changes are crobot-native `VariationChange` shapes — the same the
 * apply engine consumes for real variations, so drafts render identically.
 */

import type { VariationChange } from '@testa-platform/shared-types';

export const PREVIEW_FLAG = 'testa_preview';
export const PREVIEW_TOKEN = 'testa_preview_token';
/** Synthetic variation id for applied preview changes (never a real variation). */
export const PREVIEW_VARIATION_ID = -1;

/** True when the query string requests preview mode. */
export function isPreviewRequested(search: string): boolean {
  return new URLSearchParams(search).get(PREVIEW_FLAG) === 'true';
}

/** The preview session token from the query string, or null. */
export function getPreviewToken(search: string): string | null {
  return new URLSearchParams(search).get(PREVIEW_TOKEN);
}

/**
 * Fetch the draft changes for a preview session. Never throws — a failed /
 * malformed response yields an empty list (apply nothing). `apiUrl` is the
 * backend base (crobot); `fetchImpl` is injectable for tests.
 */
export async function fetchPreviewChanges(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VariationChange[]> {
  const base = apiUrl.replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${base}/api/preview/${encodeURIComponent(token)}`);
    if (!res.ok) return [];
    const json = (await res.json()) as { changes?: unknown };
    return normalizeChanges(json.changes);
  } catch {
    return [];
  }
}

/** Validate the payload is an array of change-like objects. */
export function normalizeChanges(raw: unknown): VariationChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is VariationChange =>
      typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string',
  );
}

/**
 * Session-entry attribution (PRD-006 §3.6, §5.3; task 5.6).
 *
 * A visitor landing on `/?utm_source=google` and seeing the experiment on page
 * 3 would otherwise carry empty UTMs and an on-site referrer on their
 * `experiment_view`. So on the first page of each browsing session (`_testa_sid`)
 * the pixel stores the entry referrer, landing URL, UTMs and the TYPE of ad
 * click id in sessionStorage, and stamps them on `experiment_view` only.
 *
 * Click-id VALUES never leave the browser: only the type is kept, and the
 * click-id params are stripped from URLs. Storage failures never break
 * tracking (everything degrades to "no entry attribution").
 */
import type { ClickIdType, PixelEvent } from '@testa-platform/shared-types';

export const ENTRY_STORAGE_KEY = '_testa_entry';

/** Checked in this order; the first present wins. */
export const CLICK_ID_PARAMS: readonly ClickIdType[] = [
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
  'ttclid',
  'li_fat_id',
];

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

export type EntryFields = Pick<
  PixelEvent,
  | 'entry_referrer'
  | 'entry_url'
  | 'entry_utm_source'
  | 'entry_utm_medium'
  | 'entry_utm_campaign'
  | 'entry_utm_term'
  | 'entry_utm_content'
  | 'click_id_type'
>;

interface StoredEntry extends EntryFields {
  sid: string;
}

/** `url` with click-id params removed (values never leave the browser). */
export function stripClickIds(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    let changed = false;
    for (const p of CLICK_ID_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.delete(p);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** UTMs of the current page (all five). Empty values are omitted. */
export function readUtms(
  search: string,
): Pick<PixelEvent, 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_term' | 'utm_content'> {
  if (!search) return {};
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

function captureFromPage(sid: string): StoredEntry {
  const href = typeof location !== 'undefined' ? location.href : '';
  const search = typeof location !== 'undefined' ? location.search : '';
  const params = new URLSearchParams(search);
  const utms = readUtms(search);
  const clickId = CLICK_ID_PARAMS.find((p) => params.has(p));
  const referrer = typeof document !== 'undefined' ? document.referrer : '';
  return {
    sid,
    entry_url: stripClickIds(href),
    ...(referrer ? { entry_referrer: stripClickIds(referrer) } : {}),
    ...(utms.utm_source ? { entry_utm_source: utms.utm_source } : {}),
    ...(utms.utm_medium ? { entry_utm_medium: utms.utm_medium } : {}),
    ...(utms.utm_campaign ? { entry_utm_campaign: utms.utm_campaign } : {}),
    ...(utms.utm_term ? { entry_utm_term: utms.utm_term } : {}),
    ...(utms.utm_content ? { entry_utm_content: utms.utm_content } : {}),
    ...(clickId ? { click_id_type: clickId } : {}),
  };
}

function readStored(): StoredEntry | null {
  try {
    const raw = sessionStorage.getItem(ENTRY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredEntry) : null;
  } catch {
    return null;
  }
}

/**
 * The entry attribution of browsing session `sid`, capturing it from the
 * current page the first time this session is seen (its first page).
 */
export function entryFor(sid: string): EntryFields {
  try {
    const stored = readStored();
    if (stored && stored.sid === sid) {
      const { sid: _sid, ...fields } = stored;
      return fields;
    }
    const fresh = captureFromPage(sid);
    try {
      sessionStorage.setItem(ENTRY_STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // Storage blocked: still use this page's values for this event.
    }
    const { sid: _sid, ...fields } = fresh;
    return fields;
  } catch {
    return {};
  }
}

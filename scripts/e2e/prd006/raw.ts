/**
 * In-memory raw rows shared by the PRD-006 harness fixtures and the oracle:
 * exactly the shape of `docs/reference/samples/{f1,demo}/raw/*.jsonl`
 * (ClickHouse row shape, as `generate.py` emits it). F1/demo load these from
 * disk; the F2 generator builds them in memory; the oracle reads them; the
 * ingest step converts them to wire events.
 */

import { readFileSync } from 'node:fs';

export interface RawEvent {
  readonly [key: string]: unknown;
  readonly event_id: string;
  /** `YYYY-MM-DD HH:MM:SS.mmm`, UTC. */
  readonly client_ts: string;
  readonly server_ts: string;
  readonly project_id: number;
  readonly experiment_id: number | null;
  readonly variation_id: number | null;
  readonly visitor_id: string;
  readonly session_id: string;
  readonly event_name: string;
  readonly url: string;
  readonly is_bot: number;
  readonly exp_ids: readonly number[];
  readonly exp_var_ids: readonly number[];
  readonly exp_session_starts: readonly number[];
  readonly goal_id: number;
  readonly value_native: number;
  readonly currency: string;
  readonly order_id: string;
  readonly items_count: number;
  readonly purchase_type: string;
  readonly parent_order_id: string;
  readonly props: Readonly<Record<string, string>>;
  // Dimensions (snapshotted into `exposures` from the experiment_view).
  readonly channel: string;
  readonly referrer_domain: string;
  readonly country: string;
  readonly region: string;
  readonly city: string;
  readonly device_type: string;
  readonly os_name: string;
  readonly browser_name: string;
  readonly screen_w: number;
  readonly screen_h: number;
  readonly visit_number: number;
  readonly entry_utm_source: string;
  readonly entry_utm_medium: string;
  readonly entry_utm_campaign: string;
}

export interface RawItem {
  readonly event_id: string;
  readonly client_ts: string;
  readonly project_id: number;
  readonly visitor_id: string;
  readonly event_name: string;
  readonly exp_ids: readonly number[];
  readonly order_id: string;
  readonly purchase_type: string;
  readonly currency: string;
  readonly item_id: string;
  readonly product_id: string;
  readonly item_name: string;
  readonly item_variant: string;
  /** `null` = the tracker sent no price. */
  readonly price: number | null;
  readonly quantity: number;
  readonly [key: string]: unknown;
}

/** One simulated dataset: raw events + item rows (generate.py `Sim`). */
export interface Sim {
  readonly events: readonly RawEvent[];
  readonly items: readonly RawItem[];
}

export function readJsonl<T>(path: string): T[] {
  const text = path.endsWith('.gz')
    ? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(readFileSync(path))))
    : readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** A reference sample set from `docs/reference/samples/<set>/raw`. */
export function loadSampleSim(samplesDir: string, set: 'f1' | 'demo'): Sim {
  const ext = set === 'demo' ? '.jsonl.gz' : '.jsonl';
  return {
    events: readJsonl<RawEvent>(`${samplesDir}/${set}/raw/events${ext}`),
    items: readJsonl<RawItem>(`${samplesDir}/${set}/raw/event_items${ext}`),
  };
}

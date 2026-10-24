/**
 * Real ingest path client: HMAC-signed `POST /_ingest` batches (same protocol
 * as the edge worker, docs/reference/hmac-protocol.md), then wait until
 * ClickHouse `events` (not the Buffer) holds the rows.
 *
 * Shared with P5 (`scripts/e2e/prd006/ingest.ts` can wrap this).
 */

import { type ChTarget, chQuery } from '../lib/clickhouse.ts';
import { signIngest } from '../lib/hmac.ts';
import { waitFor } from '../lib/http.ts';
import type { WireEvent } from './f1-wire.ts';

export interface IngestResult {
  readonly batches: number;
  readonly accepted: number;
  readonly deduplicated: number;
}

export class IngestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`/_ingest returned ${status}: ${body.slice(0, 300)}`);
  }
}

export async function ingestEvents(
  collectorUrl: string,
  secret: string,
  events: readonly WireEvent[],
  batchSize = 500,
): Promise<IngestResult> {
  let accepted = 0;
  let deduplicated = 0;
  let batches = 0;
  for (let i = 0; i < events.length; i += batchSize) {
    const body = JSON.stringify({ signed_at: Date.now(), events: events.slice(i, i + batchSize) });
    const res = await fetch(`${collectorUrl}/_ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-signature': signIngest(body, secret) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (res.status >= 300) throw new IngestError(res.status, text);
    accepted += Number(res.headers.get('x-events-accepted') ?? 0);
    deduplicated += Number(res.headers.get('x-events-deduplicated') ?? 0);
    batches += 1;
  }
  return { batches, accepted, deduplicated };
}

/** Wait until `SELECT count() FROM events WHERE <where>` reaches `expected`. */
export async function waitForEventRows(
  ch: ChTarget,
  where: string,
  expected: number,
  timeoutMs = 60_000,
): Promise<number> {
  return waitFor(
    `${expected} rows in ${ch.database}.events WHERE ${where}`,
    async () => {
      const rows = await chQuery<{ n: string }>(
        ch,
        `SELECT count() AS n FROM events WHERE ${where}`,
      );
      const n = Number(rows[0]?.n ?? 0);
      return n >= expected ? n : undefined;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
}

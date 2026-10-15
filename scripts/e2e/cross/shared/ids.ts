/** Deterministic UUIDs (ClickHouse `events.event_id` is a UUID column). */

import { createHash } from 'node:crypto';

/** Name-based UUID (v5-style layout over sha1) — same name, same id. */
export function uuidFor(name: string): string {
  const h = createHash('sha1').update(name).digest('hex');
  const variant = ((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

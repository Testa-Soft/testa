/**
 * First-party visitor-id minting.
 *
 * In a Next.js deployment the customer's origin serves the page, so the
 * middleware is first-party and mints `_testa_uuid` itself via a server
 * Set-Cookie — more ITP-durable than a JS-written cookie. `crypto.randomUUID`
 * is available in both the Edge Runtime and Node.
 */

import { type CookieStore, UUID_COOKIE, UUID_TTL_SEC } from '@testa-soft/experiment-core';

/** Return the existing visitor id, or mint + persist a new one. */
export function ensureVisitorId(store: CookieStore): string {
  const existing = store.get(UUID_COOKIE);
  if (existing) return existing;
  const uuid = crypto.randomUUID();
  store.set(UUID_COOKIE, uuid, { maxAgeSec: UUID_TTL_SEC });
  return uuid;
}

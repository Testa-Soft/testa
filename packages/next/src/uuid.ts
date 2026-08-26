/**
 * First-party visitor id, kept in two cookies.
 *
 * In a Next.js deployment the customer's origin serves the page, so the
 * middleware is first-party and mints `_testa_uuid` itself via a server
 * Set-Cookie. `crypto.randomUUID` is available in both the Edge Runtime and
 * Node.
 *
 * The id also gets an `HttpOnly` copy (`_testa_uuid_s`), and the readable one is
 * RESTORED from it whenever it goes missing. Losing the id is the expensive
 * failure: the visitor becomes a new visitor, is counted a second time, and is
 * re-bucketed — free to land in the other group while standing on the group
 * they were originally sent to. Everything else re-derives, because bucketing
 * is `hash(visitorId:experimentId)`: a visitor whose assignment cookie is gone
 * but whose id survived is put back in the SAME variation.
 *
 * The readable copy stays authoritative when both exist and disagree. It is
 * what the client engine and the pixel write, and adopting the older server
 * copy would move an active visitor between variations mid-session — worse than
 * the deletion we are defending against.
 */

import {
  type CookieStore,
  UUID_BACKUP_COOKIE,
  UUID_COOKIE,
  UUID_TTL_SEC,
} from '@testa-soft/experiment-core';

/**
 * Return this visitor's id — existing, restored from the server-owned copy, or
 * freshly minted — and keep both cookies in sync.
 */
export function ensureVisitorId(store: CookieStore): string {
  const readable = store.get(UUID_COOKIE);
  const backup = store.get(UUID_BACKUP_COOKIE);

  if (readable) {
    // Re-sync a missing or stale backup so the next deletion is survivable.
    if (backup !== readable) writeBackup(store, readable);
    return readable;
  }

  if (backup) {
    // The readable cookie was cleared — by a consent tool, an extension, a
    // browser cap. Put it back rather than minting a second visitor.
    store.set(UUID_COOKIE, backup, { maxAgeSec: UUID_TTL_SEC });
    return backup;
  }

  const uuid = crypto.randomUUID();
  store.set(UUID_COOKIE, uuid, { maxAgeSec: UUID_TTL_SEC });
  writeBackup(store, uuid);
  return uuid;
}

function writeBackup(store: CookieStore, uuid: string): void {
  store.set(UUID_BACKUP_COOKIE, uuid, { maxAgeSec: UUID_TTL_SEC, httpOnly: true });
}

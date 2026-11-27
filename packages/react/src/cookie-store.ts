/**
 * A `CookieStore` backed by a PROMOTING cascade — memory, `document.cookie`, and
 * Web Storage kept in sync on every access. 3.3.3 `helpers.getCookie` parity,
 * with its write-back behaviour made explicit.
 *
 * WHY THREE TIERS. Cookies are not reliably writable, and the failure is silent:
 * `document.cookie` is a setter that throws nothing when the value is refused.
 * In-app webviews — Meta's above all, which is where paid social traffic lands —
 * restrict cookie storage while leaving Web Storage working. A cookie-only store
 * cannot read the visitor id back, so a NEW one is minted on every pageview: the
 * same human is counted repeatedly, re-bucketed each time, and their conversions
 * are attributed to ids that never appear again.
 *
 * WHY PROMOTION IS THE POINT. A read-only fallback fixes the client and leaves
 * the SERVER blind — the middleware can only see cookies, so it keeps minting a
 * fresh id on every request no matter what the browser knows. So a value found
 * in a lower tier is written back UP: into the cookie, so the next request
 * carries it, and into memory, so the rest of this page load is free. The jar
 * repairs itself the moment it starts accepting writes again.
 *
 * READ ORDER is cookie → memory → storage, deliberately. The cookie is the one
 * tier the server also writes (a refreshed `_testa_exp` session window arrives
 * that way), so it must win whenever it exists; memory and storage exist to
 * survive its absence, never to shadow it.
 *
 * The memory tier is module-level, so it spans the soft navigations of a single
 * page load — the case where a store is constructed afresh each render. It is
 * inert without a `document`, so a server render can never share state between
 * requests.
 *
 * SSR-safe: every method is a no-op / null when there is no `document`.
 */

import {
  type CookieSetOptions,
  type CookieStore,
  PERSISTENCE_COOKIE,
  type Persistence,
  UUID_COOKIE,
  cookieMaxAge,
} from '@testa-soft/experiment-core';
import { currentPersistence } from './consent.ts';

/**
 * Keys whose value is an IDENTITY: established once, never legitimately
 * changed. When the cookie and the mirror disagree on one of these, something
 * re-minted — a server that could not see the cookie, a jar that dropped it —
 * and re-minting is always the error, because it makes one visitor into two.
 * The mirror wins and is promoted into the cookie, so the next request teaches
 * the server the id it could not otherwise learn.
 *
 * Everything else (`_testa_exp` above all) is mutable STATE the server owns: it
 * slides the session window and adds assignments on every pass. There the
 * cookie is authoritative and the mirror is only a fallback for its absence.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([UUID_COOKIE]);

export interface DocumentCookieStoreOptions {
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secure?: boolean;
  /** Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`). Omit for host-only. */
  domain?: string;
  /**
   * Keep the memory + Web Storage tiers. Default true. Set false to be strictly
   * cookie-only (e.g. a consent mode that treats Web Storage separately).
   */
  mirrorToStorage?: boolean;
  /**
   * Storage lifetime. Default: whatever the visitor's consent allows (see
   * consent.ts), re-read on every access so a consent change applies at once.
   * `session` writes session cookies and mirrors to sessionStorage only;
   * `persistent` is the full-lifetime cookie + localStorage behaviour.
   */
  persistence?: Persistence | (() => Persistence);
}

interface Held {
  value: string;
  /** Epoch ms the value expires, or 0 for "no expiry recorded". */
  expiresAt: number;
  /**
   * Epoch ms this browser FIRST saw this value, or 0 when unrecorded.
   *
   * The clock that settles an identity conflict. The server's mint time is not
   * knowable here — it cannot be embedded in the id, because crobot's `uuid`
   * column is `char(36)` and a longer value would be truncated into a different
   * visitor — and it does not need to be. A cookie carrying a value this
   * browser has never held is, by construction, younger than one it has been
   * holding: "first seen" is a local fact, always establishable, and enough to
   * order the two. Longest-held wins.
   */
  firstSeenAt?: number;
}

/**
 * Tier 1, spanning the soft navs of one page load. Only ever populated in a
 * browser (see `hasDocument`), so a server bundle cannot leak it across
 * requests.
 */
const memory = new Map<string, Held>();

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

function nowMs(): number {
  return Date.now();
}

function live(held: Held | undefined): Held | undefined {
  if (!held) return undefined;
  if (held.expiresAt !== 0 && held.expiresAt <= nowMs()) return undefined;
  return held;
}

/** Read a Web Storage area without ever throwing (private mode, quota, disabled). */
function rawStorage(area: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return globalThis[area]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(area: 'localStorage' | 'sessionStorage', key: string, held: Held): boolean {
  try {
    globalThis[area]?.setItem(key, JSON.stringify(held));
    return true;
  } catch {
    return false;
  }
}

function removeStorage(area: 'localStorage' | 'sessionStorage', key: string): void {
  try {
    globalThis[area]?.removeItem(key);
  } catch {
    // storage disabled / quota — nothing to undo
  }
}

/**
 * Decode a mirrored entry.
 *
 * Tolerates a BARE STRING as well as our `{value, expiresAt}` envelope, because
 * the legacy 3.3.3 pixel mirrors plain values under the same keys (`_testa_uuid`
 * above all). On a site running both, refusing to read the pixel's copy would
 * mint a second visitor for someone we can already identify.
 */
function decodeHeld(raw: string | null): Held | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as Held).value === 'string') {
      const held = parsed as Held;
      return {
        value: held.value,
        expiresAt: Number(held.expiresAt) || 0,
        firstSeenAt: Number(held.firstSeenAt) || 0,
      };
    }
  } catch {
    // not our envelope — fall through to the legacy plain-value read
  }
  return { value: raw, expiresAt: 0 };
}

export class DocumentCookieStore implements CookieStore {
  private readonly secure: boolean;
  private readonly domain: string | undefined;
  private readonly mirror: boolean;
  private readonly persistence: () => Persistence;
  private cookieWriteFailures = 0;
  private promotions = 0;

  constructor(opts: DocumentCookieStoreOptions = {}) {
    this.secure = opts.secure ?? true;
    this.domain = opts.domain;
    this.mirror = opts.mirrorToStorage ?? true;
    // Read the marker straight from the jar: `get` consults the mirror, whose
    // tiers depend on this very answer.
    const p = opts.persistence ?? (() => currentPersistence(this.readCookie(PERSISTENCE_COOKIE)));
    this.persistence = typeof p === 'function' ? p : () => p;
  }

  /** Web Storage areas this store may use: no localStorage without consent. */
  private areas(): ReadonlyArray<'localStorage' | 'sessionStorage'> {
    return this.persistence() === 'persistent'
      ? ['localStorage', 'sessionStorage']
      : ['sessionStorage'];
  }

  /**
   * How many writes the COOKIE jar silently refused. A rejected
   * `document.cookie` write throws nothing, so without counting it there is no
   * way to tell "no value yet" from "this client cannot store cookies".
   */
  failedWrites(): number {
    return this.cookieWriteFailures;
  }

  /**
   * How many reads were served by a lower tier and written back up. Non-zero
   * alongside `failedWrites()` is the signature of a storage-restricted client
   * whose identity is being held together by the mirror.
   */
  recoveries(): number {
    return this.promotions;
  }

  get(name: string): string | null {
    if (!hasDocument()) return null;

    const fromCookie = this.readCookie(name);
    const held = this.mirror ? this.readMirror(name) : undefined;

    if (fromCookie !== null) {
      // RECONCILE. The two tiers disagreeing on an identity means it was
      // re-minted behind our back; the established value is the true one and
      // the cookie has to be corrected, or client and server drift apart for
      // the rest of the session.
      if (held && held.value !== fromCookie && IDENTITY_KEYS.has(name)) {
        // The mirror is holding a value; the cookie carries a different one we
        // have no record of ever holding. The one we have been holding is
        // therefore the older, established identity — `firstSeenAt` says since
        // when, which is what makes this auditable rather than a rule of thumb.
        this.promotions += 1;
        this.promote(name, held);
        return held.value;
      }
      if (this.mirror) {
        const prior = memory.get(name);
        memory.set(name, {
          value: fromCookie,
          expiresAt: 0,
          firstSeenAt:
            prior && prior.value === fromCookie ? (prior.firstSeenAt ?? nowMs()) : nowMs(),
        });
      }
      return fromCookie;
    }
    if (!held) return null;

    // PROMOTE. Restoring the cookie is what lets the SERVER recognise this
    // visitor on the next request instead of minting another one.
    this.promotions += 1;
    this.promote(name, held);
    return held.value;
  }

  /**
   * Names visible to this store: `document.cookie` plus both Web Storage
   * mirrors. All three are consulted because the legacy pixel wrote to cookies
   * AND localStorage, so a visitor whose cookie jar was cleared (ITP, a consent
   * tool) can still have their assignment recovered from the mirror.
   */
  names(): string[] {
    const found = new Set<string>();
    if (!hasDocument()) return [];

    for (const pair of document.cookie.split(';')) {
      const name = pair.split('=')[0]?.trim();
      if (name) found.add(name);
    }
    if (this.mirror) {
      for (const area of this.areas()) {
        try {
          const storage = globalThis[area];
          if (!storage) continue;
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key) found.add(key);
          }
        } catch {
          // storage disabled / partitioned — the cookie names still stand
        }
      }
      for (const key of memory.keys()) found.add(key);
    }
    return [...found];
  }

  private readMirror(name: string): Held | undefined {
    let held = live(memory.get(name));
    for (const area of this.areas()) held ??= live(decodeHeld(rawStorage(area, name)));
    return held;
  }

  set(name: string, value: string, opts: CookieSetOptions): void {
    if (!hasDocument()) return;
    const maxAgeSec = Math.max(0, Math.floor(opts.maxAgeSec));
    this.writeCookie(name, value, maxAgeSec);
    if (this.readCookie(name) !== value) this.cookieWriteFailures += 1;

    if (!this.mirror) return;
    // `maxAgeSec: 0` is a DELETE — every tier must honour it, or a removed value
    // comes straight back on the next read.
    if (maxAgeSec === 0) {
      memory.delete(name);
      removeStorage('localStorage', name);
      removeStorage('sessionStorage', name);
      return;
    }
    const prior = memory.get(name);
    const held: Held = {
      value,
      expiresAt: nowMs() + maxAgeSec * 1000,
      // Re-writing the same value keeps its original first-seen stamp; a new
      // value starts its own clock.
      firstSeenAt: prior && prior.value === value ? (prior.firstSeenAt ?? nowMs()) : nowMs(),
    };
    memory.set(name, held);
    if (this.persistence() === 'persistent') {
      writeStorage('localStorage', name, held) || writeStorage('sessionStorage', name, held);
      return;
    }
    // Session-scoped: never leave a persistent copy behind (this is also what
    // clears an earlier grant's copy on revoke).
    removeStorage('localStorage', name);
    writeStorage('sessionStorage', name, held);
  }

  /** Write a recovered value back into every tier above the one it came from. */
  private promote(name: string, held: Held): void {
    memory.set(name, held);
    const remainingSec =
      held.expiresAt === 0
        ? DEFAULT_PROMOTION_TTL_SEC
        : Math.max(1, Math.floor((held.expiresAt - nowMs()) / 1000));
    this.writeCookie(name, held.value, remainingSec);
    if (this.readCookie(name) !== held.value) this.cookieWriteFailures += 1;
  }

  private writeCookie(name: string, value: string, maxAgeSec: number): void {
    // No cookie is HttpOnly — a pure client SDK could not write one anyway, and
    // the assignment/uuid cookies must stay readable by this very code.
    // No `max-age` at all = a session cookie (no consent to persist).
    const maxAge = cookieMaxAge(maxAgeSec, this.persistence());
    const parts = [`${name}=${encodeURIComponent(value)}`, 'path=/'];
    if (maxAge !== undefined) parts.push(`max-age=${maxAge}`);
    parts.push('SameSite=Lax');
    if (this.secure) parts.push('Secure');
    if (this.domain) parts.push(`domain=${this.domain}`);
    document.cookie = parts.join('; ');
  }

  private readCookie(name: string): string | null {
    if (!hasDocument()) return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${escapeForRegExp(name)}=([^;]*)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

/**
 * Lifetime given to a promoted value carrying no recorded expiry — i.e. one the
 * legacy pixel wrote as a bare string. 30 days matches `ASSIGNMENT_TTL_SEC`, the
 * shorter of the two things we persist, so a promotion can never outlive what
 * the value it restored was meant to have.
 */
const DEFAULT_PROMOTION_TTL_SEC = 30 * 24 * 60 * 60;

/** Test seam — drop the in-memory tier. */
export function __resetMemoryTier(): void {
  memory.clear();
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

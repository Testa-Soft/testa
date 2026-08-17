/**
 * A `CookieStore` (from experiment-core) backed by `document.cookie`.
 *
 * The client-side counterpart to `@testa-soft/next`'s `NextCookieStore`. There's
 * no request/response pair in a pure SPA — reads and writes both hit
 * `document.cookie` directly, so a write is immediately visible to a later `get`
 * (the read-through contract experiment-core's `CookieStore` requires) with no
 * pending buffer.
 *
 * SSR-safe: every method is a no-op / null when there is no `document`, so the
 * module can be imported in a server render without throwing.
 */

import type { CookieSetOptions, CookieStore } from '@testa-soft/experiment-core';

export interface DocumentCookieStoreOptions {
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secure?: boolean;
  /** Cookie `Domain` for cross-subdomain sharing (e.g. `.acme.com`). Omit for host-only. */
  domain?: string;
}

export class DocumentCookieStore implements CookieStore {
  private readonly secure: boolean;
  private readonly domain: string | undefined;

  constructor(opts: DocumentCookieStoreOptions = {}) {
    this.secure = opts.secure ?? true;
    this.domain = opts.domain;
  }

  get(name: string): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${escapeForRegExp(name)}=([^;]*)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  set(name: string, value: string, opts: CookieSetOptions): void {
    if (typeof document === 'undefined') return;
    // No cookie is HttpOnly — a pure client SDK could not write one anyway, and
    // the assignment/uuid cookies must stay readable by this very code.
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'path=/',
      `max-age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
      'SameSite=Lax',
    ];
    if (this.secure) parts.push('Secure');
    if (this.domain) parts.push(`domain=${this.domain}`);
    document.cookie = parts.join('; ');
  }
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `CookieStore` (from experiment-core) backed by a Next.js request/response
 * cookie pair.
 *
 * Duck-typed against `next/server`'s cookie shapes so this file needs no runtime
 * Next import and stays unit-testable with plain fakes:
 *   - reads from the request's cookies (`req.cookies.get(name)?.value`)
 *   - buffers writes, then flushes them onto the chosen response via `applyTo`
 *
 * Buffered writes are read-through (`get` consults the buffer first), so the
 * middleware can loop over experiments writing into ONE packed `_testa_exp`
 * cookie and each later `assign()` sees the earlier write — the contract
 * experiment-core's `CookieStore` requires.
 */

import type { CookieSetOptions, CookieStore } from '@testa-soft/experiment-core';

export interface ReadableCookies {
  get(name: string): { value: string } | undefined;
}

export interface WritableCookies {
  set(name: string, value: string, opts: Record<string, unknown>): void;
}

interface PendingWrite {
  value: string;
  maxAgeSec: number;
}

export interface NextCookieStoreOptions {
  /** Emit `Secure` cookies. Default true; set false for local http dev. */
  secure?: boolean;
  /** Cookie `Domain` for cross-subdomain sharing. Omit for host-only cookies. */
  domain?: string;
}

export class NextCookieStore implements CookieStore {
  private readonly reqCookies: ReadableCookies;
  private readonly pending = new Map<string, PendingWrite>();
  private readonly secure: boolean;
  private readonly domain: string | undefined;

  constructor(reqCookies: ReadableCookies, opts: NextCookieStoreOptions = {}) {
    this.reqCookies = reqCookies;
    this.secure = opts.secure ?? true;
    this.domain = opts.domain;
  }

  get(name: string): string | null {
    const buffered = this.pending.get(name);
    if (buffered) return buffered.value;
    return this.reqCookies.get(name)?.value ?? null;
  }

  set(name: string, value: string, opts: CookieSetOptions): void {
    this.pending.set(name, { value, maxAgeSec: opts.maxAgeSec });
  }

  /** True when any cookie is queued to be written. */
  hasWrites(): boolean {
    return this.pending.size > 0;
  }

  /** Flush buffered cookies onto a response's cookie jar. */
  applyTo(resCookies: WritableCookies): void {
    for (const [name, write] of this.pending) {
      resCookies.set(name, write.value, {
        maxAge: write.maxAgeSec,
        path: '/',
        sameSite: 'lax',
        secure: this.secure,
        // No cookie is HttpOnly: `_testa_uuid` must be readable by the (future)
        // client guard/pixel for client-side bucketing, and `_testa_exp` /
        // `_testa_redirected` likewise. Durability comes from being set via the
        // server Set-Cookie header (first-party), not from HttpOnly.
        httpOnly: false,
        ...(this.domain ? { domain: this.domain } : {}),
      });
    }
  }
}

/**
 * In-memory `CookieStore` for tests. Read-through of pending writes, matching
 * the contract real hosts must honour.
 */

import type { CookieStore } from '../cookie-store.ts';

export function memoryStore(initial: Record<string, string> = {}): CookieStore & {
  dump(): Record<string, string>;
} {
  const jar = new Map<string, string>(Object.entries(initial));
  return {
    get: (name) => jar.get(name) ?? null,
    set: (name, value) => {
      jar.set(name, value);
    },
    dump: () => Object.fromEntries(jar),
  };
}

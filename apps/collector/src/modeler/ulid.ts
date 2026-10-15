/** ULID (Crockford base32, 48-bit ms time + 80 random bits): sortable, unique run ids. */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number = Date.now()): string {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let random = '';
  for (let i = 0; i < 16; i++) random += ALPHABET[(bytes[i] ?? 0) % 32];
  return time + random;
}

/** Run ids look like `r_01JA…` (PRD §3.4 shows `r_…`). */
export const newRunId = (nowMs?: number): string => `r_${ulid(nowMs)}`;

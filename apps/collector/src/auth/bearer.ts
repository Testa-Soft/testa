/**
 * `Authorization: Bearer <token>` check shared by the config write API and the
 * tracking API (same token: CONFIG_WRITE_TOKEN). Constant-time-ish compare.
 * An unset token disables the check (dev / tests without a token).
 */
export function isBearerAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  if (provided.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= provided.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/**
 * Read a cookie value in the browser. Shared by the client components
 * (`<TestaRouterGuard/>`, `<TestaProvider/>`). Returns null on the server or
 * when the cookie is absent.
 */
export function readClientCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${escapeForRegExp(name)}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

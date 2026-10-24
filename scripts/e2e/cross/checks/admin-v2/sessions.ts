/**
 * admin-v2 sessions (CONTRACT "Sessions"): login does not revoke other
 * sessions, `expires_in` on login/refresh, and `POST /auth/logout-others`
 * leaves only the caller. Runs LAST in the suite: logging out the other
 * sessions also ends the harness's own tokens for the seeded user.
 */

import { type CheckDef, Diff } from '../../lib/check.ts';
import { http, field } from '../../lib/http.ts';
import { api, dataOf, login, str } from './support.ts';

const OWNER = 'admin-v2 Sessions';

const isPositiveInt = (v: unknown): boolean => Number.isInteger(v) && Number(v) > 0;

export const adminV2SessionChecks: readonly CheckDef[] = [
  {
    id: 'admin-v2.sessions.logout-others',
    layer: 'admin-v2',
    title:
      'two password logins both valid (expires_in); refresh has expires_in; logout-others leaves only the caller',
    owner: OWNER,
    dod: ['admin-v2 CONTRACT Sessions', 'decision 6'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const a = await login(ctx);
      const b = await login(ctx);
      const c = await login(ctx);
      const probe = async (token: string): Promise<number> =>
        (await api(ctx, 'GET', '/projects', undefined, { token })).status;
      const before = {
        a: await probe(a.accessToken),
        b: await probe(b.accessToken),
        c: await probe(c.accessToken),
      };

      const refreshed = await http({
        method: 'POST',
        url: `${ctx.cfg.crobot.url}/api/auth/refresh`,
        body: { refresh_token: c.refreshToken },
      });
      const refreshData = dataOf(refreshed);

      const out = await api(ctx, 'POST', '/auth/logout-others', {}, { token: a.accessToken });
      const after = {
        a: await probe(a.accessToken),
        b: await probe(b.accessToken),
        c: await probe(c.accessToken),
      };
      const refreshedToken = field(refreshData, 'access_token');
      const afterRefreshed =
        typeof refreshedToken === 'string' ? await probe(refreshedToken) : null;
      const bRefresh = await http({
        method: 'POST',
        url: `${ctx.cfg.crobot.url}/api/auth/refresh`,
        body: { refresh_token: b.refreshToken },
      });

      return new Diff()
        .truthy(
          'login expires_in > 0',
          isPositiveInt(a.expiresIn) && isPositiveInt(b.expiresIn),
          `got ${str(a.expiresIn)}, ${str(b.expiresIn)}`,
        )
        .eq('all three sessions valid before', { a: 200, b: 200, c: 200 }, before)
        .eq('refresh status', 200, refreshed.status)
        .truthy(
          'refresh expires_in > 0',
          isPositiveInt(field(refreshData, 'expires_in')),
          `got ${str(field(refreshData, 'expires_in'))}`,
        )
        .eq('logout-others status', 200, out.status)
        .truthy(
          'revoked_tokens ≥ 4 (2 per other session)',
          Number(field(dataOf(out), 'revoked_tokens') ?? 0) >= 4,
          `got ${str(field(dataOf(out), 'revoked_tokens'))}`,
        )
        .eq('after: caller only', { a: 200, b: 401, c: 401 }, after)
        .eq('after: refreshed token of another session', 401, afterRefreshed)
        .truthy(
          'after: other session cannot refresh',
          bRefresh.status >= 400,
          `got ${bRefresh.status}`,
        )
        .outcome(
          `expires_in ${str(a.expiresIn)} s; revoked ${str(field(dataOf(out), 'revoked_tokens'))} tokens`,
        );
    },
  },
];

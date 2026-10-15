/**
 * Calls to the live testa-platform sync / stats API (PRD-006 Part 3, §4.5) and
 * the rule that tells "not built yet" from "built and wrong".
 */

import type { Ctx } from './check.ts';
import { PendingError } from './check.ts';
import { http, type HttpResponse, field, waitFor } from './http.ts';
import { type DailySummary, dailySummary, schemaIssues } from './schemas.ts';

export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to the shared service token; `null` sends no token. */
  readonly token?: string | null;
}

export async function platformApi(ctx: Ctx, call: ApiCall): Promise<HttpResponse> {
  const token = call.token === undefined ? ctx.cfg.secrets.service : call.token;
  return http({
    method: call.method,
    url: `${ctx.cfg.collector.url}${call.path}`,
    headers: token === null ? {} : { 'x-service-token': token },
    ...(call.body !== undefined ? { body: call.body } : {}),
    timeoutMs: 30_000,
  });
}

/**
 * Throws PendingError(owner) when the response means the endpoint isn't built:
 * an unmounted route (plain-text 404 without an `error` code) or `501`.
 */
export function assertBuilt(res: HttpResponse, owner: string, what: string): void {
  if (res.status === 501) throw new PendingError(owner, `${what}: 501 not_implemented`);
  if (res.status === 404 && field(res.json, 'error') === undefined) {
    throw new PendingError(owner, `${what}: route not mounted (404 ${res.text.slice(0, 40)})`);
  }
}

export const expPath = (experimentId: number, rest: string): string =>
  `/api/v1/experiments/${experimentId}/${rest}`;

/** Subscription body (§3.1) for the harness's own platform-only checks. */
export function subscriptionBody(
  ctx: Ctx,
  metrics: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    project_id: ctx.cfg.ids.projectId,
    status: 'running',
    from: '2026-10-01',
    to: null,
    report_currency: 'EUR',
    metrics,
    ...overrides,
  };
}

/**
 * Poll `GET …/daily-summary` until `status: ready` (respecting `retry_after`
 * up to a cap) and return the parsed body.
 */
export async function waitForReadySummary(
  ctx: Ctx,
  experimentId: number,
  timeoutMs = 180_000,
  predicate: (s: DailySummary) => boolean = () => true,
): Promise<DailySummary> {
  return waitFor(
    `daily-summary ready for ${experimentId}`,
    async () => {
      const res = await platformApi(ctx, {
        method: 'GET',
        path: expPath(experimentId, 'daily-summary'),
      });
      assertBuilt(res, 'P4', 'GET daily-summary');
      if (res.status !== 200)
        throw new Error(`daily-summary ${res.status}: ${res.text.slice(0, 200)}`);
      const parsed = dailySummary.safeParse(res.json);
      if (!parsed.success) throw new Error(`daily-summary schema: ${schemaIssues(parsed.error)}`);
      return parsed.data.status === 'ready' && predicate(parsed.data) ? parsed.data : undefined;
    },
    { timeoutMs, intervalMs: 2_000, rethrow: (err) => err instanceof PendingError },
  );
}

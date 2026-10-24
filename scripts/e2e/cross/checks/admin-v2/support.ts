/**
 * Shared helpers for the `admin-v2` layer (crobot tasks/admin-v2/CONTRACT.md):
 * real password logins as the seeded user, crobot API calls with a session
 * token, and experiment create / info / status through the public API.
 *
 * The group mutates crobot project 42 (new experiments, library goals), so it
 * runs after every other layer. `admin-v2.sessions` ends the user's other
 * sessions (incl. the harness's artisan token) and therefore runs last.
 */

import type { Ctx } from '../../lib/check.ts';
import { http, type HttpResponse, field } from '../../lib/http.ts';
import { run } from '../../lib/shell.ts';

export const STATUS_VOCAB = ['ready', 'pending', 'no_data', 'error'] as const;

/** Password of E2EAnalyticsSeeder::USER_EMAIL (local-only fixture value). */
const SEEDED_EMAIL = 'e2e-analytics@testa.local';
const SEEDED_PASSWORD = 'e2e-analytics-local-only';

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: unknown;
}

/** `data` of crobot's ApiResponse envelope (or the body itself). */
export function dataOf(res: HttpResponse): unknown {
  const data = field(res.json, 'data');
  return data === undefined ? res.json : data;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export async function login(ctx: Ctx): Promise<Session> {
  const res = await http({
    method: 'POST',
    url: `${ctx.cfg.crobot.url}/api/auth/login`,
    body: { email: SEEDED_EMAIL, password: SEEDED_PASSWORD },
    timeoutMs: 30_000,
  });
  const data = dataOf(res);
  const token = field(data, 'access_token');
  if (res.status !== 200 || typeof token !== 'string') {
    throw new Error(`POST /api/auth/login → ${res.status}: ${res.text.slice(0, 300)}`);
  }
  return {
    accessToken: token,
    refreshToken: String(field(data, 'refresh_token') ?? ''),
    expiresIn: field(data, 'expires_in'),
  };
}

const SESSION_FACT = 'admin-v2.session';

/** One login shared by the group's API checks (not the sessions check). */
export async function sharedSession(ctx: Ctx): Promise<Session> {
  const cached = ctx.facts.get(SESSION_FACT) as Session | undefined;
  if (cached !== undefined) return cached;
  const session = await login(ctx);
  ctx.facts.set(SESSION_FACT, session);
  return session;
}

export interface ApiOptions {
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** crobot `/api{path}` as the seeded user (`Authorization: <token>`). */
export async function api(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  opts: ApiOptions = {},
): Promise<HttpResponse> {
  const token = opts.token ?? (await sharedSession(ctx)).accessToken;
  return http({
    method,
    url: `${ctx.cfg.crobot.url}/api${path}`,
    headers: { authorization: token, ...(opts.headers ?? {}) },
    ...(body !== undefined ? { body } : {}),
    timeoutMs: 60_000,
  });
}

export const projectPath = (ctx: Ctx, rest: string): string =>
  `/projects/${ctx.cfg.ids.projectUuid}${rest}`;

/** Body of POST /projects/{uuid}/create-copy-experiment (v2 project 42). */
export function copyExperimentPayload(title: string, goals: readonly unknown[]): unknown {
  return {
    title,
    url: 'https://shop.example',
    url_match_type: 'contains',
    type: 'copy',
    traffic: 100,
    rules: [],
    goals,
    variations: [
      { title: 'Control', traffic: 50, changes: [] },
      { title: 'Variation A', traffic: 50, changes: [] },
    ],
  };
}

/** Run PHP in the e2e web container via tinker (fixture setup only; e2e DB). */
export async function tinker(ctx: Ctx, php: string): Promise<void> {
  const res = await run([
    'docker',
    'exec',
    '-e',
    'HOME=/tmp', // psysh needs a writable config dir
    ctx.cfg.crobot.webContainer,
    'php',
    'artisan',
    'tinker',
    `--execute=${php}`,
  ]);
  if (res.code !== 0) throw new Error(`tinker: ${(res.stderr || res.stdout).slice(0, 400)}`);
}

const HEADROOM_FACT = 'admin-v2.identifier-headroom';

/**
 * crobot allocates a new experiment identifier as "identifier of the client's
 * LATEST-created experiment + 1" (ExperimentRepository::getLatestExperimentIdentifier).
 * The seeder inserts 1717/1802/1903/1900 with one shared created_at, so the API
 * would hand out 1901, 1902, 1903 — colliding with the seeded F3 experiment.
 * Fixture fix: make the highest seeded identifier the latest-created row.
 */
async function ensureIdentifierHeadroom(ctx: Ctx): Promise<void> {
  if (ctx.facts.has(HEADROOM_FACT)) return;
  const top = Math.max(
    ctx.cfg.ids.f1,
    ctx.cfg.ids.f1Second,
    ctx.cfg.ids.f3,
    ctx.cfg.ids.v1Experiment,
  );
  await tinker(
    ctx,
    `DB::table('experiments')->where('project_id', ${ctx.cfg.ids.projectId})->where('identifier', '<', ${top})->update(['created_at' => now()->subHour()]); DB::table('experiments')->where('project_id', ${ctx.cfg.ids.projectId})->where('identifier', ${top})->update(['created_at' => now()->subMinute()]);`,
  );
  ctx.facts.set(HEADROOM_FACT, true);
}

export async function createExperiment(
  ctx: Ctx,
  title: string,
  goals: readonly unknown[],
): Promise<HttpResponse> {
  await ensureIdentifierHeadroom(ctx);
  return api(
    ctx,
    'POST',
    projectPath(ctx, '/create-copy-experiment'),
    copyExperimentPayload(title, goals),
  );
}

/** Create and return the new experiment's identifier, or throw with the response. */
export async function createExperimentOrThrow(
  ctx: Ctx,
  title: string,
  goals: readonly unknown[],
): Promise<number> {
  const res = await createExperiment(ctx, title, goals);
  const id = field(dataOf(res), 'experiment_id');
  if (res.status !== 200 || id === undefined) {
    throw new Error(`create-copy-experiment → ${res.status}: ${res.text.slice(0, 400)}`);
  }
  return Number(id);
}

export interface ExperimentInfo {
  readonly id: number;
  readonly identifier: number;
  readonly goals: readonly Record<string, unknown>[];
  readonly groups: readonly Record<string, unknown>[];
  readonly raw: unknown;
}

export async function experimentInfo(ctx: Ctx, identifier: number): Promise<ExperimentInfo> {
  const res = await api(ctx, 'GET', `/experiments/${identifier}`);
  if (res.status !== 200)
    throw new Error(`GET /experiments/${identifier} → ${res.status}: ${res.text.slice(0, 300)}`);
  const data = dataOf(res);
  return {
    id: Number(field(data, 'id')),
    identifier: Number(field(data, 'identifier')),
    goals: (field(data, 'goals') ?? []) as Record<string, unknown>[],
    groups: (field(data, 'groups') ?? []) as Record<string, unknown>[],
    raw: data,
  };
}

export async function setStatus(ctx: Ctx, identifier: number, status: string): Promise<void> {
  const res = await api(ctx, 'POST', `/experiments/${identifier}/status`, { status });
  if (res.status !== 200)
    throw new Error(`POST /experiments/${identifier}/status → ${res.status}: ${res.text}`);
}

/** POST /experiments/{identifier} (update) keeping the variations by identifier. */
export async function updateGoals(
  ctx: Ctx,
  info: ExperimentInfo,
  title: string,
  goals: readonly unknown[],
): Promise<HttpResponse> {
  const base = copyExperimentPayload(title, goals) as Record<string, unknown>;
  const variations = info.groups.map((g) => ({
    identifier: g.identifier,
    traffic: g.traffic ?? 50,
    changes: [],
  }));
  return api(ctx, 'POST', `/experiments/${info.identifier}`, { ...base, variations });
}

/** Pull `{error, index, reason}` of an invalid_goals 422. */
export function invalidGoals(res: HttpResponse): {
  status: number;
  error: unknown;
  index: unknown;
  reason: unknown;
} {
  return {
    status: res.status,
    error: field(res.json, 'error'),
    index: field(res.json, 'index'),
    reason: field(res.json, 'reason'),
  };
}

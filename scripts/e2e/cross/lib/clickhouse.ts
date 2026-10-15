/**
 * ClickHouse over its HTTP interface. Independent of the collector's client on
 * purpose: the harness checks what the collector WROTE, so it must not share
 * the collector's code path.
 */

export interface ChTarget {
  readonly url: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

async function post(target: ChTarget, sql: string, database: string | null): Promise<string> {
  const params = new URLSearchParams({ user: target.user });
  if (target.password) params.set('password', target.password);
  if (database !== null) params.set('database', database);
  const res = await fetch(`${target.url}/?${params}`, {
    method: 'POST',
    body: sql,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 500)}\nSQL: ${sql.slice(0, 300)}`);
  return text;
}

/** SELECT … → rows (JSONEachRow). */
export async function chQuery<T = Record<string, unknown>>(
  target: ChTarget,
  sql: string,
): Promise<T[]> {
  const text = await post(target, `${sql}\nFORMAT JSONEachRow`, target.database);
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** DDL / INSERT … VALUES, in the harness database. */
export async function chCommand(target: ChTarget, sql: string): Promise<void> {
  await post(target, sql, target.database);
}

/** Statement outside any database (CREATE / DROP DATABASE). */
export async function chServerCommand(target: ChTarget, sql: string): Promise<void> {
  await post(target, sql, null);
}

export async function chPing(target: ChTarget): Promise<boolean> {
  try {
    const res = await fetch(`${target.url}/ping`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Column names of a table in the harness database. */
export async function chColumns(target: ChTarget, table: string): Promise<Set<string>> {
  const rows = await chQuery<{ name: string }>(
    target,
    `SELECT name FROM system.columns WHERE database = '${target.database}' AND table = '${table}'`,
  );
  return new Set(rows.map((r) => r.name));
}

export async function chTableExists(target: ChTarget, table: string): Promise<boolean> {
  const rows = await chQuery<{ n: number }>(
    target,
    `SELECT count() AS n FROM system.tables WHERE database = '${target.database}' AND name = '${table}'`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

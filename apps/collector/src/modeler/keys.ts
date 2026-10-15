/**
 * Redis keys of the modeler (PRD-006 §3.2), all under a configurable prefix.
 * Experiment ids are unique per project only (R3), so per-experiment keys
 * carry both ids. Query ids already hash the body's `project_id`.
 */
export interface ModelerKeys {
  /** Sorted set of jobs ready to run; score = priority, then enqueue time. */
  queue: string;
  /** Sorted set of jobs waiting for a retry; score = due time (ms). */
  delayed: string;
  /** Recent run durations (ms), newest first. */
  durations: string;
  run: (projectId: number, experimentId: number) => string;
  lock: (projectId: number, experimentId: number) => string;
  query: (queryId: string) => string;
  /** Long-lived marker so an aged-out result answers 410 instead of 404. */
  queryKnown: (queryId: string) => string;
  /** Sorted set of a project's pending query ids (429 limit). */
  queryPending: (projectId: number) => string;
  /** POST …/queries rate-limit counter for the current minute. */
  queryRate: (projectId: number, minute: number) => string;
}

export function modelerKeys(prefix: string): ModelerKeys {
  const k = (s: string): string => `${prefix}modeler:${s}`;
  return {
    queue: k('queue'),
    delayed: k('delayed'),
    durations: k('durations'),
    run: (pid, id) => k(`run:${pid}:${id}`),
    lock: (pid, id) => k(`lock:${pid}:${id}`),
    query: (id) => k(`query:${id}`),
    queryKnown: (id) => k(`query-known:${id}`),
    queryPending: (pid) => k(`query-pending:${pid}`),
    queryRate: (pid, minute) => k(`query-rate:${pid}:${minute}`),
  };
}

/** Redis keys of the modeler (PRD-006 §3.2), all under a configurable prefix. */
export interface ModelerKeys {
  /** Sorted set of jobs ready to run; score = priority, then enqueue time. */
  queue: string;
  /** Sorted set of jobs waiting for a retry; score = due time (ms). */
  delayed: string;
  /** Recent run durations (ms), newest first. */
  durations: string;
  run: (experimentId: number) => string;
  lock: (experimentId: number) => string;
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
    run: (id) => k(`run:${id}`),
    lock: (id) => k(`lock:${id}`),
    query: (id) => k(`query:${id}`),
    queryKnown: (id) => k(`query-known:${id}`),
    queryPending: (pid) => k(`query-pending:${pid}`),
    queryRate: (pid, minute) => k(`query-rate:${pid}:${minute}`),
  };
}

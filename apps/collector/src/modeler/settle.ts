/**
 * Settle watermark: the modeler reads `events` and its MVs (`exposures`,
 * `event_items`), which only see a row once its `events_buffer` layer flushes.
 * The 16 Buffer layers flush independently (up to max_time = 30 s), so at run
 * start the newest flushed `server_ts` can be AHEAD of an older row that is
 * still buffered. Using that newest value as `data_through` marked the run as
 * current and the scheduler never re-ran it for a quiet or stopped experiment.
 *
 * So `data_through` is no longer the newest flushed `server_ts` but the
 * instant the run is complete through: `run start − settle`. Every event with
 * a `server_ts` at or before it is guaranteed flushed and counted. An event
 * younger than that (possibly missed) makes the scheduler's "newer events than
 * data_through" rule re-run the experiment on the next tick; a quiet project
 * converges after one extra run. This is also what crobot's final-run check
 * (`data_through >= paused_at`) expects.
 *
 * A stopped experiment's run is final only when it started at least `settle`
 * after the stop; an earlier run is stored as a normal (non-final) run.
 */

/** `YYYY-MM-DD hh:mm:ss.sss` (UTC) → ISO-8601. */
export const chToIso = (s: string): string => new Date(`${s.replace(' ', 'T')}Z`).toISOString();

/** `data_through` (ISO) for a run that started at `startedMs`. */
export function settledWatermark(startedMs: number, settleSec: number): string {
  return new Date(startedMs - settleSec * 1000).toISOString();
}

/** Whether a run started at `startedMs` sees every event ingested before the stop. */
export function stopSettled(stoppedAt: string, startedMs: number, settleSec: number): boolean {
  const stoppedMs = Date.parse(`${stoppedAt.replace(' ', 'T')}Z`);
  return !Number.isNaN(stoppedMs) && startedMs - settleSec * 1000 >= stoppedMs;
}

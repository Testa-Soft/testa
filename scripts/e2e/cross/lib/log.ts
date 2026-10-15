/** Progress output for the harness (stderr, so stdout stays clean for tooling). */

const t0 = Date.now();

function stamp(): string {
  return `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
}

export function log(message: string): void {
  process.stderr.write(`[e2e:cross ${stamp()}] ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`[e2e:cross ${stamp()}] WARN ${message}\n`);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

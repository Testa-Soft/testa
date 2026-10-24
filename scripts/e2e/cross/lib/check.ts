/**
 * Check model. Every check proves one DoD item against the LIVE systems and
 * ends in exactly one of:
 *   pass                 — verified end to end
 *   fail                 — the feature exists and is wrong, or infra is broken
 *   pending-<package>    — the feature isn't built yet (route 404/501, class or
 *                          table missing); NOT a pass. `--strict` turns it into a failure.
 */

import type { HarnessConfig } from './config.ts';

export type Layer = 'infra' | 'smoke' | 'contract' | 'sync' | 'ui' | 'lifecycle' | 'admin-v2';

export const LAYERS: readonly Layer[] = [
  'infra',
  'smoke',
  'contract',
  'sync',
  'ui',
  'lifecycle',
  'admin-v2',
];

export type Status = 'pass' | 'fail' | 'pending';

export interface Outcome {
  readonly status: Status;
  /** Package the check waits on (status pending), e.g. `P4`, `CB`. */
  readonly pendingOn?: string;
  readonly detail: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface CheckResult extends Outcome {
  readonly id: string;
  readonly layer: Layer;
  readonly title: string;
  readonly owner: string;
  readonly dod: readonly string[];
  readonly ms: number;
}

/** Facts checks hand to later checks (ingest done, run ids, …). */
export type Facts = Map<string, unknown>;

export interface Ctx {
  readonly cfg: HarnessConfig;
  readonly facts: Facts;
}

export interface CheckDef {
  readonly id: string;
  readonly layer: Layer;
  readonly title: string;
  /** Package(s) that deliver the feature under test. */
  readonly owner: string;
  /** DoD / acceptance references, e.g. `V2`, `crobot §9 AOV`, `X1`. */
  readonly dod: readonly string[];
  /** Check ids that must pass first; otherwise this check inherits their state. */
  readonly needs?: readonly string[];
  run(ctx: Ctx): Promise<Outcome>;
}

export const pass = (detail: string, actual?: unknown): Outcome => ({
  status: 'pass',
  detail,
  ...(actual !== undefined ? { actual } : {}),
});

export const fail = (detail: string, expected?: unknown, actual?: unknown): Outcome => ({
  status: 'fail',
  detail,
  ...(expected !== undefined ? { expected } : {}),
  ...(actual !== undefined ? { actual } : {}),
});

export const pending = (pkg: string, detail: string): Outcome => ({
  status: 'pending',
  pendingOn: pkg,
  detail,
});

/** Signal from deep inside a check that a feature is missing. */
export class PendingError extends Error {
  constructor(
    readonly pkg: string,
    message: string,
  ) {
    super(message);
  }
}

export function statusLabel(r: Pick<Outcome, 'status' | 'pendingOn'>): string {
  return r.status === 'pending' ? `pending-${r.pendingOn ?? '?'}` : r.status;
}

/** Collects mismatches; empty = all equal. */
export class Diff {
  private readonly items: string[] = [];

  eq(label: string, expected: unknown, actual: unknown): this {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      this.items.push(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    return this;
  }

  near(
    label: string,
    expected: number | null,
    actual: number | null | undefined,
    tol = 1e-6,
  ): this {
    const ok =
      expected === null
        ? actual === null || actual === undefined
        : typeof actual === 'number' && Math.abs(expected - actual) <= tol;
    if (!ok) this.items.push(`${label}: expected ${expected} (±${tol}), got ${actual}`);
    return this;
  }

  truthy(label: string, ok: boolean, detail = ''): this {
    if (!ok) this.items.push(`${label}${detail ? `: ${detail}` : ''}`);
    return this;
  }

  get ok(): boolean {
    return this.items.length === 0;
  }

  get list(): readonly string[] {
    return this.items;
  }

  outcome(passDetail: string, actual?: unknown): Outcome {
    if (this.ok) return pass(passDetail, actual);
    return fail(
      `${this.items.length} mismatch(es): ${this.items.slice(0, 12).join('; ')}`,
      undefined,
      actual,
    );
  }
}

/**
 * The analytics error type (PRD-006 §5.5). Thrown by validators, guards and
 * view runners; routers turn it into `{ error, field? }` with `status`.
 */
import type { SyncError, SyncErrorCode } from '@testa-platform/shared-types';

export type SyncErrorStatus = 400 | 401 | 404 | 409 | 410 | 429 | 501;

export class SyncApiError extends Error {
  readonly code: SyncErrorCode;
  readonly status: SyncErrorStatus;
  readonly field: string | undefined;

  constructor(code: SyncErrorCode, status: SyncErrorStatus, field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'SyncApiError';
    this.code = code;
    this.status = status;
    this.field = field;
  }

  toBody(): SyncError {
    return this.field === undefined
      ? { error: this.code }
      : { error: this.code, field: this.field };
  }
}

/** 501 `{ "error": "not_implemented" }`; `owner` only goes into the message (logs). */
export function notImplemented(owner: string): SyncApiError {
  const err = new SyncApiError('not_implemented', 501);
  err.message = `not_implemented: ${owner}`;
  return err;
}

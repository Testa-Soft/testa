/**
 * Cross-domain continuity — INBOUND read side, for the middleware.
 *
 * When an experiment is `cross_domain`, the origin site tags outbound links with
 * `?_testa_cd=<base64({u, exps:[{e,v}]})>` (that tagging is client-side / the
 * pixel's job — the middleware can't rewrite links). On the DESTINATION site the
 * middleware reads the param and applies each carried assignment so `assign()`'s
 * cookie-first path returns it instead of re-bucketing.
 *
 * Encoding is the exact 3.3.3 wire format (see the pixel's cross-domain.ts):
 * base64 of `{ u, exps:[{e,v}] }`, or `encodeURIComponent(json)` as fallback.
 * The single-experiment `{e,v,u}` is normalized to the multi format.
 */

export const CROSS_DOMAIN_PARAM = '_testa_cd';

export interface CrossDomainAssignment {
  experimentId: number | string;
  variationId: number | string;
}

export interface CrossDomainPayload {
  uuid?: string;
  assignments: CrossDomainAssignment[];
}

/**
 * Encode assignments for an OUTBOUND `_testa_cd` param — base64 of
 * `{ u, exps:[{e,v}] }`, with `encodeURIComponent(json)` fallback when `btoa`
 * throws (non-Latin1). This is the pixel's outbound tagging encoder; the wire
 * format is the exact one `decodeCrossDomain` reads, so pixel-tagged links are
 * honoured by both a pixel-site and a middleware-site on landing.
 */
export function encodeCrossDomainData(
  assignments: readonly CrossDomainAssignment[],
  uuid: string,
): string {
  const data = {
    u: uuid,
    exps: assignments.map((a) => ({ e: a.experimentId, v: a.variationId })),
  };
  const json = JSON.stringify(data);
  try {
    return btoa(json);
  } catch {
    return encodeURIComponent(json);
  }
}

function tryParse(raw: string): unknown {
  // base64 first (btoa/atob wire format), then percent-encoded JSON.
  try {
    return JSON.parse(atob(raw));
  } catch {
    // fall through
  }
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

/** Decode a `_testa_cd` value into carried assignments, or null on failure. */
export function decodeCrossDomain(raw: string): CrossDomainPayload | null {
  if (!raw) return null;
  const parsed = tryParse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  // Multi format: { u, exps: [{e, v}] }
  if (Array.isArray(obj.exps)) {
    const assignments: CrossDomainAssignment[] = [];
    for (const item of obj.exps) {
      if (item && typeof item === 'object') {
        const e = (item as Record<string, unknown>).e;
        const v = (item as Record<string, unknown>).v;
        if (isIdLike(e) && isIdLike(v)) {
          assignments.push({ experimentId: e, variationId: v });
        }
      }
    }
    return { assignments, ...(typeof obj.u === 'string' ? { uuid: obj.u } : {}) };
  }

  // Single-experiment format: { e, v, u }
  if (isIdLike(obj.e) && isIdLike(obj.v)) {
    return {
      assignments: [{ experimentId: obj.e, variationId: obj.v }],
      ...(typeof obj.u === 'string' ? { uuid: obj.u } : {}),
    };
  }

  return null;
}

function isIdLike(x: unknown): x is number | string {
  return typeof x === 'number' || (typeof x === 'string' && x.length > 0);
}

/**
 * `products` query view (PRD-006 §6.5, task 5.16): the Products & upsell tab
 * (list mode) and the product-detail panel (`product_id` set). Runs on the
 * modeler queue via `POST …/queries`. No stats: crobot calls `/api/v1/stats`.
 */
import type {
  ProductsPurchaseType,
  ProductsResult,
  ProductsSort,
} from '@testa-platform/shared-types';
import { SyncApiError } from '../analytics/errors.ts';
import { type ViewTypes, registerView } from '../analytics/views.ts';
import { assertCurrency, assertRange } from '../modeler/daily-rows.ts';
import { buildCatalog, buildProductDetail, buildProductsList } from './build.ts';
import { fetchItemGroups } from './query.ts';

type ProductsParams = ViewTypes['products']['params'];

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 200;
const MAX_TEXT = 200;
const PURCHASE_TYPES: readonly ProductsPurchaseType[] = ['all', 'initial', 'upsell'];
const SORTS: readonly ProductsSort[] = ['control_revenue', 'revenue_share'];

const bad = (field: string) => new SyncApiError('unknown_metric', 400, field);

function asRecord(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SyncApiError('unknown_view', 400, field);
  }
  return raw as Record<string, unknown>;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) throw bad(field);
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw bad(field);
  return value as T;
}

function optionalInt(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw bad(field);
  return value as number;
}

/** Throws the PRD §5.5 400 codes (`unknown_metric` with the bad field, `invalid_range`, …). */
export function validateProductsParams(raw: unknown): ProductsParams {
  const body = asRecord(raw, 'params');
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  assertRange(from, to);
  // Filters are part of the contract but not supported by the MVP query yet.
  if (body.filters !== undefined && Object.keys(asRecord(body.filters, 'filters')).length > 0) {
    throw new SyncApiError('unknown_dimension', 400, 'filters');
  }
  const fields = {
    report_currency:
      body.report_currency === undefined ? undefined : assertCurrency(body.report_currency),
    product_id: optionalText(body.product_id, 'product_id'),
    purchase_type: optionalEnum(body.purchase_type, PURCHASE_TYPES, 'purchase_type'),
    search: optionalText(body.search, 'search'),
    sort: optionalEnum(body.sort, SORTS, 'sort'),
    limit: optionalInt(body.limit, 1, MAX_LIMIT, 'limit'),
    offset: optionalInt(body.offset, 0, Number.MAX_SAFE_INTEGER, 'offset'),
  };
  // Drop absent optionals (exactOptionalPropertyTypes; canonical query_id).
  const present = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return { from, to, ...present } as ProductsParams;
}

registerView('products', {
  validate: validateProductsParams,
  async run(ctx, params): Promise<ProductsResult> {
    const reportCurrency = params.report_currency ?? ctx.reportCurrency;
    const purchaseType = params.purchase_type ?? 'all';
    const groups = await fetchItemGroups(ctx.query, {
      projectId: ctx.projectId,
      experimentId: ctx.experimentId,
      from: params.from,
      to: params.to,
      reportCurrency,
      purchaseType,
    });
    const catalog = buildCatalog(
      groups,
      ctx.experiment.variations.map((v) => v.variation_id),
    );
    const base = {
      experiment_id: ctx.experimentId,
      from: params.from,
      to: params.to,
      report_currency: reportCurrency,
      purchase_type: purchaseType,
    };
    if (params.product_id !== undefined) {
      return buildProductDetail(catalog, base, params.product_id);
    }
    return buildProductsList(catalog, base, {
      sort: params.sort ?? 'control_revenue',
      limit: params.limit ?? DEFAULT_LIMIT,
      offset: params.offset ?? 0,
      ...(params.search === undefined ? {} : { search: params.search }),
    });
  },
});

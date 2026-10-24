/**
 * Query-view registry (PRD-006 §3.5, §6.5). Each view owns its folder and
 * registers its runner on import, so parallel work never edits a shared file:
 * `summary` (P4, modeler), `products` / `distributions` (P7), `health` (P8).
 * The sync API looks views up by name and runs them on the modeler queue.
 */
import type {
  DistributionsQueryRequest,
  DistributionsResult,
  ExperimentConfig,
  HealthQueryRequest,
  HealthResult,
  ProductsQueryRequest,
  ProductsResult,
  SummaryQueryRequest,
  SummaryResult,
  ViewName,
} from '@testa-platform/shared-types';
import type { QueryRunner } from './attribution.ts';
import { SyncApiError } from './errors.ts';

export type { ViewName };

export const VIEW_NAMES: readonly ViewName[] = ['summary', 'products', 'distributions', 'health'];

/** Body fields that belong to the request envelope, not to the view. */
type EnvelopeKeys = 'view' | 'project_id' | 'refresh';

/** Params and result per view; params are the query body minus the envelope. */
export interface ViewTypes {
  summary: { params: Omit<SummaryQueryRequest, EnvelopeKeys>; result: SummaryResult };
  products: { params: Omit<ProductsQueryRequest, EnvelopeKeys>; result: ProductsResult };
  distributions: {
    params: Omit<DistributionsQueryRequest, EnvelopeKeys>;
    result: DistributionsResult;
  };
  health: { params: Omit<HealthQueryRequest, EnvelopeKeys>; result: HealthResult };
}

export interface ViewContext {
  projectId: number;
  experimentId: number;
  /** The v2 experiment from the project config (`requireV2Experiment`). */
  experiment: ExperimentConfig;
  /** Subscription's reporting currency unless the query overrides it. */
  reportCurrency: string;
  query: QueryRunner;
}

export interface ViewRunner<P, R> {
  /** Validate raw body params; throw `SyncApiError` with a PRD §5.5 400 code. */
  validate(params: unknown): P;
  run(ctx: ViewContext, params: P): Promise<R>;
}

export type AnyViewRunner = {
  [N in ViewName]: ViewRunner<ViewTypes[N]['params'], ViewTypes[N]['result']>;
}[ViewName];

export interface ViewRegistry {
  register<N extends ViewName>(
    name: N,
    runner: ViewRunner<ViewTypes[N]['params'], ViewTypes[N]['result']>,
  ): void;
  /** Throws 400 `unknown_view` for a name that isn't a view, 501 if not registered yet. */
  get<N extends ViewName>(name: N): ViewRunner<ViewTypes[N]['params'], ViewTypes[N]['result']>;
  get(name: string): AnyViewRunner;
  has(name: string): boolean;
}

const isViewName = (name: string): name is ViewName =>
  (VIEW_NAMES as readonly string[]).includes(name);

export function createViewRegistry(): ViewRegistry {
  const runners = new Map<ViewName, AnyViewRunner>();
  return {
    register(name, runner) {
      if (!isViewName(name)) throw new SyncApiError('unknown_view', 400, name);
      if (runners.has(name)) throw new Error(`view already registered: ${name}`);
      runners.set(name, runner as AnyViewRunner);
    },
    get(name: string) {
      if (!isViewName(name)) throw new SyncApiError('unknown_view', 400, name);
      const runner = runners.get(name);
      if (!runner) throw new SyncApiError('not_implemented', 501, name);
      return runner;
    },
    has(name) {
      return isViewName(name) && runners.has(name);
    },
  } as ViewRegistry;
}

/** The process-wide registry the sync API reads. */
export const views: ViewRegistry = createViewRegistry();

export function registerView<N extends ViewName>(
  name: N,
  runner: ViewRunner<ViewTypes[N]['params'], ViewTypes[N]['result']>,
): void {
  views.register(name, runner);
}

export function getView<N extends ViewName>(
  name: N,
): ViewRunner<ViewTypes[N]['params'], ViewTypes[N]['result']>;
export function getView(name: string): AnyViewRunner;
export function getView(name: string): AnyViewRunner {
  return views.get(name);
}

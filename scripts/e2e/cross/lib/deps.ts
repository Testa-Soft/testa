/**
 * Third-party modules for the harness. `scripts/` isn't a workspace package,
 * so (with pnpm's strict layout) bare imports don't resolve from here; we borrow
 * the collector's pinned copies instead of adding a package.
 */
export { z } from '../../../../apps/collector/node_modules/zod/lib/index.js';
export type { ZodTypeAny } from '../../../../apps/collector/node_modules/zod/lib/index.js';

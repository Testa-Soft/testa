/**
 * Prepend the `"use client"` directive to the built client-entry files.
 *
 * `<TestaRouterGuard/>` and `<TestaExperiments/>` are React client components,
 * but esbuild strips module-level directives when bundling (it warns "directives
 * cause errors when bundled"). So we add the directive here, after tsup — the
 * directive must be the first statement of the file Next imports, or Next errors
 * on the client hooks (usePathname/useRouter/useEffect) inside them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// NOTE: `server/index.*` is intentionally ABSENT — the `@testa-soft/next/server`
// entry is a React Server Component surface and must stay directive-free. It
// imports the client entry via the self-reference `@testa-soft/next/_internal/experiments`,
// which carries the directive on its own bundle.
// NOTE: `pages/index.*` is intentionally ABSENT — the `/pages` entry is
// Pages-Router-only, where directives do nothing for correctness but ACTIVELY
// BREAK transpilePackages consumers: Next's SWC applies the App-Router
// client-entry transform (`__next_internal_client_entry_do_not_use__`) to any
// "use client" module it compiles, even in a pages-router build, which strips
// the module's real exports (TestaProvider renders as undefined).
const CLIENT_ENTRIES = [
  'router-guard/index.js',
  'router-guard/index.cjs',
  'experiments/index.js',
  'experiments/index.cjs',
];

const DIRECTIVE = '"use client";\n';

for (const rel of CLIENT_ENTRIES) {
  const file = join(distDir, rel);
  const body = readFileSync(file, 'utf8');
  if (body.startsWith('"use client"') || body.startsWith("'use client'")) continue;
  writeFileSync(file, DIRECTIVE + body);
  console.log(`[add-use-client] prepended directive → dist/${rel}`);
}

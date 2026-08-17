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

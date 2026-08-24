/**
 * Fail the build if any emitted bundle imports a bare `next/<subpath>`.
 *
 * `next` has no `exports` map, so Node's ESM resolver can only load its subpath
 * root stubs by literal filename (`next/headers.js`). tsup rewrites our imports
 * to that form (see tsup.config.ts → rewriteNextSubpaths); this script is the
 * backstop that keeps a new extensionless `next/...` import from shipping and
 * breaking consumers whose apps externalize the package (the exact failure:
 * `ERR_MODULE_NOT_FOUND: Cannot find module '.../next/headers'` on Next 14).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const listBundles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listBundles(path);
    return /\.(js|cjs|mjs)$/.test(entry.name) ? [path] : [];
  });

const BARE_NEXT_SPECIFIER = /["'](next\/[^"']+)["']/g;

const violations = listBundles(distDir).flatMap((file) => {
  const body = readFileSync(file, 'utf8');
  return [...body.matchAll(BARE_NEXT_SPECIFIER)]
    .map(([, specifier]) => specifier)
    .filter((specifier) => !specifier.endsWith('.js'))
    .map((specifier) => ({ file: relative(distDir, file), specifier }));
});

if (violations.length > 0) {
  for (const { file, specifier } of violations) {
    console.error(
      `[verify-dist] dist/${file}: bare specifier '${specifier}' — Node ESM cannot ` +
        `resolve it (next has no exports map); import '${specifier}.js' instead ` +
        `or add it to NEXT_SUBPATH_STUBS in tsup.config.ts.`,
    );
  }
  process.exit(1);
}

console.log('[verify-dist] OK — all next/* specifiers use the .js stub form');

/**
 * Validates every modeled sample (`docs/reference/samples/{demo,f1}/modeled/*.json`,
 * produced by the `generate.py` reference oracle) against the shared types.
 *
 * Each sample is emitted as a typed object literal (`const s: T = <json>`) and
 * compiled with the TypeScript compiler, so the types themselves are the
 * validator: literal unions, required fields and excess properties are all
 * checked, with no hand-written schema to drift from them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import ts from 'typescript';

const SAMPLES_DIR = resolve(import.meta.dir, '../../../docs/reference/samples');
const TYPES_ENTRY = resolve(import.meta.dir, '../src/index.ts');
const SAMPLE_SETS = ['demo', 'f1'] as const;

/** Sample file name → the type its content must satisfy. */
function typeFor(file: string): string {
  if (file.startsWith('daily_summary')) return 'SummaryResult';
  if (file.startsWith('products')) return 'ProductsResult';
  if (file.startsWith('distributions')) return 'DistributionsResult';
  if (file.startsWith('health')) return 'HealthResult';
  throw new Error(`no type mapping for sample ${file}`);
}

function listSamples(): { set: string; file: string; path: string }[] {
  return SAMPLE_SETS.flatMap((set) => {
    const dir = join(SAMPLES_DIR, set, 'modeled');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((file) => ({ set, file, path: join(dir, file) }));
  });
}

function compileErrors(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? basename(d.file.fileName) : '?';
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

describe('modeled samples match the shared types', () => {
  const samples = listSamples();

  test('every sample set has samples', () => {
    for (const set of SAMPLE_SETS) {
      expect(samples.filter((s) => s.set === set).length).toBeGreaterThan(0);
    }
  });

  test(
    'each sample compiles as its type',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'shared-types-samples-'));
      try {
        const files = samples.map(({ set, file, path }) => {
          const type = typeFor(file);
          const src = [
            `import type { ${type} } from '${TYPES_ENTRY}';`,
            `export const sample: ${type} = ${readFileSync(path, 'utf8')};`,
          ].join('\n');
          const out = join(dir, `${set}__${file.replace(/\.json$/, '')}.ts`);
          writeFileSync(out, src);
          return out;
        });
        expect(compileErrors(files)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});

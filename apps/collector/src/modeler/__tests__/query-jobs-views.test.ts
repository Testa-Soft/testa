/**
 * The modeler runs query jobs, so loading `query-jobs.ts` alone must register
 * every view (a deployed modeler never imports src/index.ts). Checked in a
 * fresh subprocess: in this test process another file may already have
 * imported a view module and would mask a missing import.
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

const QUERY_JOBS = resolve(import.meta.dir, '../query-jobs.ts');
const VIEWS = resolve(import.meta.dir, '../../analytics/views.ts');

const script = `
  await import(${JSON.stringify(QUERY_JOBS)});
  const { views } = await import(${JSON.stringify(VIEWS)});
  const out = {};
  for (const name of ['summary', 'products', 'distributions', 'health']) out[name] = views.has(name);
  // health is implemented: its validator runs instead of answering 501.
  out.healthParams = views.get('health').validate({ from: '2026-10-01', to: '2026-10-03' });
  console.log(JSON.stringify(out));
`;

describe('modeler query-job path registers every view', () => {
  it('query-jobs.ts alone → summary, products, distributions, health; health is not 501', () => {
    const proc = Bun.spawnSync(['bun', '-e', script], { cwd: import.meta.dir });
    expect(proc.stderr.toString()).toBe('');
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim())).toEqual({
      summary: true,
      products: true,
      distributions: true,
      health: true,
      healthParams: { from: '2026-10-01', to: '2026-10-03' },
    });
  });
});

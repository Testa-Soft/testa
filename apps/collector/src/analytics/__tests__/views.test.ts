import { describe, expect, it } from 'bun:test';
import { SyncApiError } from '../errors.ts';
import { createViewRegistry } from '../views.ts';

const stubRunner = {
  validate: () => ({}) as never,
  run: async () => ({}) as never,
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SyncApiError ? `${err.status} ${err.code}` : (err as Error).message;
  }
  return undefined;
}

describe('view registry', () => {
  it('registers and returns a runner', () => {
    const registry = createViewRegistry();
    registry.register('health', stubRunner);
    expect(registry.get('health')).toBe(stubRunner);
    expect(registry.has('health')).toBe(true);
  });

  it('registering a view twice throws', () => {
    const registry = createViewRegistry();
    registry.register('products', stubRunner);
    expect(codeOf(() => registry.register('products', stubRunner))).toBe(
      'view already registered: products',
    );
  });

  it('unknown view → 400 unknown_view', () => {
    const registry = createViewRegistry();
    expect(codeOf(() => registry.get('funnel'))).toBe('400 unknown_view');
    expect(registry.has('funnel')).toBe(false);
  });

  it('known but unregistered view → 501 not_implemented', () => {
    expect(codeOf(() => createViewRegistry().get('summary'))).toBe('501 not_implemented');
  });
});

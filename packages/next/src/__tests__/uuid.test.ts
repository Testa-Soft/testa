import { UUID_COOKIE } from '@testa-soft/experiment-core';
import { describe, expect, it } from 'vitest';
import { ensureVisitorId } from '../uuid.ts';
import { memoryStore } from './helpers.ts';

describe('ensureVisitorId', () => {
  it('returns the existing visitor id without minting', () => {
    const store = memoryStore({ [UUID_COOKIE]: 'existing-uuid' });
    expect(ensureVisitorId(store)).toBe('existing-uuid');
    // No new write.
    expect(store.dump()[UUID_COOKIE]).toBe('existing-uuid');
  });

  it('mints and persists a new id on first visit', () => {
    const store = memoryStore();
    const id = ensureVisitorId(store);
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(store.get(UUID_COOKIE)).toBe(id);
  });

  it('is idempotent within a request once minted', () => {
    const store = memoryStore();
    const first = ensureVisitorId(store);
    const second = ensureVisitorId(store);
    expect(first).toBe(second);
  });
});

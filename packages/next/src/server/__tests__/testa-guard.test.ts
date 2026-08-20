import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable holder so each test can control what `headers()` returns (or throws).
const holder: { get: (name: string) => string | null; throws: boolean } = {
  get: () => null,
  throws: false,
};

vi.mock('next/headers', () => ({
  headers: async () => {
    if (holder.throws) throw new Error('outside request scope');
    return { get: holder.get };
  },
}));

import { TestaGuard } from '../TestaGuard.tsx';

beforeEach(() => {
  holder.get = () => null;
  holder.throws = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('TestaGuard (server component)', () => {
  it('renders an inline shield script when the header is "1"', async () => {
    holder.get = (name) => (name === 'x-testa-shield' ? '1' : null);
    const el = await TestaGuard({});
    expect(el).not.toBeNull();
    expect((el as { type: string }).type).toBe('script');
    const html = (el as { props: { dangerouslySetInnerHTML: { __html: string } } }).props
      .dangerouslySetInnerHTML.__html;
    expect(html).toContain('__testa_shield');
  });

  it('passes selector + timeoutMs through to the snippet', async () => {
    holder.get = () => '1';
    const el = await TestaGuard({ selector: '#main', timeoutMs: 1234 });
    const html = (el as { props: { dangerouslySetInnerHTML: { __html: string } } }).props
      .dangerouslySetInnerHTML.__html;
    expect(html).toContain('#main');
    expect(html).toContain('1234');
  });

  it('returns null when the header is "0"', async () => {
    holder.get = () => '0';
    expect(await TestaGuard({})).toBeNull();
  });

  it('returns null when the header is absent', async () => {
    holder.get = () => null;
    expect(await TestaGuard({})).toBeNull();
  });

  it('returns null (fail open) when headers() throws', async () => {
    holder.throws = true;
    expect(await TestaGuard({})).toBeNull();
  });
});

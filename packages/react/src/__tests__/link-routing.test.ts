import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkNavigator } from '../link-routing.ts';

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('linkNavigator', () => {
  it("routes through the app's navigate", () => {
    const navigate = vi.fn();
    linkNavigator(() => navigate)('/pricing');
    expect(navigate).toHaveBeenCalledWith('/pricing');
  });

  it('reads navigate at click time, so a re-rendered router function is used', () => {
    const first = vi.fn();
    const latest = vi.fn();
    let current = first;
    const go = linkNavigator(() => current);
    current = latest;
    go('/pricing');
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('/pricing');
  });

  it('does a normal navigation if navigate was removed after install', () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    linkNavigator(() => undefined)('/pricing');
    expect(assign).toHaveBeenCalledWith('/pricing');
    assign.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSpaNav } from '../spa-nav.ts';

afterEach(() => {
  // Reset URL back to a known path between tests.
  window.history.pushState({}, '', '/');
});

describe('installSpaNav', () => {
  it('fires the callback on a pushState URL change', () => {
    const cb = vi.fn();
    const uninstall = installSpaNav(cb);
    window.history.pushState({}, '', '/page-a');
    expect(cb).toHaveBeenCalledOnce();
    uninstall();
  });

  it('fires on replaceState and popstate too', () => {
    const cb = vi.fn();
    const uninstall = installSpaNav(cb);
    window.history.replaceState({}, '', '/page-b');
    expect(cb).toHaveBeenCalledTimes(1);
    window.history.pushState({}, '', '/page-c');
    window.dispatchEvent(new Event('popstate'));
    // popstate re-checks href; it's unchanged since the pushState, so no extra call.
    expect(cb).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it('does not fire when the URL is unchanged', () => {
    const cb = vi.fn();
    const uninstall = installSpaNav(cb);
    const href = window.location.href;
    window.history.pushState({}, '', href);
    expect(cb).not.toHaveBeenCalled();
    uninstall();
  });

  it('stops firing after uninstall', () => {
    const cb = vi.fn();
    const uninstall = installSpaNav(cb);
    uninstall();
    window.history.pushState({}, '', '/page-d');
    expect(cb).not.toHaveBeenCalled();
  });
});

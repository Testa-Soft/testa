/**
 * `@testa-soft/next/pages` `<TestaProvider/>` — composition smoke tests via
 * renderToString (the guard's router logic is unit-tested in router-guard/;
 * the client engine in @testa-soft/react's own suite).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import { TestaProvider } from '../TestaProvider.tsx';

describe('pages <TestaProvider/>', () => {
  it('renders its children (SSR-safe, no router required)', () => {
    const html = renderToString(
      createElement(
        TestaProvider,
        { projectId: 'acme', shield: false },
        createElement('main', null, 'page-content'),
      ),
    );
    expect(html).toContain('page-content');
  });

  it('accepts an inline config without throwing', () => {
    const html = renderToString(
      createElement(
        TestaProvider,
        { config: splitUrlConfig(), shield: false },
        createElement('span', null, 'inline-config'),
      ),
    );
    expect(html).toContain('inline-config');
  });
});

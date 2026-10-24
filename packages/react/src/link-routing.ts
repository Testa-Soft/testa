/**
 * The `navigate` the provider hands to `@testa-soft/dom`'s link router.
 *
 * `getNavigate` is read at click time, not install time: a router's navigate
 * function (React Router's `useNavigate()`) can change identity between
 * renders, and the listener is installed once. Should the app stop passing one
 * between install and click, the link gets the plain navigation it would have
 * had anyway.
 */

import type { Navigate } from '@testa-soft/dom';

export function linkNavigator(getNavigate: () => Navigate | undefined): Navigate {
  return (href) => {
    const navigate = getNavigate();
    if (navigate) navigate(href);
    else window.location.assign(href);
  };
}

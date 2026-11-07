/**
 * PRD-006 tracking for Next.js (task 5.7): `track` + typed helpers that post
 * pixel-format events to the edge `/track`, stamped with the visitor's active
 * v2 experiment sessions from the packed `_testa_exp` cookie. Shared with
 * `@testa-soft/react`; `<TestaProvider>` wires sessions + experiment_view.
 * `pushEvent` (custom goal matching) is unchanged.
 *
 * `setConsent` reports the visitor's tracking consent from a CMP callback
 * (same as the provider's `consent` prop): until `'granted'` everything is
 * session-scoped.
 */
export { getConsent, onConsentChange, setConsent } from '@testa-soft/react';
export {
  DEFAULT_EVENTS_ENDPOINT,
  track,
  trackAddToCart,
  trackBeginCheckout,
  trackLead,
  trackPageView,
  trackPaymentInfo,
  trackPurchase,
  trackShippingInfo,
  trackSignUp,
} from '@testa-soft/react';

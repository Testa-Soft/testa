/**
 * `products` query view (PRD-006 §6.5). Stub registered by P0; P7 (task 5.16) replaces
 * the runner and keeps the registration.
 */
import { notImplemented } from '../analytics/errors.ts';
import { registerView } from '../analytics/views.ts';

registerView('products', {
  validate() {
    throw notImplemented('products');
  },
  async run() {
    throw notImplemented('products');
  },
});

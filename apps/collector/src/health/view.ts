/**
 * `health` query view (PRD-006 §6.5). Stub registered by P0; P8 (task 5.17) replaces
 * the runner and keeps the registration.
 */
import { notImplemented } from '../analytics/errors.ts';
import { registerView } from '../analytics/views.ts';

registerView('health', {
  validate() {
    throw notImplemented('health');
  },
  async run() {
    throw notImplemented('health');
  },
});

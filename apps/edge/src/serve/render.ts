import type { GeoData, ProjectConfig } from '@testa-platform/shared-types';

/**
 * Build the JS body the customer's browser receives from `GET /projects/:slug.js`.
 *
 * For `4.0` projects: emits a small prelude IIFE before the loader+runtime
 * bundle — `window.cfGeoData` (visitor geo from `request.cf`, read by the
 * runtime's targeting/audience evaluation) and `window.cfPrefill.project`
 * (the config, so the bundle knows which experiments to evaluate without
 * hitting the network again).
 *
 * For frozen legacy bundles (`3.4`, `3.6`): prepends only the `cfGeoData`
 * line — the job the legacy geo proxy worker used to do — then the bundle
 * verbatim. Those bundles include their own bootstrap and read
 * `window.crbData` set by customer-side embedding code.
 */
export function renderPixel(
  config: ProjectConfig,
  bundle: string,
  environment: string,
  geo: GeoData,
): string {
  const geoLine = `window.cfGeoData = ${safeJson(geo)};`;
  if (config.integration_version !== '4.0') {
    return `${geoLine}\n${bundle}`;
  }
  return [
    '(function(){',
    `  ${geoLine}`,
    '  window.cfPrefill = window.cfPrefill || {};',
    `  window.cfPrefill.project = ${safeJson(config)};`,
    `  window.cfPrefill.env = ${safeJson(environment)};`,
    '})();',
    bundle,
  ].join('\n');
}

/** Visitor geo off `request.cf` (populated by Cloudflare pre-worker). `''` = unknown. */
export function geoOf(request: Request): GeoData {
  const cf = request.cf;
  return {
    country: typeof cf?.country === 'string' ? cf.country : '',
    region: typeof cf?.regionCode === 'string' ? cf.regionCode : '',
    city: typeof cf?.city === 'string' ? cf.city : '',
  };
}

/**
 * JSON.stringify with HTML-comment-safe escaping. The output is embedded in
 * a `<script>` tag context, so any `</script>` substring inside the JSON
 * would let an attacker break out. Replace the literal slash before `script`
 * with its escaped form. Same protection for `<!--` HTML-comment open.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

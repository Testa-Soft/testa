/**
 * Crawler / non-human user-agent detection (3.3.3 parity: the legacy pixel
 * never runs experiments for crawlers).
 *
 * Why the proxy skips crawlers by default (`skipBots: true`):
 *   - assignment cookies minted for Googlebot / monitors / scripts inflate
 *     visitor counts and skew results (SRM);
 *   - exposures fired for them pollute conversion data;
 *   - crawlers consistently seeing the control (with the variant reachable
 *     via its own URL) is the standard, search-safe behavior for split-URL
 *     testing.
 *
 * UA-only heuristics, deliberately: this runs in the middleware on every
 * request, so it must be dependency-free and O(1) — richer signals (ASN,
 * verified-bot flags) live in the edge worker's `bot.ts`. A MISSING user
 * agent is treated as human (fail open): UA-stripping corporate proxies
 * exist, and misclassifying real visitors is worse than admitting the rare
 * UA-less script — the tracking pipeline tags those server-side anyway.
 */

// Names that don't contain "bot": crawlers, previews, SEO tools, headless
// browsers, uptime monitors, and script HTTP clients.
const NAMED_CRAWLER_RE =
  /crawler|spider|crawling|slurp|baiduspider|bingpreview|facebookexternalhit|whatsapp|skypeuripreview|screaming frog|bytespider|headlesschrome|phantomjs|lighthouse|pagespeed|pingdom|uptimerobot|statuscake|site24x7|newrelicpinger|curl\/|wget\/|python-requests|python-urllib|libwww|httpclient|okhttp|go-http-client|node-fetch|axios\/|java\//i;

// Generic "bot" with a boundary AFTER it ("Googlebot/2.1", "Twitterbot",
// "DuckDuckBot-…") and a lookbehind excluding Cubot phones — the classic
// false positive of bare /bot/ matching a real Android browser UA.
const GENERIC_BOT_RE = /(?<!cu)bot(?:[\s/);:,._-]|$)/i;

/** True when the user-agent identifies a crawler, script, or monitor — see module doc. */
export function isCrawlerUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return NAMED_CRAWLER_RE.test(userAgent) || GENERIC_BOT_RE.test(userAgent);
}

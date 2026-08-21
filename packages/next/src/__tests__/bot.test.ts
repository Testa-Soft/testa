/**
 * Crawler UA detection — bots must never be assigned, redirected, or tracked
 * (3.3.3 parity: the legacy pixel skips crawlers entirely).
 */

import { describe, expect, it } from 'vitest';
import { isCrawlerUserAgent } from '../bot.ts';

describe('isCrawlerUserAgent', () => {
  it('detects the major crawlers', () => {
    const crawlers = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'DuckDuckBot-Https/1.1; (+https://duckduckgo.com/duckduckbot)',
      'Mozilla/5.0 (compatible; Baiduspider/2.0)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Screaming Frog SEO Spider/19.4',
      'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    ];
    for (const ua of crawlers) expect(isCrawlerUserAgent(ua), ua).toBe(true);
  });

  it('detects scripts, headless browsers, and uptime monitors', () => {
    const tools = [
      'curl/8.4.0',
      'Wget/1.21.4',
      'python-requests/2.31.0',
      'Go-http-client/2.0',
      'axios/1.6.2',
      'okhttp/4.12.0',
      'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36',
      'Chrome-Lighthouse',
      'Pingdom.com_bot_version_1.4',
      'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    ];
    for (const ua of tools) expect(isCrawlerUserAgent(ua), ua).toBe(true);
  });

  it('does NOT flag real browsers', () => {
    const browsers = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    ];
    for (const ua of browsers) expect(isCrawlerUserAgent(ua), ua).toBe(false);
  });

  it('does NOT flag Cubot phones (the classic generic-"bot" false positive)', () => {
    expect(
      isCrawlerUserAgent(
        'Mozilla/5.0 (Linux; Android 11; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe(false);
  });

  it('treats a MISSING user-agent as human (fail open — UA-stripping proxies exist)', () => {
    expect(isCrawlerUserAgent(null)).toBe(false);
    expect(isCrawlerUserAgent(undefined)).toBe(false);
    expect(isCrawlerUserAgent('')).toBe(false);
  });
});

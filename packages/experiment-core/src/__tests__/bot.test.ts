/**
 * Crawler detection. Shared by the proxy and the client engine, so a miss here
 * mints a visitor id, writes an assignment and fires an exposure for something
 * that was never a visitor.
 */

import { describe, expect, it } from 'vitest';
import { isCrawlerUserAgent } from '../bot.ts';

describe('isCrawlerUserAgent', () => {
  it('catches the Google crawler family, including the ones without "bot"', () => {
    for (const ua of [
      'AdsBot-Google (+http://www.google.com/adsbot.html)',
      'AdsBot-Google-Mobile',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mediapartners-Google',
      'APIs-Google (+https://developers.google.com/webmasters/APIs-Google.html)',
      'GoogleOther',
      'Google-InspectionTool/1.0',
      'Storebot-Google/1.0',
    ]) {
      expect(isCrawlerUserAgent(ua), ua).toBe(true);
    }
  });

  it('catches scripts, monitors and headless browsers', () => {
    for (const ua of [
      'curl/8.4.0',
      'python-requests/2.31.0',
      'UptimeRobot/2.0',
      'Mozilla/5.0 HeadlessChrome/120.0.0.0',
      'ChatGPT-User/1.0',
    ]) {
      expect(isCrawlerUserAgent(ua), ua).toBe(true);
    }
  });

  it('leaves real browsers alone — including the ones that read like bots', () => {
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      // Cubot is a phone brand — the classic false positive of a bare /bot/.
      'Mozilla/5.0 (Linux; Android 9; CUBOT MAX 3) AppleWebKit/537.36 Chrome/89 Mobile Safari/537.36',
    ]) {
      expect(isCrawlerUserAgent(ua), ua).toBe(false);
    }
  });

  it('treats a missing user agent as human (fail open)', () => {
    expect(isCrawlerUserAgent(null)).toBe(false);
    expect(isCrawlerUserAgent(undefined)).toBe(false);
    expect(isCrawlerUserAgent('')).toBe(false);
  });
});

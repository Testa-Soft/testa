/**
 * Dimension-grade OS / browser families from ua-parser-js names (PRD-006 §3.6):
 * `os_name` ∈ iOS, Android, Windows, macOS, Linux, ChromeOS (else the parser's
 * name), `browser_name` folds mobile / webview variants into their base brand.
 * Versions are kept separately (`os_version`, `browser_version` = major).
 */

const OS_FAMILIES: Record<string, string> = {
  'Mac OS': 'macOS',
  macOS: 'macOS',
  iOS: 'iOS',
  iPadOS: 'iOS',
  Android: 'Android',
  Windows: 'Windows',
  'Windows Phone': 'Windows',
  'Chromium OS': 'ChromeOS',
  'Chrome OS': 'ChromeOS',
  Linux: 'Linux',
  Ubuntu: 'Linux',
  Debian: 'Linux',
  Fedora: 'Linux',
  Arch: 'Linux',
  Mint: 'Linux',
  CentOS: 'Linux',
  'Red Hat': 'Linux',
  SUSE: 'Linux',
};

const BROWSER_FAMILIES: Record<string, string> = {
  Chrome: 'Chrome',
  'Mobile Chrome': 'Chrome',
  'Chrome WebView': 'Chrome',
  'Chrome Headless': 'Chrome',
  Chromium: 'Chrome',
  Safari: 'Safari',
  'Mobile Safari': 'Safari',
  Firefox: 'Firefox',
  'Mobile Firefox': 'Firefox',
  Edge: 'Edge',
  'Samsung Browser': 'Samsung Internet',
  'Samsung Internet': 'Samsung Internet',
  Opera: 'Opera',
  'Opera Mobi': 'Opera',
  'Opera Mini': 'Opera',
  'Opera Touch': 'Opera',
  IE: 'IE',
  IEMobile: 'IE',
};

export const osFamily = (name: string | undefined): string =>
  name ? (OS_FAMILIES[name] ?? name) : '';

export const browserFamily = (name: string | undefined): string =>
  name ? (BROWSER_FAMILIES[name] ?? name) : '';

/** `129.0.6668.58` → `129`. */
export const majorVersion = (version: string | undefined): string =>
  (version ?? '').split('.')[0] ?? '';

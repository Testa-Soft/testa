/**
 * Traffic channel + referrer domain from session-entry attribution
 * (PRD-006 §3.6). Simplified GA4 default channel grouping: rules evaluated in
 * order, first match wins. Bump CHANNEL_RULES_VERSION whenever a rule or a
 * domain list changes (stored rows keep the label they were given).
 */

export const CHANNEL_RULES_VERSION = 1;

export type Channel =
  | 'Paid Search'
  | 'Paid Social'
  | 'Display'
  | 'Email'
  | 'Affiliates'
  | 'SMS'
  | 'Other Campaign'
  | 'Organic Search'
  | 'Organic Social'
  | 'Referral'
  | 'Direct';

export const DIRECT_REFERRER = '(direct)';

/** utm_source values that name a search engine. */
export const SEARCH_SOURCES = [
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'yandex',
  'ecosia',
  'baidu',
] as const;
/** utm_source values that name a social network. */
export const SOCIAL_SOURCES = [
  'facebook',
  'fb',
  'instagram',
  'ig',
  'twitter',
  'x',
  't.co',
  'linkedin',
  'pinterest',
  'tiktok',
  'reddit',
  'youtube',
] as const;
/** Referrer host markers (`google.` matches google.com, google.co.uk …). */
export const SEARCH_REFERRERS = [
  'google.',
  'bing.',
  'duckduckgo.',
  'yahoo.',
  'yandex.',
  'ecosia.',
  'baidu.',
] as const;
export const SOCIAL_REFERRERS = [
  'facebook.',
  'instagram.',
  't.co',
  'x.com',
  'linkedin.',
  'pinterest.',
  'tiktok.',
  'reddit.',
  'youtube.',
] as const;

const PAID_SEARCH_CLICK_IDS = new Set(['gclid', 'gbraid', 'wbraid', 'msclkid']);
const PAID_SOCIAL_CLICK_IDS = new Set(['fbclid', 'ttclid', 'li_fat_id']);
const PAID_SEARCH_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch']);
const PAID_SOCIAL_MEDIUMS = new Set(['paid_social', 'paidsocial', 'social_paid']);
const PAID_SOCIAL_CPC_MEDIUMS = new Set(['cpc', 'paid']);
const DISPLAY_MEDIUMS = new Set(['display', 'banner', 'cpm']);
const EMAIL_MEDIUMS = new Set(['email', 'e-mail', 'newsletter']);

const stripWww = (host: string): string => host.replace(/^www\./, '');

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return stripWww(new URL(url).hostname.toLowerCase());
  } catch {
    return '';
  }
}

/** Host of the entry referrer, `www.` stripped; `(direct)` when empty, unparseable or same-site. */
export function referrerDomain(
  entryReferrer: string | undefined,
  pageUrl: string | undefined,
): string {
  const ref = hostOf(entryReferrer);
  if (ref === '') return DIRECT_REFERRER;
  const page = hostOf(pageUrl);
  return page !== '' && ref === page ? DIRECT_REFERRER : ref;
}

const matchesHost = (host: string, markers: readonly string[]): boolean =>
  markers.some((m) =>
    m.endsWith('.')
      ? host.startsWith(m) || host.includes(`.${m}`)
      : host === m || host.endsWith(`.${m}`),
  );

export interface ChannelInputs {
  click_id_type?: string | undefined;
  utm_source?: string | undefined;
  utm_medium?: string | undefined;
  utm_campaign?: string | undefined;
  utm_term?: string | undefined;
  utm_content?: string | undefined;
  /** Output of `referrerDomain`. */
  referrer_domain: string;
}

/** The 11-rule table of PRD-006 §3.6. */
export function deriveChannel(i: ChannelInputs): Channel {
  const clickId = (i.click_id_type ?? '').toLowerCase();
  const source = (i.utm_source ?? '').toLowerCase().trim();
  const medium = (i.utm_medium ?? '').toLowerCase().trim();
  const isSearchSource = (SEARCH_SOURCES as readonly string[]).includes(source);
  const isSocialSource = (SOCIAL_SOURCES as readonly string[]).includes(source);
  const anyUtm = [i.utm_source, i.utm_medium, i.utm_campaign, i.utm_term, i.utm_content].some(
    (v) => (v ?? '').trim() !== '',
  );
  const ref = i.referrer_domain;

  if (PAID_SEARCH_CLICK_IDS.has(clickId) || (PAID_SEARCH_MEDIUMS.has(medium) && isSearchSource)) {
    return 'Paid Search';
  }
  if (
    PAID_SOCIAL_CLICK_IDS.has(clickId) ||
    PAID_SOCIAL_MEDIUMS.has(medium) ||
    (PAID_SOCIAL_CPC_MEDIUMS.has(medium) && isSocialSource)
  ) {
    return 'Paid Social';
  }
  if (DISPLAY_MEDIUMS.has(medium)) return 'Display';
  if (EMAIL_MEDIUMS.has(medium)) return 'Email';
  if (medium === 'affiliate') return 'Affiliates';
  if (medium === 'sms') return 'SMS';
  if (anyUtm) return 'Other Campaign';
  if (ref !== DIRECT_REFERRER && matchesHost(ref, SEARCH_REFERRERS)) return 'Organic Search';
  if (ref !== DIRECT_REFERRER && matchesHost(ref, SOCIAL_REFERRERS)) return 'Organic Social';
  if (ref !== DIRECT_REFERRER && ref !== '') return 'Referral';
  return 'Direct';
}

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_RULES_VERSION,
  type ChannelInputs,
  deriveChannel,
  referrerDomain,
} from '../channel.ts';

const direct = { referrer_domain: '(direct)' };
const ch = (i: Partial<ChannelInputs>) => deriveChannel({ ...direct, ...i });

describe('deriveChannel — PRD-006 §3.6 rule table (first match wins)', () => {
  it('is versioned', () => {
    expect(CHANNEL_RULES_VERSION).toBe(1);
  });

  it.each<[string, Partial<ChannelInputs>, string]>([
    // 1 Paid Search
    ['1: gclid', { click_id_type: 'gclid' }, 'Paid Search'],
    ['1: gbraid', { click_id_type: 'gbraid' }, 'Paid Search'],
    ['1: wbraid', { click_id_type: 'wbraid' }, 'Paid Search'],
    ['1: msclkid', { click_id_type: 'msclkid' }, 'Paid Search'],
    ['1: cpc + google', { utm_medium: 'cpc', utm_source: 'google' }, 'Paid Search'],
    ['1: paidsearch + bing', { utm_medium: 'paidsearch', utm_source: 'Bing' }, 'Paid Search'],
    // 2 Paid Social
    ['2: fbclid', { click_id_type: 'fbclid' }, 'Paid Social'],
    ['2: ttclid', { click_id_type: 'ttclid' }, 'Paid Social'],
    ['2: li_fat_id', { click_id_type: 'li_fat_id' }, 'Paid Social'],
    ['2: paid_social medium', { utm_medium: 'paid_social', utm_source: 'anything' }, 'Paid Social'],
    ['2: cpc + facebook', { utm_medium: 'cpc', utm_source: 'facebook' }, 'Paid Social'],
    // 3–6 medium-based
    ['3: display', { utm_medium: 'display' }, 'Display'],
    ['3: cpm', { utm_medium: 'CPM' }, 'Display'],
    ['4: email', { utm_medium: 'email' }, 'Email'],
    ['4: newsletter', { utm_medium: 'newsletter' }, 'Email'],
    ['5: affiliate', { utm_medium: 'affiliate' }, 'Affiliates'],
    ['6: sms', { utm_medium: 'sms' }, 'SMS'],
    // 7 other campaign
    ['7: cpc + unknown source', { utm_medium: 'cpc', utm_source: 'partner-x' }, 'Other Campaign'],
    ['7: campaign only', { utm_campaign: 'autumn' }, 'Other Campaign'],
    // 8–11 referrer-based
    ['8: google referrer', { referrer_domain: 'google.com' }, 'Organic Search'],
    ['8: google.co.uk', { referrer_domain: 'google.co.uk' }, 'Organic Search'],
    ['8: duckduckgo', { referrer_domain: 'duckduckgo.com' }, 'Organic Search'],
    ['9: facebook', { referrer_domain: 'facebook.com' }, 'Organic Social'],
    ['9: m.facebook.com', { referrer_domain: 'm.facebook.com' }, 'Organic Social'],
    ['9: t.co', { referrer_domain: 't.co' }, 'Organic Social'],
    ['9: x.com', { referrer_domain: 'x.com' }, 'Organic Social'],
    ['10: external referrer', { referrer_domain: 'blog.example.org' }, 'Referral'],
    ['11: direct', {}, 'Direct'],
  ])('%s → %s', (_name, inputs, want) => {
    expect(ch(inputs)).toBe(want);
  });

  it('edge cases: earlier rules win', () => {
    expect(ch({ click_id_type: 'gclid', utm_medium: 'email' })).toBe('Paid Search');
    expect(ch({ click_id_type: 'fbclid', referrer_domain: 'google.com' })).toBe('Paid Social');
    expect(ch({ utm_source: 'newsletter-tool', referrer_domain: 'google.com' })).toBe(
      'Other Campaign',
    );
    // A host that merely contains a marker is not a search engine.
    expect(ch({ referrer_domain: 'notgoogle.com' })).toBe('Referral');
    expect(ch({ referrer_domain: 'xt.co' })).toBe('Referral');
  });
});

describe('referrerDomain', () => {
  it.each<[string | undefined, string | undefined, string]>([
    ['https://www.google.com/search?q=x', 'https://shop.example/', 'google.com'],
    ['https://news.ycombinator.com/item', 'https://shop.example/', 'news.ycombinator.com'],
    ['', 'https://shop.example/', '(direct)'],
    [undefined, 'https://shop.example/', '(direct)'],
    ['not a url', 'https://shop.example/', '(direct)'],
    ['https://www.shop.example/cart', 'https://shop.example/', '(direct)'], // same-site
  ])('%p on %p → %p', (ref, page, want) => {
    expect(referrerDomain(ref, page)).toBe(want);
  });
});

import { describe, expect, it } from 'bun:test';
import {
  REDACTED,
  containsEmail,
  isPiiKey,
  redactText,
  scrubEvent,
  scrubProps,
  scrubUrl,
} from '../pii.ts';

describe('isPiiKey', () => {
  it('matches personal-data field names regardless of case and separators', () => {
    for (const k of [
      'email',
      'E-Mail',
      'user_email',
      'first_name',
      'LastName',
      'phone_number',
      'ip',
    ])
      expect(isPiiKey(k)).toBe(true);
  });

  it('leaves commerce and product fields alone', () => {
    for (const k of ['name', 'item_name', 'order_id', 'currency', 'value_native', 'zip_code_area'])
      expect(isPiiKey(k)).toBe(false);
  });
});

describe('containsEmail', () => {
  it('finds raw and percent-encoded emails', () => {
    expect(containsEmail('jane.doe+x@example.co.uk')).toBe(true);
    expect(containsEmail('jane%40example.com')).toBe(true);
    expect(containsEmail('order-123')).toBe(false);
    expect(containsEmail('%E0%A4%A')).toBe(false);
  });
});

describe('redactText', () => {
  it('redacts emails in free text, keeping the rest', () => {
    expect(redactText('Thanks jane@example.com!')).toBe(`Thanks ${REDACTED}!`);
    expect(redactText('Plain title')).toBe('Plain title');
  });
});

describe('scrubUrl', () => {
  it('drops PII params by key and by value, preserving the others verbatim', () => {
    expect(
      scrubUrl('https://shop.test/thanks?utm_source=fb&email=a%40b.com&q=x%20y&ref=a@b.com#top'),
    ).toBe('https://shop.test/thanks?utm_source=fb&q=x%20y#top');
  });

  it('removes the query mark when every param was PII', () => {
    expect(scrubUrl('https://shop.test/p?phone=123')).toBe('https://shop.test/p');
  });

  it('redacts emails in the path and scrubs hash-routed queries', () => {
    expect(scrubUrl('https://shop.test/u/jane@example.com/#/done?first_name=J&step=2')).toBe(
      `https://shop.test/u/${REDACTED}/#/done?step=2`,
    );
  });

  it('passes clean and empty URLs through unchanged', () => {
    expect(scrubUrl('https://shop.test/a?b=1&c')).toBe('https://shop.test/a?b=1&c');
    expect(scrubUrl('')).toBe('');
  });
});

describe('scrubProps', () => {
  it('drops PII keys and email values, recursing into items, without mutating', () => {
    const input = {
      order_id: 'A1',
      email: 'jane@example.com',
      note: 'contact jane@example.com',
      method: 'google',
      items: [{ item_id: 'sku', item_name: 'Shoe', customer_name: 'Jane' }],
    };
    const out: Record<string, unknown> = scrubProps(input);
    expect(out).toEqual({
      order_id: 'A1',
      method: 'google',
      items: [{ item_id: 'sku', item_name: 'Shoe' }],
    });
    expect(input.email).toBe('jane@example.com');
  });
});

describe('scrubEvent', () => {
  it('scrubs URL fields, the title and unknown passthrough fields', () => {
    const out: Record<string, unknown> = scrubEvent({
      event_name: 'page_view',
      url: 'https://a.test/?email=x%40y.com&k=1',
      referrer: 'https://b.test/?first_name=J',
      title: 'Hi x@y.com',
      email: 'x@y.com',
    });
    expect(out).toEqual({
      event_name: 'page_view',
      url: 'https://a.test/?k=1',
      referrer: 'https://b.test/',
      title: `Hi ${REDACTED}`,
    });
  });
});

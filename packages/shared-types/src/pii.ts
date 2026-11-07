/**
 * Personal-data scrubbing for tracking payloads (GDPR data minimisation).
 *
 * Nothing that identifies a person may reach our storage: no emails, phone
 * numbers, names, addresses or IPs. Customers do put such things in URLs
 * (`/thanks?email=…`), page titles and event props by accident, so every hop
 * scrubs — the SDK before sending (the data never leaves the browser), then the
 * edge and the collector again, because a payload is untrusted input.
 *
 * Policy: STRIP, don't reject. A prop or query param that is (or contains) PII
 * is dropped and the event still goes through, so one careless prop never
 * costs a purchase. Free text that cannot be dropped as a unit (a page title, a
 * URL path) has the email redacted in place.
 *
 * Detection is deliberately two-pronged:
 *   - by KEY — a field named like personal data is dropped whatever its value;
 *   - by VALUE — an email anywhere in a string. Phone numbers are matched by
 *     key only: a digit run in a value is far more often an order id.
 *
 * Runtime code (not just types) and dependency-free on purpose: the edge
 * worker, the collector and the SDKs all import it.
 */

export const REDACTED = '[redacted]';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/**
 * Normalised (lower-case, separators removed) field names that are personal
 * data whatever they hold. `name` alone is NOT here: on an item it is the
 * product name.
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  'email',
  'emailaddress',
  'mail',
  'phone',
  'phonenumber',
  'tel',
  'telephone',
  'mobile',
  'firstname',
  'lastname',
  'fullname',
  'surname',
  'username',
  'customername',
  'address',
  'streetaddress',
  'street',
  'zip',
  'zipcode',
  'postcode',
  'postalcode',
  'ip',
  'ipaddress',
  'password',
  'passwd',
  'ssn',
  'dob',
  'dateofbirth',
  'birthdate',
  'birthday',
  'creditcard',
  'cardnumber',
  'iban',
]);

/** Fragments that mark a key as personal data wherever they appear in it. */
const PII_KEY_FRAGMENTS = ['email', 'phone', 'password'] as const;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[\s_\-.[\]]/g, '');

/** True when a field with this name must never be stored. */
export function isPiiKey(key: string): boolean {
  const k = normaliseKey(key);
  return PII_KEYS.has(k) || PII_KEY_FRAGMENTS.some((f) => k.includes(f));
}

/** Decode `%40`-style escapes without ever throwing on a malformed sequence. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** True when the string carries an email address, raw or percent-encoded. */
export function containsEmail(value: string): boolean {
  EMAIL_RE.lastIndex = 0;
  if (EMAIL_RE.test(value)) return true;
  if (!value.includes('%')) return false;
  EMAIL_RE.lastIndex = 0;
  return EMAIL_RE.test(safeDecode(value));
}

/** Replace every email in free text with {@link REDACTED}. */
export function redactText(value: string): string {
  const plain = value.replace(EMAIL_RE, REDACTED);
  return containsEmail(plain) ? safeDecode(plain).replace(EMAIL_RE, REDACTED) : plain;
}

function scrubSearch(search: string): string {
  if (search === '' || search === '?') return '';
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => {
      if (pair === '') return false;
      const eq = pair.indexOf('=');
      const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return !isPiiKey(key) && !containsEmail(value) && !containsEmail(key);
    });
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}

/** A hash routed like a query (`#/thanks?email=…`) is scrubbed like one. */
function scrubHash(hash: string): string {
  const q = hash.indexOf('?');
  if (q === -1) return redactText(hash);
  return redactText(hash.slice(0, q)) + scrubSearch(hash.slice(q));
}

/**
 * Drop PII query params (by key or by email value) and redact emails left in
 * the path or hash. Everything else — order, encoding, unrelated params — is
 * preserved byte for byte, so URL-based targeting and reporting still match.
 * Unparseable input is treated as free text.
 */
export function scrubUrl(url: string): string {
  if (!url) return url;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = queryAt === -1 ? '' : beforeHash.slice(queryAt);
  return redactText(base) + scrubSearch(search) + scrubHash(hash);
}

/** A value is dropped when it is a string carrying an email. */
const isPiiValue = (value: unknown): boolean => typeof value === 'string' && containsEmail(value);

/** Scrub one value: recurse into arrays/objects, keep scalars as-is. */
function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => !isPiiValue(v)).map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return scrubProps(value as Record<string, unknown>);
  }
  return value;
}

/**
 * A copy of `props` without personal data: PII-named keys and email-bearing
 * string values are dropped, nested objects/arrays (e.g. `items`) are scrubbed
 * the same way. Never mutates the input.
 */
export function scrubProps<T extends Record<string, unknown>>(props: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isPiiKey(key) || isPiiValue(value)) continue;
    out[key] = scrubValue(value);
  }
  return out as T;
}

/** Event fields that hold a URL. */
const EVENT_URL_FIELDS = ['url', 'referrer', 'entry_url', 'entry_referrer'] as const;

/**
 * A copy of a whole tracking event without personal data: every field is
 * scrubbed like a prop (so an unknown passthrough `email` is dropped too), URL
 * fields lose PII params, and the page title has emails redacted.
 */
export function scrubEvent<T extends Record<string, unknown>>(event: T): T {
  const out: Record<string, unknown> = scrubProps(event);
  for (const field of EVENT_URL_FIELDS) {
    const v = event[field];
    if (typeof v === 'string') out[field] = scrubUrl(v);
  }
  if (typeof event.title === 'string') out.title = redactText(event.title);
  return out as T;
}

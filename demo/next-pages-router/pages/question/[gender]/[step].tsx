/**
 * Regression fixture for a split-URL redirect on a DYNAMIC route with query
 * params — `/question/male/1?flow=7247` → `/question/female/1?flow=7247`.
 *
 * The shape matters: the guard has to survive a route with two dynamic
 * segments, keep the query string the visitor arrived with, and stay a SOFT
 * navigation. `window.__navMarker` (set by the home page before it links here)
 * is the tell: it survives a client-side transition and is wiped by a full
 * document load.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';

export default function QuestionStep() {
  const router = useRouter();
  const { gender, step } = router.query;
  const query = Object.entries(router.query)
    .filter(([key]) => key !== 'gender' && key !== 'step')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&');

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', lineHeight: 1.6 }}>
      <h1 id="hero">
        Question — {String(gender ?? '?')} / step {String(step ?? '?')}
      </h1>
      <p>
        Query carried over: <code id="carried">{query || '(none)'}</code>
      </p>
      <p>
        Soft nav preserved:{' '}
        <code id="softnav">
          {typeof window !== 'undefined' &&
          (window as unknown as { __navMarker?: string }).__navMarker
            ? 'yes'
            : 'no (full document load)'}
        </code>
      </p>
      <Link href="/">← Home</Link>
    </main>
  );
}

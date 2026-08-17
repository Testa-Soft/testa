export default function About() {
  return (
    <main>
      {/* #hero is the site-wide experiment target — the ✨ variant badge is
          appended here client-side when you navigate in. */}
      <h1 id="hero">About</h1>
      <p>
        Same site-wide experiment, a different page. The assignment lives in the sticky{' '}
        <code>_testa_exp</code> cookie (set once by the middleware); the client applies it here
        cookie-first, without re-bucketing.
      </p>
    </main>
  );
}

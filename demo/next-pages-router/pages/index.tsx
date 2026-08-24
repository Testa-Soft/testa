import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', lineHeight: 1.6 }}>
      <h1 id="hero">Pages Router demo</h1>
      <p>
        Experiment 202 appends a <em>✨ variant</em> badge to the H1 above (client engine). It
        re-applies on every navigation.
      </p>
      <p>
        Experiment 101 is a 50/50 split-URL test on the pricing page. Your bucket is sticky
        (cookie <code>_testa_exp</code>):
      </p>
      <ul>
        <li>
          <Link href="/pricing">Pricing (soft nav — router guard re-points variants pre-render)</Link>
        </li>
        <li>
          <a href="/pricing">Pricing (hard load — the proxy 307s variants server-side)</a>
        </li>
      </ul>
      <p style={{ color: '#666' }}>
        Bucketed to control? Clear the <code>_testa_exp</code> cookie (or use a private window) to
        re-roll. Watch the dev-server terminal for <code>[testa][server]</code> assignment logs and
        the Network tab for the 307.
      </p>
    </main>
  );
}

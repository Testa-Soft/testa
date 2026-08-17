import Link from 'next/link';

const linkStyle = {
  display: 'inline-block',
  padding: '8px 14px',
  border: '1px solid #ccc',
  borderRadius: 6,
  textDecoration: 'none',
};

export default function Home() {
  return (
    <main>
      {/* Experiment 202 (HTML/DOM) targets #hero: change_html (text) + css
          (color). The server-rendered control heading below is what a
          non-variant visitor sees; the variant swaps it client-side, shielded. */}
      <h1 id="hero">Welcome (control heading)</h1>

      <p>
        This home page runs a <strong>client HTML experiment</strong> (crobot{' '}
        <code>change_html</code> + <code>css</code>). The middleware assigns it server-side; the{' '}
        <code>&lt;TestaExperiments/&gt;</code> component applies it, shielded against flicker — so
        you should never see the control heading flash.
      </p>

      <p>
        <code>/pricing</code> runs a separate <strong>split-URL</strong> experiment (server 307).
      </p>

      <p style={{ display: 'flex', gap: 12, margin: '20px 0' }}>
        <Link href="/pricing" style={linkStyle}>
          Go to /pricing (soft nav — Link)
        </Link>
        <a href="/pricing" style={linkStyle}>
          Go to /pricing (hard nav — a)
        </a>
      </p>
    </main>
  );
}

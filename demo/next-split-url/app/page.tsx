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
      <h1>Testa split-URL demo</h1>
      <p>
        The middleware runs an active split-URL experiment on <code>/pricing</code>. If you're
        bucketed to the variant, you're redirected server-side to <code>/pricing-v2</code>.
      </p>

      <p style={{ display: 'flex', gap: 12, margin: '20px 0' }}>
        <Link href="/pricing" style={linkStyle}>
          Go to /pricing (soft nav — Link)
        </Link>
        <a href="/pricing" style={linkStyle}>
          Go to /pricing (hard nav — a)
        </a>
      </p>

      <p style={{ color: '#666', fontSize: 14 }}>
        Click the <strong>soft nav</strong> link and watch the client session id below: if it stays
        the same when you land on the variant, the middleware redirect was followed without a full
        reload. Compare with the <strong>hard nav</strong> link (always reloads).
      </p>
    </main>
  );
}

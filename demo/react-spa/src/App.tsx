import { useTestaVariant } from '@testa-soft/react';
import { Link, Route, Routes } from 'react-router-dom';

const navLink = { marginRight: 16 };

/** Code-based experiment 303: the app renders the variant through React (robust). */
function Cta() {
  const { isControl, variationId } = useTestaVariant(303);
  // Default to control while unassigned (variationId null) or when bucketed to control.
  const variant = variationId != null && !isControl;
  return (
    <p
      id="cta"
      style={{
        display: 'inline-block',
        padding: '10px 16px',
        borderRadius: 8,
        background: variant ? '#c2185b' : '#eee',
        color: variant ? '#fff' : '#333',
      }}
    >
      {variant ? '🎉 Start your free trial' : 'Sign up'}
    </p>
  );
}

function Page({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main>
      {/* #hero gets its colour from the css experiment (202) — survives nav. */}
      <h1 id="hero">{title}</h1>
      {children}
      <div style={{ margin: '20px 0' }}>
        <Cta />
      </div>
    </main>
  );
}

export function App() {
  return (
    <>
      <nav style={{ marginBottom: 24, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
        <Link to="/" style={navLink}>Home</Link>
        <Link to="/features" style={navLink}>Features</Link>
        <Link to="/about" style={navLink}>About</Link>
        <Link to="/calculator" style={navLink}>Calculator</Link>
      </nav>
      <Routes>
        <Route
          path="/"
          element={
            <Page title="Home">
              <p>
                A <strong>Vite + React SPA</strong> (no server) using <code>@testa-soft/react</code>.
                <code>&lt;TestaProvider&gt;</code> assigns experiments client-side. The heading colour
                comes from a <code>css</code> change; the CTA below is a <strong>code-based</strong>{' '}
                experiment rendered via <code>useTestaVariant</code>.
              </p>
              <p style={{ color: '#666', fontSize: 14 }}>
                Click the nav links (react-router soft nav) — both the colour and the CTA variant
                stay applied on every page, because css lives in <code>&lt;head&gt;</code> and the CTA
                is owned by React (no reconciliation clobbering).
              </p>
            </Page>
          }
        />
        <Route path="/features" element={<Page title="Features"><p>Same experiments, re-resolved on soft nav — robust across routes.</p></Page>} />
        <Route path="/about" element={<Page title="About"><p>Cookie-first: assignment lives in <code>_testa_exp</code>; no re-bucketing.</p></Page>} />
        {/* Prod-config target page: the real project's experiments are scoped to
            `contains /calculator`. Redirect variants land on ?testa=ab here;
            change_html variants rewrite this h1 — soft-nav away must NOT leak it. */}
        <Route path="/calculator" element={<Page title="Calculator"><p>Prod-config target page (<code>VITE_TESTA_DEMO_PROD=1</code>). Author changes for <code>/calculator</code> in crobot; they land here within ~30s.</p></Page>} />
      </Routes>
    </>
  );
}

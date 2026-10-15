import { useTestaVariant } from '@testa-soft/react';
import { Link, Route, Routes } from 'react-router-dom';

const navLink = { marginRight: 16 };

const TESTA_KEY = /^_testa/;

/** Forget this visitor (cookies + storage mirrors) so the next load re-buckets. */
function resetVisitor() {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim() ?? '';
    if (TESTA_KEY.test(name)) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
  for (const store of [localStorage, sessionStorage]) {
    for (const key of Object.keys(store)) if (TESTA_KEY.test(key)) store.removeItem(key);
  }
  window.location.assign('/');
}

function armLabel(variationId: number | null, isControl: boolean) {
  if (variationId === null) return 'not assigned yet';
  return isControl ? 'Control' : `Variant (${variationId})`;
}

/** Test panel: which arm this visitor is in, plus a re-roll button. */
function TestPanel() {
  const html = useTestaVariant(10);
  const split = useTestaVariant(11);
  return (
    <aside
      style={{
        margin: '0 0 24px',
        padding: 12,
        border: '1px dashed #bbb',
        borderRadius: 8,
        fontSize: 14,
      }}
    >
      <div>
        HTML test (#10, /calculator): <strong>{armLabel(html.variationId, html.isControl)}</strong>
      </div>
      <div>
        Split URL (#11, /pricing → /pricing-b):{' '}
        <strong>{armLabel(split.variationId, split.isControl)}</strong>
      </div>
      <button type="button" onClick={resetVisitor} style={{ marginTop: 8 }}>
        New visitor (reset assignment)
      </button>
    </aside>
  );
}

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
        <Link to="/" style={navLink}>
          Home
        </Link>
        <Link to="/features" style={navLink}>
          Features
        </Link>
        <Link to="/about" style={navLink}>
          About
        </Link>
        <Link to="/calculator" style={navLink}>
          Calculator
        </Link>
        <Link to="/pricing" style={navLink}>
          Pricing
        </Link>
      </nav>
      <TestPanel />
      <Routes>
        <Route
          path="/"
          element={
            <Page title="Home">
              <p>
                A <strong>Vite + React SPA</strong> (no server) using <code>@testa-soft/react</code>
                .<code>&lt;TestaProvider&gt;</code> assigns experiments client-side. The heading
                colour comes from a <code>css</code> change; the CTA below is a{' '}
                <strong>code-based</strong> experiment rendered via <code>useTestaVariant</code>.
              </p>
              <p style={{ color: '#666', fontSize: 14 }}>
                Click the nav links (react-router soft nav) — both the colour and the CTA variant
                stay applied on every page, because css lives in <code>&lt;head&gt;</code> and the
                CTA is owned by React (no reconciliation clobbering).
              </p>
            </Page>
          }
        />
        <Route
          path="/features"
          element={
            <Page title="Features">
              <p>Same experiments, re-resolved on soft nav — robust across routes.</p>
            </Page>
          }
        />
        <Route
          path="/about"
          element={
            <Page title="About">
              <p>
                Cookie-first: assignment lives in <code>_testa_exp</code>; no re-bucketing.
              </p>
            </Page>
          }
        />
        {/* Prod-config target page: the real project's experiments are scoped to
            `contains /calculator`. Redirect variants land on ?testa=ab here;
            change_html variants rewrite this h1 — soft-nav away must NOT leak it. */}
        <Route
          path="/calculator"
          element={
            <Page title="Calculator">
              <p>
                Prod-config target page (<code>VITE_TESTA_DEMO_PROD=1</code>). Author changes for{' '}
                <code>/calculator</code> in crobot; they land here within ~30s.
              </p>
            </Page>
          }
        />
        <Route
          path="/pricing"
          element={
            <Page title="Pricing — original (A)">
              <p>
                Split-URL control page. Variant visitors are redirected to <code>/pricing-b</code>.
              </p>
            </Page>
          }
        />
        <Route
          path="/pricing-b"
          element={
            <Page title="Pricing — variant (B)">
              <p>Split-URL destination. Visitors in the variant land here.</p>
            </Page>
          }
        />
      </Routes>
    </>
  );
}

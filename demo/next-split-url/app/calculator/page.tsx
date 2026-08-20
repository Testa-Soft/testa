/**
 * Prod-config test page — the real project's "Calculator" experiment page-rule
 * is `contains /calculator`, so this route is where its changes/redirects land
 * when the demo runs with `TESTA_DEMO_PROD=1` (see testa.config.ts).
 */
export default function CalculatorPage() {
  return (
    <main>
      <h1 id="hero">Calculator</h1>
      <p>
        Prod-config target page. Author changes for <code>/calculator</code> in crobot, publish,
        and they land here within ~30s — soft-nav away and back to verify page-scoping.
      </p>
    </main>
  );
}

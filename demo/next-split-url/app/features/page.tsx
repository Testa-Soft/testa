export default function Features() {
  return (
    <main>
      {/* #hero is the site-wide experiment target — the ✨ variant badge is
          appended here client-side when you navigate in. */}
      <h1 id="hero">Features</h1>
      <p>
        You navigated here via a <strong>soft (client-side) navigation</strong>. The site-wide HTML
        experiment (202) re-applied its <code>#hero</code> badge on this page — no full page reload.
      </p>
      <p style={{ color: '#666', fontSize: 14 }}>
        On a soft nav there is no shield, so if you watch closely the badge appears a beat after the
        heading. On a hard reload (Cmd/Ctrl+R) the shield hides the page until it is applied.
      </p>
    </main>
  );
}

import Link from 'next/link';

export default function PricingV2() {
  return (
    <main
      style={{
        fontFamily: 'system-ui',
        maxWidth: 640,
        margin: '4rem auto',
        lineHeight: 1.6,
        background: '#fff3f8',
        padding: '1rem 2rem',
        borderRadius: 12,
      }}
    >
      <h1 id="hero">Pricing — VARIANT 🎉</h1>
      <p>
        You are in the variant bucket of experiment 101. Hard loads of <code>/pricing</code> got a
        server-side 307 here; soft navs were re-pointed by the router guard before the control page
        could render.
      </p>
      <p>
        <Link href="/">← Home (soft nav)</Link>
      </p>
    </main>
  );
}

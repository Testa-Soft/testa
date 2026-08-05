import Link from 'next/link';

export default function PricingVariant() {
  return (
    <main>
      <h1>Pricing — Variant 🎉</h1>
      <p>
        This is variation <strong>2 (variant)</strong>, served at <code>/pricing-v2</code>. You were
        redirected here server-side by the Testa middleware — the control page never painted.
      </p>
      <p>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}

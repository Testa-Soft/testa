import Link from 'next/link';

export default function PricingControl() {
  return (
    <main>
      <h1>Pricing — Control</h1>
      <p>
        This is variation <strong>1 (control)</strong>, served at <code>/pricing</code>. If you see
        this page, the middleware assigned you to control and did not redirect.
      </p>
      <p>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}

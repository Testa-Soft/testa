import Link from 'next/link';

export default function Pricing() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '4rem auto', lineHeight: 1.6 }}>
      <h1 id="hero">Pricing — CONTROL</h1>
      <p>You are in the control bucket of experiment 101 (or unassigned traffic).</p>
      <p>
        <Link href="/">← Home (soft nav)</Link>
      </p>
    </main>
  );
}

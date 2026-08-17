/** @type {import('next').NextConfig} */
const nextConfig = {
  // StrictMode double-invokes effects in dev — a good stress test that the
  // client apply is idempotent (no duplicate inserts on effect re-run).
  reactStrictMode: true,
  // The workspace packages ship raw .ts (no build step) — let Next transpile them.
  transpilePackages: [
    '@testa/next',
    '@testa-platform/experiment-core',
    '@testa-platform/shared-types',
  ],
};

export default nextConfig;

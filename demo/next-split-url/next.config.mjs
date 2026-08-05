/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship raw .ts (no build step) — let Next transpile them.
  transpilePackages: [
    '@testa/next',
    '@testa-platform/experiment-core',
    '@testa-platform/shared-types',
  ],
};

export default nextConfig;

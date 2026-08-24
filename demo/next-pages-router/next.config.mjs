/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The raw-.ts workspace packages need Next's transpile for the CLIENT bundle.
  // @testa-soft/next is deliberately NOT listed: it ships built ESM (dist/) and
  // must be consumed exactly like a published install — running it through
  // transpilePackages makes Next 15.0.3's SWC emit CJS for a module webpack
  // records as ESM, so every named export reads back `undefined`.
  transpilePackages: [
    '@testa-soft/react',
    '@testa-soft/experiment-core',
    '@testa-soft/dom',
    '@testa-platform/shared-types',
  ],
  // WORKSPACE-ONLY NOTE (published consumers are unaffected): the dev `main`
  // of @testa-soft/react points at raw .tsx (its publishConfig swaps to dist
  // on publish), and Next's pages-router SERVER externalizes the package —
  // Node then loads the .tsx at runtime. The dev/start scripts register the
  // `tsx` loader (NODE_OPTIONS='--import tsx') so that runtime load works.
};

export default nextConfig;

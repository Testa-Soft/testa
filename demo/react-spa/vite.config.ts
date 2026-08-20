import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Prod-config test loop: proxy config fetches STRAIGHT to the collector
      // (Fly), bypassing the Cloudflare cache (10-min s-maxage + SWR would
      // otherwise serve stale configs for minutes after a crobot publish) and
      // sidestepping CORS (the collector origin sends no ACAO header — the CDN
      // adds it). Same-origin from the browser's point of view.
      '/__testa-config': {
        target: 'https://testa-collector.fly.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__testa-config/, ''),
      },
    },
  },
});

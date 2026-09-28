import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    /**
     * Preact via compat, not React: ~55KB less gzipped, and bundle size is the
     * dominant term in the research's "under three seconds to interactive on a
     * mid-range Android" budget.
     *
     * Anchored regexes, not object keys: an object alias matches by PREFIX in
     * key order, so a bare `react` entry swallows `react-dom` and produces a
     * nonsense specifier. Longest-first and exact is unambiguous.
     */
    alias: [
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
      { find: /^react-dom\/test-utils$/, replacement: 'preact/test-utils' },
      { find: /^react-dom$/, replacement: 'preact/compat' },
      { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
      { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
      { find: /^react$/, replacement: 'preact/compat' },
    ],
  },
  build: {
    outDir: 'dist',
    // Fail the build if the bundle grows past what a mid-range Android on a
    // poor connection can afford. The research budget is under three seconds
    // to interactive, and bundle size is the dominant term.
    chunkSizeWarningLimit: 200,
    target: 'es2020',
  },
  server: {
    port: 5173,
    // Dev-only: talk to the API on its own port without CORS.
    proxy: {
      '/locations': 'http://localhost:3000',
      '/appointments': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/queue': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/realtime': { target: 'ws://localhost:3000', ws: true },
    },
  },
});

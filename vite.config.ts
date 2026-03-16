import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  build: {
    // Polyglot's ESM bundle uses top-level await, so we target modern browsers.
    target: 'esnext',
  },
  optimizeDeps: {
    // Keep this package out of esbuild pre-bundling so its WASM loading works correctly.
    exclude: ['@polyglot-sql/sdk'],
  },
});

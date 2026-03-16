import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig(() => {
  const explicitBase = process.env.VITE_BASE_PATH;
  const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
  const isGithubActionsBuild = process.env.GITHUB_ACTIONS === 'true';

  // Default to project-site paths on GitHub Actions, but allow explicit override.
  const base =
    explicitBase ?? (isGithubActionsBuild && repositoryName ? `/${repositoryName}/` : '/');

  return {
    base,
    plugins: [wasm()],
    build: {
      // Polyglot's ESM bundle uses top-level await, so we target modern browsers.
      target: 'esnext',
    },
    optimizeDeps: {
      // Keep this package out of esbuild pre-bundling so its WASM loading works correctly.
      exclude: ['@polyglot-sql/sdk'],
    },
  };
});

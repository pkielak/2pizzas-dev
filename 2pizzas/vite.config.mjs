import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The built SPA is served by server.mjs: the shell (index.html) is served at
// the MIGRATED route paths (see SPA_ROUTES in server.mjs), static assets
// under /ui/. base must match. `npm run dev` proxies the API + SSE to the
// running 2pizzas on :3001.
export default defineConfig({
  plugins: [svelte()],
  base: '/ui/',
  build: { outDir: 'ui/dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
      '/live': 'http://127.0.0.1:3001',
    },
  },
});

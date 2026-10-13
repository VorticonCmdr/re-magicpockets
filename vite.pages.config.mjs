import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The GitHub Pages build: the playable page (index.html) and the asset explorer (viewer.html). level.html (the level viewer) decodes the visitor's own files in the browser. No game data is bundled or served; visitors pick
// their own copy of Magic Pockets with "Load folder…" and the files stay in their browser.
export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(import.meta.dirname, 'index.html'), viewer: resolve(import.meta.dirname, 'viewer.html'), level: resolve(import.meta.dirname, 'level.html') } },
  },
});

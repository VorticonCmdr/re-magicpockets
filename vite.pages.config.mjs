import { defineConfig } from 'vite';

// The GitHub Pages build: only the playable page (index.html). No game data is bundled or served; visitors pick
// their own copy of Magic Pockets with "Load folder…" and the files stay in their browser.
export default defineConfig({
  base: './',
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: true },
});

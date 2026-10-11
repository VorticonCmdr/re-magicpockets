import { defineConfig } from 'vite';
import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const root = import.meta.dirname;
const types = { '.json': 'application/json', '.png': 'image/png', '.mid': 'audio/midi' };

// Local assets stay out of the distributable. Both dev and preview can access the owner's
// data/ and legacy build/ output; a hosted build instead accepts a folder in the browser.
function localAssets() {
  const install = (server) => { server.middlewares.use(async (req, res, next) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Vite must transform JSON imported by browser modules, rather than serve its raw text.
      if (url.searchParams.has('import')) return next();
      if (url.pathname === '/api/assets') {
        let names = [];
        try { names = await readdir(resolve(root, 'data')); } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        const files = [];
        for (const name of names.filter((name) => !name.startsWith('.'))) {
          const info = await stat(resolve(root, 'data', name));
          if (info.isFile()) files.push({ name, size: info.size });
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(files));
        return;
      }
      const match = /^\/(data|build|symbols)\/(.+)$/.exec(decodeURIComponent(url.pathname));
      if (!match) return next();
      const base = resolve(root, match[1]);
      const filename = resolve(base, match[2]);
      if (!filename.startsWith(base + sep)) { res.statusCode = 403; res.end(); return; }
      const bytes = await readFile(filename);
      res.setHeader('Content-Type', types[extname(filename)] || 'application/octet-stream');
      res.end(bytes);
    } catch (err) {
      res.statusCode = err.code === 'ENOENT' ? 404 : 500;
      res.end(err.code === 'ENOENT' ? 'Asset not found' : 'Unable to read local assets');
    }
  }); };
  return {
    name: 'local-game-assets',
    configureServer: install,
    configurePreviewServer: install,
    async generateBundle() {
      // The existing game uses a runtime URL for this reverse-engineered lookup table.
      this.emitFile({ type: 'asset', fileName: 'symbols/entity-shapes.json', source: await readFile(resolve(root, 'symbols/entity-shapes.json')) });
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [localAssets()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        viewer: resolve(root, 'viewer.html'),
        level: resolve(root, 'level.html'),
        game: resolve(root, 'web/index.html'),
        midi: resolve(root, 'tools/midi-player.html'),
      },
    },
  },
});

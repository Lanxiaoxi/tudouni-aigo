import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createReadStream, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * The icon the launch splash draws, served as `/splash-icon.png`.
 *
 * **One source, so it cannot drift.** `splash.html` is a plain document with no
 * imports, so it cannot pull the icon through the module graph the way a React
 * component would — and copying the file into `public/` would be a second copy
 * of the packaged icon, which is exactly the kind of copy that goes stale
 * silently. This plugin serves the *bundled* icon at that one URL in dev and
 * emits the same bytes into `dist` on a build. The splash and the installer
 * therefore always wear the same face.
 */
const SPLASH_ICON = fileURLToPath(new URL('./src-tauri/icons/128x128@2x.png', import.meta.url));

const splashIcon = (): Plugin => ({
  name: 'splash-icon',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Exact match only: this middleware sits in front of Vite's own static
      // handling, so anything else has to fall through untouched.
      if (req.url?.split('?')[0] !== '/splash-icon.png') return next();
      res.setHeader('Content-Type', 'image/png');
      createReadStream(SPLASH_ICON).pipe(res);
    });
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'splash-icon.png',
      source: readFileSync(SPLASH_ICON),
    });
  },
});

export default defineConfig({
  plugins: [react(), splashIcon()],
  // The desktop's own version, independent of the runtime's. It is displayed
  // next to the runtime's on the first screen (decision 1).
  define: {
    __DESKTOP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri drives the dev server itself; a fixed port keeps the two in step.
  server: {
    port: 5178,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    // Two documents: the application (`index.html`) and the launch splash
    // (`splash.html`, the window behind `label: "splash"` in tauri.conf.json).
    // Tauri's asset protocol wants the main entry at a predictable name — which
    // is why `entryFileNames` is fixed — and the splash contributes **no
    // entry chunk** at all: it holds no scripts, so the fixed name cannot
    // collide with anything it would have produced.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});

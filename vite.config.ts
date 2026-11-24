import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** Dev-only helper: serve local test logs from ULOG_DEV_DIR to the dev server (localhost) for UI testing. */
function devLogs(): PluginOption {
  const dir = process.env.ULOG_DEV_DIR;
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ulg|params)$/i.test(f) ? [p] : []; });
  return {
    name: 'dev-logs',
    apply: 'serve',
    configureServer(server) {
      if (!dir) return;
      server.middlewares.use('/__devlogs', (req, res) => {
        const files = walk(dir);
        const url = new URL(req.url ?? '/', 'http://x');
        const name = url.searchParams.get('name');
        if (!name) { res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*'); res.end(JSON.stringify(files.map((f) => basename(f)))); return; }
        const f = files.find((x) => basename(x) === name);
        if (!f) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('access-control-allow-origin', '*');
        res.end(readFileSync(f));
      });
    },
  };
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Modes:
//   (default)  -> dist/         used by the Tauri desktop build
//   web        -> dist-web/     installable offline PWA (service worker precaches everything)
//   single     -> dist-single/  one self-contained HTML file that works from file:// without any server
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react(), devLogs()];
  if (mode === 'web') {
    plugins.push(VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // new versions activate right away (used from the next reload) instead of waiting for every tab to close
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'], maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, skipWaiting: true, clientsClaim: true },
      manifest: {
        name: 'ULog Studio', short_name: 'ULog Studio', description: 'Offline PX4 flight log analysis',
        theme_color: '#0f6cbd', background_color: '#fafafa', display: 'standalone',
        icons: [{ src: 'icon-256.png', sizes: '256x256', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
        file_handlers: [{ action: './', accept: { 'application/octet-stream': ['.ulg'] } }],
      },
    }));
  }
  if (mode === 'single') plugins.push(viteSingleFile({ removeViteModuleLoader: true }));
  return {
    base: './',
    plugins,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TARGET__: JSON.stringify(mode === 'web' ? 'pwa' : mode === 'single' ? 'single' : 'desktop'),
    },
    worker: { format: 'iife' },
    clearScreen: false,
    server: { port: 5173, strictPort: true },
    build: {
      outDir: mode === 'web' ? 'dist-web' : mode === 'single' ? 'dist-single' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 4000,
      assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
    },
  };
});

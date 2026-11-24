import { BUILD_TARGET } from './platform';

/** Register the service worker in the PWA build only (desktop and single-file builds need none). */
export function registerServiceWorker() {
  if (BUILD_TARGET !== 'pwa' || !('serviceWorker' in navigator) || location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            // a new version is cached; it activates on the next start (no interruption while analysing)
            console.info('ULog Studio: update downloaded, it will be used next time the app is opened.');
          }
        });
      });
    }).catch((e) => console.warn('Service worker registration failed', e));
  });
  // file handling API (installed PWA "Open with")
  const lq = (window as unknown as { launchQueue?: { setConsumer: (f: (p: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    const { openFiles } = await import('./store');
    const files = await Promise.all(params.files.map(async (h) => { const f = await h.getFile(); return { name: f.name, data: await f.arrayBuffer() }; }));
    await openFiles(files);
  });
}

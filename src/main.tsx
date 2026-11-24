import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import { App } from './app/App';
import { registerServiceWorker } from './app/pwa';
import iconUrl from './assets/icon.svg';

const fav = document.querySelector<HTMLLinkElement>('link[rel=icon]');
if (fav) fav.href = iconUrl;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();

// Dev-only: ?devlogs=substring loads matching test logs served by the dev server (see vite.config devLogs)
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search).get('devlogs');
  if (q !== null) {
    void (async () => {
      const { openFiles } = await import('./app/store');
      const names: string[] = await (await fetch('/__devlogs')).json();
      const pick = names.filter((n) => q.split(',').some((p) => n.includes(p)));
      await openFiles(pick.map((n) => ({ name: n, data: async () => (await fetch(`/__devlogs?name=${encodeURIComponent(n)}`)).arrayBuffer() })));
    })();
  }
}

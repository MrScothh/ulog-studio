/** Minimal global store (useSyncExternalStore) for loaded logs, navigation and theme. */
import { useSyncExternalStore } from 'react';
import type { LogSummary, PageSpec } from '../core/types';
import * as Comlink from 'comlink';
import { engine } from './engineClient';
import { prefs } from './prefs';

export type PageKey = 'overview' | 'tracking' | 'actuators' | 'vibration' | 'filters' | 'rateloop' | 'power' | 'sensors' | 'system' | 'params' | 'messages' | 'explorer' | 'compare' | 'pdiff';
export type ThemePref = 'system' | 'light' | 'dark';

export interface LoadingItem { name: string; error?: string }
export interface State {
  logs: LogSummary[];
  activeId?: string;
  page: PageKey;
  theme: ThemePref;
  loading: LoadingItem[];
  paramFiles: { name: string; count: number }[];
  showParamChanges: boolean;
  navOpen: boolean;
}

let state: State = {
  logs: [], page: 'overview', theme: prefs.get<ThemePref>('theme', 'system'), loading: [], paramFiles: [], showParamChanges: true,
  navOpen: prefs.get('navOpen', true),
};
const listeners = new Set<() => void>();
function set(p: Partial<State>) { state = { ...state, ...p }; listeners.forEach((l) => l()); }

export const store = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  set,
};

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state));
}

let seq = 0;
const pageCache = new Map<string, Promise<PageSpec>>();

export async function openFiles(files: { name: string; data: ArrayBuffer | (() => Promise<ArrayBuffer>) }[]) {
  const ulgs = files.filter((f) => /\.ulg$/i.test(f.name));
  const params = files.filter((f) => /\.params$/i.test(f.name) || /\.txt$/i.test(f.name));
  for (const p of params) {
    const buf = typeof p.data === 'function' ? await p.data() : p.data;
    const r = await engine().addParamsFile(p.name, new TextDecoder().decode(buf));
    set({ paramFiles: [...state.paramFiles.filter((x) => x.name !== r.name), r] });
  }
  if (!ulgs.length) { if (params.length) set({ page: 'pdiff' }); return; }
  set({ loading: [...state.loading, ...ulgs.map((u) => ({ name: u.name }))] });
  await Promise.all(ulgs.map(async (f) => {
    const id = `log${++seq}`;
    try {
      const buf = typeof f.data === 'function' ? await f.data() : f.data;
      const s = await engine().open(id, f.name, Comlink.transfer(buf, [buf]));
      set({ logs: [...state.logs, s].sort((a, b) => (a.utcStart ?? 0) - (b.utcStart ?? 0) || a.fileName.localeCompare(b.fileName)), activeId: state.activeId ?? id });
      set({ loading: state.loading.filter((l) => l.name !== f.name) });
    } catch (e) {
      set({ loading: state.loading.map((l) => (l.name === f.name ? { ...l, error: String((e as Error).message ?? e) } : l)) });
    }
  }));
  const last = state.logs[state.logs.length - 1];
  if (ulgs.length === 1 && last && !state.activeId) set({ activeId: last.id });
}

export function closeLog(id: string) {
  void engine().close(id);
  for (const k of [...pageCache.keys()]) if (k.startsWith(`${id}:`)) pageCache.delete(k);
  const logs = state.logs.filter((l) => l.id !== id);
  set({ logs, activeId: state.activeId === id ? logs[0]?.id : state.activeId });
}

export function dismissLoading(name: string) { set({ loading: state.loading.filter((l) => l.name !== name) }); }

export function getPage(id: string, page: PageKey): Promise<PageSpec> {
  const key = `${id}:${page}`;
  let p = pageCache.get(key);
  if (!p) {
    p = engine().page(id, page as never);
    pageCache.set(key, p);
    p.catch(() => pageCache.delete(key));
  }
  return p;
}

export function setTheme(t: ThemePref) { prefs.set('theme', t); set({ theme: t }); }
export function setNavOpen(v: boolean) { prefs.set('navOpen', v); set({ navOpen: v }); }

/** Per-viewer UI conveniences in localStorage (always optional: the app works without storage). */
const KEY = 'ulog-studio:prefs';

function load(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}

export const prefs = {
  get<T>(k: string, def: T): T {
    const v = load()[k];
    return v === undefined ? def : (v as T);
  },
  set(k: string, v: unknown) {
    try { const all = load(); all[k] = v; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  },
};

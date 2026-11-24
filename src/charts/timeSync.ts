/** Shared time range (zoom) per log, so every time plot zooms together. */
import { useSyncExternalStore } from 'react';

type Range = [number, number] | null;
const ranges = new Map<string, Range>();
const listeners = new Map<string, Set<() => void>>();

export const timeSync = {
  get(logId: string): Range { return ranges.get(logId) ?? null; },
  set(logId: string, r: Range) {
    const cur = ranges.get(logId) ?? null;
    if (cur === r || (cur && r && Math.abs(cur[0] - r[0]) < 1e-9 && Math.abs(cur[1] - r[1]) < 1e-9)) return;
    ranges.set(logId, r);
    listeners.get(logId)?.forEach((l) => l());
  },
  subscribe(logId: string, l: () => void) {
    let s = listeners.get(logId);
    if (!s) { s = new Set(); listeners.set(logId, s); }
    s.add(l);
    return () => { s!.delete(l); };
  },
};

export function useTimeRange(logId: string): Range {
  return useSyncExternalStore((l) => timeSync.subscribe(logId, l), () => timeSync.get(logId));
}

/** Cursor position shared across plots (seconds), for the mode timeline & readouts. */
let cursorT: number | null = null;
let cursorSrc: 'plot' | 'ext' = 'plot';
const cursorListeners = new Set<() => void>();
export const cursorSync = {
  get: () => cursorT,
  /** 'plot' = set by a uPlot chart (charts sync natively); 'ext' = map, XY view or timeline (charts follow). */
  source: () => cursorSrc,
  set(t: number | null, src: 'plot' | 'ext' = 'plot') { if (t !== cursorT || src !== cursorSrc) { cursorT = t; cursorSrc = src; cursorListeners.forEach((l) => l()); } },
  subscribe(l: () => void) { cursorListeners.add(l); return () => { cursorListeners.delete(l); }; },
};
export function useCursorT(): number | null {
  return useSyncExternalStore(cursorSync.subscribe, cursorSync.get);
}

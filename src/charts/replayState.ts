/** Shared replay state: whether a flight replay is running and whether the map follows the drone. */
import { useSyncExternalStore } from 'react';

let state = { playing: false, follow: true };
const listeners = new Set<() => void>();

export const replayState = {
  get: () => state,
  set(p: Partial<typeof state>) { state = { ...state, ...p }; listeners.forEach((l) => l()); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function useReplayState() {
  return useSyncExternalStore(replayState.subscribe, replayState.get);
}

/** Linear interpolation helper on a sorted time vector; returns [index, fraction]. */
export function locate(t: ArrayLike<number>, v: number): [number, number] {
  let lo = 0, hi = t.length - 1;
  if (v <= t[0]) return [0, 0];
  if (v >= t[hi]) return [hi, 0];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= v) lo = m; else hi = m; }
  const d = t[hi] - t[lo];
  return [lo, d > 0 ? (v - t[lo]) / d : 0];
}

export function lerp(a: ArrayLike<number>, i: number, f: number): number {
  return f > 0 && i + 1 < a.length ? a[i] + (a[i + 1] - a[i]) * f : a[i];
}

/** Interpolate an angle in degrees across the ±180 wrap. */
export function lerpDeg(a: ArrayLike<number>, i: number, f: number): number {
  if (!(f > 0) || i + 1 >= a.length) return a[i];
  let d = a[i + 1] - a[i];
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a[i] + d * f;
}

/** Min/max decimation of several independently-sampled series, joined on a common x axis for uPlot. */
import type { Num } from '../core/types';

function lb(a: Num, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** Returns [x, y] arrays with at most ~2*buckets points (min & max per bucket, in time order). */
export function decimateSeries(t: Num, y: Num, t0: number, t1: number, buckets: number): [number[], (number | null)[]] {
  const i0 = Math.max(0, lb(t, t0) - 1), i1 = Math.min(t.length, lb(t, t1) + 1);
  const n = i1 - i0;
  const xs: number[] = [], ys: (number | null)[] = [];
  if (n <= 0) return [xs, ys];
  if (n <= buckets * 2) {
    for (let i = i0; i < i1; i++) { xs.push(t[i]); const v = y[i]; ys.push(v === v ? v : null); }
    return [xs, ys];
  }
  const span = (t1 - t0) / buckets;
  let i = i0;
  // keep the sample just before the window for continuity
  xs.push(t[i]); ys.push(y[i] === y[i] ? y[i] : null); i++;
  for (let b = 0; b < buckets && i < i1; b++) {
    const end = t0 + (b + 1) * span;
    let mn = Infinity, mx = -Infinity, imn = -1, imx = -1;
    while (i < i1 && t[i] < end) {
      const v = y[i];
      if (v === v) { if (v < mn) { mn = v; imn = i; } if (v > mx) { mx = v; imx = i; } }
      i++;
    }
    if (imn < 0) continue;
    if (imn === imx) { xs.push(t[imn]); ys.push(mn); }
    else if (imn < imx) { xs.push(t[imn], t[imx]); ys.push(mn, mx); }
    else { xs.push(t[imx], t[imn]); ys.push(mx, mn); }
  }
  while (i < i1) { xs.push(t[i]); ys.push(y[i] === y[i] ? y[i] : null); i++; }
  return [xs, ys];
}

/** Join several (x,y) series into uPlot's aligned format (union of x, null gaps). */
export function joinSeries(parts: [number[], (number | null)[]][]): (number | null)[][] {
  const k = parts.length;
  const idx = new Array(k).fill(0);
  const X: number[] = [];
  const Y: (number | null)[][] = parts.map(() => []);
  for (;;) {
    let mn = Infinity;
    for (let s = 0; s < k; s++) { const xs = parts[s][0]; if (idx[s] < xs.length && xs[idx[s]] < mn) mn = xs[idx[s]]; }
    if (mn === Infinity) break;
    X.push(mn);
    for (let s = 0; s < k; s++) {
      const xs = parts[s][0];
      if (idx[s] < xs.length && xs[idx[s]] === mn) { Y[s].push(parts[s][1][idx[s]]); idx[s]++; }
      else Y[s].push(undefined as unknown as null);
    }
  }
  return [X, ...Y];
}

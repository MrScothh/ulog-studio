import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

/** Observe the width of a container (debounced to animation frames). */
export function useWidth(ref: React.RefObject<HTMLElement | null>, fixed?: number): number {
  const [w, setW] = useState(fixed ?? 0);
  useEffect(() => {
    if (fixed) return;
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setW(Math.floor(entries[0].contentRect.width)));
    });
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [ref, fixed]);
  return w;
}

/** Create/destroy a uPlot instance when `deps` change; keep it sized to `width`. */
export function useUplotInstance(
  target: React.RefObject<HTMLDivElement | null>,
  make: (width: number) => { opts: uPlot.Options; data: uPlot.AlignedData } | undefined,
  width: number,
  height: number,
  deps: unknown[],
): React.RefObject<uPlot | null> {
  const plot = useRef<uPlot | null>(null);
  useEffect(() => {
    if (!target.current || width < 50) return;
    const m = make(width);
    if (!m) return;
    const u = new uPlot({ ...m.opts, width, height }, m.data, target.current);
    plot.current = u;
    return () => { u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, width > 50]);
  useEffect(() => {
    if (plot.current && width > 50) plot.current.setSize({ width, height });
  }, [width, height]);
  return plot;
}

/** Wheel zoom on the x scale around the cursor (Ctrl/plain wheel), calling onRange. */
export function wheelZoomPlugin(onRange: (min: number, max: number) => void, limits: () => [number, number]): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener('wheel', (e) => {
          if (!e.ctrlKey && !e.shiftKey) return; // keep page scrolling with the plain wheel
          e.preventDefault();
          const { left } = u.cursor;
          if (left == null || left < 0) return;
          const xVal = u.posToVal(left, 'x');
          const min = u.scales.x.min!, max = u.scales.x.max!;
          const f = e.deltaY < 0 ? 0.75 : 1 / 0.75;
          let nmin = xVal - (xVal - min) * f, nmax = xVal + (max - xVal) * f;
          const [lo, hi] = limits();
          if (nmax - nmin >= hi - lo) { nmin = lo; nmax = hi; }
          onRange(Math.max(lo, nmin), Math.min(hi, nmax));
        }, { passive: false });
      },
    },
  };
}

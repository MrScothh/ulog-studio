import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { XYPlotSpec } from '../core/types';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { axisCommon, seriesColor, fmtTime } from './theme';
import { useWidth } from './useUplot';
import { cursorSync, useCursorT } from './timeSync';
import { saveCanvasPng } from '../app/platform';

/** Draw a parametric series in sample order (uPlot's linear builder assumes x sorted and bins by pixel column). */
const orderedPath = (u: uPlot, si: number) => {
  const [xs, ys] = u.data[si] as unknown as [number[], number[]];
  const p = new Path2D();
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const x = u.valToPos(xs[i], 'x', true), y = u.valToPos(ys[i], 'y', true);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; continue; }
    if (pen) p.lineTo(x, y); else { p.moveTo(x, y); pen = true; }
  }
  return { stroke: p, fill: null, clip: null, band: null, gaps: null, flags: 0 } as unknown as uPlot.Series.Paths;
};

/**
 * Parametric x/y plot (uPlot mode 2) with optional equal aspect ratio.
 * When the first series carries time, hovering it moves the flight cursor and the cursor time is shown as a marker.
 */
export function XYPlot({ spec }: { spec: XYPlotSpec }) {
  const ctx = useChartCtx();
  const outer = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLDivElement>(null);
  const width = useWidth(outer, ctx.staticWidth);
  const plot = useRef<uPlot | null>(null);
  const pts = useRef<{ x: number[]; y: number[]; t: number[] } | null>(null);
  const height = spec.height ?? 320;
  const cur = useCursorT();

  useEffect(() => {
    if (!target.current || width < 60) return;
    const t = ctx.theme;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of spec.series) for (let i = 0; i < s.x.length; i++) {
      const a = s.x[i], b = s.y[i];
      if (a === a && b === b) { if (a < xmin) xmin = a; if (a > xmax) xmax = a; if (b < ymin) ymin = b; if (b > ymax) ymax = b; }
    }
    const pad = 0.05;
    const equalRange = (u: uPlot, axis: 'x' | 'y'): [number, number] => {
      const w = u.bbox.width || width, h = u.bbox.height || height;
      let cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
      let sx = (xmax - xmin) * (1 + pad) || 1, sy = (ymax - ymin) * (1 + pad) || 1;
      if (spec.equal) {
        const k = Math.max(sx / w, sy / h);
        sx = k * w; sy = k * h;
      }
      if (!isFinite(cx)) cx = 0;
      if (!isFinite(cy)) cy = 0;
      return axis === 'x' ? [cx - sx / 2, cx + sx / 2] : [cy - sy / 2, cy + sy / 2];
    };
    const step = (n: number) => Math.max(1, Math.floor(n / 20000));
    const data: uPlot.AlignedData = [null as unknown as number[], ...spec.series.map((s, si) => {
      const k = step(s.x.length);
      const xs: number[] = [], ys: number[] = [], ts: number[] = [];
      for (let i = 0; i < s.x.length; i += k) { xs.push(s.x[i]); ys.push(s.y[i]); if (s.t) ts.push(s.t[i]); }
      if (si === 0 && s.t) pts.current = { x: xs, y: ys, t: ts };
      return [xs, ys] as unknown as number[];
    })] as unknown as uPlot.AlignedData;
    const opts: uPlot.Options = {
      mode: 2,
      width, height,
      padding: [8, 12, 0, 0],
      scales: { x: { time: false, auto: false, range: (u) => equalRange(u, 'x') }, y: { auto: false, range: (u) => equalRange(u, 'y') } },
      axes: [
        { ...axisCommon(t), size: 32, label: spec.xLabel, labelSize: 14, labelGap: 0 },
        { ...axisCommon(t), size: 58, label: spec.yLabel, labelSize: 16, labelGap: 2 },
      ],
      series: [
        {},
        ...spec.series.map((s) => {
          const c = seriesColor(t, s.color);
          return { label: s.label, stroke: c, width: 1.6, dash: s.dash ? [6, 4] : undefined, points: { show: !!s.points, size: 4, fill: c }, paths: s.points ? () => null : orderedPath, facets: [{ scale: 'x', auto: false }, { scale: 'y', auto: false }] } as uPlot.Series;
        }),
      ],
      cursor: { drag: { x: false, y: false }, points: { show: false }, x: false, y: false },
      legend: { show: true, live: false },
    };
    const u = new uPlot(opts, data, target.current);
    plot.current = u;
    // hover → nearest point of the trajectory → flight cursor
    const onMove = (e: MouseEvent) => {
      const p = pts.current;
      if (!p) return;
      const r = u.over.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = -1, bd = 24 * 24;
      for (let i = 0; i < p.x.length; i++) {
        const dx = u.valToPos(p.x[i], 'x') - mx, dy = u.valToPos(p.y[i], 'y') - my;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      cursorSync.set(best >= 0 ? p.t[best] : null, 'ext');
    };
    const onLeave = () => cursorSync.set(null, 'ext');
    u.over.addEventListener('mousemove', onMove);
    u.over.addEventListener('mouseleave', onLeave);
    const unreg = ctx.register?.(spec.id, spec.title, () => u.ctx.canvas.toDataURL('image/png'));
    return () => { unreg?.(); u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, ctx.theme, width > 60]);

  useEffect(() => { if (plot.current && width > 60) { plot.current.setSize({ width, height }); plot.current.redraw(true, true); } }, [width, height]);

  // marker at the cursor time
  useEffect(() => {
    const u = plot.current, p = pts.current, m = marker.current;
    if (!m) return;
    if (!u || !p || cur == null || !p.t.length || cur < p.t[0] || cur > p.t[p.t.length - 1]) { m.style.display = 'none'; return; }
    let lo = 0, hi = p.t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.t[mid] < cur) lo = mid; else hi = mid; }
    const over = u.over.getBoundingClientRect(), host = target.current!.getBoundingClientRect();
    m.style.display = 'block';
    m.style.left = `${over.left - host.left + u.valToPos(p.x[lo], 'x')}px`;
    m.style.top = `${over.top - host.top + u.valToPos(p.y[lo], 'y')}px`;
    m.title = fmtTime(p.t[lo]);
  }, [cur]);

  return (
    <ChartFrame title={spec.title} note={spec.note} onSavePng={() => plot.current && saveCanvasPng(plot.current.ctx.canvas, `${spec.id}.png`)} bodyRef={outer}>
      <div style={{ position: 'relative' }}>
        <div ref={target} className="uplot-host" style={{ minHeight: height }} />
        <div ref={marker} className="xy-marker" style={{ display: 'none' }} />
      </div>
    </ChartFrame>
  );
}

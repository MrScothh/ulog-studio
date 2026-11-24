import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { FreqPlotSpec } from '../core/types';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { axisCommon, seriesColor, withAlpha, tickFormatter } from './theme';
import { useWidth } from './useUplot';
import { saveCanvasPng, saveCsv } from '../app/platform';

const logTick = (_u: unknown, ticks: number[]) => ticks.map((v) => {
  if (v == null || !isFinite(v) || v <= 0) return '';
  const e = Math.floor(Math.log10(v) + 1e-9);
  const m = v / 10 ** e;
  if (e >= -2 && e <= 3) return String(+v.toPrecision(2));
  return Math.abs(m - 1) < 1e-6 ? `1e${e}` : `${+m.toFixed(1)}e${e}`;
});

const fmt = (v: number | null | undefined) => {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  return a === 0 ? '0' : a >= 1000 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.01 ? v.toFixed(3) : v.toExponential(2);
};

/** Line plot on a shared x axis (frequency, time-lag, …), optional log axes, vertical/horizontal markers. */
export function FreqPlot({ spec }: { spec: FreqPlotSpec }) {
  const ctx = useChartCtx();
  const outer = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const width = useWidth(outer, ctx.staticWidth);
  const plot = useRef<uPlot | null>(null);
  const height = spec.height ?? 260;

  useEffect(() => {
    if (!target.current || width < 60) return;
    const t = ctx.theme;
    let x = Array.from(spec.x);
    const keep: number[] = [];
    for (let i = 0; i < x.length; i++) {
      if (spec.logX && x[i] <= 0) continue;
      if (spec.xRange && (x[i] < spec.xRange[0] - 1e-9 || x[i] > spec.xRange[1] + 1e-9)) continue;
      keep.push(i);
    }
    x = keep.map((i) => spec.x[i]);
    const ys = spec.series.map((s) => keep.map((i) => { const v = s.y[i]; return v === v && (!spec.logY || v > 0) ? v : null; }));
    const data = [x, ...ys] as uPlot.AlignedData;
    const opts: uPlot.Options = {
      width, height,
      padding: [8, 12, 0, 0],
      scales: {
        x: { time: false, distr: spec.logX ? 3 : 1, ...(spec.xRange ? { auto: false, range: spec.xRange } : {}) },
        y: { distr: spec.logY ? 3 : 1, ...(spec.yRange ? { auto: false, range: spec.yRange } : {}) },
      },
      axes: [
        { ...axisCommon(t), size: 32, label: spec.xLabel, labelSize: spec.xLabel ? 14 : 0, labelGap: 0, values: spec.logX ? logTick : tickFormatter },
        { ...axisCommon(t), size: 62, label: spec.yLabel, labelSize: spec.yLabel ? 16 : 0, labelGap: 2, values: spec.logY ? logTick : tickFormatter },
      ],
      series: [
        { label: spec.xLabel ?? 'x', value: (_u, v) => fmt(v) },
        ...spec.series.map((s) => {
          const c = seriesColor(t, s.color);
          const o: uPlot.Series = { label: s.label, stroke: c, width: s.width ?? 1.5, points: { show: false }, value: (_u: uPlot, v: number | null) => fmt(v) };
          if (s.dash) o.dash = [6, 4];
          if (s.points) { o.paths = () => null; o.points = { show: true, size: 6, width: 1, stroke: c, fill: withAlpha(c, 0.35) }; }
          return o;
        }),
      ],
      cursor: { drag: { x: true, y: false, setScale: true }, points: { size: 6 } },
      legend: { show: true, live: true },
      hooks: {
        draw: [(u) => {
          const c = u.ctx;
          const { top, height: h, left, width: w } = u.bbox;
          c.save();
          c.font = t.font.replace('12px', `${Math.round(11 * devicePixelRatio)}px`);
          c.lineWidth = Math.max(1, devicePixelRatio);
          for (const b of spec.bands ?? []) {
            const x0 = u.valToPos(b.x0, 'x', true), x1 = u.valToPos(b.x1, 'x', true);
            c.fillStyle = withAlpha(seriesColor(t, b.color ?? 3), 0.12);
            c.fillRect(x0, top, x1 - x0, h);
          }
          let lastPx = -1e9, row = 0;
          for (const m of [...(spec.marks ?? [])].sort((a, b) => a.x - b.x)) {
            const px = u.valToPos(m.x, 'x', true);
            if (px < left || px > left + w) continue;
            row = px - lastPx < 48 * devicePixelRatio ? row + 1 : 0;
            lastPx = px;
            c.strokeStyle = withAlpha(t.dark ? '#ffffff' : '#000000', 0.5);
            c.setLineDash([4, 4]);
            c.beginPath(); c.moveTo(px, top); c.lineTo(px, top + h); c.stroke();
            c.setLineDash([]);
            c.fillStyle = t.textMuted;
            c.fillText(m.label, px + 4 * devicePixelRatio, top + (12 + 13 * row) * devicePixelRatio);
          }
          for (const m of spec.hmarks ?? []) {
            const py = u.valToPos(m.y, 'y', true);
            if (py < top || py > top + h) continue;
            c.strokeStyle = withAlpha(t.dark ? '#ffffff' : '#000000', 0.45);
            c.setLineDash([4, 4]);
            c.beginPath(); c.moveTo(left, py); c.lineTo(left + w, py); c.stroke();
            c.setLineDash([]);
            c.fillStyle = t.textMuted;
            c.fillText(m.label, left + w - c.measureText(m.label).width - 4 * devicePixelRatio, py - 4 * devicePixelRatio);
          }
          c.restore();
        }],
      },
    };
    const u = new uPlot(opts, data, target.current);
    plot.current = u;
    const unreg = ctx.register?.(spec.id, spec.title, () => u.ctx.canvas.toDataURL('image/png'));
    return () => { unreg?.(); u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, ctx.theme, width > 60]);

  useEffect(() => { if (plot.current && width > 60) plot.current.setSize({ width, height }); }, [width, height]);

  const onCsv = () => {
    const head = ['x', ...spec.series.map((s) => `"${s.label}"`)].join(',');
    const rows = Array.from(spec.x, (x, i) => [x, ...spec.series.map((s) => s.y[i])].join(','));
    saveCsv([head, ...rows].join('\n'), `${spec.id}.csv`);
  };
  const reset = () => { const u = plot.current; if (u) { u.setData(u.data, true); } };
  return (
    <ChartFrame title={spec.title} note={spec.note} onResetZoom={reset} onSavePng={() => plot.current && saveCanvasPng(plot.current.ctx.canvas, `${spec.id}.png`)} onSaveCsv={onCsv} bodyRef={outer}>
      <div ref={target} className="uplot-host" style={{ minHeight: height }} />
    </ChartFrame>
  );
}

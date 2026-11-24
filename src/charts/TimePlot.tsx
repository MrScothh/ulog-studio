import { useEffect, useRef, useCallback } from 'react';
import uPlot from 'uplot';
import type { TimePlotSpec } from '../core/types';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { axisCommon, seriesColor, fmtTime, withAlpha, tickFormatter } from './theme';
import { decimateSeries, joinSeries } from './decimate';
import { timeSync, useTimeRange, cursorSync } from './timeSync';
import { useWidth, wheelZoomPlugin } from './useUplot';
import { saveCanvasPng, saveCsv } from '../app/platform';

function fmtVal(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

export function TimePlot({ spec }: { spec: TimePlotSpec }) {
  const ctx = useChartCtx();
  const outer = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const width = useWidth(outer, ctx.staticWidth);
  const range = useTimeRange(ctx.logId);
  const plot = useRef<uPlot | null>(null);
  const rangeRef = useRef<[number, number]>(range ?? [0, ctx.duration]);
  const height = spec.height ?? 240;

  const buildData = useCallback((r: [number, number], w: number): uPlot.AlignedData => {
    const buckets = Math.max(100, Math.floor(w * 1.2));
    const parts = spec.series.map((s) => decimateSeries(s.t, s.y, r[0], r[1], buckets));
    return joinSeries(parts) as uPlot.AlignedData;
  }, [spec]);

  // create
  useEffect(() => {
    if (!target.current || width < 60) return;
    const t = ctx.theme;
    const r = rangeRef.current;
    const opts: uPlot.Options = {
      width, height,
      padding: [8, 8, 0, 0],
      scales: {
        x: { time: false, auto: false, range: () => rangeRef.current },
        y: spec.yRange ? { auto: false, range: spec.yRange } : { auto: true },
      },
      axes: [
        { ...axisCommon(t), values: (_u, ticks) => ticks.map(fmtTime), size: 30 },
        { ...axisCommon(t), size: 58, label: spec.yLabel, labelSize: spec.yLabel ? 16 : 0, labelGap: 2, values: tickFormatter },
      ],
      series: [
        { label: 'Time', value: (_u, v) => (v == null ? '–' : fmtTime(v)) },
        ...spec.series.map((s) => {
          const c = seriesColor(t, s.color);
          const base: uPlot.Series = {
            label: s.label, stroke: c, width: s.width ?? 1.4, spanGaps: false,
            value: (_u: uPlot, v: number | null) => fmtVal(v),
            points: { show: false },
          };
          if (s.dash) base.dash = [6, 4];
          if (s.step) base.paths = uPlot.paths.stepped!({ align: 1 });
          if (s.points) { base.paths = () => null; base.points = { show: true, size: 5, fill: c, stroke: c }; }
          return base;
        }),
      ],
      cursor: {
        sync: { key: `time-${ctx.logId}`, setSeries: false, scales: ['x', null] },
        drag: { x: true, y: false, setScale: false },
        points: { size: 6 },
        bind: { dblclick: () => null },
      },
      legend: { show: true, live: true },
      hooks: {
        setSelect: [(u) => {
          if (u.select.width > 4) {
            const min = u.posToVal(u.select.left, 'x'), max = u.posToVal(u.select.left + u.select.width, 'x');
            timeSync.set(ctx.logId, [min, max]);
          }
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        }],
        setCursor: [(u) => {
          const i = u.cursor.idx;
          u.root.classList.toggle('u-idle', i == null);
          cursorSync.set(i != null ? (u.data[0][i] as number) : null);
        }],
        drawClear: [(u) => {
          if (spec.noModes) return;
          const c = u.ctx;
          const { top, height: h, left, width: w } = u.bbox;
          c.save();
          c.beginPath(); c.rect(left, top, w, h); c.clip();
          for (const m of ctx.modes) {
            const x0 = u.valToPos(m.t0, 'x', true), x1 = u.valToPos(m.t1, 'x', true);
            if (x1 < left || x0 > left + w) continue;
            c.fillStyle = withAlpha(m.color, t.modeAlpha);
            c.fillRect(x0, top, x1 - x0, h);
          }
          c.restore();
        }],
        draw: [(u) => {
          if (!ctx.showParamChanges || !ctx.paramChanges.length) return;
          const c = u.ctx;
          const { top, height: h } = u.bbox;
          c.save();
          c.strokeStyle = withAlpha(t.dark ? '#ffffff' : '#000000', 0.45);
          c.setLineDash([3, 3]);
          c.lineWidth = 1;
          for (const p of ctx.paramChanges) {
            const x = u.valToPos(p.t, 'x', true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
            c.beginPath(); c.moveTo(x, top); c.lineTo(x, top + h); c.stroke();
          }
          c.restore();
        }],
      },
      plugins: [wheelZoomPlugin((a, b) => timeSync.set(ctx.logId, [a, b]), () => [0, ctx.duration])],
    };
    const u = new uPlot(opts, buildData(r, width), target.current);
    u.root.classList.add('u-idle');
    u.over.addEventListener('dblclick', () => timeSync.set(ctx.logId, null));
    plot.current = u;
    const unreg = ctx.register?.(spec.id, spec.title, () => u.ctx.canvas.toDataURL('image/png'));
    return () => { unreg?.(); u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, ctx.theme, ctx.modes, ctx.showParamChanges, width > 60]);

  // resize
  useEffect(() => { if (plot.current && width > 60) { plot.current.setSize({ width, height }); plot.current.setData(buildData(rangeRef.current, width), true); } }, [width, height, buildData]);

  // range changes
  useEffect(() => {
    const r: [number, number] = range ?? [Math.min(0, ...spec.series.map((s) => s.t[0] ?? 0)), ctx.duration];
    rangeRef.current = r;
    const u = plot.current;
    if (u) u.setData(buildData(r, u.width), true);
  }, [range, buildData, ctx.duration, spec]);

  // follow the cursor driven by the timeline, the map or the XY view (no re-broadcast)
  useEffect(() => cursorSync.subscribe(() => {
    if (cursorSync.source() !== 'ext') return;
    const u = plot.current;
    if (!u) return;
    const t = cursorSync.get();
    const inside = t != null && t >= (u.scales.x.min ?? 0) && t <= (u.scales.x.max ?? 0);
    u.root.classList.toggle('u-idle', !inside);
    (u.setCursor as (o: { left: number; top: number }, fire?: boolean, pub?: boolean) => void)(inside ? { left: u.valToPos(t!, 'x'), top: u.bbox.height / devicePixelRatio / 2 } : { left: -10, top: -10 }, false, false);
  }), []);

  const onPng = () => plot.current && saveCanvasPng(plot.current.ctx.canvas, `${spec.id}.png`);
  const onCsv = () => {
    const r = rangeRef.current;
    const lines = ['series,time_s,value'];
    for (const s of spec.series) for (let i = 0; i < s.t.length; i++) if (s.t[i] >= r[0] && s.t[i] <= r[1]) lines.push(`"${s.label}",${s.t[i].toFixed(6)},${s.y[i]}`);
    saveCsv(lines.join('\n'), `${spec.id}.csv`);
  };

  return (
    <ChartFrame title={spec.title} note={spec.note} onResetZoom={range ? () => timeSync.set(ctx.logId, null) : undefined} onSavePng={onPng} onSaveCsv={onCsv} bodyRef={outer}>
      <div ref={target} className="uplot-host" style={{ minHeight: height }} />
    </ChartFrame>
  );
}

import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import { Caption1, tokens } from '@fluentui/react-components';
import type { SpectrogramSpec } from '../core/types';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { axisCommon, fmtTime, viridis, withAlpha } from './theme';
import { useWidth, wheelZoomPlugin } from './useUplot';
import { timeSync, useTimeRange, cursorSync } from './timeSync';
import { saveCanvasPng } from '../app/platform';

/** Time–frequency heatmap (dB), zoom-synchronised with the time plots. */
export function SpectrogramPlot({ spec }: { spec: SpectrogramSpec }) {
  const ctx = useChartCtx();
  const outer = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const width = useWidth(outer, ctx.staticWidth);
  const range = useTimeRange(ctx.logId);
  const rangeRef = useRef<[number, number]>(range ?? [0, ctx.duration]);
  const plot = useRef<uPlot | null>(null);
  const height = spec.height ?? 240;
  const { sg } = spec;
  // robust color limits: 2nd..99.5th percentile of finite values
  const [lo, hi] = useMemo(() => {
    const vals: number[] = [];
    const step = Math.max(1, Math.floor(sg.z.length / 50000));
    for (let i = 0; i < sg.z.length; i += step) if (sg.z[i] > -290) vals.push(sg.z[i]);
    vals.sort((a, b) => a - b);
    return [vals[Math.floor(vals.length * 0.02)] ?? sg.zmin, vals[Math.floor(vals.length * 0.995)] ?? sg.zmax];
  }, [sg]);
  const image = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = sg.nt; c.height = sg.nf;
    const g = c.getContext('2d')!;
    const img = g.createImageData(sg.nt, sg.nf);
    for (let ti = 0; ti < sg.nt; ti++) for (let fi = 0; fi < sg.nf; fi++) {
      const v = sg.z[ti * sg.nf + fi];
      const [r, gg, b] = viridis((v - lo) / (hi - lo || 1));
      const p = ((sg.nf - 1 - fi) * sg.nt + ti) * 4;
      img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = b; img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }, [sg, lo, hi]);

  useEffect(() => {
    if (!target.current || width < 60) return;
    const t = ctx.theme;
    const fmax = sg.f[sg.f.length - 1];
    const dtSeg = sg.nt > 1 ? (sg.t[sg.nt - 1] - sg.t[0]) / (sg.nt - 1) : 1;
    const opts: uPlot.Options = {
      width, height,
      padding: [8, 8, 0, 0],
      scales: { x: { time: false, auto: false, range: () => rangeRef.current }, y: { auto: false, range: [0, fmax] } },
      axes: [
        { ...axisCommon(t), values: (_u, ticks) => ticks.map(fmtTime), size: 30, grid: { show: false } },
        { ...axisCommon(t), size: 58, label: spec.yLabel ?? 'Hz', labelSize: 16, labelGap: 2, grid: { show: false } },
      ],
      series: [{}, { stroke: 'transparent', points: { show: false } }],
      cursor: { sync: { key: `time-${ctx.logId}`, setSeries: false, scales: ['x', null] }, drag: { x: true, y: false, setScale: false }, bind: { dblclick: () => null } },
      legend: { show: false },
      hooks: {
        setSelect: [(u) => {
          if (u.select.width > 4) timeSync.set(ctx.logId, [u.posToVal(u.select.left, 'x'), u.posToVal(u.select.left + u.select.width, 'x')]);
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        }],
        drawClear: [(u) => {
          const c = u.ctx;
          const { left, top, width: w, height: h } = u.bbox;
          c.save();
          c.beginPath(); c.rect(left, top, w, h); c.clip();
          c.imageSmoothingEnabled = false;
          const x0 = u.valToPos(sg.t[0] - dtSeg / 2, 'x', true), x1 = u.valToPos(sg.t[sg.nt - 1] + dtSeg / 2, 'x', true);
          const y0 = u.valToPos(fmax, 'y', true), y1 = u.valToPos(0, 'y', true);
          c.drawImage(image, x0, y0, x1 - x0, y1 - y0);
          for (const m of spec.marks ?? []) {
            const py = u.valToPos(m.y, 'y', true);
            c.strokeStyle = withAlpha('#ffffff', 0.7); c.setLineDash([4, 4]);
            c.beginPath(); c.moveTo(left, py); c.lineTo(left + w, py); c.stroke();
          }
          c.restore();
        }],
      },
      plugins: [wheelZoomPlugin((a, b) => timeSync.set(ctx.logId, [a, b]), () => [0, ctx.duration])],
    };
    const u = new uPlot(opts, [[sg.t[0], sg.t[sg.nt - 1]], [0, fmax]], target.current);
    u.over.addEventListener('dblclick', () => timeSync.set(ctx.logId, null));
    plot.current = u;
    const unreg = ctx.register?.(spec.id, spec.title, () => u.ctx.canvas.toDataURL('image/png'));
    return () => { unreg?.(); u.destroy(); plot.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, image, ctx.theme, width > 60]);

  useEffect(() => { if (plot.current && width > 60) plot.current.setSize({ width, height }); }, [width, height]);
  useEffect(() => {
    rangeRef.current = range ?? [0, ctx.duration];
    const u = plot.current;
    if (u) u.setScale('x', { min: rangeRef.current[0], max: rangeRef.current[1] });
  }, [range, ctx.duration]);

  useEffect(() => cursorSync.subscribe(() => {
    if (cursorSync.source() !== 'ext') return;
    const u = plot.current;
    if (!u) return;
    const t = cursorSync.get();
    const inside = t != null && t >= (u.scales.x.min ?? 0) && t <= (u.scales.x.max ?? 0);
    (u.setCursor as (o: { left: number; top: number }, fire?: boolean, pub?: boolean) => void)(inside ? { left: u.valToPos(t!, 'x'), top: u.bbox.height / devicePixelRatio / 2 } : { left: -10, top: -10 }, false, false);
  }), []);

  const legend = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{lo.toFixed(0)} dB</Caption1>
      <div style={{ width: 120, height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((x) => `rgb(${viridis(x).map(Math.round).join(',')})`).join(',')})` }} />
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{hi.toFixed(0)} dB</Caption1>
    </div>
  );
  return (
    <ChartFrame title={spec.title} note={spec.note} extra={legend} onResetZoom={range ? () => timeSync.set(ctx.logId, null) : undefined} onSavePng={() => plot.current && saveCanvasPng(plot.current.ctx.canvas, `${spec.id}.png`)} bodyRef={outer}>
      <div ref={target} className="uplot-host" style={{ minHeight: height }} />
    </ChartFrame>
  );
}

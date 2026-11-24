import { useRef } from 'react';
import { tokens } from '@fluentui/react-components';
import type { BarSpec } from '../core/types';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { useWidth } from './useUplot';

/** Horizontal-baseline bar chart (signed values centred on zero), direct value labels. */
export function BarChart({ spec }: { spec: BarSpec }) {
  const ctx = useChartCtx();
  const outer = useRef<HTMLDivElement>(null);
  const width = Math.max(200, useWidth(outer, ctx.staticWidth));
  const h = 220, padL = 44, padR = 12, padT = 16, padB = 28;
  const max = Math.max(1e-9, ...spec.values.map(Math.abs));
  const n = spec.values.length;
  const iw = width - padL - padR, ih = h - padT - padB;
  const band = iw / Math.max(1, n);
  const bw = Math.min(56, band * 0.56);
  const zero = spec.signed ? padT + ih / 2 : padT + ih;
  const scale = spec.signed ? ih / 2 / max : ih / max;
  const t = ctx.theme;
  const ticks = spec.signed ? [-max, -max / 2, 0, max / 2, max] : [0, max / 2, max];
  return (
    <ChartFrame title={spec.title} note={spec.note} bodyRef={outer}>
      <svg width={width} height={h} role="img" aria-label={spec.title} style={{ display: 'block' }}>
        {ticks.map((v, i) => {
          const y = zero - v * scale;
          return (
            <g key={i}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke={v === 0 ? t.axis : t.grid} />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={11} fill={t.textMuted}>{v.toFixed(Math.abs(max) < 10 ? 1 : 0)}{spec.unit ?? ''}</text>
            </g>
          );
        })}
        {spec.values.map((v, i) => {
          const cx = padL + band * i + band / 2;
          const y = v >= 0 ? zero - v * scale : zero;
          const hh = Math.max(1, Math.abs(v) * scale);
          const color = t.series[0];
          return (
            <g key={i}>
              <rect x={cx - bw / 2} y={y} width={bw} height={hh} rx={3} fill={color}><title>{`${spec.categories[i]}: ${v.toFixed(2)}${spec.unit ?? ''}`}</title></rect>
              <text x={cx} y={v >= 0 ? y - 4 : y + hh + 12} textAnchor="middle" fontSize={11} fill={t.text}>{`${v >= 0 && spec.signed ? '+' : ''}${v.toFixed(1)}${spec.unit ?? ''}`}</text>
              <text x={cx} y={h - 8} textAnchor="middle" fontSize={12} fill={t.textMuted} style={{ fontWeight: 600 }}>{spec.categories[i]}</text>
            </g>
          );
        })}
      </svg>
      <span style={{ display: 'none', color: tokens.colorNeutralForeground1 }} />
    </ChartFrame>
  );
}

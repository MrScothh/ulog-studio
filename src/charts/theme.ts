/** Chart palette (validated categorical palette, light & dark steps) and theme-aware uPlot styling. */
export const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

export interface ChartTheme {
  dark: boolean;
  series: string[];
  neutral: string;
  text: string;
  textMuted: string;
  grid: string;
  axis: string;
  surface: string;
  modeAlpha: number;
  font: string;
}

export function chartTheme(dark: boolean): ChartTheme {
  return {
    dark,
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    neutral: dark ? '#9a9a9a' : '#6b6b6b',
    text: dark ? '#e6e6e6' : '#242424',
    textMuted: dark ? '#adadad' : '#616161',
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    axis: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)',
    surface: dark ? '#292929' : '#ffffff',
    modeAlpha: dark ? 0.1 : 0.08,
    font: '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  };
}

export function seriesColor(t: ChartTheme, idx: number | undefined): string {
  if (idx === undefined) return t.series[0];
  if (idx < 0) return t.neutral;
  return t.series[idx % t.series.length];
}

export function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Viridis colormap (perceptually uniform) for spectrograms. */
const VIRIDIS = [
  [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141], [41, 120, 142], [32, 144, 140],
  [34, 167, 132], [68, 190, 112], [121, 209, 81], [189, 222, 38], [253, 231, 37],
];
export function viridis(x: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, x)) * (VIRIDIS.length - 1);
  const i = Math.floor(v), f = v - i;
  const a = VIRIDIS[i], b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function axisCommon(t: ChartTheme) {
  return {
    stroke: t.textMuted,
    font: t.font,
    labelFont: t.font,
    grid: { stroke: t.grid, width: 1 },
    ticks: { stroke: t.axis, width: 1, size: 4 },
  };
}

export function fmtTime(s: number): string {
  const neg = s < 0;
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const sec = a - m * 60;
  return `${neg ? '-' : ''}${m}:${sec < 10 ? '0' : ''}${sec.toFixed(sec % 1 === 0 ? 0 : 1)}`;
}

/** Axis tick labels with as many decimals as the tick step needs. */
export function tickFormatter(_u: unknown, ticks: number[]): string[] {
  if (ticks.length < 2) return ticks.map((v) => String(+v.toPrecision(6)));
  const step = Math.abs(ticks[1] - ticks[0]) || Math.abs(ticks[0]) || 1;
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return ticks.map((v) => {
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e6 || a < 1e-4)) return v.toExponential(1);
    return v.toFixed(dec);
  });
}

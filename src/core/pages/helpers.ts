import type { ULog, TopicData } from '../ulog';
import type { TimeSeries, TimePlotSpec, FreqPlotSpec, SpectrogramSpec, Mark } from '../types';
import { sampleRate, spectrogram, amplitudeSpectrum, median, diff } from '../dsp';

export const DEG = 180 / Math.PI;

export interface SerOpts {
  scale?: number;
  offset?: number;
  fn?: (v: number, i: number, d: TopicData) => number;
  step?: boolean;
  dash?: boolean;
  points?: boolean;
  sampleTime?: boolean;
  width?: number;
}

/** Build a time series from topic/field (returns undefined if missing or all NaN). */
export function ser(log: ULog, key: string, field: string | null, label: string, color: number, o: SerOpts = {}): TimeSeries | undefined {
  const d = log.topic(key);
  if (!d) return undefined;
  const src = field ? d.cols[field] : undefined;
  if (field && !src) return undefined;
  const y = new Float32Array(d.count);
  const sc = o.scale ?? 1, off = o.offset ?? 0;
  let valid = 0;
  for (let i = 0; i < d.count; i++) {
    const v = o.fn ? o.fn(src ? src[i] : NaN, i, d) : (src as Float64Array)[i] * sc + off;
    y[i] = v;
    if (v === v) valid++;
  }
  if (!valid) return undefined;
  const t = o.sampleTime ? log.sampleTime(key)! : d.t;
  return { label, t, y, color, step: o.step, dash: o.dash, points: o.points, width: o.width };
}

export function timePlot(id: string, title: string, series: (TimeSeries | undefined)[], extra: Partial<TimePlotSpec> = {}): TimePlotSpec | undefined {
  const s = series.filter((x): x is TimeSeries => !!x);
  if (!s.length) return undefined;
  return { kind: 'time', id, title, series: s, ...extra };
}

export function compact<T>(a: (T | undefined | null | false)[]): T[] {
  return a.filter((x): x is T => !!x);
}

/** Flight Review DataPlotFFT equivalent (whole-log amplitude spectrum, mean above 40 Hz in legend). */
export function fftPlot(log: ULog, id: string, title: string, key: string, fields: string[], labels: string[], marks: Mark[], opts: { yMax?: number } = {}): FreqPlotSpec | undefined {
  const d = log.topic(key);
  if (!d || fields.some((f) => !d.cols[f])) return undefined;
  const t = log.sampleTime(key)!;
  const fs = sampleRate(t);
  if (fs < 100 || !isFinite(fs)) return undefined;
  let x: Float64Array | undefined;
  const series = fields.map((f, i) => {
    const s = amplitudeSpectrum(d.cols[f], fs);
    x = s.f;
    let acc = 0, k = 0;
    for (let j = 0; j < s.f.length; j++) if (s.f[j] >= 40) { acc += s.p[j]; k++; }
    const m = k ? acc / k : 0;
    return { label: `${labels[i]} (mean above 40 Hz: ${m.toFixed(2)})`, y: Float32Array.from(s.p), color: i };
  });
  return {
    kind: 'freq', id, title, xLabel: 'Hz', yLabel: 'amplitude', x: x!, series, marks: marks.filter((m) => m.x > 0),
    yRange: [0, opts.yMax ?? 0.01], xRange: [0, fs / 2],
    note: `Sample rate ${fs.toFixed(0)} Hz (median), whole log`,
  };
}

/** Flight Review DataPlotSpec equivalent (sum of the PSDs of the fields, dB). */
export function specPlot(id: string, title: string, t: ArrayLike<number>, chans: ArrayLike<number>[], opts: { nperseg?: number; minFs?: number; marks?: { y: number; label: string }[]; note?: string } = {}): SpectrogramSpec | undefined {
  if (!chans.length || t.length < 300) return undefined;
  const dt = median(diff(t));
  if (!(dt > 1e-6)) return undefined;
  const fs = 1 / dt;
  if (fs < (opts.minFs ?? 100)) return undefined;
  const nper = opts.nperseg ?? 256;
  const sg = spectrogram(chans, t, fs, nper, nper / 2);
  if (!sg.nt) return undefined;
  return { kind: 'spectrogram', id, title, yLabel: 'Hz', sg, marks: opts.marks, note: opts.note ?? `fs ${fs.toFixed(0)} Hz, window ${nper}, PSD summed over axes [dB]` };
}

export function isAllConstant(a: ArrayLike<number>): boolean {
  for (let i = 1; i < a.length; i++) if (a[i] !== a[0]) return false;
  return true;
}

export function maxAbs(a: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}

export function fmt(v: number | undefined, d = 2): string {
  if (v === undefined || v === null || !isFinite(v)) return '–';
  return v.toFixed(d);
}

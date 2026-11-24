/**
 * Step response estimation by Wiener deconvolution — port of Flight Review's pid_analysis.py
 * (based on PID-Analyzer by Florian Melsheimer, "beer-ware" license). Only windows with enough
 * input excitation are deconvolved (others carry zero weight in the original as well).
 */
import { fftOf, gaussianFilter1d, interp, nextPow2 } from '../dsp';

const FRAMELEN = 1.0, RESPLEN = 0.5, CUTFREQ = 25, SUPERPOS = 16, THRESHOLD = 500;

export interface StepResult {
  time: Float64Array;
  low?: Float64Array; // response for inputs <= 500 deg/s
  high?: Float64Array;
  nLow: number;
  nHigh: number;
  riseTime?: number; // 10-90 %
  overshoot?: number; // %
  peakTime?: number;
  settle?: number; // steady-state value at end of window
}

function hanningSym(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = n === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * @param t time [s], @param gyro measured rate [deg/s], @param sp rate setpoint [deg/s] (all same length)
 */
export function stepResponse(t: ArrayLike<number>, gyro: ArrayLike<number>, sp: ArrayLike<number>): StepResult | undefined {
  const n = t.length;
  if (n < 200) return undefined;
  // equalize: uniform resampling
  const t0 = t[0], t1 = t[n - 1];
  const tu = new Float64Array(n);
  for (let i = 0; i < n; i++) tu[i] = t0 + ((t1 - t0) * i) / (n - 1);
  const g = interp(tu, t, gyro), inp = interp(tu, t, sp);
  const dt = (t1 - t0) / (n - 1);
  const flen = Math.floor(FRAMELEN / dt), rlen = Math.floor(RESPLEN / dt);
  if (flen < 16 || n < flen * 2) return undefined;
  const shift = Math.max(1, Math.floor(flen / SUPERPOS));
  const wins = Math.floor((n - flen) / shift);
  const win = hanningSym(flen);
  const N = Math.max(1024, nextPow2(flen));
  const fft = fftOf(N);
  // Wiener noise term: sn = 10 below cut, ~0 above, smoothed
  const freq = new Float64Array(N);
  for (let k = 0; k < N; k++) { const kk = k <= N / 2 ? k : k - N; freq[k] = Math.abs(kk / (N * dt)); }
  let sn = Float64Array.from(freq, (f) => Math.min(Math.max(f, CUTFREQ - 1e-9), CUTFREQ));
  const norm = (a: Float64Array) => { let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } const r = hi - lo; return a.map((v) => (r > 1e-10 ? (v - lo) / r : v - lo)); };
  sn = norm(sn);
  let lenLpf = 0;
  for (const v of sn) lenLpf += 1 - v;
  sn = norm(gaussianFilter1d(sn, Math.max(1e-3, lenLpf / 6)));
  const noise = Float64Array.from(sn, (v) => 1 / (10 * (-v + 1 + 1e-9)));

  const respLow: Float64Array[] = [], respHigh: Float64Array[] = [];
  const bufI = new Float64Array(N), bufO = new Float64Array(N);
  const H = fft.createComplexArray() as number[], G = fft.createComplexArray() as number[];
  const Q = fft.createComplexArray() as number[], out = fft.createComplexArray() as number[];
  for (let w = 0; w < wins; w++) {
    const a = w * shift;
    let maxIn = 0;
    for (let i = 0; i < flen; i++) { const v = Math.abs(inp[a + i] * win[i]); if (v > maxIn) maxIn = v; }
    if (maxIn <= 20) continue; // "toolow" mask
    bufI.fill(0); bufO.fill(0);
    for (let i = 0; i < flen; i++) { bufI[i] = inp[a + i] * win[i]; bufO[i] = g[a + i] * win[i]; }
    fft.realTransform(H, bufI); fft.completeSpectrum(H);
    fft.realTransform(G, bufO); fft.completeSpectrum(G);
    for (let k = 0; k < N; k++) {
      const hr = H[2 * k], hi = H[2 * k + 1], gr = G[2 * k], gi = G[2 * k + 1];
      const den = hr * hr + hi * hi + noise[k];
      // G * conj(H) / den
      Q[2 * k] = (gr * hr + gi * hi) / den;
      Q[2 * k + 1] = (gi * hr - gr * hi) / den;
    }
    fft.inverseTransform(out, Q);
    const r = new Float64Array(rlen);
    let acc = 0;
    for (let i = 0; i < rlen; i++) { acc += out[2 * i]; r[i] = acc; }
    (maxIn <= THRESHOLD ? respLow : respHigh).push(r);
  }
  const time = Float64Array.from({ length: rlen }, (_, i) => i * dt);
  const mode = (rs: Float64Array[]) => weightedModeAvr(rs, rlen);
  const res: StepResult = { time, nLow: respLow.length, nHigh: respHigh.length };
  if (respLow.length) res.low = mode(respLow);
  if (respHigh.length >= 10) res.high = mode(respHigh);
  const r = res.low ?? res.high;
  if (r) {
    const tail = r.subarray(Math.floor(rlen * 0.6));
    let ss = 0; for (const v of tail) ss += v; ss /= tail.length;
    res.settle = ss;
    let pk = -Infinity, pi = 0;
    for (let i = 0; i < rlen; i++) if (r[i] > pk) { pk = r[i]; pi = i; }
    res.peakTime = time[pi];
    res.overshoot = ss > 0.2 ? Math.max(0, (pk / ss - 1) * 100) : undefined;
    const i10 = r.findIndex((v) => v >= 0.1 * ss), i90 = r.findIndex((v) => v >= 0.9 * ss);
    if (i10 >= 0 && i90 >= 0 && ss > 0.2) res.riseTime = time[i90] - time[i10];
  }
  return res;
}

/** Most common trace (2D histogram, gaussian smoothed) — weighted_mode_avr of PID-Analyzer. */
function weightedModeAvr(rs: Float64Array[], rlen: number): Float64Array {
  const lo = -1.5, hi = 3.5, bins = 1000;
  const avr = new Float64Array(rlen);
  const col = new Float64Array(bins);
  for (let j = 0; j < rlen; j++) {
    col.fill(0);
    for (const r of rs) {
      const b = Math.floor(((r[j] - lo) / (hi - lo)) * bins);
      if (b >= 0 && b < bins) col[b] += 1;
    }
    const sm = gaussianFilter1d(col, 7, 'constant');
    let mx = 0;
    for (const v of sm) if (v > mx) mx = v;
    if (mx <= 0) { avr[j] = 0; continue; }
    let num = 0, den = 0;
    for (let b = 0; b < bins; b++) {
      const w = (sm[b] / mx) ** 2;
      num += (lo + ((hi - lo) * b) / (bins - 1)) * w; den += w;
    }
    avr[j] = den > 0 ? num / den : 0;
  }
  return avr;
}

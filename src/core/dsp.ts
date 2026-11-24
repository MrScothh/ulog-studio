/** Signal processing primitives (FFT, Welch PSD, CSD, spectrogram, biquads, PX4 filter models). */
import FFT from 'fft.js';

const fftCache = new Map<number, FFT>();
export function fftOf(n: number): FFT {
  let f = fftCache.get(n);
  if (!f) { f = new FFT(n); fftCache.set(n, f); }
  return f;
}
export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(4, n)));
export const prevPow2 = (n: number) => 2 ** Math.floor(Math.log2(Math.max(4, n)));

export function hann(n: number): Float64Array {
  // scipy 'hann' periodic window (sym=False) as used by welch/spectrogram
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

export function mean(x: ArrayLike<number>, a = 0, b = x.length): number {
  let s = 0, k = 0;
  for (let i = a; i < b; i++) { const v = x[i]; if (v === v) { s += v; k++; } }
  return k ? s / k : NaN;
}
export function std(x: ArrayLike<number>): number {
  const m = mean(x);
  let s = 0, k = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v === v) { s += (v - m) ** 2; k++; } }
  return k ? Math.sqrt(s / k) : NaN;
}
export function rms(x: ArrayLike<number>): number {
  let s = 0, k = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v === v) { s += v * v; k++; } }
  return k ? Math.sqrt(s / k) : NaN;
}
export function percentile(x: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(x).filter((v) => v === v).sort();
  if (!a.length) return NaN;
  const r = (p / 100) * (a.length - 1);
  const lo = Math.floor(r), hi = Math.ceil(r);
  return a[lo] + (a[hi] - a[lo]) * (r - lo);
}
export const median = (x: ArrayLike<number>) => percentile(x, 50);
export function minMax(x: ArrayLike<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < x.length; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}
export function diff(x: ArrayLike<number>): Float64Array {
  const o = new Float64Array(Math.max(0, x.length - 1));
  for (let i = 1; i < x.length; i++) o[i - 1] = x[i] - x[i - 1];
  return o;
}

/** Median sample rate from a time vector (s). */
export function sampleRate(t: ArrayLike<number>): number {
  if (t.length < 3) return 0;
  const step = Math.max(1, Math.floor(t.length / 5000));
  const d: number[] = [];
  for (let i = step; i < t.length; i += step) d.push((t[i] - t[i - step]) / step);
  d.sort((a, b) => a - b);
  const m = d[d.length >> 1];
  return m > 0 ? 1 / m : 0;
}

/** Index of first element >= v in a sorted array. */
export function lowerBound(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** Linear interpolation of (x,y) at sorted query points xq. */
export function interp(xq: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const out = new Float64Array(xq.length);
  const n = x.length;
  if (!n) return out.fill(NaN);
  let j = 0;
  for (let i = 0; i < xq.length; i++) {
    const q = xq[i];
    if (q <= x[0]) { out[i] = y[0]; continue; }
    if (q >= x[n - 1]) { out[i] = y[n - 1]; continue; }
    if (j > 0 && x[j - 1] > q) j = 0;
    while (j < n - 1 && x[j + 1] < q) j++;
    const x0 = x[j], x1 = x[j + 1];
    out[i] = x1 > x0 ? y[j] + ((y[j + 1] - y[j]) * (q - x0)) / (x1 - x0) : y[j];
  }
  return out;
}
/** Zero-order hold (previous value) interpolation. */
export function interpHold(xq: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>): Float64Array {
  const out = new Float64Array(xq.length);
  let j = 0;
  for (let i = 0; i < xq.length; i++) {
    while (j < x.length - 1 && x[j + 1] <= xq[i]) j++;
    out[i] = xq[i] < x[0] ? y[0] : y[j];
  }
  return out;
}

export function uniformGrid(t0: number, t1: number, fs: number): Float64Array {
  const n = Math.max(0, Math.floor((t1 - t0) * fs));
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = t0 + i / fs;
  return g;
}

/** Select samples in [a,b). */
export function sliceRange(t: Float64Array, a: number, b: number): [number, number] {
  return [lowerBound(t, a), lowerBound(t, b)];
}

// ---------------------------------------------------------------- spectra
export interface Spectrum { f: Float64Array; p: Float64Array }

/** scipy.signal.welch(x, fs, window='hann', nperseg, noverlap=nperseg/2, detrend='constant', scaling='density'). */
export function welch(x: ArrayLike<number>, fs: number, nperseg = 256, noverlap?: number): Spectrum & { segments: number } {
  const n = prevPow2(Math.min(nperseg, Math.max(4, x.length)));
  const step = n - (noverlap ?? n / 2);
  const w = hann(n);
  let ws = 0;
  for (let i = 0; i < n; i++) ws += w[i] * w[i];
  const scale = 1 / (fs * ws);
  const nf = n / 2 + 1;
  const acc = new Float64Array(nf);
  const fft = fftOf(n);
  const buf = new Float64Array(n);
  const out = fft.createComplexArray() as number[];
  let segs = 0;
  for (let s = 0; s + n <= x.length; s += step) {
    let m = 0;
    for (let i = 0; i < n; i++) m += x[s + i];
    m /= n;
    if (m !== m) continue;
    for (let i = 0; i < n; i++) buf[i] = (x[s + i] - m) * w[i];
    fft.realTransform(out, buf);
    for (let k = 0; k < nf; k++) {
      const re = out[2 * k], im = out[2 * k + 1];
      acc[k] += (re * re + im * im) * scale * (k === 0 || k === n / 2 ? 1 : 2);
    }
    segs++;
  }
  const f = new Float64Array(nf);
  for (let k = 0; k < nf; k++) { f[k] = (k * fs) / n; if (segs) acc[k] /= segs; }
  return { f, p: acc, segments: segs };
}

/** Welch PSD averaged over several separate windows (weighted by number of segments). */
export function welchMulti(chunks: ArrayLike<number>[], fs: number, nperseg = 512): Spectrum & { segments: number } | undefined {
  let res: Float64Array | undefined, f: Float64Array | undefined, total = 0;
  for (const c of chunks) {
    if (c.length < nperseg) continue;
    const r = welch(c, fs, nperseg);
    if (!r.segments) continue;
    if (!res) { res = new Float64Array(r.p.length); f = r.f; }
    for (let k = 0; k < r.p.length; k++) res[k] += r.p[k] * r.segments;
    total += r.segments;
  }
  if (!res || !f) return undefined;
  for (let k = 0; k < res.length; k++) res[k] /= total;
  return { f, p: res, segments: total };
}

/** Band RMS from a PSD: sqrt(integral of p over [f0,f1]). */
export function bandRms(s: Spectrum, f0: number, f1: number): number {
  const df = s.f.length > 1 ? s.f[1] - s.f[0] : 1;
  let acc = 0;
  for (let k = 0; k < s.f.length; k++) if (s.f[k] > f0 && s.f[k] < f1) acc += s.p[k];
  return Math.sqrt(acc * df);
}
export function peakIn(s: Spectrum, f0: number, f1: number): { f: number; p: number } {
  let best = -1, pk = 0;
  for (let k = 0; k < s.f.length; k++) if (s.f[k] > f0 && s.f[k] < f1 && s.p[k] > best) { best = s.p[k]; pk = s.f[k]; }
  return { f: pk, p: best };
}

/** Cross spectral density + auto spectra (Welch, hann, 50% overlap) → H = Pxy/Pxx and coherence. */
export function transferEstimate(x: ArrayLike<number>, y: ArrayLike<number>, fs: number, nperseg = 512) {
  const n = prevPow2(Math.min(nperseg, x.length));
  const step = n / 2;
  const w = hann(n);
  const nf = n / 2 + 1;
  const pxx = new Float64Array(nf), pyy = new Float64Array(nf), re = new Float64Array(nf), im = new Float64Array(nf);
  const fft = fftOf(n);
  const bx = new Float64Array(n), by = new Float64Array(n);
  const ox = fft.createComplexArray() as number[], oy = fft.createComplexArray() as number[];
  for (let s = 0; s + n <= x.length; s += step) {
    const mx = mean(x, s, s + n), my = mean(y, s, s + n);
    for (let i = 0; i < n; i++) { bx[i] = (x[s + i] - mx) * w[i]; by[i] = (y[s + i] - my) * w[i]; }
    fft.realTransform(ox, bx); fft.realTransform(oy, by);
    for (let k = 0; k < nf; k++) {
      const xr = ox[2 * k], xi = ox[2 * k + 1], yr = oy[2 * k], yi = oy[2 * k + 1];
      pxx[k] += xr * xr + xi * xi; pyy[k] += yr * yr + yi * yi;
      // conj(X) * Y
      re[k] += xr * yr + xi * yi; im[k] += xr * yi - xi * yr;
    }
  }
  const f = new Float64Array(nf), mag = new Float64Array(nf), ph = new Float64Array(nf), coh = new Float64Array(nf);
  for (let k = 0; k < nf; k++) {
    f[k] = (k * fs) / n;
    const hr = re[k] / pxx[k], hi = im[k] / pxx[k];
    mag[k] = Math.hypot(hr, hi);
    ph[k] = Math.atan2(hi, hr);
    coh[k] = (re[k] * re[k] + im[k] * im[k]) / (pxx[k] * pyy[k]);
  }
  return { f, mag, phase: ph, coherence: coh };
}

export interface Spectrogram { f: Float64Array; t: Float64Array; z: Float32Array; nf: number; nt: number; zmin: number; zmax: number }

/** scipy.signal.spectrogram(x, fs, 'hann', nperseg, noverlap, scaling='density'), summed over channels, in dB. */
export function spectrogram(channels: ArrayLike<number>[], tvec: ArrayLike<number>, fs: number, nperseg = 256, noverlap = 128): Spectrogram {
  const n = nperseg;
  const pow2 = (n & (n - 1)) === 0;
  const N = pow2 ? n : nextPow2(n);
  const step = n - noverlap;
  const len = channels[0].length;
  const nt = Math.max(0, Math.floor((len - noverlap) / step));
  const nf = N / 2 + 1;
  const w = hann(n);
  let ws = 0;
  for (let i = 0; i < n; i++) ws += w[i] * w[i];
  const scale = 1 / (fs * ws);
  const z = new Float32Array(nt * nf);
  const fft = fftOf(N);
  const buf = new Float64Array(N);
  const out = fft.createComplexArray() as number[];
  const t = new Float64Array(nt);
  for (let s = 0; s < nt; s++) {
    const a = s * step;
    t[s] = tvec[Math.min(len - 1, a + (n >> 1))];
    for (const x of channels) {
      const m = mean(x, a, a + n);
      for (let i = 0; i < n; i++) buf[i] = (x[a + i] - m) * w[i];
      fft.realTransform(out, buf);
      for (let k = 0; k < nf; k++) {
        const re = out[2 * k], im = out[2 * k + 1];
        z[s * nf + k] += (re * re + im * im) * scale * (k === 0 || k === N / 2 ? 1 : 2);
      }
    }
  }
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < z.length; i++) {
    const v = 10 * Math.log10(z[i] > 0 ? z[i] : 1e-30);
    z[i] = v;
    if (v > -290) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  }
  const f = new Float64Array(nf);
  for (let k = 0; k < nf; k++) f[k] = (k * fs) / N;
  return { f, t, z, nf, nt, zmin, zmax };
}

/** Flight-Review-style amplitude spectrum: 2/N |FFT(x)| (zero-padded to a power of two). */
export function amplitudeSpectrum(x: ArrayLike<number>, fs: number): Spectrum {
  const N = nextPow2(x.length);
  const fft = fftOf(N);
  const buf = new Float64Array(N);
  for (let i = 0; i < x.length; i++) buf[i] = x[i] === x[i] ? x[i] : 0;
  const out = fft.createComplexArray() as number[];
  fft.realTransform(out, buf);
  const nf = N / 2;
  const f = new Float64Array(nf), p = new Float64Array(nf);
  const sc = 2 / x.length;
  for (let k = 0; k < nf; k++) { f[k] = (k * fs) / N; p[k] = sc * Math.hypot(out[2 * k], out[2 * k + 1]); }
  return { f, p };
}

// ---------------------------------------------------------------- biquads / filters
export interface Biquad { b: [number, number, number]; a: [number, number, number] }

/** 2nd order low pass section, bilinear with prewarp (== scipy butter(2) for q=1/sqrt2, == PX4 LowPassFilter2p). */
export function lowpass2(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
  const K = Math.tan((Math.PI * fc) / fs);
  const norm = 1 / (1 + K / q + K * K);
  const b0 = K * K * norm;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (K * K - 1) * norm, (1 - K / q + K * K) * norm] };
}
export function highpass2(fc: number, fs: number, q = Math.SQRT1_2): Biquad {
  const K = Math.tan((Math.PI * fc) / fs);
  const norm = 1 / (1 + K / q + K * K);
  return { b: [norm, -2 * norm, norm], a: [1, 2 * (K * K - 1) * norm, (1 - K / q + K * K) * norm] };
}
/** Butterworth of even order as cascade of biquads. */
export function butterworth(order: number, fc: number, fs: number, type: 'low' | 'high' = 'low'): Biquad[] {
  const secs: Biquad[] = [];
  for (let k = 0; k < order / 2; k++) {
    const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)));
    secs.push(type === 'low' ? lowpass2(fc, fs, q) : highpass2(fc, fs, q));
  }
  return secs;
}
/** PX4 math::NotchFilter coefficients. */
export function px4Notch(f0: number, bw: number, fs: number): Biquad {
  const alpha = Math.tan((Math.PI * bw) / fs);
  const beta = -Math.cos((2 * Math.PI * f0) / fs);
  const a0i = 1 / (alpha + 1);
  return { b: [a0i, 2 * beta * a0i, a0i], a: [1, 2 * beta * a0i, (1 - alpha) * a0i] };
}

/**
 * PX4 AlphaFilter (first-order low-pass, y += a·(x − y)) as set by setCutoffFreq(fs, fc):
 * a = dt / (dt + 1/(2π·fc)). Used for the D-term filter (IMU_DGYRO_CUTOFF) and the yaw torque filter.
 * Returns undefined when PX4 would leave the filter disabled (fc <= 0 or fc >= fs/2).
 */
export function alphaLpf(fc: number, fs: number): Biquad | undefined {
  if (!(fc > 0) || !(fs > 0) || fc >= fs / 2) return undefined;
  const dt = 1 / fs, a = dt / (dt + 1 / (2 * Math.PI * fc));
  return { b: [a, 0, 0], a: [1, -(1 - a), 0] };
}

/**
 * Filter x (sampled at fs) by an arbitrary frequency response, given at the FFT bin frequencies by H(f).
 * Zero-padded to at least twice the length, so the result is a (causal) linear, not circular, convolution
 * for responses whose impulse response is shorter than the signal.
 */
export function applyResponse(x: ArrayLike<number>, fs: number, H: (f: Float64Array) => Cplx[]): Float64Array {
  const n = x.length, N = nextPow2(2 * n), fft = fftOf(N);
  const buf = new Float64Array(N);
  for (let i = 0; i < n; i++) buf[i] = x[i];
  const X = fft.createComplexArray() as number[];
  fft.realTransform(X, buf);
  fft.completeSpectrum(X);
  const nf = N / 2 + 1;
  const f = new Float64Array(nf);
  for (let k = 0; k < nf; k++) f[k] = (k * fs) / N;
  const h = H(f);
  for (let k = 0; k < N; k++) {
    const kk = k < nf ? k : N - k;
    const hr = h[kk].re, hi = k < nf ? h[kk].im : -h[kk].im;
    const xr = X[2 * k], xi = X[2 * k + 1];
    X[2 * k] = xr * hr - xi * hi; X[2 * k + 1] = xr * hi + xi * hr;
  }
  const y = fft.createComplexArray() as number[];
  fft.inverseTransform(y, X);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = y[2 * i];
  return out;
}

/** Direct-form filtering (with steady-state init from first sample). */
export function lfilter(q: Biquad, x: ArrayLike<number>, init = true): Float64Array {
  const y = new Float64Array(x.length);
  const [b0, b1, b2] = q.b, [, a1, a2] = q.a;
  const x0 = init && x.length ? x[0] : 0;
  const g = (b0 + b1 + b2) / (1 + a1 + a2);
  let x1 = x0, x2 = x0, y1 = Number.isFinite(g) ? g * x0 : 0, y2 = y1;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}
export function cascade(secs: Biquad[], x: ArrayLike<number>, init = true): Float64Array {
  let y: Float64Array = Float64Array.from(x);
  for (const s of secs) y = lfilter(s, y, init);
  return y;
}
/** Zero phase filtering (forward-backward) with odd reflection padding like scipy filtfilt. */
export function filtfilt(secs: Biquad[], x: ArrayLike<number>): Float64Array {
  const n = x.length;
  const pad = Math.min(n - 1, 3 * 3 * secs.length);
  if (n < 2) return Float64Array.from(x);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  let y = cascade(secs, ext);
  y.reverse();
  y = cascade(secs, y);
  y.reverse();
  return y.slice(pad, pad + n);
}

export interface Cplx { re: number; im: number }
/** Frequency response of a biquad at frequency f for sample rate fs. */
export function biquadResponse(q: Biquad, f: number, fs: number): Cplx {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const nr = q.b[0] + q.b[1] * c1 + q.b[2] * c2, ni = q.b[1] * s1 + q.b[2] * s2;
  const dr = q.a[0] + q.a[1] * c1 + q.a[2] * c2, di = q.a[1] * s1 + q.a[2] * s2;
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}
export const cmul = (a: Cplx, b: Cplx): Cplx => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const cdiv = (a: Cplx, b: Cplx): Cplx => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const cadd = (a: Cplx, b: Cplx): Cplx => ({ re: a.re + b.re, im: a.im + b.im });
export const cabs = (a: Cplx) => Math.hypot(a.re, a.im);
export const carg = (a: Cplx) => Math.atan2(a.im, a.re);
export const cexpj = (ph: number): Cplx => ({ re: Math.cos(ph), im: Math.sin(ph) });
export const cscale = (a: Cplx, k: number): Cplx => ({ re: a.re * k, im: a.im * k });

export function logspace(a: number, b: number, n: number): Float64Array {
  const o = new Float64Array(n);
  const la = Math.log10(a), lb = Math.log10(b);
  for (let i = 0; i < n; i++) o[i] = 10 ** (la + ((lb - la) * i) / (n - 1));
  return o;
}

/** scipy.ndimage.gaussian_filter1d (mode='reflect', truncate=4). */
export function gaussianFilter1d(x: ArrayLike<number>, sigma: number, mode: 'reflect' | 'constant' = 'reflect'): Float64Array {
  const n = x.length;
  const r = Math.max(1, Math.round(4 * sigma));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      let idx = i + j;
      if (idx < 0 || idx >= n) {
        if (mode === 'constant') continue;
        while (idx < 0 || idx >= n) idx = idx < 0 ? -idx - 1 : 2 * n - idx - 1;
      }
      acc += x[idx] * k[j + r];
    }
    out[i] = acc;
  }
  return out;
}

/** Contiguous true segments of a mask over time t, returning [start,end] pairs with min length. */
export function maskSegments(mask: ArrayLike<boolean | number>, t: ArrayLike<number>, minLen = 0): [number, number][] {
  const segs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && start < 0) start = i;
    if ((!mask[i] || i === mask.length - 1) && start >= 0) {
      const a = t[start], b = t[i];
      if (b - a >= minLen) segs.push([a, b]);
      start = -1;
    }
  }
  return segs;
}

/**
 * PX4 gyro filter chain model (VehicleAngularVelocity): static notches (IMU_GYRO_NF0/NF1) -> LPF (IMU_GYRO_CUTOFF)
 * for the angular velocity (P/I path), derivative of the notched signal -> LPF (IMU_DGYRO_CUTOFF) for the D path.
 * Filters run at the raw gyro sample rate.
 */
import type { ULog } from '../ulog';
import { unpackFifo } from '../ulog';
import {
  px4Notch, lowpass2, biquadResponse, cmul, cabs, carg, Cplx, lfilter, logspace, butterworth, filtfilt, interp,
  welchMulti, bandRms, sampleRate, Biquad, median,
} from '../dsp';
import { quietHoverWindows, chunks, inWindows } from '../px4';

export interface FilterConfig {
  fs: number; // filter sample rate (raw gyro)
  notches: { f: number; bw: number }[];
  lpf: number;
  dlpf: number;
  dnfEnabled?: number; // IMU_GYRO_DNF_EN bitmask (ESC RPM=1, FFT=2)
}

export function rawGyroRate(log: ULog): { fs: number; source: string } {
  const f = log.topic('sensor_gyro_fifo');
  if (f && f.cols['dt']) {
    const dt = median(f.cols['dt']);
    if (dt > 0) return { fs: 1e6 / dt, source: 'sensor_gyro_fifo.dt' };
  }
  const s = log.topic('vehicle_imu_status');
  if (s && s.cols['gyro_raw_rate_hz']) {
    const r = median(Array.from(s.cols['gyro_raw_rate_hz']).filter((v) => v > 0));
    // Invensense drivers publish the FIFO decimated to <= 2 kHz (e.g. 8 kHz sensor -> 2 kHz sensor_gyro_fifo)
    if (r > 0) return r > 2100 ? { fs: 2000, source: `assumed 2 kHz FIFO (sensor raw ${r.toFixed(0)} Hz; log sensor_gyro_fifo for the exact rate)` } : { fs: r, source: 'vehicle_imu_status.gyro_raw_rate_hz' };
  }
  return { fs: log.params.get('IMU_GYRO_RATEMAX') ?? 400, source: 'IMU_GYRO_RATEMAX' };
}

export function configFromParams(log: ULog, params?: Map<string, number>): FilterConfig {
  const P = params ?? log.params;
  const g = (n: string, d = 0) => P.get(n) ?? d;
  return {
    fs: rawGyroRate(log).fs,
    notches: [
      { f: g('IMU_GYRO_NF0_FRQ'), bw: g('IMU_GYRO_NF0_BW', 20) },
      { f: g('IMU_GYRO_NF1_FRQ'), bw: g('IMU_GYRO_NF1_BW', 20) },
    ],
    lpf: g('IMU_GYRO_CUTOFF', 40),
    dlpf: g('IMU_DGYRO_CUTOFF', 30),
    dnfEnabled: g('IMU_GYRO_DNF_EN'),
  };
}

function activeNotches(c: FilterConfig): Biquad[] {
  return c.notches.filter((n) => n.f > 0 && n.bw > 0 && n.f < c.fs / 2).map((n) => px4Notch(n.f, n.bw, c.fs));
}
function lpfOf(fc: number, fs: number): Biquad | undefined {
  return fc > 0 && fc < fs / 2 ? lowpass2(fc, fs) : undefined;
}

/** Complex responses of the P path (notches * LPF) and D path filters (notches * DLPF), at frequencies f. */
export function chainResponse(c: FilterConfig, f: ArrayLike<number>): { p: Cplx[]; d: Cplx[]; n: Cplx[] } {
  const nq = activeNotches(c), l = lpfOf(c.lpf, c.fs), dl = lpfOf(c.dlpf, c.fs);
  const p: Cplx[] = [], d: Cplx[] = [], n: Cplx[] = [];
  for (let i = 0; i < f.length; i++) {
    let h: Cplx = { re: 1, im: 0 };
    for (const q of nq) h = cmul(h, biquadResponse(q, f[i], c.fs));
    n.push(h);
    p.push(l ? cmul(h, biquadResponse(l, f[i], c.fs)) : h);
    d.push(dl ? cmul(h, biquadResponse(dl, f[i], c.fs)) : h);
  }
  return { p, d, n };
}

export interface ResponseCurves { f: Float64Array; magP: Float64Array; magD: Float64Array; phP: Float64Array; phD: Float64Array; delayP: Float64Array; delayD: Float64Array }

export function responseCurves(c: FilterConfig, fmax = 200): ResponseCurves {
  const f = logspace(0.5, Math.min(fmax, c.fs / 2 - 1), 600);
  const r = chainResponse(c, f);
  const unwrap = (a: Cplx[]) => {
    const o = new Float64Array(a.length);
    let prev = 0, off = 0;
    for (let i = 0; i < a.length; i++) {
      let ph = carg(a[i]) + off;
      while (ph - prev > Math.PI) { ph -= 2 * Math.PI; off -= 2 * Math.PI; }
      while (ph - prev < -Math.PI) { ph += 2 * Math.PI; off += 2 * Math.PI; }
      o[i] = ph; prev = ph;
    }
    return o;
  };
  const pp = unwrap(r.p), pd = unwrap(r.d);
  return {
    f,
    magP: Float64Array.from(r.p, (h) => 20 * Math.log10(Math.max(1e-9, cabs(h)))),
    magD: Float64Array.from(r.d, (h) => 20 * Math.log10(Math.max(1e-9, cabs(h)))),
    phP: pp.map((v) => (v * 180) / Math.PI), phD: pd.map((v) => (v * 180) / Math.PI),
    delayP: Float64Array.from(pp, (v, i) => (-v / (2 * Math.PI * f[i])) * 1000),
    delayD: Float64Array.from(pd, (v, i) => (-v / (2 * Math.PI * f[i])) * 1000),
  };
}

/** Phase lag (deg) and equivalent delay (ms) at given frequencies. */
export function lagAt(c: FilterConfig, freqs: number[]): { f: number; phP: number; phD: number; msP: number; msD: number }[] {
  const r = chainResponse(c, freqs);
  return freqs.map((f, i) => {
    const a = (carg(r.p[i]) * 180) / Math.PI, b = (carg(r.d[i]) * 180) / Math.PI;
    return { f, phP: a, phD: b, msP: (-a / 360 / f) * 1000, msD: (-b / 360 / f) * 1000 };
  });
}

/** Apply the chain in time domain at fs: returns filtered rate and filtered derivative (D input). */
export function applyChain(c: FilterConfig, x: Float64Array): { vel: Float64Array; acc: Float64Array } {
  let y: Float64Array<ArrayBufferLike> = x;
  for (const q of activeNotches(c)) y = lfilter(q, y);
  const l = lpfOf(c.lpf, c.fs), dl = lpfOf(c.dlpf, c.fs);
  const vel = l ? lfilter(l, y) : y;
  let acc: Float64Array<ArrayBufferLike> = new Float64Array(y.length);
  for (let i = 1; i < y.length; i++) acc[i] = (y[i] - y[i - 1]) * c.fs;
  acc[0] = acc[1] ?? 0;
  if (dl) acc = lfilter(dl, acc);
  return { vel, acc };
}

export interface RawGyroSource {
  source: 'fifo' | 'sensor_combined';
  t: Float64Array;
  axes: Float64Array[]; // body roll/pitch/yaw [rad/s]
  fs: number;
  mapping: string;
  warning?: string;
}

/** Raw gyro in body axes. FIFO axes are mapped to body axes by correlation with vehicle_angular_velocity. */
export function rawGyroBody(log: ULog, range?: [number, number]): RawGyroSource | undefined {
  const av = log.topic('vehicle_angular_velocity');
  const fifo = log.has('sensor_gyro_fifo') ? unpackFifo(log, 'sensor_gyro_fifo', range) : undefined;
  if (fifo && fifo.t.length > 2000 && av) {
    const tav = log.sampleTime('vehicle_angular_velocity')!;
    const lp = butterworth(2, 15, fifo.fs);
    const raw = { x: filtfilt(lp, fifo.x), y: filtfilt(lp, fifo.y), z: filtfilt(lp, fifo.z) };
    const lo = fifo.t[0] + 0.2, hi = fifo.t[fifo.t.length - 1] - 0.2;
    const idx: number[] = [];
    for (let i = 0; i < tav.length; i++) if (tav[i] > lo && tav[i] < hi) idx.push(i);
    const step = Math.max(1, Math.floor(idx.length / 20000));
    const tq = Float64Array.from(idx.filter((_, k) => k % step === 0), (i) => tav[i]);
    const axes: Float64Array[] = [];
    const names: string[] = [];
    for (let b = 0; b < 3; b++) {
      const ref = Float64Array.from(idx.filter((_, k) => k % step === 0), (i) => av.cols[`xyz[${b}]`][i]);
      let best = { ax: 'x' as 'x' | 'y' | 'z', c: 0 };
      for (const ax of ['x', 'y', 'z'] as const) {
        const v = interp(tq, fifo.t, raw[ax]);
        const c = corr(v, ref);
        if (Math.abs(c) > Math.abs(best.c)) best = { ax, c };
      }
      const s = Math.sign(best.c) || 1;
      axes.push(fifo[best.ax].map((v) => v * s));
      names.push(`${'RPY'[b]}←${s < 0 ? '-' : ''}${best.ax} (r=${Math.abs(best.c).toFixed(2)})`);
    }
    return { source: 'fifo', t: fifo.t, axes, fs: fifo.fs, mapping: names.join(', '), warning: fifo.gaps > 5 ? `${fifo.gaps} gaps in FIFO stream (logger dropouts)` : undefined };
  }
  const sc = log.topic('sensor_combined');
  if (!sc) return undefined;
  let t = sc.t;
  let i0 = 0, i1 = t.length;
  if (range) { i0 = t.findIndex((v) => v >= range[0]); i1 = t.findIndex((v) => v > range[1]); if (i1 < 0) i1 = t.length; if (i0 < 0) i0 = 0; }
  t = t.subarray(i0, i1);
  const fs = sampleRate(t);
  return {
    source: 'sensor_combined', t, fs,
    axes: [0, 1, 2].map((i) => sc.cols[`gyro_rad[${i}]`].subarray(i0, i1)),
    mapping: 'sensor_combined.gyro_rad (body frame)',
    warning: `No sensor_gyro_fifo in this log: replay uses sensor_combined at ${fs.toFixed(0)} Hz (integrated, below the real filter rate). Enable a FIFO logging profile (SDLOG_PROFILE bit "raw FIFO high-rate IMU") for an exact replay.`,
  };
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb || 1);
}

export interface WhatIfResult {
  source: RawGyroSource['source'];
  mapping: string;
  warning?: string;
  fs: number;
  windowsS: number;
  psd: { f: Float64Array; raw: Float64Array[]; cur: Float64Array[]; prop: Float64Array[]; dCur: Float64Array[]; dProp: Float64Array[] };
  table: { axis: string; rawVib: number; curVel: number; propVel: number; curD: number; propD: number; curTorque: number; propTorque: number }[];
}

/**
 * Replay current vs proposed filters on the raw gyro inside quiet-hover windows (or a time range),
 * reporting PSDs and the 30–(fs/2) Hz noise injected into the torque via P and D paths.
 */
export function whatIf(log: ULog, cur: FilterConfig, prop: FilterConfig, range?: [number, number]): WhatIfResult | undefined {
  const src = rawGyroBody(log, range);
  if (!src) return undefined;
  let wins = range ? [range] : quietHoverWindows(log).windows;
  if (!wins.length) wins = [[src.t[0], src.t[src.t.length - 1]]];
  const fsF = src.source === 'fifo' ? src.fs : src.fs;
  const c = { ...cur, fs: src.source === 'fifo' ? cur.fs : fsF };
  const p = { ...prop, fs: src.source === 'fifo' ? prop.fs : fsF };
  const nper = src.fs > 1000 ? 2048 : 512;
  const P = log.params;
  const axn = ['ROLL', 'PITCH', 'YAW'];
  const mask = inWindows(src.t, wins);
  const totalS = mask.reduce((s, v) => s + v, 0) / src.fs;
  const out: WhatIfResult = { source: src.source, mapping: src.mapping, warning: src.warning, fs: src.fs, windowsS: totalS, psd: { f: new Float64Array(), raw: [], cur: [], prop: [], dCur: [], dProp: [] }, table: [] };
  for (let a = 0; a < 3; a++) {
    const x = src.axes[a];
    const fc = applyChain(c, x), fp = applyChain(p, x);
    const K = P.get(`MC_${axn[a]}RATE_K`) ?? 1, Pg = P.get(`MC_${axn[a]}RATE_P`) ?? 0.15, Dg = P.get(`MC_${axn[a]}RATE_D`) ?? 0.003;
    const ch = (y: Float64Array) => chunks(src.t, y, wins);
    const deg = (y: Float64Array) => y.map((v) => (v * 180) / Math.PI);
    const sr = welchMulti(ch(deg(x)), src.fs, nper), sc = welchMulti(ch(deg(fc.vel)), src.fs, nper), sp = welchMulti(ch(deg(fp.vel)), src.fs, nper);
    const dc = welchMulti(ch(fc.acc.map((v) => v * K * Dg)), src.fs, nper), dp = welchMulti(ch(fp.acc.map((v) => v * K * Dg)), src.fs, nper);
    if (!sr || !sc || !sp || !dc || !dp) continue;
    out.psd.f = sr.f;
    out.psd.raw.push(sr.p); out.psd.cur.push(sc.p); out.psd.prop.push(sp.p); out.psd.dCur.push(dc.p); out.psd.dProp.push(dp.p);
    const hiF = Math.min(src.fs / 2, 400);
    const kp = (K * Pg * Math.PI) / 180;
    const tq = (v: Float64Array, d: Float64Array) => Math.hypot(bandRms({ f: sr.f, p: v }, 30, hiF) * kp, bandRms({ f: sr.f, p: d }, 30, hiF));
    out.table.push({
      axis: ['roll', 'pitch', 'yaw'][a],
      rawVib: bandRms(sr, 30, hiF), curVel: bandRms(sc, 30, hiF), propVel: bandRms(sp, 30, hiF),
      curD: bandRms(dc, 30, hiF), propD: bandRms(dp, 30, hiF),
      curTorque: tq(sc.p, dc.p), propTorque: tq(sp.p, dp.p),
    });
  }
  return out;
}

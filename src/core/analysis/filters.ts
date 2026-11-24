/**
 * Model of the PX4 gyro filter chain, as implemented in src/modules/sensors/vehicle_angular_velocity
 * (VehicleAngularVelocity.cpp, unchanged from v1.17 to main):
 *
 *   for every raw sample of the *selected* gyro, at its raw rate (vehicle_imu_status.gyro_raw_rate_hz):
 *     dynamic notches (ESC RPM harmonics, onboard-FFT peaks)
 *     -> static notches IMU_GYRO_NF0 / NF1                      (math::NotchFilter)
 *     -> 2nd-order Butterworth low-pass IMU_GYRO_CUTOFF         (math::LowPassFilter2p)
 *        = angular velocity, used by the P and I terms
 *     -> backward difference -> 1st-order low-pass IMU_DGYRO_CUTOFF (AlphaFilter)
 *        = angular acceleration, used by the D term
 *
 * The D term therefore goes through every filter of the rate path plus its own first-order filter.
 * The rate controller runs once per published sample (vehicle_imu_status.gyro_rate_hz).
 */
import type { ULog } from '../ulog';
import { unpackFifo } from '../ulog';
import {
  px4Notch, lowpass2, alphaLpf, biquadResponse, cmul, cabs, carg, Cplx, lfilter, logspace, butterworth, filtfilt, interp,
  welchMulti, bandRms, sampleRate, Biquad, median,
} from '../dsp';
import { quietHoverWindows, airborneIntervals, chunks, inWindows } from '../px4';

export interface Notch { f: number; bw: number }

/** Dynamic notches frozen at their hover operating point (they follow motor speed / FFT peaks in flight). */
export interface DynamicNotches { axes: Notch[][]; desc: string }

export interface FilterConfig {
  /** filter sample rate = raw rate of the selected gyro [Hz] */
  fs: number;
  /** rate-controller rate = gyro publication rate [Hz] */
  ctrlRate: number;
  notches: Notch[];
  lpf: number;
  dlpf: number;
  /** IMU_GYRO_DNF_EN bitmask (1 = ESC RPM, 2 = onboard FFT) */
  dnfEnabled?: number;
  dynamic?: DynamicNotches;
}

export interface GyroInfo { deviceId?: number; fs: number; pubRate: number; source: string; fifoKey?: string }

const hex = (id: number) => `0x${id.toString(16).toUpperCase()}`;

function instanceKeys(log: ULog, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) { const k = i ? `${name}_${i}` : name; if (log.has(k)) out.push(k); }
  return out;
}

function mostCommon(a: ArrayLike<number>): number | undefined {
  const c = new Map<number, number>();
  for (let i = 0; i < a.length; i++) if (a[i]) c.set(a[i], (c.get(a[i]) ?? 0) + 1);
  let best: number | undefined, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}
const positive = (a: ArrayLike<number> | undefined) => (a ? Array.from(a).filter((v) => v > 0) : []);

const gyroCache = new WeakMap<ULog, GyroInfo>();

/**
 * The gyro the controller actually uses and its filter rate, the way VehicleAngularVelocity picks them:
 * sensor_selection.gyro_device_id, then gyro_raw_rate_hz / gyro_rate_hz of the vehicle_imu_status instance
 * with that device id.
 */
export function selectedGyro(log: ULog): GyroInfo {
  const hit = gyroCache.get(log);
  if (hit) return hit;
  const P = log.params;
  let dev = mostCommon(log.topic('sensor_selection')?.cols['gyro_device_id'] ?? []);
  let how = 'sensor_selection';
  if (dev === undefined) {
    // fallback: highest calibration priority
    let prio = -1;
    for (let i = 0; i < 4; i++) {
      const id = P.get(`CAL_GYRO${i}_ID`), pr = P.get(`CAL_GYRO${i}_PRIO`) ?? 50;
      if (id && pr > prio) { prio = pr; dev = id; }
    }
    how = 'highest CAL_GYROn_PRIO';
  }
  const fifoKey = instanceKeys(log, 'sensor_gyro_fifo').find((k) => dev !== undefined && mostCommon(log.topic(k)!.cols['device_id'] ?? []) === dev);
  let out: GyroInfo | undefined;
  for (const k of instanceKeys(log, 'vehicle_imu_status')) {
    const s = log.topic(k)!;
    const id = mostCommon(s.cols['gyro_device_id'] ?? []);
    if (dev !== undefined && id !== dev) continue;
    const raw = median(positive(s.cols['gyro_raw_rate_hz'])), pub = median(positive(s.cols['gyro_rate_hz']));
    if (raw > 10 && raw < 10000) {
      out = { deviceId: id, fs: raw, pubRate: pub > 0 ? pub : raw, fifoKey, source: `gyro ${id !== undefined ? hex(id) : '?'} (${dev !== undefined ? `selected, ${how}` : 'first IMU'}), vehicle_imu_status` };
      break;
    }
  }
  if (!out && fifoKey) {
    const dt = median(positive(log.topic(fifoKey)!.cols['dt']));
    if (dt > 0) out = { deviceId: dev, fs: 1e6 / dt, pubRate: P.get('IMU_GYRO_RATEMAX') ?? 1e6 / dt, fifoKey, source: `${fifoKey}.dt` };
  }
  if (!out) {
    const r = P.get('IMU_GYRO_RATEMAX') ?? 400;
    out = { deviceId: dev, fs: r, pubRate: r, source: 'IMU_GYRO_RATEMAX (no vehicle_imu_status in the log: approximate)' };
  }
  gyroCache.set(log, out);
  return out;
}

/** @deprecated kept for callers that only need the rate */
export function rawGyroRate(log: ULog): { fs: number; source: string } {
  const g = selectedGyro(log);
  return { fs: g.fs, source: g.source };
}

function hoverWindows(log: ULog): [number, number][] {
  const q = quietHoverWindows(log);
  return q.windows.length ? q.windows : airborneIntervals(log);
}

function medianInWindows(t: ArrayLike<number>, y: ArrayLike<number>, w: [number, number][], keep: (v: number) => boolean): number {
  const m = inWindows(t, w);
  const v: number[] = [];
  for (let i = 0; i < y.length; i++) if (m[i] && keep(y[i])) v.push(y[i]);
  return v.length ? median(v) : NaN;
}

export interface DynamicNotchInfo { dyn?: DynamicNotches; notes: { tone: 'info' | 'warning'; title: string; detail: string }[] }
const dynCache = new WeakMap<ULog, DynamicNotchInfo>();

/**
 * Dynamic notches at the hover operating point (median over quiet hover), with PX4's own rules:
 * ESC RPM: f = max(rpm/60·(h+1), max(DNF_MIN, DNF_BW) + h·DNF_BW/2), bandwidth IMU_GYRO_DNF_BW, DNF_HMC harmonics.
 * FFT: sensor_gyro_fft peaks > 10 Hz per axis, bandwidth = clamp(resolution_hz, 8, 30).
 */
export function dynamicNotches(log: ULog): DynamicNotchInfo {
  const hit = dynCache.get(log);
  if (hit) return hit;
  const P = log.params;
  const en = P.get('IMU_GYRO_DNF_EN') ?? 0;
  const out: DynamicNotchInfo = { notes: [] };
  const gyro = selectedGyro(log);
  const axes: Notch[][] = [[], [], []];
  const desc: string[] = [];
  if (en & 1) {
    const es = log.topic('esc_status');
    const bw = P.get('IMU_GYRO_DNF_BW') ?? 15, hmc = P.get('IMU_GYRO_DNF_HMC') ?? 3;
    const fmin = Math.max(P.get('IMU_GYRO_DNF_MIN') ?? 25, bw);
    const n0 = axes[0].length;
    if (es) {
      const w = hoverWindows(log);
      for (let e = 0; e < 12; e++) {
        const col = es.cols[`esc[${e}].esc_rpm`];
        if (!col) break;
        const rpm = Math.abs(medianInWindows(es.t, col, w, (v) => v !== 0));
        if (!(rpm > 0)) continue;
        for (let h = 0; h < hmc; h++) {
          const f = Math.max((rpm / 60) * (h + 1), fmin + h * 0.5 * bw);
          for (const a of axes) a.push({ f, bw });
        }
      }
    }
    if (axes[0].length > n0) desc.push(`ESC RPM: ${axes[0].length - n0} notches (${hmc} harmonics, bandwidth ${bw} Hz) at the hover RPM`);
    else out.notes.push({ tone: 'warning', title: 'ESC RPM dynamic notch enabled, but no RPM in the log', detail: 'IMU_GYRO_DNF_EN has the ESC RPM bit set, but esc_status with RPM is not logged, so these notches cannot be modelled. The delays shown are a lower bound.' });
  }
  if (en & 2) {
    const fftEn = P.get('IMU_GYRO_FFT_EN');
    const key = instanceKeys(log, 'sensor_gyro_fft').find((k) => gyro.deviceId === undefined || mostCommon(log.topic(k)!.cols['device_id'] ?? []) === gyro.deviceId);
    if (key) {
      const ft = log.topic(key)!;
      const w = hoverWindows(log);
      const bw = Math.min(30, Math.max(8, median(positive(ft.cols['resolution_hz'])) || 8));
      let n = 0;
      ['x', 'y', 'z'].forEach((ax, a) => {
        for (let k = 0; k < 6; k++) {
          const col = ft.cols[`peak_frequencies_${ax}[${k}]`];
          if (!col) break;
          const f = medianInWindows(ft.t, col, w, (v) => v > 10);
          if (f > 10) { axes[a].push({ f, bw }); n++; }
        }
      });
      if (n) desc.push(`onboard FFT: ${n} notches (bandwidth ${bw.toFixed(0)} Hz) at the median hover peaks`);
    } else if (fftEn === undefined) {
      out.notes.push({ tone: 'info', title: 'FFT dynamic notch has no effect on this vehicle', detail: 'IMU_GYRO_DNF_EN has the FFT bit set, but this firmware has no gyro_fft module (IMU_GYRO_FFT_EN does not exist), so no FFT notch is applied.' });
    } else if (!fftEn) {
      out.notes.push({ tone: 'info', title: 'FFT dynamic notch has no effect', detail: 'IMU_GYRO_DNF_EN has the FFT bit set, but IMU_GYRO_FFT_EN = 0: the onboard FFT is off, so no FFT notch is applied.' });
    } else {
      out.notes.push({ tone: 'warning', title: 'FFT dynamic notch active but not modelled', detail: 'The onboard FFT is running, but sensor_gyro_fft is not in the log, so its notches cannot be modelled. The delays shown are a lower bound.' });
    }
  }
  if (axes.some((a) => a.length)) out.dyn = { axes, desc: desc.join('; ') };
  dynCache.set(log, out);
  return out;
}

export function configFromParams(log: ULog, params?: Map<string, number>): FilterConfig {
  const P = params ?? log.params;
  const g = (n: string, d = 0) => P.get(n) ?? d;
  const gy = selectedGyro(log);
  return {
    fs: gy.fs,
    ctrlRate: gy.pubRate,
    notches: [
      { f: g('IMU_GYRO_NF0_FRQ'), bw: g('IMU_GYRO_NF0_BW', 20) },
      { f: g('IMU_GYRO_NF1_FRQ'), bw: g('IMU_GYRO_NF1_BW', 20) },
    ],
    lpf: g('IMU_GYRO_CUTOFF', 40),
    dlpf: g('IMU_DGYRO_CUTOFF', 20),
    dnfEnabled: g('IMU_GYRO_DNF_EN'),
    dynamic: dynamicNotches(log).dyn,
  };
}

const validNotch = (n: Notch, fs: number) => n.f > 0 && n.bw > 0 && n.f < fs / 2;

function notchesFor(c: FilterConfig, axis: number): Biquad[] {
  const dyn = c.dynamic?.axes[axis] ?? [];
  return [...dyn, ...c.notches].filter((n) => validNotch(n, c.fs)).map((n) => px4Notch(n.f, n.bw, c.fs));
}
/** LowPassFilter2p: disabled when fc <= 0 or fc >= fs/2. */
function lpfOf(fc: number, fs: number): Biquad | undefined {
  return fc > 0 && fc < fs / 2 ? lowpass2(fc, fs) : undefined;
}

/**
 * Complex responses at frequencies f, for one body axis (dynamic FFT notches can differ per axis):
 *   n = all notches, p = rate path (notches · LPF), d = D path relative to an ideal derivative
 *   (p · backward-difference/s · first-order D-LPF).
 */
export function chainResponse(c: FilterConfig, f: ArrayLike<number>, axis = 0): { p: Cplx[]; d: Cplx[]; n: Cplx[] } {
  const nq = notchesFor(c, axis), l = lpfOf(c.lpf, c.fs), dl = alphaLpf(c.dlpf, c.fs);
  const p: Cplx[] = [], d: Cplx[] = [], n: Cplx[] = [];
  const T = 1 / c.fs;
  for (let i = 0; i < f.length; i++) {
    let h: Cplx = { re: 1, im: 0 };
    for (const q of nq) h = cmul(h, biquadResponse(q, f[i], c.fs));
    n.push(h);
    const hp = l ? cmul(h, biquadResponse(l, f[i], c.fs)) : h;
    p.push(hp);
    // backward difference (1 - z^-1)/T divided by jω: a half-sample delay with a slight droop
    const w = 2 * Math.PI * f[i];
    const bd: Cplx = w > 0 ? { re: Math.sin(w * T) / (w * T), im: -(1 - Math.cos(w * T)) / (w * T) } : { re: 1, im: 0 };
    let hd = cmul(hp, bd);
    if (dl) hd = cmul(hd, biquadResponse(dl, f[i], c.fs));
    d.push(hd);
  }
  return { p, d, n };
}

export interface ResponseCurves { f: Float64Array; magP: Float64Array; magD: Float64Array; phP: Float64Array; phD: Float64Array; delayP: Float64Array; delayD: Float64Array }

function unwrap(a: Cplx[]): Float64Array {
  const o = new Float64Array(a.length);
  let prev = 0, off = 0;
  for (let i = 0; i < a.length; i++) {
    let ph = carg(a[i]) + off;
    while (ph - prev > Math.PI) { ph -= 2 * Math.PI; off -= 2 * Math.PI; }
    while (ph - prev < -Math.PI) { ph += 2 * Math.PI; off += 2 * Math.PI; }
    o[i] = ph; prev = ph;
  }
  return o;
}

export function responseCurves(c: FilterConfig, fmax = 200, axis = 0): ResponseCurves {
  const f = logspace(0.5, Math.min(fmax, c.fs / 2 - 1), 600);
  const r = chainResponse(c, f, axis);
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

/** Phase lag (deg, negative = lag) and the equivalent time delay (ms) at the given frequencies. */
export function lagAt(c: FilterConfig, freqs: number[], axis = 0): { f: number; phP: number; phD: number; msP: number; msD: number }[] {
  const lo = logspace(0.05, Math.max(...freqs), 400);
  const all = [...lo, ...freqs].sort((a, b) => a - b);
  const r = chainResponse(c, all, axis);
  const pp = unwrap(r.p), pd = unwrap(r.d);
  return freqs.map((f) => {
    const i = all.indexOf(f);
    const a = (pp[i] * 180) / Math.PI, b = (pd[i] * 180) / Math.PI;
    return { f, phP: a, phD: b, msP: (-a / 360 / f) * 1000, msD: (-b / 360 / f) * 1000 };
  });
}

/** Run the chain sample by sample at c.fs: filtered rate (P/I input) and filtered derivative (D input). */
export function applyChain(c: FilterConfig, x: Float64Array, axis = 0): { vel: Float64Array; acc: Float64Array } {
  let y: Float64Array<ArrayBufferLike> = x;
  for (const q of notchesFor(c, axis)) y = lfilter(q, y);
  const l = lpfOf(c.lpf, c.fs), dl = alphaLpf(c.dlpf, c.fs);
  const vel = l ? lfilter(l, y) : y;
  let acc: Float64Array<ArrayBufferLike> = new Float64Array(vel.length);
  for (let i = 1; i < vel.length; i++) acc[i] = (vel[i] - vel[i - 1]) * c.fs;
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

/** Raw gyro of the selected IMU in body axes. FIFO axes are mapped to body axes by correlation with vehicle_angular_velocity. */
export function rawGyroBody(log: ULog, range?: [number, number]): RawGyroSource | undefined {
  const av = log.topic('vehicle_angular_velocity');
  const gy = selectedGyro(log);
  const fifo = gy.fifoKey ? unpackFifo(log, gy.fifoKey, range) : undefined;
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
    return { source: 'fifo', t: fifo.t, axes, fs: fifo.fs, mapping: names.join(', '), warning: fifo.gaps > 5 ? `${fifo.gaps} gaps in the FIFO stream (logger dropouts)` : undefined };
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
    warning: `No raw FIFO data of the selected gyro in this log: the replay uses sensor_combined at ${fs.toFixed(0)} Hz, far below the real filter rate (${gy.fs.toFixed(0)} Hz), so noise above ${(fs / 2).toFixed(0)} Hz is invisible and folded. Set the SDLOG_PROFILE bit "Raw FIFO high-rate IMU" for an exact replay.`,
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

export interface WhatIfRow {
  axis: string; rawVib: number; curVel: number; propVel: number; curTorque: number; propTorque: number;
  /** the same band measured on the logged vehicle_torque_setpoint (validation of the replay with the flown filters) */
  logTorque?: number;
}
export interface WhatIfResult {
  source: RawGyroSource['source'];
  mapping: string;
  warning?: string;
  fs: number;
  windowsS: number;
  band: [number, number];
  psd: { f: Float64Array; raw: Float64Array[]; cur: Float64Array[]; prop: Float64Array[]; tqCur: Float64Array[]; tqProp: Float64Array[]; tqLog?: { f: Float64Array; p: Float64Array[] } };
  table: WhatIfRow[];
  /** sample rate of the logged torque setpoint, when it can be compared */
  tqLogRate?: number;
  /** replay of the flown chain vs PX4's own output (vehicle_angular_velocity), relative RMS error per axis */
  check?: { rate: number[]; dterm?: number[] };
}

/** Relative RMS difference after removing each signal's mean (gyro bias is corrected after filtering in PX4). */
function relErr(y: ArrayLike<number>, ref: ArrayLike<number>): number {
  let my = 0, mr = 0;
  for (let i = 0; i < y.length; i++) { my += y[i]; mr += ref[i]; }
  my /= y.length; mr /= ref.length;
  let se = 0, sr = 0;
  for (let i = 0; i < y.length; i++) { se += (y[i] - my - (ref[i] - mr)) ** 2; sr += (ref[i] - mr) ** 2; }
  return Math.sqrt(se / (sr || 1));
}

/**
 * Replay the current and the proposed chain on the raw gyro (quiet hover or a time range) and measure the noise
 * that reaches the torque setpoint: torque noise = MC_*RATE_K · (P · filtered rate + D · filtered derivative),
 * in the controller's normalised torque units (1 = full authority), so ×100 gives percent.
 */
export function whatIf(log: ULog, cur: FilterConfig, prop: FilterConfig, range?: [number, number]): WhatIfResult | undefined {
  const src = rawGyroBody(log, range);
  if (!src) return undefined;
  let wins = range ? [range] : quietHoverWindows(log).windows;
  if (!wins.length) wins = [[src.t[0], src.t[src.t.length - 1]]];
  const c = { ...cur, fs: src.fs }, p = { ...prop, fs: src.fs };
  const nper = src.fs > 1000 ? 2048 : 512;
  const P = log.params;
  const axn = ['ROLL', 'PITCH', 'YAW'];
  const mask = inWindows(src.t, wins);
  const totalS = mask.reduce((s, v) => s + v, 0) / src.fs;
  // logged torque setpoint: the real controller output, to check the replay against
  const tq = log.topic('vehicle_torque_setpoint'), ttq = log.sampleTime('vehicle_torque_setpoint');
  const tqRate = tq && ttq && tq.count > 100 ? sampleRate(ttq) : 0;
  let hi = Math.min(src.fs / 2, 300, cur.ctrlRate / 2);
  if (tqRate > 80) hi = Math.min(hi, (tqRate / 2) * 0.9);
  const band: [number, number] = [30, hi];
  const out: WhatIfResult = { source: src.source, mapping: src.mapping, warning: src.warning, fs: src.fs, windowsS: totalS, band, psd: { f: new Float64Array(), raw: [], cur: [], prop: [], tqCur: [], tqProp: [] }, table: [] };
  if (tqRate > 80) { out.tqLogRate = tqRate; out.psd.tqLog = { f: new Float64Array(), p: [] }; }
  const yawFc = P.get('MC_YAW_TQ_CUTOFF') ?? 2;
  // compare the replayed flown chain with what PX4 itself published (needs the raw FIFO)
  const av = log.topic('vehicle_angular_velocity'), tav = log.sampleTime('vehicle_angular_velocity');
  let cmpIdx: number[] = [];
  if (src.source === 'fifo' && av && tav) {
    const t0 = src.t[0] + 1, t1 = src.t[src.t.length - 1] - 0.5;
    for (let i = 0; i < tav.length; i++) if (tav[i] > t0 && tav[i] < t1) cmpIdx.push(i);
    if (cmpIdx.length < 300) cmpIdx = [];
    else out.check = { rate: [], dterm: av.cols['xyz_derivative[0]'] ? [] : undefined };
  }
  const tCmp = Float64Array.from(cmpIdx, (i) => tav![i]);
  for (let a = 0; a < 3; a++) {
    const x = src.axes[a];
    const fc = applyChain(c, x, a), fp = applyChain(p, x, a);
    if (out.check && av) {
      out.check.rate.push(relErr(interp(tCmp, src.t, fc.vel), cmpIdx.map((i) => av.cols[`xyz[${a}]`][i])));
      out.check.dterm?.push(relErr(interp(tCmp, src.t, fc.acc), cmpIdx.map((i) => av.cols[`xyz_derivative[${a}]`][i])));
    }
    const K = P.get(`MC_${axn[a]}RATE_K`) ?? 1, Pg = P.get(`MC_${axn[a]}RATE_P`) ?? 0.15, Dg = P.get(`MC_${axn[a]}RATE_D`) ?? 0.003;
    const ch = (y: Float64Array) => chunks(src.t, y, wins);
    const deg = (y: Float64Array) => y.map((v) => (v * 180) / Math.PI);
    const yl = a === 2 ? alphaLpf(yawFc, src.fs) : undefined;
    const torque = (r: { vel: Float64Array; acc: Float64Array }) => {
      const t = r.vel.map((v, i) => K * (Pg * v + Dg * r.acc[i]));
      return yl ? lfilter(yl, t) : t;
    };
    const sr = welchMulti(ch(deg(x)), src.fs, nper), sc = welchMulti(ch(deg(fc.vel)), src.fs, nper), sp = welchMulti(ch(deg(fp.vel)), src.fs, nper);
    const tc = welchMulti(ch(torque(fc)), src.fs, nper), tp = welchMulti(ch(torque(fp)), src.fs, nper);
    if (!sr || !sc || !sp || !tc || !tp) continue;
    out.psd.f = sr.f;
    out.psd.raw.push(sr.p); out.psd.cur.push(sc.p); out.psd.prop.push(sp.p); out.psd.tqCur.push(tc.p); out.psd.tqProp.push(tp.p);
    const row: WhatIfRow = {
      axis: ['roll', 'pitch', 'yaw'][a],
      rawVib: bandRms(sr, band[0], band[1]), curVel: bandRms(sc, band[0], band[1]), propVel: bandRms(sp, band[0], band[1]),
      curTorque: bandRms(tc, band[0], band[1]), propTorque: bandRms(tp, band[0], band[1]),
    };
    if (out.psd.tqLog && tq && ttq) {
      const tl = welchMulti(chunks(ttq, tq.cols[`xyz[${a}]`], wins), tqRate, tqRate > 400 ? 1024 : 512);
      if (tl) { out.psd.tqLog.f = tl.f; out.psd.tqLog.p.push(tl.p); row.logTorque = bandRms(tl, band[0], band[1]); }
    }
    out.table.push(row);
  }
  return out;
}

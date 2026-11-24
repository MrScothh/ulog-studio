/**
 * Rate-loop plant identification from stick doublets, and loop margins.
 *
 * Plant (torque setpoint -> body angular acceleration): G(s) = K · e^(-s·d) / (τ·s + 1)
 *   K = control effectiveness, τ = motor/propeller time constant, d = pure delay (computation, mixer, output
 *   protocol, ESC). It is fitted on the logged vehicle_torque_setpoint and vehicle_angular_velocity. The logged
 *   angular velocity is the *filtered* one, so the fit runs on   α_logged = H_gyro(f) · G · u   with the PX4 gyro
 *   filter chain H_gyro modelled exactly (see filters.ts): K, τ and d describe the airframe only, and any filter
 *   setting can then be put back in the loop without approximation.
 *
 * Loop (PX4 RateControl, v1.17+): torque = K_r·[P·e + I·∫e − D·α_f] + FF·ω_sp   with e = ω_sp − ω_f
 *   (D on the measurement, P/I/D all multiplied by MC_*RATE_K, FF not), then for yaw a first-order low-pass
 *   MC_YAW_TQ_CUTOFF on the torque. Broken at the plant input:
 *     L(s) = H_yaw · K_r · (P·H_p + I/s·H_p + D·s·H_d) · G(s)/s
 *   H_p = notches·LPF (rate path), H_d = H_p·backward difference·D-LPF (D path).
 */
import type { ULog } from '../ulog';
import {
  butterworth, filtfilt, interp, sampleRate, uniformGrid, logspace, Cplx, cmul, cadd, cdiv, cabs, carg, cexpj, cscale,
  transferEstimate, applyResponse, fftOf, nextPow2,
} from '../dsp';
import { airborneIntervals, AXES, Axis } from '../px4';
import { FilterConfig, chainResponse, configFromParams } from './filters';

export interface Doublet { axis: Axis; t0: number; t1: number; peakDegS: number }
export interface PlantFit { axis: Axis; K: number; tau: number; delay: number; r2: number; t0: number; t1: number; fs: number; n: number }
export interface Gains { k: number; p: number; i: number; d: number }
export interface Margins { fc: number; pm: number; gm: number; fGm: number; smax: number; fSmax: number }

export function gainsFromParams(P: Map<string, number>, axis: Axis): Gains {
  const A = axis.toUpperCase();
  return { k: P.get(`MC_${A}RATE_K`) ?? 1, p: P.get(`MC_${A}RATE_P`) ?? 0.15, i: P.get(`MC_${A}RATE_I`) ?? 0.2, d: P.get(`MC_${A}RATE_D`) ?? 0.003 };
}

/** Find stick-doublet-like excitation windows in vehicle_rates_setpoint per axis. */
export function findDoublets(log: ULog): Doublet[] {
  const rs = log.topic('vehicle_rates_setpoint');
  if (!rs) return [];
  const air = airborneIntervals(log);
  const out: Doublet[] = [];
  for (const axis of AXES) {
    const v = rs.cols[axis];
    if (!v) continue;
    const others = AXES.filter((a) => a !== axis).map((a) => rs.cols[a]);
    let mx = 0;
    for (let i = 0; i < v.length; i++) mx = Math.max(mx, Math.abs(v[i]));
    const thr = Math.max((30 * Math.PI) / 180, 0.35 * mx);
    const active: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const t = rs.t[i];
      if (!air.some(([a, b]) => t > a + 1 && t < b - 1)) continue;
      if (Math.abs(v[i]) > thr && others.every((o) => Math.abs(o[i]) < 0.5 * Math.abs(v[i]))) active.push(i);
    }
    // cluster active samples into windows (gap < 1.5 s), pad 1.5 s
    let start = -1, last = -1, peak = 0;
    const flush = () => {
      if (start >= 0) {
        const t0 = rs.t[start] - 1.5, t1 = rs.t[last] + 1.5;
        if (t1 - t0 > 3) out.push({ axis, t0, t1, peakDegS: (peak * 180) / Math.PI });
      }
    };
    for (const i of active) {
      if (start < 0) { start = i; last = i; peak = Math.abs(v[i]); continue; }
      if (rs.t[i] - rs.t[last] > 1.5) { flush(); start = i; peak = 0; }
      last = i; peak = Math.max(peak, Math.abs(v[i]));
    }
    flush();
  }
  return out;
}

function gradient(x: Float64Array, fs: number): Float64Array {
  const n = x.length, o = new Float64Array(n);
  if (n < 2) return o;
  o[0] = (x[1] - x[0]) * fs; o[n - 1] = (x[n - 1] - x[n - 2]) * fs;
  for (let i = 1; i < n - 1; i++) o[i] = ((x[i + 1] - x[i - 1]) / 2) * fs;
  return o;
}

/** Least-squares gain and R² of y ≈ K·x on [skip, n). */
function lsFit(x: ArrayLike<number>, y: ArrayLike<number>, skip: number, sst: number): { K: number; r2: number } {
  let xy = 0, xx = 0;
  for (let i = skip; i < y.length; i++) { xy += x[i] * y[i]; xx += x[i] * x[i]; }
  const K = xx > 0 ? xy / xx : 0;
  let sse = 0;
  for (let i = skip; i < y.length; i++) sse += (y[i] - K * x[i]) ** 2;
  return { K, r2: 1 - sse / sst };
}

/**
 * Fit K, τ and d on [t0, t1] for an axis. Coarse grid in the time domain (integer-sample delays), then a fine
 * grid with fractional delays and an exact first-order lag in the frequency domain.
 */
export function identify(log: ULog, axis: Axis, t0: number, t1: number, cfg?: FilterConfig): PlantFit | undefined {
  const tq = log.topic('vehicle_torque_setpoint'), av = log.topic('vehicle_angular_velocity');
  if (!tq || !av) return undefined;
  const ai = AXES.indexOf(axis);
  const tav = log.sampleTime('vehicle_angular_velocity')!;
  const ttq = log.sampleTime('vehicle_torque_setpoint')!;
  const fs = sampleRate(tav);
  if (fs < 80) return undefined;
  const grid = uniformGrid(t0, t1, fs);
  if (grid.length < fs * 2) return undefined;
  const c = cfg ?? configFromParams(log);
  const u = interp(grid, ttq, tq.cols[`xyz[${ai}]`]);
  const w = interp(grid, tav, av.cols[`xyz[${ai}]`]);
  const lp = butterworth(4, Math.min(15, fs / 4), fs), hp = butterworth(2, 0.5, fs, 'high');
  const uf0 = filtfilt(hp, filtfilt(lp, u)), wf = filtfilt(hp, filtfilt(lp, w));
  // the gyro filters are part of what the log sees: put them on the input side of the model
  const uf = applyResponse(uf0, fs, (f) => chainResponse(c, f, ai).p);
  const alpha = gradient(wf, fs);
  const skip = Math.round(0.15 * fs);
  const yy = alpha.subarray(skip);
  let ym = 0; for (const v of yy) ym += v; ym /= yy.length;
  let sst = 0; for (const v of yy) sst += (v - ym) ** 2;

  // 1) coarse: discrete lag, integer delays
  const maxD = Math.min(Math.round(0.12 * fs), skip);
  const ul = new Float64Array(uf.length);
  const shifted = new Float64Array(uf.length);
  let best: { r2: number; K: number; tau: number; d: number } | undefined;
  for (let tau = 0.005; tau <= 0.15 + 1e-9; tau += 0.0025) {
    const ad = Math.exp(-1 / (fs * tau));
    let s = 0;
    for (let i = 0; i < uf.length; i++) { s = ad * s + (1 - ad) * uf[i]; ul[i] = s; }
    for (let d = 0; d <= maxD; d++) {
      for (let i = 0; i < ul.length; i++) shifted[i] = i >= d ? ul[i - d] : 0;
      const r = lsFit(shifted, alpha, skip, sst);
      if (!best || r.r2 > best.r2) best = { r2: r.r2, K: r.K, tau, d: d / fs };
    }
  }
  if (!best) return undefined;

  // 2) fine: exact 1/(τs+1)·e^(-sd) applied in the frequency domain
  const n = uf.length, N = nextPow2(2 * n), fft = fftOf(N);
  const buf = new Float64Array(N);
  buf.set(uf);
  const U = fft.createComplexArray() as number[];
  fft.realTransform(U, buf);
  fft.completeSpectrum(U);
  const X = fft.createComplexArray() as number[], y = fft.createComplexArray() as number[];
  const model = new Float64Array(n);
  const evalFit = (tau: number, d: number) => {
    for (let k = 0; k < N; k++) {
      const kk = k <= N / 2 ? k : k - N;
      const om = (2 * Math.PI * kk * fs) / N;
      // H = e^{-jωd} / (1 + jωτ)
      const den = 1 + om * om * tau * tau;
      const er = Math.cos(om * d), ei = -Math.sin(om * d);
      const hr = (er - ei * om * tau) / den, hi = (ei + er * om * tau) / den;
      const ur = U[2 * k], ui = U[2 * k + 1];
      X[2 * k] = ur * hr - ui * hi; X[2 * k + 1] = ur * hi + ui * hr;
    }
    fft.inverseTransform(y, X);
    for (let i = 0; i < n; i++) model[i] = y[2 * i];
    return lsFit(model, alpha, skip, sst);
  };
  let fine = { ...best };
  const dStep = 0.00025, tStep = 0.0005;
  for (let tau = Math.max(0.003, best.tau - 0.003); tau <= best.tau + 0.003 + 1e-9; tau += tStep) {
    for (let d = Math.max(0, best.d - 1.2 / fs); d <= best.d + 1.2 / fs + 1e-9; d += dStep) {
      const r = evalFit(tau, d);
      if (r.r2 > fine.r2) fine = { r2: r.r2, K: r.K, tau, d };
    }
  }
  return { axis, K: fine.K, tau: fine.tau, delay: fine.d, r2: fine.r2, t0, t1, fs, n: grid.length };
}

export interface LoopOptions { ff?: number; yawCutoff?: number; fmax?: number }
export interface LoopCurves {
  f: Float64Array; magL: Float64Array; phL: Float64Array; magS: Float64Array;
  /** predicted closed loop, rate setpoint -> logged (filtered) rate */
  magT: Float64Array; phT: Float64Array;
  margins: Margins | undefined;
}

/** Open loop, sensitivity, predicted closed loop and margins for a plant fit, gains and filter config. */
export function loopResponse(fit: PlantFit, gains: Gains, cfg: FilterConfig, opts: LoopOptions = {}): LoopCurves {
  const top = Math.min(opts.fmax ?? 100, cfg.fs / 2 - 1, cfg.ctrlRate / 2 - 1);
  const f = logspace(0.1, top, 4000);
  return loopAt(fit, gains, cfg, opts, f);
}

/** PX4 AlphaFilter as used on the yaw torque (update(x, dt) at the controller rate). */
function yawFilter(fc: number | undefined, ctrlRate: number, f: number): Cplx {
  if (!fc || !(fc > 0)) return { re: 1, im: 0 };
  const dt = 1 / ctrlRate, a = dt / (dt + 1 / (2 * Math.PI * fc));
  const w = 2 * Math.PI * f * dt;
  // a / (1 - (1-a) e^{-jw})
  return cdiv({ re: a, im: 0 }, { re: 1 - (1 - a) * Math.cos(w), im: (1 - a) * Math.sin(w) });
}

export function loopAt(fit: PlantFit, gains: Gains, cfg: FilterConfig, opts: LoopOptions, f: Float64Array): LoopCurves {
  const ai = AXES.indexOf(fit.axis);
  const r = chainResponse(cfg, f, ai);
  const yawFc = fit.axis === 'yaw' ? opts.yawCutoff : undefined;
  const ff = opts.ff ?? 0;
  const L: Cplx[] = [], T: Cplx[] = [];
  for (let k = 0; k < f.length; k++) {
    const w = 2 * Math.PI * f[k];
    const s: Cplx = { re: 0, im: w };
    // plant from torque to angular rate: K e^{-sd} / ((τs+1) s)
    const G = cdiv(cscale(cexpj(-w * fit.delay), fit.K), cmul(s, { re: 1, im: fit.tau * w }));
    const Hy = yawFilter(yawFc, cfg.ctrlRate, f[k]);
    const P = cscale(r.p[k], gains.p);
    const I = cdiv(cscale(r.p[k], gains.i), s);
    const D = cmul(cscale(r.d[k], gains.d), s);
    const Lk = cmul(cmul(cscale(cadd(cadd(P, I), D), gains.k), G), Hy);
    L.push(Lk);
    // setpoint path: (K(P + I/s) + FF) · Hy · G · H_p, closed by 1 + L
    const Cr = cadd(cscale(cadd({ re: gains.p, im: 0 }, cdiv({ re: gains.i, im: 0 }, s)), gains.k), { re: ff, im: 0 });
    const num = cmul(cmul(cmul(Cr, Hy), G), r.p[k]);
    T.push(cdiv(num, { re: 1 + Lk.re, im: Lk.im }));
  }
  const unwrapDeg = (a: Cplx[]) => {
    const o = new Float64Array(a.length);
    let prev = carg(a[0]), off = 0;
    o[0] = prev;
    for (let k = 1; k < a.length; k++) {
      let p = carg(a[k]) + off;
      while (p - prev > Math.PI) { p -= 2 * Math.PI; off -= 2 * Math.PI; }
      while (p - prev < -Math.PI) { p += 2 * Math.PI; off += 2 * Math.PI; }
      o[k] = p; prev = p;
    }
    return o.map((v) => (v * 180) / Math.PI);
  };
  const magL = Float64Array.from(L, (h) => 20 * Math.log10(cabs(h)));
  const phL = unwrapDeg(L);
  const magS = Float64Array.from(L, (h) => 20 * Math.log10(1 / cabs({ re: 1 + h.re, im: h.im })));
  const magT = Float64Array.from(T, (h) => 20 * Math.log10(cabs(h)));
  const phT = unwrapDeg(T);
  return { f, magL, phL, magS, magT, phT, margins: margins(f, magL, phL, magS) };
}

function margins(f: Float64Array, magL: Float64Array, phL: Float64Array, magS: Float64Array): Margins | undefined {
  // gain crossover: last downward crossing of 0 dB
  let kx = -1;
  for (let k = 1; k < magL.length; k++) if (magL[k - 1] >= 0 && magL[k] < 0) kx = k;
  if (kx < 0) return undefined;
  const fr = magL[kx - 1] / (magL[kx - 1] - magL[kx]);
  const fc = f[kx - 1] * (f[kx] / f[kx - 1]) ** fr;
  const phc = phL[kx - 1] + (phL[kx] - phL[kx - 1]) * fr;
  let pm = ((phc + 180) % 360 + 360) % 360;
  if (pm > 180) pm -= 360;
  // phase crossover: first crossing of -180° (mod 360) above the gain crossover
  let gm = Infinity, fGm = NaN;
  for (let k = kx; k < phL.length; k++) {
    const a = phL[k - 1], b = phL[k];
    const lvl = Math.floor((a + 180) / 360) * 360 - 180;
    if (a > lvl && b <= lvl) {
      const q = (a - lvl) / (a - b);
      gm = -(magL[k - 1] + (magL[k] - magL[k - 1]) * q);
      fGm = f[k - 1] * (f[k] / f[k - 1]) ** q;
      break;
    }
  }
  let smax = -Infinity, fS = 0;
  for (let k = 0; k < magS.length; k++) if (magS[k] > smax) { smax = magS[k]; fS = f[k]; }
  return { fc, pm, gm, fGm, smax: 10 ** (smax / 20), fSmax: fS };
}

export interface ClosedLoopCheck {
  f: Float64Array; magMeas: Float64Array; phMeas: Float64Array; coherence: Float64Array;
  magModel: Float64Array; phModel: Float64Array;
  /** RMS error over the coherent band (coherence ≥ 0.6, 0.5–10 Hz) */
  errDb: number; errDeg: number; nUsed: number; band: [number, number];
}

/**
 * Model check: closed loop measured in the log (vehicle_rates_setpoint -> vehicle_angular_velocity) against the
 * closed loop predicted by the fitted plant with the logged gains and filters.
 */
export function closedLoopCheck(log: ULog, fit: PlantFit, gains: Gains, cfg: FilterConfig, opts: LoopOptions): ClosedLoopCheck | undefined {
  const rs = log.topic('vehicle_rates_setpoint'), av = log.topic('vehicle_angular_velocity');
  if (!rs || !av) return undefined;
  const tav = log.sampleTime('vehicle_angular_velocity')!;
  const fs = sampleRate(tav);
  const grid = uniformGrid(fit.t0, fit.t1, fs);
  if (grid.length < 600) return undefined;
  const sp = interp(grid, rs.t, rs.cols[fit.axis]);
  const w = interp(grid, tav, av.cols[`xyz[${AXES.indexOf(fit.axis)}]`]);
  const nseg = Math.min(1024, 2 ** Math.floor(Math.log2(grid.length / 3)));
  const m = transferEstimate(sp, w, fs, nseg);
  const keep: number[] = [];
  for (let k = 1; k < m.f.length; k++) if (m.f[k] <= Math.min(20, fs / 4)) keep.push(k);
  const fq = Float64Array.from(keep, (k) => m.f[k]);
  const model = loopAt(fit, gains, cfg, opts, fq);
  const magMeas = Float64Array.from(keep, (k) => 20 * Math.log10(m.mag[k]));
  // measured phase, wrapped to the model's branch
  const phMeas = Float64Array.from(keep, (k, j) => {
    let p = (m.phase[k] * 180) / Math.PI;
    while (p - model.phT[j] > 180) p -= 360;
    while (p - model.phT[j] < -180) p += 360;
    return p;
  });
  const coh = Float64Array.from(keep, (k) => m.coherence[k]);
  const band: [number, number] = [0.5, 10];
  let sDb = 0, sDeg = 0, nU = 0;
  for (let j = 0; j < fq.length; j++) {
    if (fq[j] < band[0] || fq[j] > band[1] || coh[j] < 0.6) continue;
    sDb += (magMeas[j] - model.magT[j]) ** 2; sDeg += (phMeas[j] - model.phT[j]) ** 2; nU++;
  }
  return {
    f: fq, magMeas, phMeas, coherence: coh, magModel: model.magT, phModel: model.phT,
    errDb: nU ? Math.sqrt(sDb / nU) : NaN, errDeg: nU ? Math.sqrt(sDeg / nU) : NaN, nUsed: nU, band,
  };
}

export function loopOptions(P: Map<string, number>, axis: Axis): LoopOptions {
  return { ff: P.get(`MC_${axis.toUpperCase()}RATE_FF`) ?? 0, yawCutoff: axis === 'yaw' ? P.get('MC_YAW_TQ_CUTOFF') ?? 2 : undefined };
}

export function defaultConfigs(log: ULog): { cur: FilterConfig } {
  return { cur: configFromParams(log) };
}

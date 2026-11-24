/**
 * Rate-loop plant identification from stick doublets and loop margins.
 * Model: angular acceleration = K * lag(tau) * delay(d) * torque_setpoint  (fit on band-passed data, R²).
 * Open loop: L = K_rate*(P*Hn*Hl + I/s*Hn*Hl + D*s*Hn*Hd) * Gp,  Gp = K e^{-sd} / (s (tau s + 1)) / (Hn_id*Hl_id)
 * (the identified plant already contains the filters active in the log, which are divided out).
 */
import type { ULog } from '../ulog';
import { butterworth, filtfilt, interp, sampleRate, uniformGrid, logspace, Cplx, cmul, cadd, cdiv, cabs, carg, cexpj, cscale, transferEstimate, lowerBound } from '../dsp';
import { airborneIntervals, AXES, Axis } from '../px4';
import { FilterConfig, chainResponse, configFromParams } from './filters';

export interface Doublet { axis: Axis; t0: number; t1: number; peakDegS: number }
export interface PlantFit { axis: Axis; K: number; tau: number; delay: number; r2: number; t0: number; t1: number; fs: number; n: number }
export interface Gains { k: number; p: number; i: number; d: number }
export interface Margins { fc: number; pm: number; gm: number; smax: number; fSmax: number }

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

/** Fit K, tau, delay on window [t0,t1] for an axis. */
export function identify(log: ULog, axis: Axis, t0: number, t1: number): PlantFit | undefined {
  const tq = log.topic('vehicle_torque_setpoint'), av = log.topic('vehicle_angular_velocity');
  if (!tq || !av) return undefined;
  const ai = AXES.indexOf(axis);
  const tav = log.sampleTime('vehicle_angular_velocity')!;
  const ttq = log.sampleTime('vehicle_torque_setpoint')!;
  const fs = sampleRate(tav);
  if (fs < 80) return undefined;
  const grid = uniformGrid(t0, t1, fs);
  if (grid.length < fs * 2) return undefined;
  const u = interp(grid, ttq, tq.cols[`xyz[${ai}]`]);
  const w = interp(grid, tav, av.cols[`xyz[${ai}]`]);
  const lp = butterworth(4, Math.min(15, fs / 4), fs), hp = butterworth(2, 0.5, fs, 'high');
  const uf = filtfilt(hp, filtfilt(lp, u)), wf = filtfilt(hp, filtfilt(lp, w));
  const alpha = gradient(wf, fs);
  const skip = Math.round(0.15 * fs);
  let best: { r2: number; K: number; tau: number; d: number } | undefined;
  const yy = alpha.subarray(skip);
  let ym = 0; for (const v of yy) ym += v; ym /= yy.length;
  let sst = 0; for (const v of yy) sst += (v - ym) ** 2;
  const maxD = Math.min(Math.round(0.12 * fs), skip);
  const ul = new Float64Array(uf.length);
  for (let tau = 0.005; tau <= 0.15; tau += 0.0025) {
    const ad = Math.exp(-1 / (fs * tau));
    let s = 0;
    for (let i = 0; i < uf.length; i++) { s = ad * s + (1 - ad) * uf[i]; ul[i] = s; }
    for (let d = 0; d <= maxD; d++) {
      let xy = 0, xx = 0;
      for (let i = skip; i < uf.length; i++) { const x = ul[i - d]; xy += x * alpha[i]; xx += x * x; }
      const K = xy / xx;
      let sse = 0;
      for (let i = skip; i < uf.length; i++) sse += (alpha[i] - K * ul[i - d]) ** 2;
      const r2 = 1 - sse / sst;
      if (!best || r2 > best.r2) best = { r2, K, tau, d };
    }
  }
  if (!best) return undefined;
  return { axis, K: best.K, tau: best.tau, delay: best.d / fs, r2: best.r2, t0, t1, fs, n: grid.length };
}

export interface LoopCurves { f: Float64Array; magL: Float64Array; phL: Float64Array; magS: Float64Array; margins: Margins | undefined }

/** Open-loop response and margins for a plant fit, gains and filter config. */
export function loopResponse(fit: PlantFit, gains: Gains, cfg: FilterConfig, cfgId: FilterConfig, fmax = 100): LoopCurves {
  const top = Math.min(fmax, cfg.fs / 2 - 1);
  const f = logspace(0.1, top, 4000);
  const r = chainResponse(cfg, f), rid = chainResponse(cfgId, f);
  const L: Cplx[] = [];
  for (let k = 0; k < f.length; k++) {
    const w = 2 * Math.PI * f[k];
    const s: Cplx = { re: 0, im: w };
    // plant
    const den = cmul(s, { re: 1, im: fit.tau * w });
    let Gp = cdiv(cscale(cexpj(-w * fit.delay), fit.K), den);
    Gp = cdiv(Gp, rid.p[k]);
    // controller
    const P = cscale(r.p[k], gains.p);
    const I = cdiv(cscale(r.p[k], gains.i), s);
    const D = cmul(cscale(r.d[k], gains.d), s);
    const C = cscale(cadd(cadd(P, I), D), gains.k);
    L.push(cmul(C, Gp));
  }
  const magL = Float64Array.from(L, (h) => 20 * Math.log10(cabs(h)));
  // unwrap phase
  const phL = new Float64Array(L.length);
  let prev = carg(L[0]), off = 0;
  phL[0] = prev;
  for (let k = 1; k < L.length; k++) {
    let p = carg(L[k]) + off;
    while (p - prev > Math.PI) { p -= 2 * Math.PI; off -= 2 * Math.PI; }
    while (p - prev < -Math.PI) { p += 2 * Math.PI; off += 2 * Math.PI; }
    phL[k] = p; prev = p;
  }
  const magS = Float64Array.from(L, (h) => 20 * Math.log10(1 / cabs({ re: 1 + h.re, im: h.im })));
  let margins: Margins | undefined;
  const kx = magL.findIndex((v, k) => k > 0 && magL[k - 1] >= 0 && v < 0);
  if (kx > 0) {
    let pm = ((phL[kx] * 180) / Math.PI + 180) % 360;
    if (pm > 180) pm -= 360;
    if (pm < -180) pm += 360;
    let gm = Infinity;
    for (let k = 1; k < phL.length; k++) {
      // first crossing of -180 deg (mod 360) after crossover
      const a = ((phL[k - 1] * 180) / Math.PI), b = ((phL[k] * 180) / Math.PI);
      const n180 = Math.floor((a + 180) / 360);
      const lvl = n180 * 360 - 180;
      if (a > lvl && b <= lvl) { gm = -magL[k]; break; }
    }
    let smax = -Infinity, fS = 0;
    for (let k = 0; k < magS.length; k++) if (magS[k] > smax) { smax = magS[k]; fS = f[k]; }
    margins = { fc: f[kx], pm, gm, smax: 10 ** (smax / 20), fSmax: fS };
  }
  return { f, magL, phL: phL.map((v) => (v * 180) / Math.PI), magS, margins };
}

/** Measured closed-loop |rate/rate_sp| on a window. */
export function measuredClosedLoop(log: ULog, axis: Axis, t0: number, t1: number) {
  const rs = log.topic('vehicle_rates_setpoint'), av = log.topic('vehicle_angular_velocity');
  if (!rs || !av) return undefined;
  const tav = log.sampleTime('vehicle_angular_velocity')!;
  const fs = sampleRate(tav);
  const grid = uniformGrid(t0, t1, fs);
  if (grid.length < 600) return undefined;
  const sp = interp(grid, rs.t, rs.cols[axis]);
  const w = interp(grid, tav, av.cols[`xyz[${AXES.indexOf(axis)}]`]);
  const r = transferEstimate(sp, w, fs, 512);
  return [1, 2, 3, 4, 5, 6, 8].map((q) => {
    const j = Math.min(r.f.length - 1, lowerBound(r.f, q));
    return { f: q, mag: r.mag[j], phaseDeg: (r.phase[j] * 180) / Math.PI, coherence: r.coherence[j] };
  });
}

export function defaultConfigs(log: ULog): { cur: FilterConfig } {
  return { cur: configFromParams(log) };
}

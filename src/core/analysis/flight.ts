/** Smaller per-flight analyses: quiet-hover spectra, aliasing, motors, hover thrust, GPS readiness, timing. */
import type { ULog } from '../ulog';
import { unpackFifo } from '../ulog';
import {
  welchMulti, bandRms, peakIn, Spectrum, sampleRate, diff, median, percentile, mean, interp, lowerBound, maskSegments, minMax,
} from '../dsp';
import { quietHoverWindows, chunks, inWindows, armedIntervals, airborneIntervals, gnssTopic, eulerCols, QuietWindows } from '../px4';
import type { Finding } from '../types';

export const DEG = 180 / Math.PI;

// ------------------------------------------------------------ quiet hover spectra
export interface QuietSpectra {
  q: QuietWindows;
  gyro?: { fs: number; source: string; s: Spectrum[] }; // roll, pitch, yaw [deg/s]^2/Hz
  fifo?: { fs: number; s: Spectrum[] };
  angvel?: { fs: number; s: Spectrum[] };
  accZ?: { fs: number; s: Spectrum };
  torque?: { fs: number; s: Spectrum[] };
  metrics: Record<string, number>;
  peaks: { f: number; source: string; axis: string }[];
}

export function quietSpectra(log: ULog, windowsOverride?: [number, number][]): QuietSpectra {
  const q = windowsOverride ? { windows: windowsOverride, threshold: 'all' as const, totalS: windowsOverride.reduce((s, [a, b]) => s + b - a, 0), reason: 'selected range' } : quietHoverWindows(log);
  const out: QuietSpectra = { q, metrics: {}, peaks: [] };
  const W = q.windows;
  if (!W.length) return out;
  const sc = log.topic('sensor_combined');
  if (sc) {
    const fs = sampleRate(sc.t);
    const s = [0, 1, 2].map((i) => welchMulti(chunks(sc.t, sc.cols[`gyro_rad[${i}]`].map((v) => v * DEG), W), fs, 512));
    if (s.every(Boolean)) {
      out.gyro = { fs, source: 'sensor_combined', s: s as Spectrum[] };
      ['roll', 'pitch', 'yaw'].forEach((n, i) => {
        out.metrics[`vib_${n}`] = bandRms(s[i]!, 30, Math.min(75, fs / 2));
        out.metrics[`osc_${n}`] = bandRms(s[i]!, 2, 6);
        const pk = peakIn(s[i]!, 20, fs / 2);
        out.metrics[`peak_${n}`] = pk.f;
      });
    }
    const az = welchMulti(chunks(sc.t, sc.cols['accelerometer_m_s2[2]'], W), fs, 512);
    if (az) { out.accZ = { fs, s: az }; out.metrics.accZ_vib = bandRms(az, 30, fs / 2); }
  }
  if (log.has('sensor_gyro_fifo')) {
    const f = unpackFifo(log, 'sensor_gyro_fifo');
    if (f && f.fs > 0) {
      const s = [f.x, f.y, f.z].map((a) => welchMulti(chunks(f.t, a.map((v) => v * DEG), W), f.fs, 2048));
      if (s.every(Boolean)) {
        out.fifo = { fs: f.fs, s: s as Spectrum[] };
        for (const [i, ax] of ['x', 'y', 'z'].entries()) {
          const pk = peakIn(s[i]!, 15, Math.min(f.fs / 2, 500));
          out.peaks.push({ f: pk.f, source: 'sensor_gyro_fifo', axis: ax });
        }
      }
    }
  }
  if (!out.fifo && out.gyro) ['roll', 'pitch', 'yaw'].forEach((n, i) => out.peaks.push({ f: peakIn(out.gyro!.s[i], 15, out.gyro!.fs / 2).f, source: 'sensor_combined', axis: n }));
  const av = log.topic('vehicle_angular_velocity');
  if (av) {
    const t = log.sampleTime('vehicle_angular_velocity')!;
    const fs = sampleRate(t);
    const s = [0, 1, 2].map((i) => welchMulti(chunks(t, av.cols[`xyz[${i}]`].map((v) => v * DEG), W), fs, fs > 150 ? 512 : 128));
    if (s.every(Boolean)) out.angvel = { fs, s: s as Spectrum[] };
  }
  const tq = log.topic('vehicle_torque_setpoint');
  if (tq) {
    const t = tq.t;
    const fs = sampleRate(t);
    const s = [0, 1, 2].map((i) => welchMulti(chunks(t, tq.cols[`xyz[${i}]`], W), fs, fs > 150 ? 512 : 128));
    if (s.every(Boolean)) out.torque = { fs, s: s as Spectrum[] };
  }
  const vi = log.topic('vehicle_imu_status');
  if (vi && vi.cols['accel_vibration_metric']) {
    const m = inWindows(vi.t, W);
    const v = vi.cols['accel_vibration_metric'].filter((_, i) => m[i]);
    out.metrics.accel_vib_metric = mean(v);
  }
  return out;
}

// ------------------------------------------------------------ aliasing
export interface AliasWarning { topic: string; rateHz: number; vibHz: number; aliasHz: number; severity: 'warning' | 'info'; text: string }
const DYNAMIC_TOPICS = [
  'vehicle_angular_velocity', 'vehicle_rates_setpoint', 'vehicle_attitude', 'vehicle_attitude_setpoint', 'vehicle_torque_setpoint',
  'vehicle_thrust_setpoint', 'actuator_motors', 'actuator_outputs', 'sensor_combined', 'vehicle_acceleration', 'rate_ctrl_status',
  'vehicle_local_position', 'manual_control_setpoint',
];

/** Topics whose content is used for tuning/oscillation analysis (aliasing there misleads). */
const CORE_TOPICS = ['vehicle_angular_velocity', 'vehicle_rates_setpoint', 'vehicle_torque_setpoint', 'vehicle_thrust_setpoint', 'actuator_motors', 'actuator_outputs', 'sensor_combined', 'vehicle_attitude', 'vehicle_attitude_setpoint'];

export function loggedRate(log: ULog, key: string): number {
  const d = log.topic(key);
  if (!d || d.count < 5) return 0;
  return sampleRate(log.sampleTime(key) ?? d.t);
}

export function aliasingCheck(log: ULog, qs?: QuietSpectra): { vib: number[]; source: string; warnings: AliasWarning[] } {
  const spectra = qs ?? quietSpectra(log);
  const vib: number[] = [];
  let source = 'none';
  // dominant vibration (prop) frequencies: from FIFO if available, else from the fastest gyro
  if (spectra.fifo) {
    source = `sensor_gyro_fifo @ ${spectra.fifo.fs.toFixed(0)} Hz`;
    for (const s of spectra.fifo.s.slice(0, 2)) { const p = peakIn(s, 15, Math.min(spectra.fifo.fs / 2, 400)); if (p.f) vib.push(p.f); }
  } else if (spectra.gyro) {
    source = `sensor_combined @ ${spectra.gyro.fs.toFixed(0)} Hz`;
    for (const s of spectra.gyro.s.slice(0, 2)) { const p = peakIn(s, 15, spectra.gyro.fs / 2 - 2); if (p.f) vib.push(p.f); }
  }
  const fv = vib.length ? median(vib) : 0;
  const warnings: AliasWarning[] = [];
  for (const key of DYNAMIC_TOPICS) {
    const r = loggedRate(log, key);
    if (!r) continue;
    if (fv > 0 && r < 2 * fv * 1.05) {
      const k = Math.round(fv / r);
      const fa = Math.abs(fv - k * r);
      warnings.push({
        topic: key, rateHz: r, vibHz: fv, aliasHz: fa, severity: fa < 10 && CORE_TOPICS.includes(key) ? 'warning' : 'info',
        text: `${key} logged at ${r.toFixed(0)} Hz (Nyquist ${(r / 2).toFixed(0)} Hz): the ~${fv.toFixed(0)} Hz vibration folds to ~${fa.toFixed(1)} Hz in this topic — slow oscillations seen there may be fake.`,
      });
    } else if (r < 100 && ['vehicle_angular_velocity', 'vehicle_rates_setpoint', 'vehicle_torque_setpoint', 'actuator_motors'].includes(key)) {
      warnings.push({ topic: key, rateHz: r, vibHz: fv, aliasHz: NaN, severity: 'info', text: `${key} logged at only ${r.toFixed(0)} Hz: too slow for oscillation/vibration analysis (use a high-rate SDLOG_PROFILE).` });
    }
  }
  return { vib, source, warnings };
}

// ------------------------------------------------------------ motors
export interface MotorImbalance {
  windowsS: number;
  means: number[];
  devPct: number[];
  geometry?: { px: number[]; py: number[]; km: number[] };
  cog?: { x: number; y: number }; // m (from thrust-weighted rotor positions)
  yawResidual?: number; // sum(T_i*km_i)/sum(T_i)
  saturationPct: number; // % of airborne time with any motor >= 0.98
  jitterPct?: number;
  text: string[];
}

export function motorImbalance(log: ULog): MotorImbalance | undefined {
  const am = log.topic('actuator_motors');
  if (!am) return undefined;
  const q = quietHoverWindows(log);
  const W = q.windows.length ? q.windows : airborneIntervals(log);
  if (!W.length) return undefined;
  const m = inWindows(am.t, W);
  const n = (() => { let k = 0; while (am.cols[`control[${k}]`] && !am.cols[`control[${k}]`].every((v) => v !== v || v === 0)) k++; return k; })();
  if (!n) return undefined;
  const means: number[] = [];
  for (let k = 0; k < n; k++) means.push(mean(am.cols[`control[${k}]`].filter((_, i) => m[i])));
  const avg = means.reduce((a, b) => a + b, 0) / n;
  const devPct = means.map((v) => (100 * (v - avg)) / avg);
  const P = log.params;
  const res: MotorImbalance = { windowsS: W.reduce((s, [a, b]) => s + b - a, 0), means, devPct, saturationPct: 0, text: [] };
  if (P.has('CA_ROTOR0_PX')) {
    const px: number[] = [], py: number[] = [], km: number[] = [];
    for (let k = 0; k < n; k++) { px.push(P.get(`CA_ROTOR${k}_PX`) ?? 0); py.push(P.get(`CA_ROTOR${k}_PY`) ?? 0); km.push(P.get(`CA_ROTOR${k}_KM`) ?? 0); }
    res.geometry = { px, py, km };
    const sumT = means.reduce((a, b) => a + b, 0);
    res.cog = { x: means.reduce((s, T, k) => s + T * px[k], 0) / sumT, y: means.reduce((s, T, k) => s + T * py[k], 0) / sumT };
    res.yawResidual = means.reduce((s, T, k) => s + T * km[k], 0) / sumT;
    const arm = Math.max(...px.map((x, k) => Math.hypot(x, py[k])));
    res.text.push(`Thrust-weighted centre ≈ ${(res.cog.x * 100).toFixed(1)} cm forward, ${(res.cog.y * 100).toFixed(1)} cm right of the geometric centre (${((Math.hypot(res.cog.x, res.cog.y) / (arm || 1)) * 100).toFixed(1)}% of arm length): the CoG is likely offset this way (or rotor geometry/props differ).`);
    if (Math.abs(res.yawResidual) > 0.002) res.text.push(`Persistent yaw torque demand (Σ T·KM / Σ T = ${res.yawResidual.toFixed(4)}): the CW/CCW motor pairs work differently — check motor tilt/twisted arms, prop pitch differences or KM.`);
  }
  const air = airborneIntervals(log);
  const ma = inWindows(am.t, air);
  let sat = 0, tot = 0;
  for (let i = 0; i < am.count; i++) {
    if (!ma[i]) continue;
    tot++;
    for (let k = 0; k < n; k++) if (am.cols[`control[${k}]`][i] >= 0.98) { sat++; break; }
  }
  res.saturationPct = tot ? (100 * sat) / tot : 0;
  const worst = Math.max(...devPct.map(Math.abs));
  res.text.unshift(`Largest motor deviation from mean: ${worst.toFixed(1)}% (quiet hover, ${res.windowsS.toFixed(0)} s).`);
  return res;
}

// ------------------------------------------------------------ hover thrust vs voltage
export interface HoverThrust {
  t: Float64Array; ht: Float64Array; v: Float64Array; norm: Float64Array; vref: number; cells: number;
  meanHt: number; meanNorm: number; driftPct: number; batScale: boolean;
}

export function hoverThrust(log: ULog, vrefOverride?: number): HoverThrust | undefined {
  const h = log.topic('hover_thrust_estimate'), b = log.topic('battery_status');
  if (!h || !b) return undefined;
  const air = airborneIntervals(log);
  const m = inWindows(h.t, air.map(([a, c]) => [a + 5, c - 3] as [number, number]));
  const idx: number[] = [];
  for (let i = 0; i < h.count; i++) if (m[i] && (h.cols['valid'] ? h.cols['valid'][i] : 1)) idx.push(i);
  if (idx.length < 10) return undefined;
  const t = Float64Array.from(idx, (i) => h.t[i]);
  const ht = Float64Array.from(idx, (i) => h.cols['hover_thrust'][i]);
  const v = interp(t, b.t, b.cols['voltage_v']);
  const cells = log.params.get('BAT1_N_CELLS') ?? (b.cols['cell_count'] ? b.cols['cell_count'][0] : 0);
  const vref = vrefOverride ?? (cells > 0 ? cells * 3.9 : median(v));
  const norm = Float64Array.from(ht, (x, i) => (x * v[i]) / vref);
  const third = Math.max(1, Math.floor(norm.length / 3));
  const a = mean(norm.subarray(0, third)), c = mean(norm.subarray(norm.length - third));
  return { t, ht, v, norm, vref, cells, meanHt: mean(ht), meanNorm: mean(norm), driftPct: (100 * (c - a)) / a, batScale: (log.params.get('MC_BAT_SCALE_EN') ?? 0) > 0 };
}

// ------------------------------------------------------------ GPS readiness at arming
export interface GpsReadiness {
  armT?: number;
  rows: [string, string][];
  findings: Finding[];
  timeline: { label: string; t: Float64Array; y: Float32Array }[];
}

const GPS_CHECKS: [string, string][] = [
  ['check_fail_gps_fix', 'fix'], ['check_fail_min_sat_count', 'min satellites'], ['check_fail_max_pdop', 'PDOP'],
  ['check_fail_max_horz_err', 'horizontal error'], ['check_fail_max_vert_err', 'vertical error'], ['check_fail_max_spd_err', 'speed error'],
  ['check_fail_max_horz_drift', 'horizontal drift'], ['check_fail_max_vert_drift', 'vertical drift'],
  ['check_fail_max_horz_spd_err', 'horizontal speed error'], ['check_fail_max_vert_spd_err', 'vertical speed error'], ['check_fail_spoofed_gps', 'spoofing'],
];

export function gpsReadiness(log: ULog): GpsReadiness | undefined {
  const gk = gnssTopic(log);
  if (!gk) return undefined;
  const g = log.topic(gk)!;
  const arms = armedIntervals(log);
  const armT = arms[0]?.[0];
  const res: GpsReadiness = { armT, rows: [], findings: [], timeline: [] };
  const at = (key: string, field: string, t: number) => {
    const d = log.topic(key);
    if (!d || !d.cols[field]) return undefined;
    const i = Math.max(0, lowerBound(d.t, t) - 1);
    return d.cols[field][i];
  };
  const firstTime = (key: string, field: string, pred: (v: number) => boolean) => {
    const d = log.topic(key);
    if (!d || !d.cols[field]) return undefined;
    for (let i = 0; i < d.count; i++) if (pred(d.cols[field][i])) return d.t[i];
    return undefined;
  };
  const t3d = firstTime(gk, 'fix_type', (v) => v >= 3);
  const tPass = firstTime('estimator_gps_status', 'checks_passed', (v) => v > 0);
  const tPos = firstTime('estimator_status_flags', 'cs_gnss_pos', (v) => v > 0);
  const tVel = firstTime('estimator_status_flags', 'cs_gnss_vel', (v) => v > 0);
  const tHgt = firstTime('estimator_status_flags', 'cs_gps_hgt', (v) => v > 0);
  const fmtT = (t?: number) => (t === undefined ? 'never' : `${t.toFixed(1)} s${armT !== undefined ? ` (${(t - armT >= 0 ? '+' : '')}${(t - armT).toFixed(1)} s vs arming)` : ''}`);
  res.rows.push(['First 3D fix', fmtT(t3d)], ['GPS checks passed (EKF2)', fmtT(tPass)], ['EKF2 using GNSS position', fmtT(tPos)], ['EKF2 using GNSS velocity', fmtT(tVel)], ['EKF2 using GNSS height', fmtT(tHgt)]);
  if (armT !== undefined) {
    res.rows.push(['Armed at', `${Math.abs(armT) < 0.05 ? '0.0' : armT.toFixed(1)} s${armT < 1 ? ' (log started at arming)' : ''}`]);
    const v = (f: string, d = 1) => { const x = at(gk, f, armT); return x === undefined ? '–' : x.toFixed(d); };
    res.rows.push(['Fix type @arm', v('fix_type', 0)], ['Satellites @arm', v('satellites_used', 0)], ['EPH / EPV @arm [m]', `${v('eph', 2)} / ${v('epv', 2)}`],
      ['HDOP / VDOP @arm', `${v('hdop', 2)} / ${v('vdop', 2)}`], ['Speed accuracy @arm [m/s]', v('s_variance_m_s', 2)],
      ['Jamming indicator / state @arm', `${v('jamming_indicator', 0)} / ${v('jamming_state', 0)}`], ['Noise / AGC @arm', `${v('noise_per_ms', 0)} / ${v('automatic_gain_control', 0)}`],
      ['Spoofing state @arm', v('spoofing_state', 0)]);
    const failing = GPS_CHECKS.filter(([f]) => (at('estimator_gps_status', f, armT) ?? 0) > 0).map(([, n]) => n);
    if (failing.length) res.rows.push(['GPS checks failing @arm', failing.join(', ')]);
    const usingPos = (at('estimator_status_flags', 'cs_gnss_pos', armT) ?? 0) > 0;
    const passed = (at('estimator_gps_status', 'checks_passed', armT) ?? 0) > 0;
    if (!usingPos) res.findings.push({ tone: 'warning', title: 'Armed before EKF2 was using GNSS position', detail: tPos !== undefined ? `GNSS fusion started ${(tPos - armT).toFixed(1)} s after arming.` : 'GNSS position was never fused.' });
    else if (!passed) res.findings.push({ tone: 'warning', title: 'Armed with EKF2 GPS checks failing', detail: failing.join(', ') });
    else res.findings.push({ tone: 'good', title: 'GPS ready at arming', detail: `EKF2 fusing GNSS since ${(armT - (tPos ?? armT)).toFixed(0)} s before arming.` });
    const j = at(gk, 'jamming_state', armT) ?? 0, sp = at(gk, 'spoofing_state', armT) ?? 0;
    if (j >= 2) res.findings.push({ tone: 'warning', title: 'Jamming detected by the receiver at arming', detail: `jamming_state=${j}` });
    if (sp >= 2) res.findings.push({ tone: 'danger', title: 'Spoofing detected by the receiver at arming', detail: `spoofing_state=${sp}` });
  } else res.findings.push({ tone: 'info', title: 'Vehicle never armed in this log' });
  const add = (label: string, key: string, field: string, sc = 1) => {
    const d = log.topic(key);
    if (d && d.cols[field]) res.timeline.push({ label, t: d.t, y: Float32Array.from(d.cols[field], (x) => x * sc) });
  };
  add('Fix type', gk, 'fix_type'); add('Satellites (/5)', gk, 'satellites_used', 0.2); add('EPH [m]', gk, 'eph');
  add('GPS checks passed', 'estimator_gps_status', 'checks_passed'); add('EKF2 GNSS pos fused', 'estimator_status_flags', 'cs_gnss_pos');
  void g;
  return res;
}

// ------------------------------------------------------------ timing & logging rates
export interface TopicRate { key: string; count: number; meanHz: number; medianHz: number; p99Ms: number; maxMs: number; cv: number }

export function topicRates(log: ULog): TopicRate[] {
  const out: TopicRate[] = [];
  for (const m of log.allTopicMeta()) {
    const d = log.topic(m.key)!;
    if (d.count < 3) { out.push({ key: m.key, count: d.count, meanHz: m.rate, medianHz: 0, p99Ms: NaN, maxMs: NaN, cv: NaN }); continue; }
    const t = log.sampleTime(m.key) ?? d.t;
    const dt = diff(t);
    const med = median(dt);
    const mu = mean(dt);
    let s = 0; for (const v of dt) s += (v - mu) ** 2;
    out.push({ key: m.key, count: d.count, meanHz: m.rate, medianHz: med > 0 ? 1 / med : 0, p99Ms: percentile(dt, 99) * 1e3, maxMs: minMax(dt)[1] * 1e3, cv: Math.sqrt(s / dt.length) / mu });
  }
  return out.sort((a, b) => b.meanHz - a.meanHz);
}

export interface LoopTiming { name: string; rate: number; median: number; p99: number; p999: number; max: number; judged: boolean }

export function loopTiming(log: ULog): { loops: LoopTiming[]; latency?: { median: number; p999: number; max: number }; cpu?: { mean: number; p95: number; max: number; ram: number }; intervalHist: { ms: number; count: number }[] } {
  const arms = armedIntervals(log);
  const a0 = arms[0]?.[0] ?? 0, a1 = arms.length ? arms[arms.length - 1][1] : log.durationS;
  const drops = log.dropouts.map((d) => [d.t, d.durationMs / 1000] as [number, number]);
  const loops: LoopTiming[] = [];
  for (const [topic, name] of [['vehicle_angular_velocity', 'Gyro filter → rate controller'], ['vehicle_attitude', 'EKF attitude'], ['vehicle_rates_setpoint', 'Attitude controller'], ['sensor_combined', 'IMU → EKF'], ['vehicle_torque_setpoint', 'Rate controller output']] as const) {
    const d = log.topic(topic);
    if (!d) continue;
    const t = log.sampleTime(topic) ?? d.t;
    const dt: number[] = [];
    for (let i = 1; i < t.length; i++) {
      if (t[i] < a0 + 1 || t[i] > a1 - 1) continue;
      if (drops.some(([ts, dd]) => t[i - 1] < ts + dd + 0.05 && t[i] > ts - 0.05)) continue;
      dt.push((t[i] - t[i - 1]) * 1e3);
    }
    if (dt.length < 50) continue;
    const med = median(dt);
    loops.push({ name: `${name} (${topic})`, rate: 1000 / med, median: med, p99: percentile(dt, 99), p999: percentile(dt, 99.9), max: minMax(dt)[1], judged: 1000 / med >= 150 });
  }
  let latency;
  const tq = log.topic('vehicle_torque_setpoint');
  if (tq && tq.cols['timestamp_sample']) {
    const lat = Array.from(tq.cols['timestamp'], (v, i) => (v - tq.cols['timestamp_sample'][i]) / 1e3).filter((v) => v >= 0 && v < 1000);
    if (lat.length) latency = { median: median(lat), p999: percentile(lat, 99.9), max: minMax(lat)[1] };
  }
  let cpu;
  const cl = log.topic('cpuload');
  if (cl) {
    const m = inWindows(cl.t, arms.length ? arms : [[0, log.durationS]]);
    const l = Array.from(cl.cols['load']).filter((_, i) => m[i]).map((v) => v * 100);
    const r = Array.from(cl.cols['ram_usage']).filter((_, i) => m[i]).map((v) => v * 100);
    if (l.length) cpu = { mean: mean(l), p95: percentile(l, 95), max: minMax(l)[1], ram: mean(r) };
  }
  // interval histogram of the fastest controller topic (reveals logger cycle quantisation)
  const intervalHist: { ms: number; count: number }[] = [];
  const av = log.topic('vehicle_angular_velocity');
  if (av) {
    const dt = diff(av.t);
    const h = new Map<number, number>();
    for (const v of dt) { const k = Math.round(v * 1e3 * 2) / 2; if (k <= 50) h.set(k, (h.get(k) ?? 0) + 1); }
    for (const [ms, count] of [...h.entries()].sort((x, y) => x[0] - y[0])) if (count > dt.length * 0.005) intervalHist.push({ ms, count });
  }
  return { loops, latency, cpu, intervalHist };
}

// ------------------------------------------------------------ tracking quality (quiet hover)
export function attitudeErrorRms(log: ULog, W: [number, number][]): { roll: number; pitch: number } | undefined {
  const att = log.topic('vehicle_attitude'), sp = log.topic('vehicle_attitude_setpoint');
  if (!att || !sp || !W.length) return undefined;
  const e = eulerCols(att, 'q'), es = eulerCols(sp, 'q_d');
  if (!e || !es) return undefined;
  const m = inWindows(sp.t, W);
  const tq: number[] = [];
  const rs: number[] = [], ps: number[] = [];
  for (let i = 0; i < sp.count; i++) if (m[i]) { tq.push(sp.t[i]); rs.push(es.roll[i]); ps.push(es.pitch[i]); }
  if (tq.length < 10) return undefined;
  const r = interp(tq, att.t, e.roll), p = interp(tq, att.t, e.pitch);
  let sr = 0, spp = 0;
  for (let i = 0; i < tq.length; i++) { sr += ((r[i] - rs[i]) * DEG) ** 2; spp += ((p[i] - ps[i]) * DEG) ** 2; }
  return { roll: Math.sqrt(sr / tq.length), pitch: Math.sqrt(spp / tq.length) };
}

export function tiltStats(log: ULog, W: [number, number][]): { quietTilt: number; maxTilt: number } | undefined {
  const att = log.topic('vehicle_attitude');
  if (!att) return undefined;
  const e = eulerCols(att, 'q')!;
  const air = airborneIntervals(log);
  const ma = inWindows(att.t, air);
  let maxT = 0;
  for (let i = 0; i < att.count; i++) if (ma[i]) maxT = Math.max(maxT, Math.acos(Math.cos(e.roll[i]) * Math.cos(e.pitch[i])) * DEG);
  const mq = inWindows(att.t, W);
  const r: number[] = [], p: number[] = [];
  for (let i = 0; i < att.count; i++) if (mq[i]) { r.push(e.roll[i] * DEG); p.push(e.pitch[i] * DEG); }
  const mr = mean(r), mp = mean(p);
  let s = 0; for (let i = 0; i < r.length; i++) s += Math.hypot(r[i] - mr, p[i] - mp);
  return { quietTilt: r.length ? s / r.length : NaN, maxTilt: maxT };
}

export { maskSegments };

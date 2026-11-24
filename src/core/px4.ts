/** PX4-specific helpers: modes, versions, flight phases, quiet-hover detection. */
import { ULog, TopicData } from './ulog';
import { maskSegments, lowerBound } from './dsp';
import type { ModeSegment } from './types';
import airframes from '../assets/px4/airframes.json';
import paramMeta from '../assets/px4/parameters.json';

export const PARAM_META = paramMeta as unknown as Record<string, {
  t: string; g: string; d?: number; s?: string; min?: number; max?: number; u?: string; dec?: number;
  v?: Record<string, string>; b?: Record<string, string>;
}>;

/** Flight mode names & colors (same as Flight Review's config_tables.py). */
export const FLIGHT_MODES: Record<number, [string, string]> = {
  0: ['Manual', '#cc0000'], 1: ['Altitude', '#eecc00'], 8: ['Altitude Cruise', '#eecc00'],
  2: ['Position', '#00cc33'], 6: ['Position (Slow)', '#00cc33'], 10: ['Acro', '#66cc00'],
  14: ['Offboard', '#00cccc'], 15: ['Stabilized', '#0033cc'],
  3: ['Mission', '#6600cc'], 4: ['Hold', '#6600cc'], 5: ['Return', '#6600cc'], 12: ['Descend', '#6600cc'],
  13: ['Terminate', '#6600cc'], 17: ['Takeoff', '#6600cc'], 18: ['Land', '#6600cc'], 19: ['Follow Target', '#6600cc'],
  20: ['Precision Land', '#6600cc'], 21: ['Orbit', '#6600cc'], 22: ['VTOL Takeoff', '#6600cc'],
  23: ['External 1', '#9700cc'], 24: ['External 2', '#9700cc'], 25: ['External 3', '#9700cc'], 26: ['External 4', '#9700cc'],
  27: ['External 5', '#9700cc'], 28: ['External 6', '#9700cc'], 29: ['External 7', '#9700cc'], 30: ['External 8', '#9700cc'],
};

export function versionString(v: number | undefined): string | undefined {
  if (v === undefined || v === 0) return undefined;
  const major = (v >>> 24) & 0xff, minor = (v >>> 16) & 0xff, patch = (v >>> 8) & 0xff, type = v & 0xff;
  let s = `v${major}.${minor}.${patch}`;
  if (type >= 255) return s;
  if (type >= 192) s += ' (rc)';
  else if (type >= 128) s += ' (beta)';
  else if (type >= 64) s += ' (alpha)';
  else s += ' (dev)';
  return s;
}

export function versionTuple(log: ULog): [number, number, number] | undefined {
  const v = log.infoNumber('ver_sw_release');
  if (!v) return undefined;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff];
}

export function isSupportedVersion(log: ULog): boolean {
  const v = versionTuple(log);
  if (!v) return true; // unknown (custom builds): try anyway
  return v[0] > 1 || (v[0] === 1 && v[1] >= 17);
}

export function airframeName(log: ULog): { name: string; type: string; id: number } | undefined {
  const id = log.params.get('SYS_AUTOSTART');
  if (id === undefined) return undefined;
  const a = (airframes as Record<string, { name: string; type: string }>)[String(id)];
  return { name: a?.name ?? '', type: a?.type ?? '', id };
}

export function quatToEuler(q0: number, q1: number, q2: number, q3: number): [number, number, number] {
  const roll = Math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2));
  const s = Math.max(-1, Math.min(1, 2 * (q0 * q2 - q3 * q1)));
  const pitch = Math.asin(s);
  const yaw = Math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3));
  return [roll, pitch, yaw];
}

/** Adds roll/pitch/yaw columns (rad) from a quaternion field prefix (q / q_d). */
export function eulerCols(d: TopicData, qField = 'q'): { roll: Float64Array; pitch: Float64Array; yaw: Float64Array } | undefined {
  const q = [0, 1, 2, 3].map((i) => d.cols[`${qField}[${i}]`]);
  if (q.some((x) => !x)) return undefined;
  const key = `__euler_${qField}`;
  const c = (d as unknown as Record<string, unknown>)[key] as ReturnType<typeof eulerCols>;
  if (c) return c;
  const n = d.count;
  const roll = new Float64Array(n), pitch = new Float64Array(n), yaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [r, p, y] = quatToEuler(q[0][i], q[1][i], q[2][i], q[3][i]);
    roll[i] = r; pitch[i] = p; yaw[i] = y;
  }
  const res = { roll, pitch, yaw };
  (d as unknown as Record<string, unknown>)[key] = res;
  return res;
}

/** Value-change list of an integer field: [t, value][] */
export function valueChanges(d: TopicData | undefined, field: string): [number, number][] {
  if (!d || !d.cols[field]) return [];
  const v = d.cols[field];
  const out: [number, number][] = [];
  for (let i = 0; i < d.count; i++) if (i === 0 || v[i] !== v[i - 1]) out.push([d.t[i], v[i]]);
  return out;
}

export function flightModes(log: ULog): ModeSegment[] {
  const ch = valueChanges(log.topic('vehicle_status'), 'nav_state');
  const end = log.durationS;
  return ch.map(([t, m], i) => {
    const [name, color] = FLIGHT_MODES[m] ?? [`Mode ${m}`, '#888888'];
    return { t0: t, t1: i + 1 < ch.length ? ch[i + 1][0] : end, mode: m, name, color };
  });
}

/** Armed intervals (vehicle_status.arming_state == 2). */
export function armedIntervals(log: ULog): [number, number][] {
  const d = log.topic('vehicle_status');
  if (!d) return [];
  const a = d.cols['arming_state'];
  const mask = Array.from(a, (v) => v === 2);
  return maskSegments(mask, d.t, 0);
}

/** Airborne intervals from vehicle_land_detected.landed (false = in air). */
export function airborneIntervals(log: ULog): [number, number][] {
  const d = log.topic('vehicle_land_detected');
  if (!d || !d.cols['landed']) return [];
  const mask = Array.from(d.cols['landed'], (v) => !v);
  const segs = maskSegments(mask, d.t, 0);
  return segs.filter(([a, b]) => b - a > 1);
}

export function gnssTopic(log: ULog): string | undefined {
  if (log.has('vehicle_gps_position')) return 'vehicle_gps_position';
  if (log.has('sensor_gps')) return 'sensor_gps';
  return undefined;
}

export interface QuietWindows { windows: [number, number][]; threshold: number | 'all'; totalS: number; reason: string }

/**
 * Quiet-hover windows: airborne, >5 s after takeoff, >3 s before landing, sticks centred
 * (|roll|,|pitch|,|yaw| < threshold, adaptive 0.08 -> 0.15 -> 0.25), optional low velocity.
 */
export function quietHoverWindows(log: ULog, opts: { minTotal?: number } = {}): QuietWindows {
  const air = airborneIntervals(log);
  const minTotal = opts.minTotal ?? 15;
  if (!air.length) return { windows: [], threshold: 'all', totalS: 0, reason: 'no airborne segment (vehicle_land_detected)' };
  const ms = log.topic('manual_control_setpoint');
  const lp = log.topic('vehicle_local_position');
  const inAir = (t: number) => air.some(([a, b]) => t > a + 5 && t < b - 3);
  if (ms && ms.cols['roll']) {
    const r = ms.cols['roll'], p = ms.cols['pitch'], y = ms.cols['yaw'];
    let vel: ((t: number) => number) | undefined;
    if (lp && lp.cols['vx']) {
      const vx = lp.cols['vx'], vy = lp.cols['vy'], vz = lp.cols['vz'];
      vel = (t: number) => {
        const i = Math.min(lp.count - 1, lowerBound(lp.t, t));
        return Math.hypot(vx[i], vy[i], vz[i]);
      };
    }
    for (const [thr, mlen] of [[0.08, 4], [0.15, 3], [0.25, 3]] as [number, number][]) {
      const mask = new Uint8Array(ms.count);
      for (let i = 0; i < ms.count; i++) {
        const t = ms.t[i];
        mask[i] = Math.abs(r[i]) < thr && Math.abs(p[i]) < thr && Math.abs(y[i]) < thr && inAir(t) && (!vel || vel(t) < 2.5) ? 1 : 0;
      }
      const w = maskSegments(mask, ms.t, mlen).map(([a, b]) => [a + 0.5, b - 0.5] as [number, number]).filter(([a, b]) => b > a);
      const tot = w.reduce((s, [a, b]) => s + b - a, 0);
      if (tot >= minTotal) return { windows: w, threshold: thr, totalS: tot, reason: `sticks centred (<${thr}), speed < 2.5 m/s` };
    }
  }
  const w = air.map(([a, b]) => [a + 5, b - 3] as [number, number]).filter(([a, b]) => b - a > 2);
  return { windows: w, threshold: 'all', totalS: w.reduce((s, [a, b]) => s + b - a, 0), reason: 'not enough quiet stick time: whole airborne time used' };
}

/** Boolean mask for time vector t inside any of the windows. */
export function inWindows(t: ArrayLike<number>, w: [number, number][]): Uint8Array {
  const m = new Uint8Array(t.length);
  for (const [a, b] of w) {
    const i0 = lowerBound(t, a), i1 = lowerBound(t, b);
    for (let i = i0; i < i1; i++) m[i] = 1;
  }
  return m;
}

/** Extract chunks of y inside windows (for spectra over separate windows). */
export function chunks(t: ArrayLike<number>, y: ArrayLike<number>, w: [number, number][]): Float64Array[] {
  const out: Float64Array[] = [];
  for (const [a, b] of w) {
    const i0 = lowerBound(t, a), i1 = lowerBound(t, b);
    if (i1 - i0 > 8) out.push(Float64Array.prototype.slice.call(y instanceof Float64Array ? y : Float64Array.from(y), i0, i1) as Float64Array);
  }
  return out;
}

export function fmtDuration(s: number): string {
  const neg = s < 0;
  const a = Math.abs(s);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), sec = Math.floor(a % 60);
  return `${neg ? '-' : ''}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function paramOr(log: ULog, name: string, def: number): number {
  const v = log.params.get(name);
  return v === undefined ? def : v;
}

export const AXES = ['roll', 'pitch', 'yaw'] as const;
export type Axis = (typeof AXES)[number];

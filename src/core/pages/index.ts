/** Page builders: each returns the sections (plots, tables, findings) for one navigation page. */
import type { ULog } from '../ulog';
import type { PageSpec, Section, PlotSpec, Finding, FreqPlotSpec, TableSpec, TimePlotSpec, Tone } from '../types';
import * as FR from './fr';
import { compact, ser, timePlot, DEG, fmt, maxAbs } from './helpers';
import {
  versionString, airframeName, fmtDuration, gnssTopic, eulerCols, armedIntervals, airborneIntervals, AXES, isSupportedVersion, PARAM_META, quietHoverWindows,
} from '../px4';
import { quietSpectra, aliasingCheck, motorImbalance, hoverThrust, gpsReadiness, topicRates, loopTiming, attitudeErrorRms } from '../analysis/flight';
import { stepResponse } from '../analysis/stepresp';
import { nonDefaultParams, fmtParam } from '../analysis/params';
import { interp, minMax, mean } from '../dsp';
import type { DecodedEvent } from '../events';
import { LOG_LEVELS } from '../events';

const sec = (id: string, title: string, items: (PlotSpec | undefined | null | false)[], description?: string): Section => ({ id, title, description, items: compact(items) });

// ------------------------------------------------------------------ overview
export function infoTables(log: ULog): { left: [string, string][]; right: [string, string][] } {
  const left: [string, string][] = [];
  const af = airframeName(log);
  if (af) left.push(['Airframe', af.name ? `${af.name} (${af.type}, ${af.id})` : String(af.id)]);
  const hw = log.infoString('ver_hw');
  if (hw) left.push(['Hardware', hw + (log.infoString('ver_hw_subtype') ? ` (${log.infoString('ver_hw_subtype')})` : '')]);
  const sw = log.infoString('ver_sw');
  const rel = versionString(log.infoNumber('ver_sw_release'));
  if (sw) left.push(['Software version', `${rel ?? ''} ${sw.slice(0, 8)}${log.infoString('ver_sw_branch') ? `  branch: ${log.infoString('ver_sw_branch')}` : ''}`.trim()]);
  const os = log.infoString('sys_os_name');
  const osv = versionString(log.infoNumber('sys_os_ver_release'));
  if (os) left.push(['OS version', `${os}${osv ? `, ${osv}` : ''}`]);
  left.push(['Estimator', log.has('estimator_status') ? 'EKF2' : 'unknown']);
  const g = gnssTopic(log);
  if (g) {
    const d = log.topic(g)!;
    const u = d.cols['time_utc_usec'];
    if (u) {
      const i = u.findIndex((v) => v > 0);
      if (i >= 0) {
        const startUtc = u[i] / 1e3 - d.t[i] * 1e3;
        left.push(['Logging start (UTC)', new Date(startUtc).toISOString().replace('T', ' ').slice(0, 19)]);
      }
    }
  }
  left.push(['Logging duration', fmtDuration(log.durationS)]);
  if (log.dropouts.length) {
    const tot = log.dropouts.reduce((s, d) => s + d.durationMs, 0) / 1000;
    left.push(['Dropouts', `${log.dropouts.length} (${tot > 5 ? tot.toFixed(0) : tot.toFixed(2)} s)`]);
  }
  const hi = log.params.get('LND_FLIGHT_T_HI'), lo = log.params.get('LND_FLIGHT_T_LO');
  if (hi !== undefined && lo !== undefined) {
    const total = ((hi < 0 ? hi + 2 ** 32 : hi) * 2 ** 32 + (lo < 0 ? lo + 2 ** 32 : lo)) / 1e6;
    left.push(['Vehicle life flight time', fmtDuration(total)]);
  }
  const uuid = log.infoString('sys_uuid');
  if (uuid) left.push(['Vehicle UUID', uuid]);

  const right: [string, string][] = [];
  const lp = log.topic('vehicle_local_position');
  if (lp && lp.cols['x']) {
    const { x, y, z } = { x: lp.cols['x'], y: lp.cols['y'], z: lp.cols['z'] };
    const valid = lp.cols['xy_valid'], zv = lp.cols['z_valid'];
    let dist = 0, last = -2;
    for (let i = 0; i < lp.count; i++) {
      if (!(valid?.[i] ?? 1) || !(zv?.[i] ?? 1)) continue;
      if (i === last + 1) dist += Math.hypot(x[i] - x[last], y[i] - y[last], z[i] - z[last]);
      last = i;
    }
    if (dist >= 1) right.push(['Distance', dist > 1000 ? `${(dist / 1000).toFixed(2)} km` : `${dist.toFixed(1)} m`]);
    const [zmin, zmax] = minMax(z);
    right.push(['Max altitude difference', `${(zmax - zmin).toFixed(0)} m`]);
    const vv = lp.cols['v_xy_valid'], vz = lp.cols['v_z_valid'];
    let sum = 0, n = 0, mx = 0, mxh = 0, up = 0, down = 0;
    for (let i = 0; i < lp.count; i++) {
      if (!(vv?.[i] ?? 1) || !(vz?.[i] ?? 1)) continue;
      const h = Math.hypot(lp.cols['vx'][i], lp.cols['vy'][i]);
      const s = Math.hypot(h, lp.cols['vz'][i]);
      sum += s; n++; mx = Math.max(mx, s); mxh = Math.max(mxh, h);
      up = Math.max(up, -lp.cols['vz'][i]); down = Math.max(down, lp.cols['vz'][i]);
    }
    if (n) {
      right.push(['Average speed', `${((sum / n) * 3.6).toFixed(1)} km/h`], ['Max speed', `${(mx * 3.6).toFixed(1)} km/h`],
        ['Max speed horizontal', `${(mxh * 3.6).toFixed(1)} km/h`], ['Max speed up', `${(up * 3.6).toFixed(1)} km/h`], ['Max speed down', `${(down * 3.6).toFixed(1)} km/h`]);
    }
  }
  const att = log.topic('vehicle_attitude');
  const e = att ? eulerCols(att) : undefined;
  if (e) {
    let mt = 0;
    for (let i = 0; i < e.roll.length; i++) mt = Math.max(mt, Math.acos(Math.cos(e.pitch[i]) * Math.cos(e.roll[i])) * DEG);
    right.push(['Max tilt angle', `${mt.toFixed(1)} deg`]);
  }
  const av = log.topic('vehicle_angular_velocity');
  if (av) {
    let m = 0;
    for (let i = 0; i < av.count; i++) m = Math.max(m, Math.hypot(av.cols['xyz[0]'][i], av.cols['xyz[1]'][i], av.cols['xyz[2]'][i]));
    right.push(['Max rotation speed', `${(m * DEG).toFixed(1)} deg/s`]);
  }
  const b = log.topic('battery_status');
  if (b && b.cols['current_a']) {
    const [, mc] = minMax(b.cols['current_a']);
    if (mc > 0.1) right.push(['Average current', `${mean(b.cols['current_a']).toFixed(1)} A`], ['Max current', `${mc.toFixed(1)} A`]);
    const dis = b.cols['discharged_mah'];
    if (dis && dis[dis.length - 1] > 1) right.push(['Discharged', `${dis[dis.length - 1].toFixed(0)} mAh`]);
    right.push(...batteryRows(log));
  }
  return { left, right };
}

/** Battery voltage at the start and at the end of the log (median of 2 s), minimum under load, and per cell. */
export function batteryRows(log: ULog): [string, string][] {
  const b = log.topic('battery_status');
  if (!b || !b.cols['voltage_v']) return [];
  const idx: number[] = [];
  for (let i = 0; i < b.count; i++) if (b.cols['voltage_v'][i] > 1) idx.push(i);
  if (idx.length < 3) return [];
  const t = (i: number) => b.t[i], v = (i: number) => b.cols['voltage_v'][i];
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const first = idx.filter((i) => t(i) <= t(idx[0]) + 2).map(v);
  const last = idx.filter((i) => t(i) >= t(idx[idx.length - 1]) - 2).map(v);
  const arms = armedIntervals(log);
  const loaded = idx.filter((i) => !arms.length || arms.some(([a, c]) => t(i) >= a && t(i) <= c)).map(v);
  const v0 = med(first), v1 = med(last), vmin = loaded.length ? minMax(loaded)[0] : NaN;
  const rows: [string, string][] = [['Battery voltage', `${v0.toFixed(2)} → ${v1.toFixed(2)} V${isFinite(vmin) ? `  (min ${vmin.toFixed(2)} V under load)` : ''}`]];
  // per-cell: measured cells if the battery reports them, otherwise pack voltage / cell count
  const n = (log.params.get('BAT1_N_CELLS') ?? 0) || (b.cols['cell_count'] ? minMax(b.cols['cell_count'])[1] : 0);
  const cellCols: Float64Array[] = [];
  for (let k = 0; k < 14; k++) { const c = b.cols[`voltage_cell_v[${k}]`]; if (c && c.some((x) => x > 2.5 && x < 4.6)) cellCols.push(c); }
  if (cellCols.length >= 2) {
    const at = (sel: number[]) => cellCols.map((c) => med(sel.map((i) => c[i])));
    const c0 = at(idx.filter((i) => t(i) <= t(idx[0]) + 2)), c1 = at(idx.filter((i) => t(i) >= t(idx[idx.length - 1]) - 2));
    const span = (a: number[]) => `${minMax(a)[0].toFixed(2)}–${minMax(a)[1].toFixed(2)}`;
    rows.push([`Cell voltage (${cellCols.length}S, measured)`, `${span(c0)} → ${span(c1)} V`]);
  } else if (n > 0) {
    rows.push([`Cell voltage (${n}S, average)`, `${(v0 / n).toFixed(2)} → ${(v1 / n).toFixed(2)} V${isFinite(vmin) ? `  (min ${(vmin / n).toFixed(2)} V under load)` : ''}`]);
  }
  return rows;
}

export function overviewFindings(log: ULog, events?: DecodedEvent[]): Finding[] {
  const f: Finding[] = [];
  const rel = versionString(log.infoNumber('ver_sw_release'));
  if (!isSupportedVersion(log)) f.push({ tone: 'warning', title: `PX4 ${rel} is older than 1.17`, detail: 'This tool targets PX4 v1.17 and newer: some topics/fields may be missing.' });
  if (log.corruptBytes) f.push({ tone: 'warning', title: 'Log contains corrupt data', detail: `${log.corruptBytes} bytes skipped while parsing.` });
  if (log.dropouts.length) {
    const tot = log.dropouts.reduce((s, d) => s + d.durationMs, 0);
    f.push({ tone: tot > 500 ? 'warning' : 'info', title: `${log.dropouts.length} logger dropouts (${tot} ms total)`, detail: 'Gaps in logged data: SD card too slow or logging profile too heavy.' });
  }
  const vi = log.topic('vehicle_imu_status');
  if (vi && vi.cols['accel_vibration_metric']) {
    const air = airborneIntervals(log);
    const m = Array.from(vi.cols['accel_vibration_metric']).filter((_, i) => air.some(([a, b]) => vi.t[i] > a && vi.t[i] < b));
    if (m.length) {
      const mx = minMax(m)[1];
      const tone: Tone = mx > 30 ? 'danger' : mx > 15 ? 'warning' : 'good';
      f.push({ tone, title: `Vibration level (accel metric) max ${mx.toFixed(1)} m/s², mean ${mean(m).toFixed(1)}`, detail: tone === 'good' ? 'Within PX4 guidance (< 15 m/s²).' : 'Above PX4 guidance: check prop balance, motor mounts, FC damping.' });
    }
  }
  const al = aliasingCheck(log);
  const aw = al.warnings.filter((x) => x.severity === 'warning');
  if (aw.length === 1) f.push({ tone: 'warning', title: 'Aliasing risk', detail: aw[0].text });
  else if (aw.length > 1) f.push({ tone: 'warning', title: `Aliasing risk in ${aw.length} controller topics`, detail: `${aw.map((w) => `${w.topic} @ ${w.rateHz.toFixed(0)} Hz`).join(', ')}: the ~${aw[0].vibHz.toFixed(0)} Hz vibration folds to ${[...new Set(aw.map((w) => w.aliasHz.toFixed(1)))].join(' / ')} Hz. Slow oscillations in these topics may be fake — see Vibration › Aliasing check.` });
  const mi = motorImbalance(log);
  if (mi) {
    const worst = Math.max(...mi.devPct.map(Math.abs));
    if (worst > 10) f.push({ tone: 'warning', title: `Motor imbalance ${worst.toFixed(0)}%`, detail: mi.text.slice(1).join(' ') });
    if (mi.saturationPct > 1) f.push({ tone: 'warning', title: `Motor saturation ${mi.saturationPct.toFixed(1)}% of airborne time`, detail: 'At least one motor at ≥98% output.' });
  }
  const gr = gpsReadiness(log);
  if (gr) f.push(...gr.findings.filter((x) => x.tone !== 'good'));
  const lt = loopTiming(log);
  if (lt.cpu && lt.cpu.mean > 70) f.push({ tone: 'warning', title: `High CPU load while armed: ${lt.cpu.mean.toFixed(0)}% mean`, detail: `p95 ${lt.cpu.p95.toFixed(0)}%, max ${lt.cpu.max.toFixed(0)}%` });
  const vs = log.topic('vehicle_status');
  if (vs && vs.cols['failsafe'] && maxAbs(vs.cols['failsafe']) > 0) {
    const i = vs.cols['failsafe'].findIndex((v) => v > 0);
    f.push({ tone: 'danger', title: `Failsafe triggered at ${vs.t[i].toFixed(1)} s` });
  }
  if (events) {
    const arms = armedIntervals(log);
    const inFlight = (t: number) => arms.some(([a, b]) => t >= a && t <= b);
    const bad = events.filter((e) => e.level <= 3);
    const flying = bad.filter((e) => inFlight(e.t));
    const pre = bad.filter((e) => !inFlight(e.t));
    if (flying.length) f.push({ tone: 'warning', title: `${flying.length} ERROR event${flying.length === 1 ? '' : 's'} while armed`, detail: [...new Set(flying.map((e) => e.message))].slice(0, 4).join(' · ') });
    if (pre.length) f.push({ tone: 'info', title: `${pre.length} ERROR event${pre.length === 1 ? '' : 's'} while disarmed (pre-flight checks)`, detail: [...new Set(pre.map((e) => e.message))].slice(0, 4).join(' · ') });
  }
  const ht = hoverThrust(log);
  if (ht) {
    const tone: Tone = ht.meanHt > 0.7 ? 'danger' : ht.meanHt > 0.6 || ht.meanHt < 0.2 ? 'warning' : 'good';
    f.push({ tone, title: `Hover thrust ${ht.meanHt.toFixed(2)} (normalised to ${ht.vref.toFixed(1)} V: ${ht.meanNorm.toFixed(2)})`, detail: tone === 'good' ? 'Good thrust margin.' : 'Low thrust margin for manoeuvres and wind.' });
  }
  if (!f.some((x) => x.tone === 'warning' || x.tone === 'danger')) f.unshift({ tone: 'good', title: 'No significant issues detected' });
  const order: Record<Tone, number> = { danger: 0, warning: 1, info: 2, neutral: 3, good: 4 };
  return f.sort((a, b) => order[a.tone] - order[b.tone]);
}

export function overviewPage(log: ULog, events?: DecodedEvent[]): PageSpec {
  const { left, right } = infoTables(log);
  const arms = armedIntervals(log), air = airborneIntervals(log);
  const flight = air.reduce((s, [a, b]) => s + b - a, 0);
  const vi = log.topic('vehicle_imu_status');
  const stats: { label: string; value: string; sub?: string; tone?: Tone }[] = [
    { label: 'Log duration', value: fmtDuration(log.durationS) },
    { label: 'Airborne', value: fmtDuration(flight), sub: `${air.length} flight${air.length === 1 ? '' : 's'}, armed ${fmtDuration(arms.reduce((s, [a, b]) => s + b - a, 0))}` },
  ];
  const dist = right.find((r) => r[0] === 'Distance');
  if (dist) stats.push({ label: 'Distance', value: dist[1] });
  const mx = right.find((r) => r[0] === 'Max speed');
  if (mx) stats.push({ label: 'Max speed', value: mx[1] });
  if (vi && vi.cols['accel_vibration_metric']) {
    const v = minMax(vi.cols['accel_vibration_metric'])[1];
    stats.push({ label: 'Vibration (max)', value: `${v.toFixed(1)} m/s²`, tone: v > 30 ? 'danger' : v > 15 ? 'warning' : 'good' });
  }
  stats.push({ label: 'Dropouts', value: String(log.dropouts.length), tone: log.dropouts.length ? 'warning' : 'good' });
  return {
    id: 'overview',
    sections: [
      sec('summary', 'Summary', [{ kind: 'stats', id: 'stats', items: stats }, { kind: 'findings', id: 'findings', title: 'Automatic checks', items: overviewFindings(log, events) }]),
      sec('trajectory', 'Trajectory & replay', [FR.replay(log), FR.gpsMap(log), FR.positionXY(log)], 'Play the flight back, or point at the track to see that moment on the timeline and on every chart.'),
      sec('info', 'Vehicle & log', [{ kind: 'kv', id: 'info-left', title: 'Vehicle', items: left }, { kind: 'kv', id: 'info-right', title: 'Flight', items: right }]),
    ],
  };
}

// ------------------------------------------------------------------ tracking
export function trackingPage(log: ULog): PageSpec {
  const att: PlotSpec[] = [];
  AXES.forEach((a, i) => { att.push(...compact([FR.attitudeAngle(log, a, i), FR.angularRate(log, a, i)])); });
  return {
    id: 'tracking',
    sections: [
      sec('att', 'Attitude & rate tracking', att, 'Estimated vs setpoint (Flight Review). Rate integral ×100.'),
      sec('pos', 'Position & velocity', [FR.altitude(log), FR.localPosition(log, 'x'), FR.localPosition(log, 'y'), FR.localPosition(log, 'z'), FR.velocity(log), ...FR.visualOdometry(log), FR.airspeed(log), FR.tecs(log)]),
      sec('inputs', 'Pilot inputs', [FR.manualControl(log)]),
      sec('step', 'Rate step response (PID analysis)', stepResponsePlots(log), 'Wiener deconvolution of rate setpoint → measured rate over 1 s windows (Flight Review PID analysis / PID-Analyzer). Needs high-rate logging of vehicle_angular_velocity and vehicle_rates_setpoint and real stick inputs.'),
    ],
  };
}

export function stepResponsePlots(log: ULog): PlotSpec[] {
  const av = log.topic('vehicle_angular_velocity'), rs = log.topic('vehicle_rates_setpoint');
  if (!av || !rs) return [{ kind: 'text', id: 'step-missing', text: 'Missing vehicle_angular_velocity or vehicle_rates_setpoint.', tone: 'warning' }];
  const t = av.t;
  const fs = 1 / ((t[t.length - 1] - t[0]) / t.length);
  if (fs < 50) return [{ kind: 'text', id: 'step-slow', text: `vehicle_angular_velocity logged at ${fs.toFixed(0)} Hz: too slow for step response estimation (need ≥ 100 Hz, ideally the high-rate logging profile).`, tone: 'warning' }];
  const air = airborneIntervals(log);
  const out: PlotSpec[] = [];
  const rows: (string | number)[][] = [];
  let x: Float64Array | undefined;
  const series: FreqPlotSpec['series'] = [];
  AXES.forEach((axis, i) => {
    // restrict to airborne time
    const idx: number[] = [];
    for (let k = 0; k < t.length; k++) if (air.some(([a, b]) => t[k] > a && t[k] < b)) idx.push(k);
    if (idx.length < 500) return;
    const tt = Float64Array.from(idx, (k) => t[k]);
    const g = Float64Array.from(idx, (k) => av.cols[`xyz[${i}]`][k] * DEG);
    const sp = interp(tt, rs.t, rs.cols[axis]).map((v) => v * DEG);
    const r = stepResponse(tt, g, sp);
    if (!r) return;
    x = r.time;
    if (r.low) series.push({ label: `${axis} (<500 deg/s, ${r.nLow} windows)`, y: Float32Array.from(r.low), color: i });
    if (r.high) series.push({ label: `${axis} (≥500 deg/s, ${r.nHigh} windows)`, y: Float32Array.from(r.high), color: i, dash: true });
    rows.push([axis, r.nLow, r.nHigh, r.riseTime !== undefined ? (r.riseTime * 1000).toFixed(0) : '–', r.overshoot !== undefined ? r.overshoot.toFixed(0) : '–', r.peakTime !== undefined ? (r.peakTime * 1000).toFixed(0) : '–', fmt(r.settle, 2)]);
  });
  if (x && series.length) {
    out.push({ kind: 'freq', id: 'step-plot', title: 'Rate step response', xLabel: 's', yLabel: 'response', x, series, yRange: [0, 1.6], hmarks: [{ y: 1, label: 'ideal' }], height: 320 });
    out.push({ kind: 'table', id: 'step-table', title: 'Step response metrics', columns: ['Axis', 'Windows <500', 'Windows ≥500', 'Rise 10–90% [ms]', 'Overshoot [%]', 'Peak [ms]', 'Steady state'], rows });
  } else out.push({ kind: 'text', id: 'step-none', text: 'Not enough excitation (rate setpoint changes > 20 deg/s) to estimate a step response.', tone: 'info' });
  return out;
}

// ------------------------------------------------------------------ actuators
export function actuatorsPage(log: ULog): PageSpec {
  const mi = motorImbalance(log);
  const imb: PlotSpec[] = [];
  if (mi) {
    imb.push({ kind: 'bars', id: 'motor-dev', title: 'Motor output deviation from mean (quiet hover)', categories: mi.devPct.map((_, i) => `M${i + 1}`), values: mi.devPct, unit: '%', signed: true, note: `Mean outputs: ${mi.means.map((v) => v.toFixed(3)).join(', ')}` });
    imb.push({ kind: 'findings', id: 'motor-text', title: 'Interpretation', items: mi.text.map((t) => ({ tone: 'info' as Tone, title: t })).concat(mi.saturationPct > 0.1 ? [{ tone: 'warning', title: `Saturation: ${mi.saturationPct.toFixed(1)}% of airborne samples with a motor ≥ 98%` }] : []) });
    if (mi.geometry) imb.push({ kind: 'table', id: 'motor-geom', title: 'Rotor geometry (CA_ROTORn_*)', columns: ['Motor', 'PX [m]', 'PY [m]', 'KM', 'Mean output', 'Deviation [%]'], rows: mi.means.map((m, i) => [`M${i + 1}`, mi.geometry!.px[i].toFixed(3), mi.geometry!.py[i].toFixed(3), mi.geometry!.km[i].toFixed(3), m.toFixed(3), mi.devPct[i].toFixed(1)]) });
  }
  return {
    id: 'actuators',
    sections: [
      sec('controls', 'Actuator controls', [FR.actuatorControls(log), FR.actuatorControlsFFT(log)]),
      sec('outputs', 'Motor & servo outputs', [FR.motorOutputs(log), FR.servoOutputs(log), ...FR.actuatorOutputs(log), FR.escRpm(log)]),
      sec('imbalance', 'Motor imbalance', imb.length ? imb : [{ kind: 'text', id: 'noimb', text: 'actuator_motors or an airborne segment is missing.', tone: 'info' }], 'Average motor commands in quiet hover. With the rotor geometry from CA_ROTORn_PX/PY/KM the imbalance is converted into a centre-of-gravity offset and a residual yaw torque.'),
    ],
  };
}

// ------------------------------------------------------------------ vibration
export function vibrationPage(log: ULog): PageSpec {
  const qs = quietSpectra(log);
  const al = aliasingCheck(log, qs);
  const psd: PlotSpec[] = [];
  const mkPsd = (id: string, title: string, s: { fs: number; s: { f: Float64Array; p: Float64Array }[] } | undefined, labels: string[], yLabel: string, note?: string) => {
    if (!s) return;
    psd.push({ kind: 'freq', id, title, xLabel: 'Hz', yLabel, x: s.s[0].f, series: s.s.map((x, i) => ({ label: labels[i], y: Float32Array.from(x.p), color: i })), logY: true, xRange: [0, s.fs / 2], note: note ?? `${s.fs.toFixed(0)} Hz, Welch PSD over ${qs.q.totalS.toFixed(0)} s of quiet hover`, marks: filterMarks(log) });
  };
  mkPsd('qpsd-fifo', 'Raw gyro PSD — quiet hover (FIFO)', qs.fifo, ['x', 'y', 'z'], '(deg/s)²/Hz');
  mkPsd('qpsd-gyro', 'Gyro PSD — quiet hover (sensor_combined)', qs.gyro, ['roll', 'pitch', 'yaw'], '(deg/s)²/Hz');
  mkPsd('qpsd-angvel', 'Filtered angular velocity PSD — quiet hover', qs.angvel, ['roll', 'pitch', 'yaw'], '(deg/s)²/Hz');
  mkPsd('qpsd-torque', 'Torque setpoint PSD — quiet hover', qs.torque, ['roll', 'pitch', 'yaw'], '1/Hz');
  const m = qs.metrics;
  const qtab: TableSpec = {
    kind: 'table', id: 'qmetrics', title: 'Quiet hover metrics', columns: ['Metric', 'Roll', 'Pitch', 'Yaw'],
    rows: [
      ['Vibration 30–75 Hz RMS [deg/s]', fmt(m.vib_roll), fmt(m.vib_pitch), fmt(m.vib_yaw)],
      ['Oscillation 2–6 Hz RMS [deg/s]', fmt(m.osc_roll), fmt(m.osc_pitch), fmt(m.osc_yaw)],
      ['Vibration peak [Hz]', fmt(m.peak_roll, 0), fmt(m.peak_pitch, 0), fmt(m.peak_yaw, 0)],
      ['Accel Z > 30 Hz RMS [m/s²]', fmt(m.accZ_vib), '', ''],
      ['Accel vibration metric (mean)', fmt(m.accel_vib_metric, 1), '', ''],
    ],
    note: `Windows: ${qs.q.windows.length} (${qs.q.totalS.toFixed(0)} s), ${qs.q.reason}`,
  };
  const aliasItems: Finding[] = al.warnings.map((w) => ({ tone: w.severity === 'warning' ? 'warning' : 'info', title: `${w.topic} @ ${w.rateHz.toFixed(0)} Hz`, detail: w.text }));
  if (!aliasItems.length) aliasItems.push({ tone: 'good', title: 'No aliasing risk detected', detail: al.vib.length ? `Dominant vibration ~${al.vib.map((v) => v.toFixed(0)).join('/')} Hz (${al.source}); all dynamic topics are logged above twice that rate.` : 'No dominant vibration found.' });
  return {
    id: 'vibration',
    sections: [
      sec('levels', 'Vibration levels', [FR.vibrationMetrics(log), FR.rawAcceleration(log), FR.rawGyro(log)]),
      sec('quiet', 'Quiet-hover spectra', [qtab, ...psd], 'PSDs computed only on airborne windows with centred sticks and low speed, so manoeuvres do not mask the vibration content.'),
      sec('alias', 'Aliasing check', [{ kind: 'findings', id: 'alias', title: `Dominant vibration: ${al.vib.length ? al.vib.map((v) => v.toFixed(0)).join(' / ') + ' Hz' : 'n/a'} (${al.source})`, items: aliasItems }], 'A topic logged below 2× the vibration frequency folds it into slow fake oscillations (e.g. 44 Hz logged at 50 Hz shows up at 6 Hz).'),
      sec('fft', 'FFT (whole log)', [FR.angularVelocityFFT(log), FR.angularAccelerationFFT(log)]),
      sec('spectrograms', 'Spectrograms', [FR.accelSpectrogram(log), FR.angVelSpectrogram(log), FR.angAccSpectrogram(log)]),
      sec('fifo', 'High-rate IMU (FIFO)', FR.fifoPlots(log)),
    ],
  };
}

function filterMarks(log: ULog) {
  const p = (n: string) => log.params.get(n) ?? 0;
  return [
    { x: p('IMU_GYRO_NF0_FRQ'), label: 'NF0' }, { x: p('IMU_GYRO_NF1_FRQ'), label: 'NF1' },
    { x: p('IMU_GYRO_CUTOFF'), label: 'LPF' }, { x: p('IMU_DGYRO_CUTOFF'), label: 'D-LPF' },
  ].filter((m) => m.x > 0);
}

// ------------------------------------------------------------------ power
export function powerPage(log: ULog): PageSpec {
  const ht = hoverThrust(log);
  const hov: PlotSpec[] = [];
  if (ht) {
    hov.push({ kind: 'time', id: 'hover', title: `Hover thrust vs voltage (normalised to ${ht.vref.toFixed(1)} V)`, series: [
      { label: 'Hover thrust estimate', t: ht.t, y: Float32Array.from(ht.ht), color: 0 },
      { label: `Hover thrust × V / ${ht.vref.toFixed(1)} V`, t: ht.t, y: Float32Array.from(ht.norm), color: 1 },
    ], note: ht.batScale ? 'MC_BAT_SCALE_EN=1: PX4 already compensates thrust for battery voltage.' : undefined });
    hov.push({ kind: 'time', id: 'hover-v', title: 'Battery voltage during hover estimate', yLabel: 'V', series: [{ label: 'Voltage', t: ht.t, y: Float32Array.from(ht.v), color: 2 }], height: 180 });
    hov.push({ kind: 'kv', id: 'hover-kv', title: 'Hover thrust', items: [
      ['Mean hover thrust', ht.meanHt.toFixed(3)], ['Mean normalised hover thrust', ht.meanNorm.toFixed(3)],
      ['Reference voltage', `${ht.vref.toFixed(2)} V${ht.cells ? ` (${ht.cells}S × 3.9 V)` : ''}`],
      ['Normalised drift first→last third', `${ht.driftPct >= 0 ? '+' : ''}${ht.driftPct.toFixed(1)} %`],
    ], note: 'For a PWM ESC without voltage compensation, motor speed scales with throttle × voltage: the normalised value should stay flat over the flight. A drift indicates sag beyond the model, heating, or a change of mass.' });
  }
  const b = log.topic('battery_status');
  const cells: PlotSpec[] = [];
  if (b) {
    const s = [];
    for (let i = 0; i < 14; i++) { const c = b.cols[`voltage_cell_v[${i}]`]; if (c && maxAbs(c) > 0.5) s.push(ser(log, 'battery_status', `voltage_cell_v[${i}]`, `Cell ${i + 1}`, i % 8)); }
    const p = timePlot('cells', 'Cell voltages', s, { yLabel: 'V' });
    if (p) cells.push(p);
  }
  return {
    id: 'power',
    sections: [
      sec('power', 'Power', [FR.power(log), ...cells, FR.temperature(log)]),
      sec('hover', 'Hover thrust normalised on voltage', hov.length ? hov : [{ kind: 'text', id: 'nohover', text: 'hover_thrust_estimate / battery_status not available or no airborne segment.', tone: 'info' }]),
    ],
  };
}

// ------------------------------------------------------------------ GPS & EKF
export function sensorsPage(log: ULog): PageSpec {
  const gr = gpsReadiness(log);
  const ready: PlotSpec[] = [];
  if (gr) {
    ready.push({ kind: 'findings', id: 'gps-find', title: 'GPS readiness at arming', items: gr.findings });
    ready.push({ kind: 'kv', id: 'gps-kv', title: 'GNSS state', items: gr.rows });
    if (gr.timeline.length) ready.push({ kind: 'time', id: 'gps-tl', title: 'GNSS readiness timeline', series: gr.timeline.map((x, i) => ({ label: x.label, t: x.t, y: x.y, color: i, step: true })), height: 220, note: gr.armT !== undefined ? `First arming at ${gr.armT.toFixed(1)} s` : undefined });
  }
  const ir = log.topic('estimator_innovation_test_ratios');
  let innov: TimePlotSpec | undefined;
  if (ir) {
    const groups: [string, string[]][] = [['GPS hpos', ['gps_hpos[0]', 'gps_hpos[1]']], ['GPS vpos', ['gps_vpos']], ['GPS hvel', ['gps_hvel[0]', 'gps_hvel[1]']], ['GPS vvel', ['gps_vvel']], ['Baro', ['baro_vpos']], ['Mag', ['mag_field[0]', 'mag_field[1]', 'mag_field[2]']], ['Heading', ['heading']], ['Range', ['rng_vpos']], ['Flow', ['flow[0]', 'flow[1]']], ['Airspeed', ['airspeed']]];
    const s = groups.map(([label, fs], i) => {
      if (fs.some((f) => !ir.cols[f])) return undefined;
      const y = new Float32Array(ir.count);
      let any = false;
      for (let k = 0; k < ir.count; k++) { let m = 0; for (const f of fs) m = Math.max(m, ir.cols[f][k]); y[k] = m; if (m > 0) any = true; }
      return any ? { label, t: ir.t, y, color: i % 8 } : undefined;
    });
    innov = timePlot('innov-ratio', 'EKF2 innovation test ratios (max per sensor; > 1 = rejected)', s, { yRange: [0, 1.5] });
  }
  const ef = log.topic('estimator_status_flags');
  let flagsTable: TableSpec | undefined;
  if (ef) {
    const rows: (string | number)[][] = [];
    for (const f of Object.keys(ef.cols)) {
      if (!/^(cs_|fs_)/.test(f)) continue;
      const v = ef.cols[f];
      const ch: string[] = [];
      for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1]) ch.push(`${ef.t[i].toFixed(1)}s→${v[i]}`);
      if (ch.length || (f.startsWith('fs_') && maxAbs(v) > 0)) rows.push([f, v[0], ch.slice(0, 8).join(', ') + (ch.length > 8 ? ` … (+${ch.length - 8})` : '')]);
    }
    flagsTable = { kind: 'table', id: 'ekf-flags', title: 'EKF2 status flags that changed', columns: ['Flag', 'Initial', 'Changes (time → value)'], rows, searchable: true, maxHeight: 360 };
  }
  return {
    id: 'sensors',
    sections: [
      sec('gps-ready', 'GPS readiness at arming', ready),
      sec('gps', 'GPS', [FR.gpsUncertainty(log), FR.gpsNoise(log)]),
      sec('ekf', 'Estimator (EKF2)', [FR.estimatorFlags(log), innov, flagsTable, FR.failsafeFlags(log)]),
      sec('mag', 'Magnetometer & distance', [FR.rawMag(log), FR.thrustAndMag(log), FR.distanceSensor(log)]),
    ],
  };
}

// ------------------------------------------------------------------ system
export function systemPage(log: ULog): PageSpec {
  const lt = loopTiming(log);
  const rates = topicRates(log);
  const timing: PlotSpec[] = [];
  if (lt.loops.length) timing.push({ kind: 'table', id: 'loops', title: 'Loop timing while armed (logger dropouts excluded)', columns: ['Loop', 'Rate [Hz]', 'Median [ms]', 'p99 [ms]', 'p99.9 [ms]', 'Max [ms]'], rows: lt.loops.map((l) => [l.name, l.rate.toFixed(0), l.median.toFixed(2), l.judged ? l.p99.toFixed(2) : '(logged too slow)', l.judged ? l.p999.toFixed(2) : '', l.max.toFixed(1)]) });
  const kv: [string, string][] = [];
  if (lt.latency) kv.push(['Rate loop latency gyro → torque (median / p99.9 / max)', `${lt.latency.median.toFixed(2)} / ${lt.latency.p999.toFixed(2)} / ${lt.latency.max.toFixed(2)} ms`]);
  if (lt.cpu) kv.push(['CPU load armed (mean / p95 / max)', `${lt.cpu.mean.toFixed(0)} / ${lt.cpu.p95.toFixed(0)} / ${lt.cpu.max.toFixed(0)} %`], ['RAM usage', `${lt.cpu.ram.toFixed(0)} %`]);
  const prof = log.params.get('SDLOG_PROFILE');
  if (prof !== undefined) {
    const bits = PARAM_META['SDLOG_PROFILE']?.b ?? {};
    kv.push(['SDLOG_PROFILE', `${prof}: ${Object.entries(bits).filter(([i]) => (prof >> Number(i)) & 1).map(([, n]) => n).join(', ')}`]);
  }
  if (lt.intervalHist.length) kv.push(['vehicle_angular_velocity logged intervals', lt.intervalHist.slice(0, 8).map((h) => `${h.ms} ms ×${h.count}`).join(', ')]);
  timing.push({ kind: 'kv', id: 'timing-kv', title: 'Timing summary', items: kv, note: 'The logger runs on a fixed cycle (≈3.5 ms by default, faster with FIFO profiles): logged intervals of fast topics are multiples of it.' });
  const dropRows = log.dropouts.map((d) => [d.t.toFixed(2), d.durationMs]);
  const perf: PlotSpec[] = [];
  for (const k of ['perf_top_preflight', 'perf_top_postflight', 'perf_counter_preflight', 'perf_counter_postflight', 'boot_console_output']) {
    const v = log.infoMulti[k]?.[0] ?? log.info[k];
    if (typeof v === 'string' && v.trim()) perf.push({ kind: 'text', id: k, title: k, text: v, mono: true });
  }
  return {
    id: 'system',
    sections: [
      sec('cpu', 'CPU & sampling', [FR.cpuRam(log), FR.samplingRegularity(log)]),
      sec('timing', 'Loop timing', timing),
      sec('rates', 'Logged topics & rates', [{ kind: 'table', id: 'rates', title: `${rates.length} logged topics`, columns: ['Topic', 'Messages', 'Mean rate [Hz]', 'Median rate [Hz]', 'p99 interval [ms]', 'Max interval [ms]', 'Jitter (CV)'], rows: rates.map((r) => [r.key, r.count, r.meanHz.toFixed(1), r.medianHz.toFixed(1), fmt(r.p99Ms, 1), fmt(r.maxMs, 0), fmt(r.cv, 2)]), searchable: true, maxHeight: 420 }]),
      sec('dropouts', 'Logger dropouts', [dropRows.length ? { kind: 'table', id: 'drop', title: `${dropRows.length} dropouts`, columns: ['Time [s]', 'Duration [ms]'], rows: dropRows, maxHeight: 260 } : { kind: 'text', id: 'nodrop', text: 'No dropouts.', tone: 'good' }]),
      sec('perf', 'Performance counters & boot log', perf),
    ],
  };
}

// ------------------------------------------------------------------ params & messages
export function paramsPage(log: ULog): PageSpec {
  const nd = nonDefaultParams(log);
  const changed = log.changedParams;
  const all = [...log.params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    id: 'params',
    sections: [
      sec('nondefault', 'Non-default parameters', [{ kind: 'table', id: 'nondef', title: `${nd.length} non-default parameters (except RC and sensor calibration)`, columns: ['Name', 'Value', 'Default', 'Frame default', 'Min', 'Max', 'Description'], rows: nd.map((r) => [r.name, fmtParam(r.name, r.value), r.def !== undefined ? fmtParam(r.name, r.def) : '', r.frameDef !== undefined ? fmtParam(r.name, r.frameDef) : '', r.min ?? '', r.max ?? '', r.desc]), rowTone: nd.map((r) => (r.notFrameDefault ? 'warning' : undefined)), searchable: true, maxHeight: 480, note: 'Marked rows differ from the airframe default (when the log carries airframe defaults). Defaults come from the log or from the bundled PX4 metadata.' }]),
      sec('inflight', 'Changed during the log', [changed.length ? { kind: 'table', id: 'chg', title: `${changed.length} changes`, columns: ['Time [s]', 'Name', 'Value'], rows: changed.map((c) => [c.t.toFixed(2), c.name, fmtParam(c.name, c.value)]) } : { kind: 'text', id: 'nochg', text: 'No parameter changes during the log.' }]),
      sec('all', 'All parameters', [{ kind: 'table', id: 'allp', title: `${all.length} parameters`, columns: ['Name', 'Value', 'Group', 'Description'], rows: all.map(([n, v]) => [n, fmtParam(n, v), PARAM_META[n]?.g ?? '', PARAM_META[n]?.s ?? '']), searchable: true, maxHeight: 520 }]),
    ],
  };
}

export function messagesPage(log: ULog, events: DecodedEvent[], source: string): PageSpec {
  const rows: { t: number; level: number; src: string; msg: string; desc: string }[] = [];
  // PROTOCOL-level events (health/arming summaries) carry no readable message: hidden like QGroundControl does
  for (const e of events) if (e.level < 8) rows.push({ t: e.t, level: e.level, src: 'event', msg: e.message, desc: e.description });
  for (const m of log.logs) if (!m.message.endsWith('\t')) rows.push({ t: m.t, level: m.level, src: 'log', msg: m.message, desc: '' });
  rows.sort((a, b) => a.t - b.t);
  const tone = (l: number): Tone | undefined => (l <= 3 ? 'danger' : l === 4 ? 'warning' : undefined);
  return {
    id: 'messages',
    sections: [sec('msgs', 'Logged messages & events', [{
      kind: 'table', id: 'msgs', title: `${rows.length} messages (${events.length} events, metadata: ${source})`, columns: ['Time', 'Level', 'Source', 'Message', 'Details'],
      rows: rows.map((r) => [fmtDuration(r.t), LOG_LEVELS[r.level] ?? String(r.level), r.src, r.msg, r.desc]), rowTone: rows.map((r) => tone(r.level)), searchable: true, maxHeight: 640,
    }])],
  };
}

export { attitudeErrorRms, quietHoverWindows };

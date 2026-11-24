/**
 * Port of Flight Review's configured_plots.py (PX4/flight_review, BSD-3-Clause) to the columnar engine.
 * Each function returns one plot spec (or undefined when the data is not in the log), in Flight Review order.
 */
import type { ULog } from '../ulog';
import type { PlotSpec, TimePlotSpec, XYPlotSpec, MapSpec, Mark, ReplaySpec } from '../types';
import { ser, timePlot, compact, fftPlot, specPlot, DEG, isAllConstant, maxAbs } from './helpers';
import { eulerCols, gnssTopic, flightModes, AXES, airborneIntervals } from '../px4';
import { unpackFifo } from '../ulog';
import { diff, minMax, lowerBound } from '../dsp';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function positionXY(log: ULog): XYPlotSpec | undefined {
  const lp = log.topic('vehicle_local_position');
  if (!lp || !lp.cols['x']) return undefined;
  if (maxAbs(lp.cols['x']) + maxAbs(lp.cols['y']) === 0) return undefined;
  const hdg = lp.cols['heading'] ? Float32Array.from(lp.cols['heading'], (h) => (h * 180) / Math.PI) : undefined;
  const series: XYPlotSpec['series'] = [{ label: 'Estimated', x: Float32Array.from(lp.cols['y']), y: Float32Array.from(lp.cols['x']), t: lp.t, hdg, color: 0 }];
  const sp = log.topic('vehicle_local_position_setpoint');
  if (sp && sp.cols['x'] && sp.count > 1) series.push({ label: 'Setpoint', x: Float32Array.from(sp.cols['y']), y: Float32Array.from(sp.cols['x']), color: 1, dash: true });
  return { kind: 'xy', id: 'pos-xy', title: 'Local position (top view)', xLabel: 'East y [m]', yLabel: 'North x [m]', series, equal: true, height: 380 };
}

export function gpsMap(log: ULog): MapSpec | undefined {
  const g = gnssTopic(log);
  const gp = log.topic('vehicle_global_position');
  let lat: Float64Array | undefined, lon: Float64Array | undefined, t: Float64Array | undefined, alt: Float64Array | undefined;
  if (gp && gp.cols['lat'] && maxAbs(gp.cols['lat']) > 0) { lat = gp.cols['lat']; lon = gp.cols['lon']; t = gp.t; alt = gp.cols['alt']; }
  else if (g) {
    const d = log.topic(g)!;
    if (d.cols['latitude_deg']) { lat = d.cols['latitude_deg']; lon = d.cols['longitude_deg']; t = d.t; alt = d.cols['altitude_msl_m']; }
  }
  if (!lat || !lon || !t) return undefined;
  const keep: number[] = [];
  for (let i = 0; i < lat.length; i++) if (lat[i] !== 0 && lon[i] !== 0 && isFinite(lat[i])) keep.push(i);
  if (keep.length < 2) return undefined;
  const la = Float64Array.from(keep, (i) => lat![i]);
  const lo = Float64Array.from(keep, (i) => lon![i]);
  const tt = Float64Array.from(keep, (i) => t![i]);
  const modes = flightModes(log);
  const segments: MapSpec['segments'] = [];
  let j = 0;
  for (const m of modes) {
    while (j < tt.length && tt[j] < m.t0) j++;
    let k = j;
    while (k < tt.length && tt[k] < m.t1) k++;
    if (k > j) segments.push({ i0: Math.max(0, j - 1), i1: k - 1, mode: m.mode });
    j = k;
  }
  if (!segments.length) segments.push({ i0: 0, i1: tt.length - 1, mode: -1 });
  const home = log.topic('home_position');
  let h: [number, number] | undefined;
  let homeAlt: number | undefined;
  if (home && home.cols['lat'] && home.count) {
    const i = home.count - 1;
    if (home.cols['lat'][i] !== 0) { h = [home.cols['lat'][i], home.cols['lon'][i]]; homeAlt = home.cols['alt']?.[i]; }
  }
  let rel: Float32Array | undefined;
  if (alt) {
    const ref = homeAlt !== undefined && isFinite(homeAlt) ? homeAlt : alt[keep[0]];
    rel = Float32Array.from(keep, (i) => alt![i] - ref);
  }
  // heading at the map samples (nearest local-position sample: no wrap-around artefacts)
  let hdg: Float32Array | undefined;
  const lp = log.topic('vehicle_local_position');
  if (lp && lp.cols['heading']) {
    const hh = lp.cols['heading'];
    hdg = Float32Array.from(tt, (ti) => (hh[Math.min(lp.count - 1, lowerBound(lp.t, ti))] * 180) / Math.PI);
  }
  return { kind: 'map', id: 'map', title: 'Trajectory', lat: la, lon: lo, t: tt, alt: rel, hdg, segments, home: h };
}

/** Replay time base and live values from vehicle_local_position. */
export function replay(log: ULog): ReplaySpec | undefined {
  const lp = log.topic('vehicle_local_position');
  if (!lp || !lp.cols['z'] || lp.count < 10) return undefined;
  const air = airborneIntervals(log);
  const n = lp.count;
  const f32 = (fn: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => fn(i));
  return {
    kind: 'replay', id: 'replay', t0: lp.t[0], t1: lp.t[n - 1], start: air.length ? Math.max(lp.t[0], air[0][0] - 3) : lp.t[0],
    t: lp.t,
    height: f32((i) => -lp.cols['z'][i]),
    speed: f32((i) => Math.hypot(lp.cols['vx'][i], lp.cols['vy'][i])),
    vz: f32((i) => -lp.cols['vz'][i]),
    hdg: f32((i) => (lp.cols['heading'] ? (lp.cols['heading'][i] * 180) / Math.PI : NaN)),
  };
}

export function altitude(log: ULog): TimePlotSpec | undefined {
  const g = gnssTopic(log);
  return timePlot('altitude', 'Altitude estimate', [
    g ? ser(log, g, 'altitude_msl_m', 'GPS altitude (MSL)', 0) : undefined,
    ser(log, 'vehicle_air_data', 'baro_alt_meter', 'Barometer altitude', 1),
    ser(log, 'vehicle_global_position', 'alt', 'Fused altitude estimate', 2),
    ser(log, 'position_setpoint_triplet', 'current.alt', 'Altitude setpoint', 4, { points: true }),
  ], { yLabel: 'm' });
}

export function attitudeAngle(log: ULog, axis: (typeof AXES)[number], i: number): TimePlotSpec | undefined {
  const att = log.topic('vehicle_attitude');
  const sp = log.topic('vehicle_attitude_setpoint');
  const e = att ? eulerCols(att, 'q') : undefined;
  const es = sp ? eulerCols(sp, 'q_d') : undefined;
  return timePlot(`angle-${axis}`, `${cap(axis)} angle`, [
    e ? ser(log, 'vehicle_attitude', null, `${cap(axis)} estimated`, 0, { fn: (_v, k) => e[axis][k] * DEG }) : undefined,
    es ? ser(log, 'vehicle_attitude_setpoint', null, `${cap(axis)} setpoint`, 1, { fn: (_v, k) => es[axis][k] * DEG, step: true }) : undefined,
    axis === 'yaw' ? ser(log, 'vehicle_attitude_setpoint', 'yaw_sp_move_rate', 'Yaw FF setpoint [deg/s]', 2, { scale: DEG, step: true }) : undefined,
  ], { yLabel: 'deg', height: 200 + 0 * i });
}

export function angularRate(log: ULog, axis: (typeof AXES)[number], i: number): TimePlotSpec | undefined {
  const lim = log.params.get(`MC_${axis[0].toUpperCase()}R_INT_LIM`);
  const limStr = lim !== undefined ? `[-${(lim * 100).toFixed(0)}, ${(lim * 100).toFixed(0)}]` : '(*100)';
  return timePlot(`rate-${axis}`, `${cap(axis)} angular rate`, [
    ser(log, 'vehicle_angular_velocity', `xyz[${i}]`, `${cap(axis)} rate estimated`, 0, { scale: DEG }),
    ser(log, 'vehicle_rates_setpoint', axis, `${cap(axis)} rate setpoint`, 1, { scale: DEG, step: true }),
    ser(log, 'rate_ctrl_status', `${axis}speed_integ`, `${cap(axis)} rate integral ${limStr}`, 2, { scale: 100 }),
  ], { yLabel: 'deg/s', height: 200 });
}

export function localPosition(log: ULog, axis: 'x' | 'y' | 'z'): TimePlotSpec | undefined {
  return timePlot(`lpos-${axis}`, `Local position ${axis.toUpperCase()}`, [
    ser(log, 'vehicle_local_position', axis, `${axis.toUpperCase()} estimated`, 0),
    ser(log, 'vehicle_local_position_setpoint', axis, `${axis.toUpperCase()} setpoint`, 1, { step: true }),
  ], { yLabel: 'm', height: 200 });
}

export function velocity(log: ULog): TimePlotSpec | undefined {
  return timePlot('velocity', 'Velocity', [
    ser(log, 'vehicle_local_position', 'vx', 'X', 0), ser(log, 'vehicle_local_position', 'vy', 'Y', 1), ser(log, 'vehicle_local_position', 'vz', 'Z', 2),
    ser(log, 'vehicle_local_position_setpoint', 'vx', 'X setpoint', 0, { step: true, dash: true }),
    ser(log, 'vehicle_local_position_setpoint', 'vy', 'Y setpoint', 1, { step: true, dash: true }),
    ser(log, 'vehicle_local_position_setpoint', 'vz', 'Z setpoint', 2, { step: true, dash: true }),
  ], { yLabel: 'm/s' });
}

export function visualOdometry(log: ULog): PlotSpec[] {
  if (!log.has('vehicle_visual_odometry')) return [];
  return compact([
    timePlot('vio-pos', 'Visual odometry position', ['position[0]', 'position[1]', 'position[2]'].map((f, i) => ser(log, 'vehicle_visual_odometry', f, 'XYZ'[i], i)), { yLabel: 'm' }),
    timePlot('vio-vel', 'Visual odometry velocity', ['velocity[0]', 'velocity[1]', 'velocity[2]'].map((f, i) => ser(log, 'vehicle_visual_odometry', f, 'XYZ'[i], i)), { yLabel: 'm/s' }),
  ]);
}

export function airspeed(log: ULog): TimePlotSpec | undefined {
  if (!log.has('airspeed_validated') && !log.has('airspeed')) return undefined;
  const g = gnssTopic(log);
  return timePlot('airspeed', 'Airspeed', [
    ser(log, 'airspeed_validated', 'true_airspeed_m_s', 'True airspeed', 1),
    ser(log, 'airspeed', 'indicated_airspeed_m_s', 'Indicated airspeed', 2),
    g ? ser(log, g, 'vel_m_s', 'Ground speed (GPS)', 0) : undefined,
    ser(log, 'tecs_status', 'true_airspeed_sp', 'True airspeed setpoint', 3),
  ], { yLabel: 'm/s' });
}

export function tecs(log: ULog): TimePlotSpec | undefined {
  return timePlot('tecs', 'TECS', [
    ser(log, 'tecs_status', 'height_rate', 'Height rate', 0), ser(log, 'tecs_status', 'height_rate_setpoint', 'Height rate setpoint', 1),
  ], { yLabel: 'm/s' });
}

export function manualControl(log: ULog): TimePlotSpec | undefined {
  const k = 'manual_control_setpoint';
  return timePlot('manual', 'Manual control inputs (radio or joystick)', [
    ser(log, k, 'roll', 'Y / Roll', 0), ser(log, k, 'pitch', 'X / Pitch', 1), ser(log, k, 'yaw', 'Yaw', 2),
    ser(log, k, 'throttle', 'Throttle [-1, 1]', 3), ser(log, k, 'aux1', 'Aux1', 4), ser(log, k, 'aux2', 'Aux2', 5),
    ser(log, 'manual_control_switches', 'mode_slot', 'Flight mode slot (/6)', 6, { scale: 1 / 6, step: true }),
    ser(log, 'manual_control_switches', 'kill_switch', 'Kill switch', 7, { fn: (v) => (v === 1 ? 1 : 0), step: true }),
  ], { yRange: [-1.1, 1.1] });
}

export function actuatorControls(log: ULog): TimePlotSpec | undefined {
  const th = log.topic('vehicle_thrust_setpoint');
  const hasFwd = th && th.cols['xyz[0]'] && maxAbs(th.cols['xyz[0]']) > 1e-6;
  return timePlot('act-controls', 'Actuator controls (torque & thrust setpoints)', [
    ser(log, 'vehicle_torque_setpoint', 'xyz[0]', 'Roll', 0), ser(log, 'vehicle_torque_setpoint', 'xyz[1]', 'Pitch', 1),
    ser(log, 'vehicle_torque_setpoint', 'xyz[2]', 'Yaw', 2),
    ser(log, 'vehicle_thrust_setpoint', 'xyz[2]', 'Thrust (up)', 3, { scale: -1 }),
    hasFwd ? ser(log, 'vehicle_thrust_setpoint', 'xyz[0]', 'Thrust (forward)', 4) : undefined,
  ]);
}

function filterMarks(log: ULog, which: ('lpf' | 'dlpf' | 'notch')[]): Mark[] {
  const p = (n: string) => log.params.get(n) ?? 0;
  const m: Mark[] = [];
  if (which.includes('dlpf')) m.push({ x: p('IMU_DGYRO_CUTOFF'), label: 'IMU_DGYRO_CUTOFF' });
  if (which.includes('lpf')) m.push({ x: p('IMU_GYRO_CUTOFF'), label: 'IMU_GYRO_CUTOFF' });
  if (which.includes('notch')) {
    m.push({ x: p('IMU_GYRO_NF0_FRQ'), label: 'IMU_GYRO_NF0_FRQ' });
    m.push({ x: p('IMU_GYRO_NF1_FRQ'), label: 'IMU_GYRO_NF1_FRQ' });
  }
  return m.filter((x) => x.x > 0);
}

export function actuatorControlsFFT(log: ULog) {
  return fftPlot(log, 'fft-torque', 'Actuator controls FFT', 'vehicle_torque_setpoint', ['xyz[0]', 'xyz[1]', 'xyz[2]'], ['Roll', 'Pitch', 'Yaw'], filterMarks(log, ['dlpf', 'lpf', 'notch']));
}
export function angularVelocityFFT(log: ULog) {
  return fftPlot(log, 'fft-angvel', 'Angular velocity FFT', 'vehicle_angular_velocity', ['xyz[0]', 'xyz[1]', 'xyz[2]'], ['Rollspeed', 'Pitchspeed', 'Yawspeed'], filterMarks(log, ['lpf', 'notch']));
}
export function angularAccelerationFFT(log: ULog) {
  return fftPlot(log, 'fft-angacc', 'Angular acceleration FFT', 'vehicle_angular_velocity', ['xyz_derivative[0]', 'xyz_derivative[1]', 'xyz_derivative[2]'], ['Roll accel', 'Pitch accel', 'Yaw accel'], filterMarks(log, ['dlpf', 'notch']), { yMax: 1 });
}

function controlOutputs(log: ULog, key: string, name: string): TimePlotSpec | undefined {
  const d = log.topic(key);
  if (!d) return undefined;
  const s = [];
  for (let i = 0; i < 12; i++) {
    const c = d.cols[`control[${i}]`];
    if (!c || c.every((v) => v !== v)) break;
    s.push(ser(log, key, `control[${i}]`, `${name} ${i + 1}`, i % 8));
  }
  return timePlot(`out-${key}`, `${name} outputs`, s, { yRange: [-1, 1] });
}
export const motorOutputs = (log: ULog) => controlOutputs(log, 'actuator_motors', 'Motor');
export const servoOutputs = (log: ULog) => controlOutputs(log, 'actuator_servos', 'Servo');

export function actuatorOutputs(log: ULog): TimePlotSpec[] {
  const out: TimePlotSpec[] = [];
  ['actuator_outputs', 'actuator_outputs_1', 'actuator_outputs_2'].forEach((k, inst) => {
    const d = log.topic(k);
    if (!d || d.count < 2) return;
    const n = Math.min(16, d.cols['noutputs'] ? minMax(d.cols['noutputs'])[1] : 16);
    const s = [];
    for (let i = 0; i < n; i++) {
      const c = d.cols[`output[${i}]`];
      if (c && !isAllConstant(c)) s.push(ser(log, k, `output[${i}]`, `Output ${i}`, i % 8));
    }
    const p = timePlot(`aout-${inst}`, `Actuator outputs (instance ${inst})`, s, { note: 'Raw output values (e.g. PWM µs)' });
    if (p) out.push(p);
  });
  return out;
}

export function escRpm(log: ULog): TimePlotSpec | undefined {
  const d = log.topic('esc_status');
  if (!d) return undefined;
  const n = d.cols['esc_count'] ? d.cols['esc_count'][0] : 8;
  const s = [];
  for (let i = 0; i < n; i++) {
    const c = d.cols[`esc[${i}].esc_rpm`];
    if (c && maxAbs(c) > 0.001) s.push(ser(log, 'esc_status', `esc[${i}].esc_rpm`, `ESC ${i} RPM`, i % 8));
  }
  return timePlot('esc-rpm', 'Motor RPM', s, { yLabel: 'RPM' });
}

export function rawAcceleration(log: ULog) {
  return timePlot('raw-acc', 'Raw acceleration', [0, 1, 2].map((i) => ser(log, 'sensor_combined', `accelerometer_m_s2[${i}]`, 'XYZ'[i], i)), { yLabel: 'm/s²' });
}

export function vibrationMetrics(log: ULog) {
  const s = [];
  for (let i = 0; i < 4; i++) {
    const k = i ? `vehicle_imu_status_${i}` : 'vehicle_imu_status';
    s.push(ser(log, k, 'accel_vibration_metric', `Accel ${i} vibration level`, i));
  }
  return timePlot('vib-metrics', 'Vibration metrics', s, { yLabel: 'm/s²', note: 'PX4 guidance: < 15 m/s² good, 15–30 borderline, > 30 problematic' });
}

export function accelSpectrogram(log: ULog) {
  const d = log.topic('sensor_combined');
  if (!d || !d.cols['accelerometer_m_s2[0]']) return undefined;
  return specPlot('spec-acc', 'Acceleration power spectral density', log.sampleTime('sensor_combined') ?? d.t, [0, 1, 2].map((i) => d.cols[`accelerometer_m_s2[${i}]`]));
}
export function angVelSpectrogram(log: ULog) {
  const d = log.topic('vehicle_angular_velocity');
  if (!d) return undefined;
  return specPlot('spec-angvel', 'Angular velocity power spectral density', log.sampleTime('vehicle_angular_velocity')!, [0, 1, 2].map((i) => d.cols[`xyz[${i}]`]));
}
export function angAccSpectrogram(log: ULog) {
  const d = log.topic('vehicle_angular_velocity');
  if (!d || !d.cols['xyz_derivative[0]']) return undefined;
  return specPlot('spec-angacc', 'Angular acceleration power spectral density', log.sampleTime('vehicle_angular_velocity')!, [0, 1, 2].map((i) => d.cols[`xyz_derivative[${i}]`]));
}

export function rawGyro(log: ULog) {
  return timePlot('raw-gyro', 'Raw angular speed (gyroscope)', [0, 1, 2].map((i) => ser(log, 'sensor_combined', `gyro_rad[${i}]`, 'XYZ'[i], i, { scale: DEG })), { yLabel: 'deg/s' });
}

/** FIFO plots for each IMU instance: raw data, spectrogram, sampling regularity. */
export function fifoPlots(log: ULog): PlotSpec[] {
  const out: PlotSpec[] = [];
  for (const [base, unit, sc, nm] of [['sensor_accel_fifo', 'm/s²', 1, 'Acceleration'], ['sensor_gyro_fifo', 'deg/s', DEG, 'Gyro']] as const) {
    for (let inst = 0; inst < 4; inst++) {
      const key = inst ? `${base}_${inst}` : base;
      if (!log.has(key)) continue;
      const f = unpackFifo(log, key);
      if (!f || f.t.length < 300) continue;
      const step = Math.max(1, Math.floor(f.t.length / 400000));
      const mk = (a: Float64Array) => { const n = Math.floor(a.length / step); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = a[i * step] * sc; return o; };
      const tt = step === 1 ? f.t : Float64Array.from({ length: Math.floor(f.t.length / step) }, (_, i) => f.t[i * step]);
      out.push({ kind: 'time', id: `fifo-raw-${key}`, title: `Raw ${nm.toLowerCase()} (FIFO, IMU${inst})`, yLabel: unit, series: [mk(f.x), mk(f.y), mk(f.z)].map((y, i) => ({ label: 'XYZ'[i], t: tt, y, color: i })), note: `${f.fs.toFixed(0)} Hz, ${f.t.length.toLocaleString()} samples, ${f.gaps} gaps` });
      const sp = specPlot(`fifo-spec-${key}`, `${nm} power spectral density (FIFO, IMU${inst})`, f.t, [f.x, f.y, f.z], { nperseg: 512 });
      if (sp) out.push(sp);
      const d = log.topic(key)!;
      const dts = diff(d.cols['timestamp_sample'] ?? d.cols['timestamp']);
      out.push({ kind: 'time', id: `fifo-reg-${key}`, title: `Sampling regularity of sensor data (FIFO, IMU${inst})`, yLabel: 'µs', series: [{ label: 'delta t (between 2 logged samples)', t: d.t.subarray(1), y: Float32Array.from(dts), color: 2 }], yRange: [0, Math.min(25e3, minMax(dts)[1] * 1.2)] });
    }
  }
  return out;
}

export function rawMag(log: ULog) {
  return timePlot('raw-mag', 'Raw magnetic field strength', [0, 1, 2].map((i) => ser(log, 'vehicle_magnetometer', `magnetometer_ga[${i}]`, 'XYZ'[i], i)), { yLabel: 'gauss' });
}

export function distanceSensor(log: ULog) {
  return timePlot('dist', 'Distance sensor', [
    ser(log, 'distance_sensor', 'current_distance', 'Distance', 0), ser(log, 'distance_sensor', 'variance', 'Variance', 1),
    ser(log, 'vehicle_local_position', 'dist_bottom', 'Estimated distance bottom', 2), ser(log, 'vehicle_local_position', 'dist_bottom_valid', 'Dist bottom valid', 3, { step: true }),
  ], { yLabel: 'm' });
}

export function gpsUncertainty(log: ULog) {
  const g = gnssTopic(log);
  if (!g) return undefined;
  return timePlot('gps-unc', 'GPS uncertainty', [
    ser(log, g, 'eph', 'Horizontal position accuracy [m]', 0), ser(log, g, 'epv', 'Vertical position accuracy [m]', 1),
    ser(log, g, 'hdop', 'Horizontal dilution of precision [m]', 2), ser(log, g, 'vdop', 'Vertical dilution of precision [m]', 3),
    ser(log, g, 's_variance_m_s', 'Speed accuracy [m/s]', 4), ser(log, g, 'satellites_used', 'Num satellites used', 5, { step: true }),
    ser(log, g, 'fix_type', 'GPS fix type', 6, { step: true }),
  ], { yRange: [0, 40] });
}

export function gpsNoise(log: ULog) {
  const g = gnssTopic(log);
  if (!g) return undefined;
  return timePlot('gps-noise', 'GPS noise & jamming', [
    ser(log, g, 'noise_per_ms', 'Noise per ms', 0), ser(log, g, 'jamming_indicator', 'Jamming indicator', 1),
    ser(log, g, 'automatic_gain_control', 'Automatic gain control', 2),
  ]);
}

export function thrustAndMag(log: ULog) {
  return timePlot('thrust-mag', 'Thrust and magnetic field', [
    ser(log, 'vehicle_magnetometer', null, 'Norm of magnetic field', 0, { fn: (_v, i, d) => Math.hypot(d.cols['magnetometer_ga[0]'][i], d.cols['magnetometer_ga[1]'][i], d.cols['magnetometer_ga[2]'][i]) }),
    ser(log, 'vehicle_thrust_setpoint', null, 'Thrust', 1, { fn: (_v, i, d) => Math.hypot(d.cols['xyz[0]'][i], d.cols['xyz[1]'][i], d.cols['xyz[2]'][i]) }),
  ], { height: 200 });
}

export function power(log: ULog) {
  const b = log.topic('battery_status');
  const hasR = b && b.cols['internal_resistance_estimate'] && maxAbs(b.cols['internal_resistance_estimate']) > 0;
  return timePlot('power', 'Power', [
    ser(log, 'battery_status', 'voltage_v', 'Battery voltage [V]', 0),
    ser(log, 'battery_status', 'current_a', 'Battery current [A]', 1),
    ser(log, 'battery_status', 'discharged_mah', 'Discharged amount [mAh / 100]', 2, { scale: 0.01 }),
    ser(log, 'battery_status', 'remaining', 'Battery remaining [0=empty, 10=full]', 3, { scale: 10 }),
    hasR ? ser(log, 'battery_status', 'ocv_estimate', 'Open circuit voltage estimate [V]', 4) : undefined,
    hasR ? ser(log, 'battery_status', 'internal_resistance_estimate', 'Internal resistance estimate [mΩ]', 5, { scale: 1000 }) : undefined,
    ser(log, 'system_power', 'voltage5v_v', '5 V', 6),
    ser(log, 'system_power', 'sensors3v3[0]', '3.3 V', 7),
  ]);
}

export function temperature(log: ULog) {
  const s = [
    ser(log, 'sensor_baro', 'temperature', 'Baro temperature', 0),
    ser(log, 'sensor_accel', 'temperature', 'Accel temperature', 1),
    ser(log, 'airspeed', 'air_temperature_celsius', 'Airspeed temperature', 2),
    ser(log, 'battery_status', 'temperature', 'Battery temperature', 3),
  ];
  const esc = log.topic('esc_status');
  if (esc) for (let i = 0; i < 8; i++) {
    const c = esc.cols[`esc[${i}].esc_temperature`];
    if (c && maxAbs(c) > 0.001) s.push(ser(log, 'esc_status', `esc[${i}].esc_temperature`, `ESC ${i} temperature`, (4 + i) % 8));
  }
  return timePlot('temperature', 'Temperature', s, { yLabel: '°C' });
}

export function estimatorFlags(log: ULog) {
  const d = log.topic('estimator_status');
  if (!d) return undefined;
  const s = [
    ser(log, 'estimator_status', 'health_flags', 'Health flags (vel, pos, hgt)', 0, { step: true }),
    ser(log, 'estimator_status', 'timeout_flags', 'Timeout flags (vel, pos, hgt)', 1, { step: true }),
    ser(log, 'estimator_status', 'filter_fault_flags', 'Filter fault flags', 2, { step: true }),
    ser(log, 'estimator_status', 'gps_check_fail_flags', 'GPS check fail flags', 3, { step: true }),
  ];
  const nz = s.filter((x) => x && maxAbs(x.y) > 0.1);
  return timePlot('est-flags', 'Estimator flags', nz.length ? nz : [s[0]], { height: 200 });
}

export function failsafeFlags(log: ULog) {
  const s = [
    ser(log, 'vehicle_status', 'failsafe', 'In failsafe', 0, { step: true }),
    ser(log, 'vehicle_status', 'failsafe_and_user_took_over', 'User took over failsafe', 1, { step: true }),
  ];
  const ff = log.topic('failsafe_flags');
  let n = 2;
  if (ff) for (const f of Object.keys(ff.cols)) {
    if (f === 'timestamp' || f.startsWith('mode_req_') || f === 'navigator') continue;
    if (maxAbs(ff.cols[f]) > 0) s.push(ser(log, 'failsafe_flags', f, f, n++ % 8, { step: true }));
  }
  return timePlot('failsafe', 'Failsafe flags', s, { height: 200 });
}

export function cpuRam(log: ULog) {
  return timePlot('cpu', 'CPU & RAM', [
    ser(log, 'cpuload', 'ram_usage', 'RAM usage', 1), ser(log, 'cpuload', 'load', 'CPU load', 2),
  ], { yRange: [0, 1], height: 200 });
}

export function samplingRegularity(log: ULog) {
  const d = log.topic('sensor_combined');
  if (!d || d.count < 3) return undefined;
  const dt = diff(d.cols['timestamp']);
  return timePlot('sampling', 'Sampling regularity of sensor data', [
    { label: 'delta t (between 2 logged samples)', t: d.t.subarray(1), y: Float32Array.from(dt), color: 2 },
    ser(log, 'estimator_status', 'time_slip', 'Estimator time slip (cumulative)', 1, { scale: 1e6 }),
  ], { yLabel: 'µs', yRange: [0, 25e3], height: 200 });
}

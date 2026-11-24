/** Interactive pages: filter what-if, rate-loop identification/margins, multi-flight comparison, parameter diff. */
import type { ULog } from '../ulog';
import type { PageSpec, PlotSpec, FreqPlotSpec, Finding, Tone } from '../types';
import { compact, fmt } from './helpers';
import { FilterConfig, configFromParams, responseCurves, lagAt, whatIf, rawGyroRate } from '../analysis/filters';
import { findDoublets, identify, loopResponse, gainsFromParams, measuredClosedLoop, Gains, PlantFit } from '../analysis/plantid';
import { quietSpectra, motorImbalance, hoverThrust, attitudeErrorRms, tiltStats, loopTiming, loggedRate } from '../analysis/flight';
import { airborneIntervals, armedIntervals, flightModes, versionString, AXES, Axis, fmtDuration } from '../px4';
import { diffParams, ParamSet, fmtParam } from '../analysis/params';
import { mean, bandRms } from '../dsp';

// ------------------------------------------------------------------ filters
export interface FiltersRequest { proposed?: Partial<FilterConfig>; range?: [number, number]; replay?: boolean }

export function filtersPage(log: ULog, req: FiltersRequest): PageSpec & { current: FilterConfig; proposed: FilterConfig; rateSource: string } {
  const cur = configFromParams(log);
  const prop: FilterConfig = { ...cur, ...req.proposed, notches: req.proposed?.notches ?? cur.notches };
  const rc = responseCurves(cur), rp = responseCurves(prop);
  const marks = [...cur.notches.filter((n) => n.f > 0).map((n, i) => ({ x: n.f, label: `NF${i}` })), { x: cur.lpf, label: 'LPF' }, { x: cur.dlpf, label: 'D-LPF' }].filter((m) => m.x > 0);
  const plots: PlotSpec[] = [
    { kind: 'freq', id: 'filt-mag', title: 'Filter magnitude', xLabel: 'Hz', yLabel: 'dB', x: rc.f, logX: true, xRange: [rc.f[0], rc.f[rc.f.length - 1]], yRange: [-40, 3], marks, series: [
      { label: 'Current — rate (P/I) path', y: rc.magP, color: 0 }, { label: 'Current — D path', y: rc.magD, color: 1 },
      { label: 'Proposed — rate (P/I) path', y: rp.magP, color: 0, dash: true }, { label: 'Proposed — D path', y: rp.magD, color: 1, dash: true },
    ] },
    { kind: 'freq', id: 'filt-phase', title: 'Filter phase', xLabel: 'Hz', yLabel: 'deg', x: rc.f, logX: true, xRange: [rc.f[0], rc.f[rc.f.length - 1]], marks, series: [
      { label: 'Current — rate path', y: rc.phP, color: 0 }, { label: 'Current — D path', y: rc.phD, color: 1 },
      { label: 'Proposed — rate path', y: rp.phP, color: 0, dash: true }, { label: 'Proposed — D path', y: rp.phD, color: 1, dash: true },
    ] },
    { kind: 'freq', id: 'filt-delay', title: 'Equivalent phase delay', xLabel: 'Hz', yLabel: 'ms', x: rc.f, logX: true, xRange: [0.5, 30], series: [
      { label: 'Current — rate path', y: rc.delayP, color: 0 }, { label: 'Current — D path', y: rc.delayD, color: 1 },
      { label: 'Proposed — rate path', y: rp.delayP, color: 0, dash: true }, { label: 'Proposed — D path', y: rp.delayD, color: 1, dash: true },
    ] },
  ];
  const fq = [1, 2, 4, 6, 10, 20];
  const lc = lagAt(cur, fq), lp = lagAt(prop, fq);
  plots.push({ kind: 'table', id: 'filt-lag', title: 'Phase lag introduced by the filters', columns: ['Frequency', 'Rate path now', 'Rate path proposed', 'D path now', 'D path proposed'], rows: fq.map((f, i) => [`${f} Hz`, `${lc[i].phP.toFixed(1)}° (${lc[i].msP.toFixed(1)} ms)`, `${lp[i].phP.toFixed(1)}° (${lp[i].msP.toFixed(1)} ms)`, `${lc[i].phD.toFixed(1)}° (${lc[i].msD.toFixed(1)} ms)`, `${lp[i].phD.toFixed(1)}° (${lp[i].msD.toFixed(1)} ms)`]) });
  const replay: PlotSpec[] = [];
  if (req.replay !== false) {
    const w = whatIf(log, cur, prop, req.range);
    if (w && w.psd.raw.length) {
      const f = w.psd.f;
      const names = ['roll', 'pitch', 'yaw'];
      const mkMarks = marks;
      for (let a = 0; a < Math.min(2, w.psd.raw.length); a++) {
        replay.push({ kind: 'freq', id: `wi-vel-${a}`, title: `${names[a]}: angular velocity PSD (replay on raw gyro)`, xLabel: 'Hz', yLabel: '(deg/s)²/Hz', x: f, logY: true, xRange: [0, Math.min(w.fs / 2, 250)], marks: mkMarks, series: [
          { label: 'Raw gyro', y: Float32Array.from(w.psd.raw[a]), color: -1 }, { label: 'Current filters', y: Float32Array.from(w.psd.cur[a]), color: 0 }, { label: 'Proposed filters', y: Float32Array.from(w.psd.prop[a]), color: 1 },
        ] });
        replay.push({ kind: 'freq', id: `wi-d-${a}`, title: `${names[a]}: D-term torque PSD (K·D·filtered derivative)`, xLabel: 'Hz', yLabel: '1/Hz', x: f, logY: true, xRange: [0, Math.min(w.fs / 2, 250)], marks: mkMarks, series: [
          { label: 'Current filters', y: Float32Array.from(w.psd.dCur[a]), color: 0 }, { label: 'Proposed filters', y: Float32Array.from(w.psd.dProp[a]), color: 1 },
        ] });
      }
      replay.unshift({ kind: 'table', id: 'wi-table', title: `Noise above 30 Hz — ${w.source === 'fifo' ? 'raw FIFO gyro' : 'sensor_combined'} @ ${w.fs.toFixed(0)} Hz, ${w.windowsS.toFixed(0)} s analysed`, columns: ['Axis', 'Raw gyro [deg/s]', 'Rate now', 'Rate proposed', 'D torque now', 'D torque proposed', 'Total torque noise now', 'Proposed', 'Change'], rows: w.table.map((r) => [r.axis, fmt(r.rawVib), fmt(r.curVel), fmt(r.propVel), fmt(r.curD, 4), fmt(r.propD, 4), fmt(r.curTorque, 4), fmt(r.propTorque, 4), `${(((r.propTorque - r.curTorque) / r.curTorque) * 100).toFixed(0)} %`]), note: `Axis mapping: ${w.mapping}${w.warning ? ' — ' + w.warning : ''}` });
    } else replay.push({ kind: 'text', id: 'wi-none', text: 'No raw gyro data available for the replay.', tone: 'info' });
  }
  const dnf = cur.dnfEnabled ?? 0;
  const notes: Finding[] = [];
  if (dnf) notes.push({ tone: 'info', title: `Dynamic notch enabled (IMU_GYRO_DNF_EN=${dnf})`, detail: 'Dynamic notches (ESC RPM / FFT) move with the motor speed and are not part of this static model.' });
  const rs = rawGyroRate(log);
  return {
    id: 'filters', current: cur, proposed: prop, rateSource: `${rs.fs.toFixed(0)} Hz from ${rs.source}`,
    sections: [
      { id: 'resp', title: 'Frequency response & delay', description: `PX4 gyro filter chain at ${cur.fs.toFixed(0)} Hz (${rs.source}): notches → LPF for the rate (P/I) path, notches → derivative → D-LPF for the D term.`, items: [...(notes.length ? [{ kind: 'findings', id: 'dnf', title: 'Notes', items: notes } as PlotSpec] : []), ...plots] },
      { id: 'replay', title: 'What-if replay on raw gyro', description: 'The current and proposed filter chains are replayed sample-by-sample on the raw gyro (quiet hover or the selected time range); the D-term noise uses the logged MC_*RATE_K and _D.', items: replay },
    ],
  };
}

// ------------------------------------------------------------------ rate loop
export interface RateLoopRequest { windows?: Partial<Record<Axis, [number, number]>>; gains?: Partial<Record<Axis, Gains>>; filters?: Partial<FilterConfig> }

export function rateLoopPage(log: ULog, req: RateLoopRequest, cache: Map<string, PlantFit | undefined>): PageSpec & { doublets: ReturnType<typeof findDoublets>; fits: Partial<Record<Axis, PlantFit>>; gains: Record<Axis, Gains> } {
  const doublets = findDoublets(log);
  const cfgId = configFromParams(log);
  const cfg: FilterConfig = { ...cfgId, ...req.filters, notches: req.filters?.notches ?? cfgId.notches };
  const fits: Partial<Record<Axis, PlantFit>> = {};
  const gains = Object.fromEntries(AXES.map((a) => [a, req.gains?.[a] ?? gainsFromParams(log.params, a)])) as Record<Axis, Gains>;
  const rows: (string | number)[][] = [];
  const marginRows: (string | number)[][] = [];
  const bode: PlotSpec[] = [];
  const findings: Finding[] = [];
  const ctrlRate = loggedRate(log, 'vehicle_angular_velocity');
  if (ctrlRate < 100) findings.push({ tone: 'warning', title: `Controller topics logged at ${ctrlRate.toFixed(0)} Hz`, detail: 'Identification needs vehicle_angular_velocity and vehicle_torque_setpoint at ≥ 100 Hz (high-rate logging profile). Results below are unreliable.' });
  let curves: { axis: Axis; c: ReturnType<typeof loopResponse> }[] = [];
  for (const axis of AXES) {
    const w = req.windows?.[axis] ?? (() => { const d = doublets.filter((x) => x.axis === axis); return d.length ? [d[0].t0, d[d.length - 1].t1] as [number, number] : undefined; })();
    if (!w) continue;
    const key = `${axis}:${w[0].toFixed(2)}:${w[1].toFixed(2)}`;
    if (!cache.has(key)) cache.set(key, identify(log, axis, w[0], w[1]));
    const fit = cache.get(key);
    if (!fit) continue;
    fits[axis] = fit;
    rows.push([axis, `${fit.t0.toFixed(1)}–${fit.t1.toFixed(1)} s`, fit.K.toFixed(1), (fit.tau * 1000).toFixed(0), (fit.delay * 1000).toFixed(0), fit.r2.toFixed(3), fit.fs.toFixed(0)]);
    const g = gains[axis];
    const c = loopResponse(fit, g, cfg, cfgId);
    const c0 = loopResponse(fit, gainsFromParams(log.params, axis), cfgId, cfgId);
    curves.push({ axis, c });
    const m = c.margins, m0 = c0.margins;
    marginRows.push([axis, `K ${g.k} P ${g.p} I ${g.i} D ${g.d}`, m ? m.fc.toFixed(2) : '–', m ? m.pm.toFixed(0) : '–', m && isFinite(m.gm) ? m.gm.toFixed(1) : '–', m ? `${m.smax.toFixed(2)} @ ${m.fSmax.toFixed(1)} Hz` : '–', m0 ? `${m0.pm.toFixed(0)}° / ${isFinite(m0.gm) ? m0.gm.toFixed(1) : '–'} dB` : '–']);
    if (fit.r2 < 0.8) findings.push({ tone: 'warning', title: `${axis}: identification unreliable (R² ${fit.r2.toFixed(2)}) — margins not assessed`, detail: 'Use a window containing clean stick doublets on this axis (sharp inputs) and little wind (zoom on it and press “Use zoom range”).' });
    else if (m) {
      const tone: Tone = m.pm < 30 ? 'danger' : m.pm < 45 ? 'warning' : 'good';
      findings.push({ tone, title: `${axis}: phase margin ${m.pm.toFixed(0)}°, gain margin ${isFinite(m.gm) ? m.gm.toFixed(1) + ' dB' : '∞'}, crossover ${m.fc.toFixed(1)} Hz`, detail: `Peak sensitivity ${m.smax.toFixed(2)} at ${m.fSmax.toFixed(1)} Hz (disturbances amplified ×${m.smax.toFixed(1)} there).` });
    }
  }
  curves = curves.filter((x) => x.c.f.length);
  if (curves.length) {
    const f = curves[0].c.f;
    bode.push({ kind: 'freq', id: 'bode-mag', title: 'Open loop |L| (with edited gains/filters)', xLabel: 'Hz', yLabel: 'dB', x: f, logX: true, yRange: [-30, 40], hmarks: [{ y: 0, label: '0 dB' }], series: curves.map((x, i) => ({ label: x.axis, y: Float32Array.from(x.c.magL), color: i })) });
    bode.push({ kind: 'freq', id: 'bode-ph', title: 'Open loop phase', xLabel: 'Hz', yLabel: 'deg', x: f, logX: true, yRange: [-450, 0], hmarks: [{ y: -180, label: '-180°' }], series: curves.map((x, i) => ({ label: x.axis, y: Float32Array.from(x.c.phL), color: i })) });
    bode.push({ kind: 'freq', id: 'sens', title: 'Sensitivity |S| = |1/(1+L)| (disturbance amplification)', xLabel: 'Hz', yLabel: 'dB', x: f, logX: true, yRange: [-30, 15], hmarks: [{ y: 0, label: '0 dB' }, { y: 6, label: '6 dB' }], series: curves.map((x, i) => ({ label: x.axis, y: Float32Array.from(x.c.magS), color: i })) });
  }
  const cl: (string | number)[][] = [];
  for (const axis of AXES) {
    const fit = fits[axis];
    if (!fit) continue;
    const r = measuredClosedLoop(log, axis, fit.t0, fit.t1);
    if (r) cl.push([axis, ...r.map((x) => `${x.mag.toFixed(2)} / ${x.phaseDeg.toFixed(0)}° (c ${x.coherence.toFixed(2)})`)]);
  }
  const dTable = doublets.map((d) => [d.axis, d.t0.toFixed(1), d.t1.toFixed(1), d.peakDegS.toFixed(0)]);
  return {
    id: 'rateloop', doublets, fits, gains,
    sections: [
      { id: 'summary', title: 'Rate loop summary', items: compact<PlotSpec>([findings.length ? { kind: 'findings', id: 'rl-find', title: 'Findings', items: findings } : undefined]) },
      { id: 'ident', title: 'Plant identification', description: 'Model: angular acceleration = K · first-order lag(τ) · delay · torque setpoint, fitted on band-passed (0.5–15 Hz) data. The delay includes ESC/motor response, gyro filtering and logging.', items: compact<PlotSpec>([
        dTable.length ? { kind: 'table', id: 'doublets', title: 'Detected stick doublets', columns: ['Axis', 'From [s]', 'To [s]', 'Peak rate sp [deg/s]'], rows: dTable } : { kind: 'text', id: 'nodbl', text: 'No stick doublets detected: zoom on a manoeuvre and use “Use current range” to identify on any window.', tone: 'info' },
        rows.length ? { kind: 'table', id: 'fit', title: 'Identified plant', columns: ['Axis', 'Window', 'K [rad/s² per unit torque]', 'τ [ms]', 'Delay [ms]', 'R²', 'Data rate [Hz]'], rows } : undefined,
      ]) },
      { id: 'margins', title: 'Stability margins', items: compact<PlotSpec>([
        marginRows.length ? { kind: 'table', id: 'margins', title: 'Margins with the edited gains and filters', columns: ['Axis', 'Gains', 'Crossover [Hz]', 'Phase margin [°]', 'Gain margin [dB]', 'Peak |S|', 'Logged gains: PM / GM'], rows: marginRows } : undefined,
        ...bode,
        cl.length ? { kind: 'table', id: 'cl', title: 'Measured closed loop |rate / rate setpoint| / phase (coherence)', columns: ['Axis', '1 Hz', '2 Hz', '3 Hz', '4 Hz', '5 Hz', '6 Hz', '8 Hz'], rows: cl } : undefined,
      ]) },
    ],
  };
}

// ------------------------------------------------------------------ compare
export interface CompareEntry { id: string; name: string; log: ULog }

export function comparePage(entries: CompareEntry[], paramSets: ParamSet[]): PageSpec {
  const metrics: Record<string, string>[] = [];
  const specs: { name: string; roll?: { f: Float64Array; p: Float64Array }; pitch?: { f: Float64Array; p: Float64Array }; fs: number }[] = [];
  for (const e of entries) {
    const log = e.log;
    const r: Record<string, string> = {};
    const P = log.params;
    const g = (k: string) => (P.has(k) ? String(+P.get(k)!.toPrecision(5)) : '–');
    const air = airborneIntervals(log), arms = armedIntervals(log);
    r['Firmware'] = versionString(log.infoNumber('ver_sw_release')) ?? '–';
    r['Airborne time'] = fmtDuration(air.reduce((s, [a, b]) => s + b - a, 0));
    const modes = new Map<string, number>();
    for (const m of flightModes(log)) {
      for (const [a, b] of arms) { const o = Math.min(b, m.t1) - Math.max(a, m.t0); if (o > 0) modes.set(m.name, (modes.get(m.name) ?? 0) + o); }
    }
    r['Modes (s)'] = [...modes.entries()].filter(([, v]) => v > 3).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') || '–';
    r['Notch NF0 / NF1 [Hz]'] = `${g('IMU_GYRO_NF0_FRQ')} / ${g('IMU_GYRO_NF1_FRQ')}`;
    r['LPF / D-LPF [Hz]'] = `${g('IMU_GYRO_CUTOFF')} / ${g('IMU_DGYRO_CUTOFF')}`;
    r['Roll K/P/I/D'] = `${g('MC_ROLLRATE_K')} / ${g('MC_ROLLRATE_P')} / ${g('MC_ROLLRATE_I')} / ${g('MC_ROLLRATE_D')}`;
    r['Pitch K/P/I/D'] = `${g('MC_PITCHRATE_K')} / ${g('MC_PITCHRATE_P')} / ${g('MC_PITCHRATE_I')} / ${g('MC_PITCHRATE_D')}`;
    r['Attitude P roll/pitch'] = `${g('MC_ROLL_P')} / ${g('MC_PITCH_P')}`;
    r['SDLOG_PROFILE'] = g('SDLOG_PROFILE');
    const qs = quietSpectra(log);
    r['Quiet hover analysed'] = `${qs.q.totalS.toFixed(0)} s (${qs.q.threshold === 'all' ? 'all airborne' : 'sticks < ' + qs.q.threshold})`;
    const ht = hoverThrust(log);
    r['Hover thrust'] = ht ? ht.meanHt.toFixed(3) : '–';
    r['Hover thrust normalised'] = ht ? `${ht.meanNorm.toFixed(3)} @ ${ht.vref.toFixed(1)} V` : '–';
    r['Battery V (mean in hover)'] = ht ? mean(ht.v).toFixed(1) : '–';
    const ts = tiltStats(log, qs.q.windows);
    r['Quiet tilt mean [deg] (wind proxy)'] = ts ? fmt(ts.quietTilt, 1) : '–';
    r['Max tilt [deg]'] = ts ? fmt(ts.maxTilt, 0) : '–';
    const m = qs.metrics;
    r['Vibration 30–75 Hz roll/pitch [deg/s]'] = `${fmt(m.vib_roll)} / ${fmt(m.vib_pitch)}`;
    r['Vibration peak roll/pitch [Hz]'] = `${fmt(m.peak_roll, 0)} / ${fmt(m.peak_pitch, 0)}`;
    r['Oscillation 2–6 Hz roll/pitch [deg/s]'] = `${fmt(m.osc_roll)} / ${fmt(m.osc_pitch)}`;
    r['Accel Z > 30 Hz [m/s²]'] = fmt(m.accZ_vib);
    r['Accel vibration metric'] = fmt(m.accel_vib_metric, 1);
    const mi = motorImbalance(log);
    r['Motor deviation % M1…'] = mi ? mi.devPct.map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`).join(' ') : '–';
    r['Motor saturation %'] = mi ? mi.saturationPct.toFixed(1) : '–';
    const ae = attitudeErrorRms(log, qs.q.windows);
    r['Attitude error RMS roll/pitch [deg]'] = ae ? `${ae.roll.toFixed(2)} / ${ae.pitch.toFixed(2)}` : '–';
    r['Logger dropouts (n / ms)'] = `${log.dropouts.length} / ${log.dropouts.reduce((s, d) => s + d.durationMs, 0)}`;
    r['Controller topics logged [Hz]'] = loggedRate(log, 'vehicle_angular_velocity').toFixed(0);
    const lt = loopTiming(log);
    r['CPU load armed'] = lt.cpu ? `${lt.cpu.mean.toFixed(0)} %` : '–';
    metrics.push(r);
    specs.push({ name: e.name, roll: qs.gyro?.s[0], pitch: qs.gyro?.s[1], fs: qs.gyro?.fs ?? 0 });
    void bandRms;
  }
  const keys = metrics.length ? Object.keys(metrics[0]) : [];
  const plots: PlotSpec[] = [];
  for (const [ax, label] of [['roll', 'Roll'], ['pitch', 'Pitch']] as const) {
    const avail = specs.filter((s) => s[ax]);
    if (!avail.length) continue;
    // interpolate onto the grid of the first one
    const base = avail[0][ax]!.f;
    const series: FreqPlotSpec['series'] = avail.map((s, i) => {
      const src = s[ax]!;
      const y = new Float32Array(base.length);
      for (let k = 0; k < base.length; k++) {
        const fk = base[k];
        const j = Math.min(src.f.length - 2, Math.max(0, Math.floor(fk / (src.f[1] - src.f[0]))));
        y[k] = fk > src.f[src.f.length - 1] ? NaN : src.p[j] + ((src.p[j + 1] - src.p[j]) * (fk - src.f[j])) / (src.f[j + 1] - src.f[j]);
      }
      return { label: s.name, y, color: i % 8 };
    });
    plots.push({ kind: 'freq', id: `cmp-psd-${ax}`, title: `${label} gyro PSD — quiet hover`, xLabel: 'Hz', yLabel: '(deg/s)²/Hz', x: base, series, logY: true });
  }
  const diffSets: ParamSet[] = [...entries.map((e) => ({ name: e.name, values: new Map(e.log.params), source: 'log' as const })), ...paramSets];
  const diff = diffParams(diffSets, { includeMissing: true, ignorePrefixes: ['CAL_', 'LND_FLIGHT_T', 'COM_FLIGHT_UUID', 'SYS_RESTART'] });
  return {
    id: 'compare',
    sections: [
      { id: 'metrics', title: 'Flight comparison', description: 'Same metrics on every flight; vibration and tracking only on quiet-hover windows.', items: [{ kind: 'table', id: 'cmp', title: `${entries.length} flights`, columns: ['Metric', ...entries.map((e) => e.name)], rows: keys.map((k) => [k, ...metrics.map((m) => m[k] ?? '–')]) }] },
      { id: 'spectra', title: 'Vibration spectra', items: plots },
      { id: 'params', title: 'Parameter differences', description: 'Parameters that differ between the selected logs and .params files (calibration and counters excluded).', items: [{ kind: 'table', id: 'pdiff', title: `${diff.length} parameters differ`, columns: ['Parameter', ...diffSets.map((s) => s.name), 'Description'], rows: diff.map((d) => [d.name, ...d.values.map((v) => fmtParam(d.name, v)), d.desc]), searchable: true, maxHeight: 560 }] },
    ],
  };
}

export function paramDiffPage(sets: ParamSet[], includeMissing: boolean): PageSpec {
  const diff = diffParams(sets, { includeMissing, ignorePrefixes: ['LND_FLIGHT_T', 'COM_FLIGHT_UUID'] });
  return {
    id: 'pdiff',
    sections: [{ id: 'pdiff', title: 'Parameter diff', items: [{ kind: 'table', id: 'pdiff-t', title: `${diff.length} parameters differ across ${sets.length} sets`, columns: ['Parameter', ...sets.map((s) => s.name), 'Group', 'Description'], rows: diff.map((d) => [d.name, ...d.values.map((v) => fmtParam(d.name, v)), d.group, d.desc]), searchable: true, maxHeight: 640 }] }],
  };
}

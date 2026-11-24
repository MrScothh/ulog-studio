/** Interactive pages: multi-flight comparison, parameter diff (filters and rate loop: see tuning.ts). */
import type { ULog } from '../ulog';
import type { PageSpec, PlotSpec, FreqPlotSpec } from '../types';
import { fmt } from './helpers';
import { quietSpectra, motorImbalance, hoverThrust, attitudeErrorRms, tiltStats, loopTiming, loggedRate } from '../analysis/flight';
import { airborneIntervals, armedIntervals, flightModes, versionString, fmtDuration } from '../px4';
import { diffParams, ParamSet, fmtParam } from '../analysis/params';
import { mean, bandRms } from '../dsp';

// filters and rate loop live in tuning.ts
export { filtersPage, rateLoopPage } from './tuning';
export type { FiltersRequest, RateLoopRequest } from './tuning';

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

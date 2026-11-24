/**
 * Gyro filters and rate-loop pages. Each page opens with a plain-language answer (what PX4 does with the gyro,
 * whether the rate loop has enough stability reserve), then the evidence, then the advanced plots (collapsed).
 */
import type { ULog } from '../ulog';
import type { PageSpec, PlotSpec, Finding, Tone, FlowStep, FlowSpec, Section } from '../types';
import { compact, fmt } from './helpers';
import { FilterConfig, Notch, configFromParams, responseCurves, lagAt, whatIf, selectedGyro, dynamicNotches, chainResponse, WhatIfResult } from '../analysis/filters';
import { findDoublets, identify, loopResponse, gainsFromParams, closedLoopCheck, loopOptions, Gains, PlantFit, Margins, ClosedLoopCheck } from '../analysis/plantid';
import { loggedRate } from '../analysis/flight';
import { AXES, Axis } from '../px4';
import { px4Notch, lowpass2, alphaLpf, biquadResponse, carg, cabs, median, Biquad } from '../dsp';

const hex = (id?: number) => (id === undefined ? '?' : `0x${id.toString(16).toUpperCase()}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** Reference frequency for delays: where multicopter rate loops cross over (a few Hz to ~20 Hz). */
const REF_F = 10;

function lagMs(q: Biquad | undefined, f: number, fs: number): number {
  if (!q) return 0;
  return (-carg(biquadResponse(q, f, fs)) / (2 * Math.PI * f)) * 1000;
}
const ms = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;
const validNotch = (n: Notch, fs: number) => n.f > 0 && n.bw > 0 && n.f < fs / 2;

/** Linear interpolation of a spectrum onto another frequency grid (NaN outside). */
function resample(f0: ArrayLike<number>, p0: ArrayLike<number>, f: ArrayLike<number>): Float32Array {
  const out = new Float32Array(f.length);
  let j = 0;
  for (let k = 0; k < f.length; k++) {
    const x = f[k];
    if (x < f0[0] || x > f0[f0.length - 1]) { out[k] = NaN; continue; }
    while (j < f0.length - 2 && f0[j + 1] < x) j++;
    const t = (x - f0[j]) / (f0[j + 1] - f0[j] || 1);
    out[k] = p0[j] + (p0[j + 1] - p0[j]) * t;
  }
  return out;
}

// ================================================================== gyro filters

export interface FiltersRequest { proposed?: Partial<FilterConfig>; range?: [number, number]; replay?: boolean }

function filterFlow(c: FilterConfig): FlowSpec {
  const fs = c.fs;
  const rate: FlowStep[] = [{ title: 'Gyro', sub: `${fs.toFixed(0)} Hz`, kind: 'source' }];
  const dyn = (c.dynamic?.axes[0] ?? []).filter((n) => validNotch(n, fs));
  if (dyn.length) {
    const lag = dyn.reduce((s, n) => s + lagMs(px4Notch(n.f, n.bw, fs), REF_F, fs), 0);
    const fr = dyn.map((n) => n.f);
    rate.push({ title: `${dyn.length} dynamic notch${dyn.length > 1 ? 'es' : ''}`, sub: `${Math.min(...fr).toFixed(0)}–${Math.max(...fr).toFixed(0)} Hz · ${ms(lag)}`, kind: 'filter' });
  }
  c.notches.forEach((n, i) => {
    if (validNotch(n, fs)) rate.push({ title: `Notch ${+n.f.toFixed(1)} Hz`, sub: `width ${+n.bw.toFixed(1)} Hz · ${ms(lagMs(px4Notch(n.f, n.bw, fs), REF_F, fs))}`, kind: 'filter' });
    else rate.push({ title: `Notch NF${i}`, sub: 'off', kind: 'off' });
  });
  const l = c.lpf > 0 && c.lpf < fs / 2 ? lowpass2(c.lpf, fs) : undefined;
  rate.push(l ? { title: `Low-pass ${+c.lpf.toFixed(1)} Hz`, sub: `2nd order · ${ms(lagMs(l, REF_F, fs))}`, kind: 'filter' } : { title: 'Low-pass', sub: 'off', kind: 'off' });
  const tot = lagAt(c, [REF_F])[0];
  rate.push({ title: 'P and I terms', sub: `total ${ms(tot.msP)}`, kind: 'sink' });
  const dl = alphaLpf(c.dlpf, fs);
  const d: FlowStep[] = [
    { title: 'Filtered rate', sub: ms(tot.msP), kind: 'source' },
    { title: 'Derivative', sub: `${ms(500 / fs)}`, kind: 'filter' },
    dl ? { title: `Low-pass ${+c.dlpf.toFixed(1)} Hz`, sub: `1st order · ${ms(lagMs(dl, REF_F, fs))}`, kind: 'filter' } : { title: 'D low-pass', sub: 'off', kind: 'off' },
    { title: 'D term', sub: `total ${ms(tot.msD)}`, kind: 'sink' },
  ];
  return {
    kind: 'flow', id: 'chain', title: `What PX4 does to the gyro signal (delay added at ${REF_F} Hz)`,
    lanes: [{ label: 'Rate (P, I)', steps: rate }, { label: 'D term', steps: d }],
    note: 'Every filter removes noise and adds delay. Delay in the rate loop costs stability margin (see the Rate loop page).',
  };
}

/** Peaks of the raw gyro spectrum (roll + pitch), relative to the median noise floor. */
function vibrationPeaks(w: WhatIfResult, fmin: number): { f: number; db: number }[] {
  const f = w.psd.f;
  if (!f.length || w.psd.raw.length < 2) return [];
  const fmax = Math.min(w.fs / 2 * 0.9, 500);
  const sum = Float64Array.from(f, (_, k) => w.psd.raw[0][k] + w.psd.raw[1][k]);
  const band: number[] = [];
  for (let k = 0; k < f.length; k++) if (f[k] >= fmin && f[k] <= fmax) band.push(k);
  if (band.length < 8) return [];
  const floor = median(band.map((k) => sum[k]));
  const df = f[1] - f[0], half = Math.max(1, Math.round(4 / df));
  const out: { f: number; db: number }[] = [];
  for (const k of band) {
    if (sum[k] < 4 * floor) continue;
    let isMax = true;
    for (let j = Math.max(0, k - half); j <= Math.min(f.length - 1, k + half); j++) if (sum[j] > sum[k]) { isMax = false; break; }
    if (isMax) out.push({ f: f[k], db: 10 * Math.log10(sum[k] / floor) });
  }
  return out.sort((a, b) => b.db - a.db).slice(0, 4);
}

function filterFindings(log: ULog, c: FilterConfig, w: WhatIfResult | undefined): Finding[] {
  const out: Finding[] = [];
  const fs = c.fs;
  const gy = selectedGyro(log);
  const tot = lagAt(c, [REF_F])[0];
  out.push({
    tone: 'info', title: `The filters delay the gyro by ${ms(tot.msP)} for P and I, ${ms(tot.msD)} for D (at ${REF_F} Hz)`,
    detail: `For comparison, the PX4 tuning guide gives ≈ 8 / 3.8 / 1.9 ms for a gyro low-pass at 30 / 60 / 120 Hz. Lowering the delay lets the rate gains go higher; raising the cutoffs lets more noise reach the motors. Filtering runs at ${fs.toFixed(0)} Hz, the raw rate of the gyro the controller uses (${hex(gy.deviceId)}).`,
  });
  // other IMUs at a different rate: say which one is used
  for (let i = 0; i < 4; i++) {
    const k = i ? `vehicle_imu_status_${i}` : 'vehicle_imu_status';
    const s = log.topic(k);
    if (!s || !s.cols['gyro_device_id']) continue;
    const id = s.cols['gyro_device_id'][0], raw = median(Array.from(s.cols['gyro_raw_rate_hz'] ?? []).filter((v) => v > 0));
    if (id && id !== gy.deviceId && raw > 0 && Math.abs(raw - fs) / fs > 0.05) {
      out.push({ tone: 'info', title: `Gyro ${hex(id)} runs at ${raw.toFixed(0)} Hz but is not the one in use`, detail: `The rate controller uses gyro ${hex(gy.deviceId)} (sensor_selection), so its rate (${fs.toFixed(0)} Hz) is the one that matters for the filters.` });
    }
  }
  for (const n of dynamicNotches(log).notes) out.push({ tone: n.tone, title: n.title, detail: n.detail });
  if (c.dynamic) out.push({ tone: 'info', title: 'Dynamic notches modelled at hover', detail: `${c.dynamic.desc}. In flight they move with the motor speed; the delays shown are for hover.` });

  const peaks = w ? vibrationPeaks(w, 15) : [];
  const srcNyq = w ? w.fs / 2 : 0;
  const reliable = w?.source === 'fifo';
  c.notches.forEach((n, i) => {
    if (!validNotch(n, fs)) return;
    const cost = lagMs(px4Notch(n.f, n.bw, fs), REF_F, fs);
    const name = `IMU_GYRO_NF${i}_FRQ = ${+n.f.toFixed(1)} Hz`;
    if (!w) return;
    if (n.f > srcNyq * 0.9) {
      out.push({ tone: 'info', title: `${name}: cannot be checked`, detail: `The gyro data in this log only goes up to ${srcNyq.toFixed(0)} Hz.` });
      return;
    }
    // how much this notch alone cuts each peak
    const q = px4Notch(n.f, n.bw, fs);
    const cut = peaks.map((p) => ({ p, db: -20 * Math.log10(Math.max(1e-9, cabs(biquadResponse(q, p.f, fs)))) })).sort((a, b) => b.db - a.db)[0];
    const caveat = reliable ? '' : ` Checked on sensor_combined at ${w.fs.toFixed(0)} Hz: vibration above ${srcNyq.toFixed(0)} Hz folds back and can show up at the wrong frequency, so log the raw FIFO for a reliable answer.`;
    const list = peaks.length ? ` Peaks in this flight: ${peaks.map((p) => `${p.f.toFixed(0)} Hz (+${p.db.toFixed(0)} dB)`).join(', ')}.` : ' The raw gyro spectrum has no clear peak.';
    if (cut && cut.db >= 10) out.push({ tone: 'good', title: `${name} removes the vibration peak at ${cut.p.f.toFixed(0)} Hz (−${cut.db.toFixed(0)} dB on a peak ${cut.p.db.toFixed(0)} dB above the noise)`, detail: `It costs ${ms(cost)} of delay at ${REF_F} Hz.${caveat}` });
    else if (cut && cut.db >= 2 && cut.p.db >= 10) out.push({ tone: 'warning', title: `${name} is off the vibration peak at ${cut.p.f.toFixed(0)} Hz (cuts it by only ${cut.db.toFixed(0)} dB)`, detail: `Centred on ≈ ${cut.p.f.toFixed(0)} Hz it would remove that peak for the same ${ms(cost)} of delay at ${REF_F} Hz.${list}${caveat}` });
    else out.push({ tone: 'warning', title: `${name}: no vibration peak there in this flight`, detail: `It adds ${ms(cost)} of delay at ${REF_F} Hz without removing a visible peak.${list} Move the notch onto a peak, or set the frequency to 0 to disable it.${caveat}` });
  });
  if (w && peaks.length) {
    const r = chainResponse(c, peaks.map((p) => p.f));
    peaks.forEach((p, i) => {
      const ncut = -20 * Math.log10(Math.max(1e-9, cabs(r.n[i])));
      if (ncut >= 6 || p.db < 10) return;
      const att = 20 * Math.log10(cabs(r.p[i]));
      out.push({ tone: att > -10 ? 'warning' : 'info', title: `Vibration peak at ${p.f.toFixed(0)} Hz (+${p.db.toFixed(0)} dB) is not notched`, detail: `The filters attenuate it by ${(-att).toFixed(0)} dB before P and I. ${att > -10 ? 'Most of it reaches the motors: consider a notch there (or fix the source mechanically).' : 'The low-pass already removes most of it.'}` });
    });
  }
  if (w?.check && w.check.rate.length >= 2) {
    const pc = (x: number) => `${(x * 100).toFixed(0)} %`;
    const rp = w.check.rate.slice(0, 2), dp = w.check.dterm?.slice(0, 2);
    const ok = Math.max(...rp) < 0.15 && (!dp || Math.max(...dp) < 0.25);
    out.push({
      tone: ok ? 'good' : 'warning',
      title: ok ? "The filter model reproduces PX4's own filtered signals sample by sample" : "The filter model differs from PX4's own filtered signals",
      detail: `Replaying the raw FIFO gyro through the flown chain gives the logged filtered rate (vehicle_angular_velocity) within ${rp.map(pc).join(' / ')} RMS${dp ? ` and the logged D-term input (xyz_derivative) within ${dp.map(pc).join(' / ')} RMS` : ''} (roll / pitch). The remainder is calibration (scale, alignment) applied after filtering and timing jitter.`,
    });
  }
  const v = w?.table.filter((r) => r.logTorque !== undefined && r.axis !== 'yaw') ?? [];
  if (w && v.length) {
    const err = Math.max(...v.map((r) => Math.abs(r.curTorque - r.logTorque!) / r.logTorque!));
    const txt = v.map((r) => `${r.axis} ${(r.curTorque * 100).toFixed(2)} % replayed vs ${(r.logTorque! * 100).toFixed(2)} % logged`).join(', ');
    if (err <= 0.3) out.push({ tone: 'good', title: `The replay reproduces the logged torque noise (within ${(err * 100).toFixed(0)} %)`, detail: `Noise in ${w.band[0]}–${w.band[1].toFixed(0)} Hz on the torque command: ${txt}. So the filter model and the numbers on this page can be trusted for this vehicle.` });
    else out.push({ tone: 'warning', title: `The replay differs from the logged torque noise by up to ${(err * 100).toFixed(0)} %`, detail: `${txt}. ${w.source === 'fifo' ? 'Other inputs (setpoint changes, wind, saturation) also reach the torque command; compare the trends rather than the absolute values.' : 'Expected without raw FIFO data: the replay only sees the low-rate gyro. Log the raw FIFO for exact numbers.'}` });
  }
  if (c.lpf > 0 && c.dlpf > 0 && c.lpf / c.dlpf >= 4) {
    out.push({ tone: 'info', title: `Gyro low-pass (${c.lpf} Hz) and D low-pass (${c.dlpf} Hz) are far apart`, detail: 'The PX4 tuning guide notes that setting them too far apart (e.g. D = 15, gyro = 80) can hurt performance.' });
  }
  const rank: Record<string, number> = { danger: 0, warning: 1, good: 2, info: 3 };
  return out.map((f, i) => ({ f, i })).sort((a, b) => (rank[a.f.tone] ?? 4) - (rank[b.f.tone] ?? 4) || a.i - b.i).map((x) => x.f);
}

export function filtersPage(log: ULog, req: FiltersRequest): PageSpec & { current: FilterConfig; proposed: FilterConfig; rateSource: string } {
  const cur = configFromParams(log);
  const prop: FilterConfig = { ...cur, ...req.proposed, notches: req.proposed?.notches ?? cur.notches };
  const changed = prop.lpf !== cur.lpf || prop.dlpf !== cur.dlpf || prop.notches.some((n, i) => n.f !== cur.notches[i]?.f || n.bw !== cur.notches[i]?.bw);
  const gy = selectedGyro(log);
  const w = req.replay !== false ? whatIf(log, cur, prop, req.range) : undefined;

  // ---- summary
  const stats: { label: string; value: string; sub?: string; tone?: Tone }[] = [];
  const lc = lagAt(cur, [REF_F])[0], lp = lagAt(prop, [REF_F])[0];
  stats.push({ label: 'Filter rate', value: `${cur.fs.toFixed(0)} Hz`, sub: `gyro ${hex(gy.deviceId)}` });
  stats.push({ label: `Delay before P and I (${REF_F} Hz)`, value: ms(lc.msP), sub: changed ? `proposed ${ms(lp.msP)}` : undefined });
  stats.push({ label: `Delay before D (${REF_F} Hz)`, value: ms(lc.msD), sub: changed ? `proposed ${ms(lp.msD)}` : undefined });
  if (w?.table.length) {
    const worst = w.table.slice(0, 2).reduce((a, b) => (b.curTorque > a.curTorque ? b : a));
    stats.push({ label: `Gyro noise sent to the motors`, value: `${(worst.curTorque * 100).toFixed(2)} %`, sub: `${worst.axis}, RMS above ${w.band[0]} Hz${w.source === 'fifo' ? '' : ' (approx., no raw FIFO)'}${changed ? ` · proposed ${(worst.propTorque * 100).toFixed(2)} %` : ''}` });
  }
  const sections: Section[] = [];
  sections.push({
    id: 'chain', title: 'Gyro filters at a glance',
    description: 'How PX4 filters the gyro before the rate controller uses it, what that costs in delay, and whether each filter is doing useful work on this flight.',
    items: [filterFlow(cur), { kind: 'stats', id: 'filt-stats', items: stats }, { kind: 'findings', id: 'filt-find', title: 'Checks', items: filterFindings(log, cur, w) }],
  });

  // ---- what-if replay
  if (req.replay !== false) {
    const items: PlotSpec[] = [];
    if (w && w.psd.raw.length) {
      const f = w.psd.f;
      const xmax = Math.min(w.fs / 2, 300);
      const marks = [...cur.notches.filter((n) => validNotch(n, cur.fs)).map((n, i) => ({ x: n.f, label: `NF${i}` })), { x: cur.lpf, label: 'LPF' }, { x: cur.dlpf, label: 'D-LPF' }].filter((m) => m.x > 0);
      const band = `${w.band[0]}–${w.band[1].toFixed(0)} Hz`;
      const pct = (v: number) => `${(v * 100).toFixed(2)} %`;
      items.push(changed ? {
        kind: 'table', id: 'wi-table', title: `Noise in ${band}: current vs proposed filters`,
        columns: ['Axis', 'Raw gyro [°/s]', 'Filtered now', 'Filtered proposed', 'To motors now', 'To motors proposed', 'Change'],
        rows: w.table.map((r) => [r.axis, fmt(r.rawVib), fmt(r.curVel), fmt(r.propVel), pct(r.curTorque), pct(r.propTorque), `${(((r.propTorque - r.curTorque) / r.curTorque) * 100).toFixed(0)} %`]),
        note: `"To motors" = RMS of MC_*RATE_K·(P·rate + D·derivative) after the filters, in % of full torque command. ${w.source === 'fifo' ? 'Raw FIFO gyro' : 'sensor_combined'} at ${w.fs.toFixed(0)} Hz, ${w.windowsS.toFixed(0)} s analysed. Axis mapping: ${w.mapping}.${w.warning ? ' ' + w.warning : ''}`,
      } : {
        kind: 'table', id: 'wi-table', title: `Gyro noise in ${band} and how much reaches the motors`,
        columns: compact(['Axis', 'Raw gyro [°/s RMS]', 'After the filters [°/s RMS]', 'Sent to the motors [% of full torque]', w.tqLogRate ? 'Logged torque command (check)' : undefined]),
        rows: w.table.map((r) => compact([r.axis, fmt(r.rawVib), fmt(r.curVel), pct(r.curTorque), w.tqLogRate ? (r.logTorque !== undefined ? pct(r.logTorque) : '–') : undefined])),
        note: `Computed by running PX4's filter chain sample by sample on the ${w.source === 'fifo' ? 'raw FIFO gyro' : 'sensor_combined gyro'} (${w.fs.toFixed(0)} Hz, ${w.windowsS.toFixed(0)} s of ${req.range ? 'the selected range' : 'quiet hover'}); the torque includes MC_*RATE_K, P and D. Axis mapping: ${w.mapping}.${w.warning ? ' ' + w.warning : ''} Change the values above to compare.`,
      });
      const names = ['Roll', 'Pitch', 'Yaw'];
      for (let a = 0; a < Math.min(2, w.psd.raw.length); a++) {
        items.push({ kind: 'freq', id: `wi-vel-${a}`, title: `${names[a]}: gyro noise spectrum`, xLabel: 'Hz', yLabel: '(°/s)²/Hz', x: f, logY: true, xRange: [0, xmax], marks, series: compact([
          { label: 'Raw gyro', y: Float32Array.from(w.psd.raw[a]), color: -1 },
          { label: changed ? 'Filtered (now)' : 'After the filters', y: Float32Array.from(w.psd.cur[a]), color: 0 },
          changed ? { label: 'Filtered (proposed)', y: Float32Array.from(w.psd.prop[a]), color: 1 } : undefined,
        ]) });
        const lg = w.psd.tqLog?.p[a] ? resample(w.psd.tqLog.f, w.psd.tqLog.p[a], f) : undefined;
        items.push({ kind: 'freq', id: `wi-tq-${a}`, title: `${names[a]}: noise sent to the motors (torque command)`, xLabel: 'Hz', yLabel: '1/Hz', x: f, logY: true, xRange: [0, xmax], marks, series: compact([
          lg ? { label: 'Logged in flight', y: lg, color: -1 } : undefined,
          { label: changed ? 'Replay, now' : 'Replay', y: Float32Array.from(w.psd.tqCur[a]), color: 0 },
          changed ? { label: 'Replay, proposed', y: Float32Array.from(w.psd.tqProp[a]), color: 1 } : undefined,
        ]) });
      }
    } else items.push({ kind: 'text', id: 'wi-none', text: 'No raw gyro data in this log, so the filters cannot be replayed.', tone: 'info' });
    sections.push({ id: 'replay', title: 'Noise vs. delay on this flight', description: 'Change the filter values above: the gyro of this flight is filtered again with the new values, so you see how much noise would reach the motors and how much delay you would save or add.', items });
  }

  // ---- frequency response (advanced)
  const rc = responseCurves(cur), rp = responseCurves(prop);
  const marks = [...cur.notches.filter((n) => n.f > 0).map((n, i) => ({ x: n.f, label: `NF${i}` })), { x: cur.lpf, label: 'LPF' }, { x: cur.dlpf, label: 'D-LPF' }].filter((m) => m.x > 0);
  const pair = (now: Float64Array, pr: Float64Array, label: string, color: number) => compact([
    { label: changed ? `${label} (now)` : label, y: now, color },
    changed ? { label: `${label} (proposed)`, y: pr, color, dash: true } : undefined,
  ]);
  const fq = [1, 2, 5, 10, 20];
  const lcs = lagAt(cur, fq), lps = lagAt(prop, fq);
  const cell = (r: { phP: number; msP: number }) => `${r.phP.toFixed(1)}° = ${r.msP.toFixed(1)} ms`;
  const cellD = (r: { phD: number; msD: number }) => `${r.phD.toFixed(1)}° = ${r.msD.toFixed(1)} ms`;
  sections.push({
    id: 'resp', title: 'Filter frequency response (advanced)', collapsed: true,
    description: `Exact response of the chain at ${cur.fs.toFixed(0)} Hz: PX4 NotchFilter and LowPassFilter2p on the rate path; on the D path additionally the backward difference and the first-order AlphaFilter (IMU_DGYRO_CUTOFF).`,
    items: [
      { kind: 'freq', id: 'filt-mag', title: 'Attenuation', xLabel: 'Hz', yLabel: 'dB', x: rc.f, logX: true, xRange: [rc.f[0], rc.f[rc.f.length - 1]], yRange: [-40, 3], marks, series: [...pair(rc.magP, rp.magP, 'Rate path (P, I)', 0), ...pair(rc.magD, rp.magD, 'D path', 1)] },
      { kind: 'freq', id: 'filt-delay', title: 'Delay added (phase lag expressed in ms)', xLabel: 'Hz', yLabel: 'ms', x: rc.f, logX: true, xRange: [0.5, 40], series: [...pair(rc.delayP, rp.delayP, 'Rate path (P, I)', 0), ...pair(rc.delayD, rp.delayD, 'D path', 1)] },
      { kind: 'freq', id: 'filt-phase', title: 'Phase', xLabel: 'Hz', yLabel: '°', x: rc.f, logX: true, xRange: [rc.f[0], rc.f[rc.f.length - 1]], marks, series: [...pair(rc.phP, rp.phP, 'Rate path (P, I)', 0), ...pair(rc.phD, rp.phD, 'D path', 1)] },
      { kind: 'table', id: 'filt-lag', title: 'Phase lag introduced by the filters', columns: changed ? ['Frequency', 'Rate path now', 'Rate path proposed', 'D path now', 'D path proposed'] : ['Frequency', 'Rate path (P, I)', 'D path'], rows: fq.map((f, i) => changed ? [`${f} Hz`, cell(lcs[i]), cell(lps[i]), cellD(lcs[i]), cellD(lps[i])] : [`${f} Hz`, cell(lcs[i]), cellD(lcs[i])]) },
    ],
  });
  return { id: 'filters', current: cur, proposed: prop, rateSource: `${cur.fs.toFixed(0)} Hz (${gy.source})`, sections };
}

// ================================================================== rate loop

export interface RateLoopRequest { windows?: Partial<Record<Axis, [number, number]>>; gains?: Partial<Record<Axis, Gains>>; filters?: Partial<FilterConfig> }

type Trust = 'good' | 'approx' | 'none';
const PM_OK = 45, GM_OK = 6, PM_MIN = 30, GM_MIN = 4;

function marginTone(m: Margins): Tone {
  if (m.pm < PM_MIN || m.gm < GM_MIN) return 'danger';
  if (m.pm < PM_OK || m.gm < GM_OK) return 'warning';
  return 'good';
}
const toneWord: Record<string, string> = { good: 'good stability reserve', warning: 'little stability reserve', danger: 'close to oscillating' };

/** Largest MC_*RATE_K (scaling P, I and D together) that keeps PM >= 45° and GM >= 6 dB. */
function maxK(fit: PlantFit, g: Gains, cfg: FilterConfig, o: ReturnType<typeof loopOptions>): number | undefined {
  const ok = (k: number) => { const m = loopResponse(fit, { ...g, k }, cfg, o).margins; return !!m && m.pm >= PM_OK && m.gm >= GM_OK; };
  let lo = g.k * 0.1, hi = g.k * 4;
  if (!ok(lo)) return undefined;
  if (ok(hi)) return hi;
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
  return lo;
}

export function rateLoopPage(log: ULog, req: RateLoopRequest, cache: Map<string, PlantFit | undefined>): PageSpec & { doublets: ReturnType<typeof findDoublets>; fits: Partial<Record<Axis, PlantFit>>; gains: Record<Axis, Gains> } {
  const P = log.params;
  const doublets = findDoublets(log);
  const cfgId = configFromParams(log);
  const cfg: FilterConfig = { ...cfgId, ...req.filters, notches: req.filters?.notches ?? cfgId.notches };
  const fits: Partial<Record<Axis, PlantFit>> = {};
  const gains = Object.fromEntries(AXES.map((a) => [a, req.gains?.[a] ?? gainsFromParams(P, a)])) as Record<Axis, Gains>;
  const stats: { label: string; value: string; sub?: string; tone?: Tone }[] = [];
  const verdict: Finding[] = [];
  const trustF: Finding[] = [];
  const plantRows: (string | number)[][] = [];
  const marginRows: (string | number)[][] = [];
  const checkPlots: PlotSpec[] = [];
  const curves: { axis: Axis; c: ReturnType<typeof loopResponse> }[] = [];
  const ctrlRate = loggedRate(log, 'vehicle_angular_velocity');
  if (ctrlRate < 100) verdict.push({ tone: 'warning', title: `Controller topics logged at ${ctrlRate.toFixed(0)} Hz only`, detail: 'The identification needs vehicle_angular_velocity and vehicle_torque_setpoint at 100 Hz or more (SDLOG_PROFILE "high rate" bit). The results below are unreliable.' });
  const fLag = lagAt(cfgId, [REF_F])[0];

  for (const axis of AXES) {
    const w = req.windows?.[axis] ?? (() => { const d = doublets.filter((x) => x.axis === axis); return d.length ? [d[0].t0, d[d.length - 1].t1] as [number, number] : undefined; })();
    if (!w) {
      stats.push({ label: cap(axis), value: '–', sub: 'no stick doublets on this axis' });
      continue;
    }
    const key = `${axis}:${w[0].toFixed(2)}:${w[1].toFixed(2)}`;
    if (!cache.has(key)) cache.set(key, identify(log, axis, w[0], w[1], cfgId));
    const fit = cache.get(key);
    if (!fit) { stats.push({ label: cap(axis), value: '–', sub: 'identification failed' }); continue; }
    fits[axis] = fit;
    const g = gains[axis], g0 = gainsFromParams(P, axis), o = loopOptions(P, axis);
    const c = loopResponse(fit, g, cfg, o);
    const c0 = loopResponse(fit, g0, cfgId, o);
    const cl = closedLoopCheck(log, fit, g0, cfgId, o);
    curves.push({ axis, c });
    const trust: Trust = fit.r2 < 0.8 ? 'none' : cl && cl.nUsed >= 5 && cl.errDb <= 3 && cl.errDeg <= 20 ? 'good' : 'approx';
    const m = c.margins, m0 = c0.margins;
    const edited = g.k !== g0.k || g.p !== g0.p || g.i !== g0.i || g.d !== g0.d || cfg !== cfgId && (cfg.lpf !== cfgId.lpf || cfg.dlpf !== cfgId.dlpf);
    const match = cl && cl.nUsed ? `${cl.errDb.toFixed(1)} dB / ${cl.errDeg.toFixed(0)}°` : '–';
    plantRows.push([axis, `${fit.t0.toFixed(1)}–${fit.t1.toFixed(1)} s`, fit.K.toFixed(0), `${(fit.tau * 1000).toFixed(1)} ms`, `${(fit.delay * 1000).toFixed(1)} ms`, fit.r2.toFixed(3), match]);
    marginRows.push([axis, `K ${g.k} · P ${g.p} · I ${g.i} · D ${g.d}`, m ? m.fc.toFixed(2) : '–', m ? m.pm.toFixed(1) : '–', m && isFinite(m.gm) ? `${m.gm.toFixed(1)} @ ${m.fGm.toFixed(1)} Hz` : '–', m ? `${(m.pm / 360 / m.fc * 1000).toFixed(1)} ms` : '–', m ? `${m.smax.toFixed(2)} @ ${m.fSmax.toFixed(1)} Hz` : '–', m0 ? `${m0.pm.toFixed(1)}° / ${isFinite(m0.gm) ? m0.gm.toFixed(1) : '–'} dB` : '–']);

    if (trust === 'none') {
      stats.push({ label: cap(axis), value: '–', sub: `not enough clean stick input (fit R² ${fit.r2.toFixed(2)})` });
      trustF.push({ tone: 'info', title: `${cap(axis)}: cannot be assessed from this flight`, detail: `The fit explains only ${(fit.r2 * 100).toFixed(0)} % of the measured angular acceleration (R² ${fit.r2.toFixed(2)}; 0.8 or more is needed). Fly a few sharp ${axis} stick doublets (quick left-right-centre) in hover, or zoom on such a manoeuvre and press “Use zoom range”.` });
    } else if (m) {
      const tone = marginTone(m);
      stats.push({ label: cap(axis), value: `${m.pm.toFixed(0)}° · ${isFinite(m.gm) ? m.gm.toFixed(1) : '∞'} dB`, sub: `${toneWord[tone]}${edited && m0 ? ` · flown: ${m0.pm.toFixed(0)}° · ${m0.gm.toFixed(1)} dB` : ''}`, tone });
      const A = axis.toUpperCase();
      const gmx = isFinite(m.gm) ? 10 ** (m.gm / 20) : Infinity;
      const dm = (m.pm / 360 / m.fc) * 1000;
      const kmax = maxK(fit, g, cfg, o);
      const parts = [
        isFinite(gmx) ? `It would start to oscillate at about ${m.fGm.toFixed(1)} Hz with ${gmx.toFixed(2)}× the current loop gain (MC_${A}RATE_K ${g.k} → ${(g.k * gmx).toFixed(2)}), or with ${dm.toFixed(0)} ms of extra delay.` : `It tolerates about ${dm.toFixed(0)} ms of extra delay before oscillating.`,
        `Disturbances around ${m.fSmax.toFixed(1)} Hz are amplified up to ×${m.smax.toFixed(1)}.`,
        `Usual targets: phase margin ≥ ${PM_OK}°, gain margin ≥ ${GM_OK} dB.`,
        kmax !== undefined ? (kmax < g.k * 0.98 ? `To reach them with the same P/I/D ratio, the model suggests MC_${A}RATE_K ≤ ${kmax.toFixed(2)}.` : `There is room: MC_${A}RATE_K up to about ${kmax.toFixed(2)} would still meet them.`) : '',
      ];
      verdict.push({ tone, title: `${cap(axis)}: ${toneWord[tone]} — phase margin ${m.pm.toFixed(0)}°, gain margin ${isFinite(m.gm) ? m.gm.toFixed(1) + ' dB' : '∞'}`, detail: parts.filter(Boolean).join(' ') });
      if (trust === 'good') trustF.push({ tone: 'good', title: `${cap(axis)}: the model reproduces the flight`, detail: `The closed-loop response predicted from the fitted airframe, your gains and the filters matches the one measured in the log within ${match} RMS (0.5–10 Hz, ${cl!.nUsed} frequencies). Fit R² ${fit.r2.toFixed(3)}.` });
      else trustF.push({ tone: 'warning', title: `${cap(axis)}: the model only roughly matches the flight (${match})`, detail: 'Predicted and measured closed loop differ more than usual (wind, saturation, a window with little excitation or other manoeuvres mixed in). Treat these margins as indicative, or pick a cleaner window.' });
    } else {
      stats.push({ label: cap(axis), value: '–', sub: 'loop gain never crosses 1' });
    }
    if (cl && trust !== 'none') {
      const msk = (y: Float64Array) => Float32Array.from(y, (v, j) => (cl.coherence[j] >= 0.6 && cl.f[j] >= 0.5 ? v : NaN));
      const xr: [number, number] = [0.5, Math.min(15, cl.f[cl.f.length - 1])];
      checkPlots.push({ kind: 'freq', id: `cl-mag-${axis}`, title: `${cap(axis)}: response to the rate setpoint — gain`, xLabel: 'Hz', yLabel: 'dB', x: cl.f, logX: true, xRange: xr, yRange: [-20, 10], hmarks: [{ y: 0, label: '0 dB' }], series: [{ label: 'Measured in flight', y: msk(cl.magMeas), color: 0, points: true }, { label: 'Predicted by the model', y: Float32Array.from(cl.magModel), color: 1 }] });
      checkPlots.push({ kind: 'freq', id: `cl-ph-${axis}`, title: `${cap(axis)}: response to the rate setpoint — phase`, xLabel: 'Hz', yLabel: '°', x: cl.f, logX: true, xRange: xr, series: [{ label: 'Measured in flight', y: msk(cl.phMeas), color: 0, points: true }, { label: 'Predicted by the model', y: Float32Array.from(cl.phModel), color: 1 }] });
    }
  }

  // where the delay comes from (first trusted fit)
  const ref = AXES.map((a) => fits[a]).find((f) => f && f.r2 >= 0.8);
  if (ref) {
    verdict.push({ tone: 'info', title: `Delay in the loop: ${ms(ref.delay * 1000)} before the motors react, motor time constant ${ms(ref.tau * 1000)}, filters ${ms(fLag.msP)} (P, I) / ${ms(fLag.msD)} (D)`,
      detail: `The pure delay (${ref.axis}) covers computation, mixer, output protocol and ESC. Less delay allows higher gains: the PX4 guide suggests DShot instead of PWM and motor outputs on the flight controller (AUX/FMU) rather than the IO chip, and gyro filter cutoffs as high as the noise allows (Gyro filters page).` });
  }

  const dTable = doublets.map((d) => [d.axis, d.t0.toFixed(1), d.t1.toFixed(1), d.peakDegS.toFixed(0)]);
  const sections: Section[] = [
    {
      id: 'verdict', title: 'Rate loop stability',
      description: 'How much reserve the roll, pitch and yaw rate loops have before they start to oscillate, computed from how this airframe responded to your stick inputs.',
      items: compact<PlotSpec>([
        { kind: 'stats', id: 'rl-stats', items: stats },
        verdict.length ? { kind: 'findings', id: 'rl-verdict', title: 'What it means', items: verdict } : undefined,
        {
          kind: 'text', id: 'rl-how', tone: 'info', title: 'How this is computed',
          text: '1. Airframe: during stick doublets the log shows how hard the drone accelerates for a given torque command (K), how fast the motors follow (τ) and the pure delay before they react (d). PX4\'s gyro filters are modelled exactly, so these three numbers describe the airframe alone.\n'
            + '2. Controller: PX4\'s rate controller is added the way the firmware computes it — MC_*RATE_K × (P·error + I·∫error − D·filtered derivative), the gyro and D-term filters, and the yaw torque low-pass (MC_YAW_TQ_CUTOFF).\n'
            + '3. Margins: the phase margin is how much extra delay, the gain margin how much extra gain the loop tolerates before it oscillates. Change the gains below to see the effect; nothing is sent to the vehicle.',
        },
      ]),
    },
    {
      id: 'check', title: 'Can the model be trusted?',
      description: 'The fitted airframe, your gains and the filters predict how the drone should follow the rate setpoint. Below, that prediction is compared with what the log actually measured (only frequencies where the measurement is clean).',
      items: compact<PlotSpec>([
        trustF.length ? { kind: 'findings', id: 'rl-trust', title: 'Model check', items: trustF } : undefined,
        ...checkPlots,
        plantRows.length ? { kind: 'table', id: 'fit', title: 'Identified airframe', columns: ['Axis', 'Window', 'K [rad/s² per unit torque]', 'Motor time constant τ', 'Delay d', 'Fit R²', 'Closed-loop match (RMS)'], rows: plantRows, note: 'α = K · e^(−s·d) / (τ·s + 1) · torque command, fitted on 0.5–15 Hz with the logged gyro filters applied to the model.' } : undefined,
      ]),
    },
  ];
  const adv: PlotSpec[] = [];
  if (marginRows.length) adv.push({ kind: 'table', id: 'margins', title: 'Margins in detail (with the gains above)', columns: ['Axis', 'Gains', 'Crossover [Hz]', 'Phase margin [°]', 'Gain margin [dB]', 'Delay margin', 'Peak sensitivity', 'As flown: PM / GM'], rows: marginRows });
  if (curves.length) {
    const f = curves[0].c.f;
    adv.push({ kind: 'freq', id: 'bode-mag', title: 'Open loop gain |L|', xLabel: 'Hz', yLabel: 'dB', x: f, logX: true, yRange: [-30, 40], hmarks: [{ y: 0, label: '0 dB' }], series: curves.map((x) => ({ label: x.axis, y: Float32Array.from(x.c.magL), color: AXES.indexOf(x.axis) })) });
    adv.push({ kind: 'freq', id: 'bode-ph', title: 'Open loop phase', xLabel: 'Hz', yLabel: '°', x: f, logX: true, yRange: [-450, 0], hmarks: [{ y: -180, label: '−180°' }], series: curves.map((x) => ({ label: x.axis, y: Float32Array.from(x.c.phL), color: AXES.indexOf(x.axis) })) });
    adv.push({ kind: 'freq', id: 'bode-sens', title: 'Disturbance amplification |S| = |1/(1+L)|', xLabel: 'Hz', yLabel: 'dB', x: f, logX: true, yRange: [-30, 15], hmarks: [{ y: 0, label: '0 dB' }, { y: 6, label: '6 dB' }], series: curves.map((x) => ({ label: x.axis, y: Float32Array.from(x.c.magS), color: AXES.indexOf(x.axis) })) });
  }
  adv.push(dTable.length ? { kind: 'table', id: 'doublets', title: 'Stick doublets found in the log', columns: ['Axis', 'From [s]', 'To [s]', 'Peak rate setpoint [°/s]'], rows: dTable } : { kind: 'text', id: 'nodbl', text: 'No stick doublets found: zoom on a manoeuvre and use “Use zoom range” to identify on any window.', tone: 'info' });
  sections.push({ id: 'bode', title: 'Loop frequency response (advanced)', collapsed: true, items: adv });
  return { id: 'rateloop', doublets, fits, gains, sections };
}

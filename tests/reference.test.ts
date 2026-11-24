/**
 * Cross-check of plant identification and rate-loop margins against an independent reference analysis.
 * The reference (log path, stick-doublet windows and expected values) lives in a local, untracked JSON file:
 *
 *   ULOG_REFERENCE=tests/reference.local.json npx vitest run tests/reference.test.ts
 *
 * {
 *   "log": "<path to a .ulg with stick doublets>",
 *   "axes": [
 *     { "axis": "roll", "window": [44, 56.5], "K": 207, "pm": 38.4, "fc": 5.73, "gm": 4.0 }
 *   ]
 * }
 * Windows are in seconds from the first arming. Expected margins come from an independent scipy computation of
 * the same loop (PX4 filter formulas, K·(P + I/s + D·s·H_d)·G(s)); the closed-loop prediction must also match the
 * response measured in the log.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ULog } from '../src/core/ulog';
import { armedIntervals, Axis } from '../src/core/px4';
import { identify, loopResponse, gainsFromParams, loopOptions, closedLoopCheck } from '../src/core/analysis/plantid';
import { configFromParams } from '../src/core/analysis/filters';

interface Ref { log: string; filterRateHz?: number; axes: { axis: Axis; window: [number, number]; K: number; pm: number; fc: number; gm: number }[] }
const refPath = process.env.ULOG_REFERENCE;

describe.skipIf(!refPath)('reference analysis', () => {
  it('plant identification and margins match the reference', () => {
    const ref: Ref = JSON.parse(readFileSync(refPath!, 'utf8'));
    const buf = readFileSync(ref.log);
    const log = new ULog(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const a0 = armedIntervals(log)[0][0];
    const base = configFromParams(log);
    const cfg = ref.filterRateHz ? { ...base, fs: ref.filterRateHz } : base;
    for (const r of ref.axes) {
      const fit = identify(log, r.axis, a0 + r.window[0], a0 + r.window[1])!;
      const g = gainsFromParams(log.params, r.axis), o = loopOptions(log.params, r.axis);
      const m = loopResponse(fit, g, cfg, o).margins!;
      const cl = closedLoopCheck(log, fit, g, cfg, o)!;
      expect(fit.r2).toBeGreaterThan(0.97);
      expect(cl.errDb).toBeLessThan(3);
      expect(cl.errDeg).toBeLessThan(20);
      expect(Math.abs(fit.K - r.K) / r.K).toBeLessThan(0.12);
      expect(Math.abs(m.pm - r.pm)).toBeLessThan(3);
      expect(Math.abs(m.fc - r.fc)).toBeLessThan(0.7);
      expect(Math.abs(m.gm - r.gm)).toBeLessThan(0.8);
    }
  });
});

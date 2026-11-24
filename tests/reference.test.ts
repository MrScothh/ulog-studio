/**
 * Cross-check of plant identification and rate-loop margins against an independent reference analysis.
 * The reference (log path, stick-doublet windows and expected values) lives in a local, untracked JSON file:
 *
 *   ULOG_REFERENCE=tests/reference.local.json npx vitest run tests/reference.test.ts
 *
 * {
 *   "log": "<path to a .ulg with stick doublets>",
 *   "filterRateHz": 2000,
 *   "axes": [
 *     { "axis": "roll", "window": [44, 56.5], "K": 210, "pm": 46, "fc": 5.36, "gm": 5.3 }
 *   ]
 * }
 * Windows are in seconds from the first arming.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ULog } from '../src/core/ulog';
import { armedIntervals, Axis } from '../src/core/px4';
import { identify, loopResponse, gainsFromParams } from '../src/core/analysis/plantid';
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
      const m = loopResponse(fit, gainsFromParams(log.params, r.axis), cfg, cfg).margins!;
      expect(fit.r2).toBeGreaterThan(0.97);
      expect(Math.abs(fit.K - r.K) / r.K).toBeLessThan(0.12);
      expect(Math.abs(m.pm - r.pm)).toBeLessThan(6);
      expect(Math.abs(m.fc - r.fc)).toBeLessThan(0.7);
      expect(Math.abs(m.gm - r.gm)).toBeLessThan(1.5);
    }
  });
});

/**
 * Runs the whole engine on real logs found in ULOG_DIR (never committed: logs are private).
 *   ULOG_DIR=<folder with .ulg files> npx vitest run tests/reallogs.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, PageId } from '../src/core/engine';

const dir = process.env.ULOG_DIR;
function findLogs(d: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) out.push(...findLogs(p));
    else if (f.toLowerCase().endsWith('.ulg')) out.push(p);
  }
  return out;
}
const logs = dir ? findLogs(dir) : [];
const PAGES: PageId[] = ['overview', 'tracking', 'actuators', 'vibration', 'power', 'sensors', 'system', 'params', 'messages'];
const report: Record<string, unknown> = {};

describe.skipIf(!dir)('real logs', () => {
  const engine = new Engine();
  for (const [i, path] of logs.entries()) {
    it(`parses and analyses ${path.split(/[\\/]/).pop()}`, async () => {
      const buf = readFileSync(path);
      const t0 = performance.now();
      const s = await engine.open(`L${i}`, path.split(/[\\/]/).pop()!, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const tParse = performance.now() - t0;
      expect(s.durationS).toBeGreaterThan(1);
      const r: Record<string, unknown> = { parseMs: Math.round(tParse), topics: s.topicCount, modes: s.modes.length, dropouts: s.dropouts.length };
      for (const p of PAGES) {
        const t1 = performance.now();
        const page = engine.page(`L${i}`, p);
        r[p] = { ms: Math.round(performance.now() - t1), items: page.sections.reduce((n, x) => n + x.items.length, 0) };
      }
      const t2 = performance.now();
      const f = engine.filters(`L${i}`, { proposed: {}, replay: true });
      r.filtersMs = Math.round(performance.now() - t2);
      r.filterTable = (f.sections[1].items[0] as { rows?: unknown[] }).rows;
      const t3 = performance.now();
      const rl = engine.rateLoop(`L${i}`, {});
      r.rateLoopMs = Math.round(performance.now() - t3);
      r.fits = rl.fits;
      r.doublets = rl.doublets.length;
      const ov = engine.page(`L${i}`, 'overview');
      r.findings = (ov.sections[0].items[1] as { items: { tone: string; title: string }[] }).items.map((x) => `${x.tone}: ${x.title}`);
      const msg = engine.page(`L${i}`, 'messages');
      r.messages = (msg.sections[0].items[0] as { title: string; rows: unknown[][] }).title;
      r.firstEvents = (msg.sections[0].items[0] as { rows: unknown[][] }).rows.filter((x) => x[2] === 'event').slice(0, 6).map((x) => `${x[0]} ${x[1]} ${x[3]}`);
      const tr = engine.page(`L${i}`, 'tracking');
      const step = tr.sections.find((x) => x.id === 'step')!.items.find((x) => x.kind === 'table') as { rows: unknown[][] } | undefined;
      r.step = step?.rows;
      const vib = engine.page(`L${i}`, 'vibration');
      r.quiet = (vib.sections[1].items[0] as { rows: unknown[][]; note: string }).rows;
      r.alias = (vib.sections[2].items[0] as { title: string; items: { title: string }[] }).items.map((x) => x.title);
      report[path] = r;
    }, 180000);
  }
  it('compare all', () => {
    const t = performance.now();
    const c = engine.compare(logs.map((_, i) => `L${i}`));
    report.compareMs = Math.round(performance.now() - t);
    report.compare = (c.sections[0].items[0] as { rows: unknown[][] }).rows;
    writeFileSync(process.env.REPORT_OUT ?? 'reallogs-report.json', JSON.stringify(report, null, 1));
  }, 300000);
});

/** Analysis engine: owns parsed logs and builds pages. Runs inside a Web Worker (or Node for tests). */
import { ULog, TopicMeta } from './ulog';
import { decodeLogEvents, EventsResult } from './events';
import type { LogSummary, PageSpec, TimelineAlert } from './types';
import { flightModes, armedIntervals, airborneIntervals, versionString, isSupportedVersion, airframeName } from './px4';
import * as P from './pages';
import { filtersPage, FiltersRequest, rateLoopPage, RateLoopRequest, comparePage, paramDiffPage } from './pages/interactive';
import { parseQgcParams, ParamSet } from './analysis/params';
import type { PlantFit } from './analysis/plantid';
import { gnssTopic } from './px4';

interface Entry { log: ULog; name: string; size: number; events?: EventsResult; fits: Map<string, PlantFit | undefined>; pages: Map<string, PageSpec> }

export type PageId = 'overview' | 'tracking' | 'actuators' | 'vibration' | 'power' | 'sensors' | 'system' | 'params' | 'messages';

export class Engine {
  private logs = new Map<string, Entry>();
  private paramFiles: ParamSet[] = [];

  async open(id: string, name: string, buf: ArrayBuffer): Promise<LogSummary> {
    const log = new ULog(new Uint8Array(buf));
    const e: Entry = { log, name, size: buf.byteLength, fits: new Map(), pages: new Map() };
    this.logs.set(id, e);
    e.events = await decodeLogEvents(log);
    return this.summary(id);
  }

  close(id: string) { this.logs.delete(id); }

  private get(id: string): Entry {
    const e = this.logs.get(id);
    if (!e) throw new Error(`Log ${id} not loaded`);
    return e;
  }

  summary(id: string): LogSummary {
    const { log, name, size } = this.get(id);
    let utcStart: number | undefined;
    const g = gnssTopic(log);
    if (g) {
      const d = log.topic(g)!;
      const u = d.cols['time_utc_usec'];
      if (u) { const i = u.findIndex((v) => v > 0); if (i >= 0) utcStart = u[i] / 1e3 - d.t[i] * 1e3; }
    }
    const af = airframeName(log);
    return {
      id, fileName: name, sizeBytes: size, durationS: log.durationS, startTimestamp: log.startTimestamp, utcStart,
      hw: log.infoString('ver_hw'), sw: log.infoString('ver_sw'), swVersion: versionString(log.infoNumber('ver_sw_release')),
      vehicleName: log.infoString('sys_name'), airframe: af ? (af.name || String(af.id)) : undefined,
      modes: flightModes(log), armed: armedIntervals(log), airborne: airborneIntervals(log),
      topicCount: log.topicKeys().length, warnings: log.warnings, dropouts: log.dropouts, paramChanges: log.changedParams,
      hasFifoGyro: log.has('sensor_gyro_fifo'), hasFifoAccel: log.has('sensor_accel_fifo'), isSupportedVersion: isSupportedVersion(log),
      alerts: this.alerts(id),
    };
  }

  /** Time-located alerts for the flight timeline (events, messages, failsafe, dropouts, parameter changes, takeoff/landing). */
  private alerts(id: string): TimelineAlert[] {
    const e = this.get(id);
    const log = e.log;
    const out: TimelineAlert[] = [];
    const sev = (lvl: number): TimelineAlert['severity'] | undefined => (lvl <= 3 ? 'danger' : lvl === 4 ? 'warning' : undefined);
    for (const ev of e.events?.events ?? []) {
      const s = sev(ev.level);
      if (s) out.push({ t: ev.t, severity: s, kind: 'event', text: ev.message, detail: ev.description || undefined });
    }
    for (const m of log.logs) {
      const s = sev(m.level);
      if (s && !m.message.endsWith('	')) out.push({ t: m.t, severity: s, kind: 'message', text: m.message.trim() });
    }
    const vs = log.topic('vehicle_status');
    if (vs && vs.cols['failsafe']) {
      const f = vs.cols['failsafe'];
      for (let i = 1; i < vs.count; i++) {
        if (f[i] && !f[i - 1]) out.push({ t: vs.t[i], severity: 'danger', kind: 'failsafe', text: 'Failsafe activated' });
        if (!f[i] && f[i - 1]) out.push({ t: vs.t[i], severity: 'info', kind: 'failsafe', text: 'Failsafe cleared' });
      }
    }
    for (const d of log.dropouts) if (d.durationMs >= 50) out.push({ t: d.t, severity: d.durationMs >= 200 ? 'warning' : 'info', kind: 'dropout', text: `Logger dropout ${d.durationMs} ms` });
    for (const p of log.changedParams) out.push({ t: p.t, severity: 'info', kind: 'param', text: `${p.name} = ${+p.value.toPrecision(6)}` });
    for (const [a, b] of airborneIntervals(log)) {
      out.push({ t: a, severity: 'info', kind: 'takeoff', text: 'Takeoff' });
      out.push({ t: b, severity: 'info', kind: 'landing', text: 'Landing' });
    }
    out.sort((x, y) => x.t - y.t);
    // drop duplicates (the same text logged as message and event)
    return out.filter((a, i) => !out.slice(Math.max(0, i - 6), i).some((b) => b.text === a.text && Math.abs(b.t - a.t) < 2));
  }

  page(id: string, page: PageId): PageSpec {
    const e = this.get(id);
    const cached = e.pages.get(page);
    if (cached) return cached;
    const log = e.log;
    let p: PageSpec;
    switch (page) {
      case 'overview': p = P.overviewPage(log, e.events?.events); break;
      case 'tracking': p = P.trackingPage(log); break;
      case 'actuators': p = P.actuatorsPage(log); break;
      case 'vibration': p = P.vibrationPage(log); break;
      case 'power': p = P.powerPage(log); break;
      case 'sensors': p = P.sensorsPage(log); break;
      case 'system': p = P.systemPage(log); break;
      case 'params': p = P.paramsPage(log); break;
      case 'messages': p = P.messagesPage(log, e.events?.events ?? [], e.events?.source ?? 'none'); break;
      default: throw new Error(`Unknown page ${page}`);
    }
    e.pages.set(page, p);
    return p;
  }

  filters(id: string, req: FiltersRequest) { return filtersPage(this.get(id).log, req); }

  rateLoop(id: string, req: RateLoopRequest) {
    const e = this.get(id);
    return rateLoopPage(e.log, req, e.fits);
  }

  topics(id: string): TopicMeta[] { return this.get(id).log.allTopicMeta(); }

  series(id: string, topic: string, field: string): { t: Float64Array; y: Float32Array } | undefined {
    const log = this.get(id).log;
    const d = log.topic(topic);
    if (!d || !d.cols[field]) return undefined;
    return { t: d.t, y: Float32Array.from(d.cols[field]) };
  }

  addParamsFile(name: string, text: string): { name: string; count: number } {
    const ps = parseQgcParams(text, name);
    this.paramFiles = this.paramFiles.filter((p) => p.name !== name).concat(ps);
    return { name, count: ps.values.size };
  }
  removeParamsFile(name: string) { this.paramFiles = this.paramFiles.filter((p) => p.name !== name); }
  paramFileNames(): string[] { return this.paramFiles.map((p) => p.name); }

  compare(ids: string[], paramFiles: string[] = []): PageSpec {
    const entries = ids.map((id) => ({ id, name: this.get(id).name.replace(/\.ulg$/i, ''), log: this.get(id).log }));
    return comparePage(entries, this.paramFiles.filter((p) => paramFiles.includes(p.name)));
  }

  paramDiff(selection: string[], includeMissing = false): PageSpec {
    const sets: ParamSet[] = [];
    for (const s of selection) {
      if (s.startsWith('file:')) { const f = this.paramFiles.find((p) => p.name === s.slice(5)); if (f) sets.push(f); }
      else { const e = this.logs.get(s); if (e) sets.push({ name: e.name.replace(/\.ulg$/i, ''), values: new Map(e.log.params), source: 'log' }); }
    }
    return paramDiffPage(sets, includeMissing);
  }

  /** Raw access for report generation */
  info(id: string): { left: [string, string][]; right: [string, string][] } { return P.infoTables(this.get(id).log); }
}

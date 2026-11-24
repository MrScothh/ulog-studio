import { useMemo, useRef, useState } from 'react';
import { makeStyles, tokens, Button, Caption1, Tooltip, mergeClasses, Badge } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronUpRegular, ArrowMaximizeRegular } from '@fluentui/react-icons';
import type { LogSummary, TimelineAlert } from '../core/types';
import { timeSync, useTimeRange, useCursorT, cursorSync } from '../charts/timeSync';
import { fmtTime } from '../charts/theme';
import { useWidth } from '../charts/useUplot';
import { prefs } from '../app/prefs';
import { toneIcon } from './SpecRenderer';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, userSelect: 'none' },
  head: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minHeight: '24px' },
  chips: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', flexGrow: 1 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2 },
  swatch: { width: '10px', height: '10px', borderRadius: '3px' },
  track: { position: 'relative', cursor: 'crosshair', touchAction: 'none' },
  laneLabel: { position: 'absolute', left: 0, fontSize: '10px', lineHeight: '10px', color: tokens.colorNeutralForeground3, width: '46px', textAlign: 'right', paddingRight: '6px', boxSizing: 'border-box' },
  modeLane: { position: 'absolute', height: '22px', borderRadius: tokens.borderRadiusMedium, overflow: 'hidden', backgroundColor: tokens.colorNeutralBackground3 },
  seg: { position: 'absolute', top: 0, bottom: 0, display: 'flex', alignItems: 'center', paddingLeft: '6px', fontSize: '11px', fontWeight: tokens.fontWeightSemibold, color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden', boxShadow: `inset -1px 0 0 ${tokens.colorNeutralBackground1}`, textShadow: '0 1px 1px rgba(0,0,0,0.35)' },
  statusLane: { position: 'absolute', height: '6px', borderRadius: '3px', backgroundColor: tokens.colorNeutralBackground3, overflow: 'hidden' },
  armed: { position: 'absolute', top: 0, bottom: 0, backgroundColor: tokens.colorNeutralStroke1 },
  air: { position: 'absolute', top: 0, bottom: 0, backgroundColor: tokens.colorBrandBackground },
  alertLane: { position: 'absolute', height: '14px' },
  mark: { position: 'absolute', top: 0, width: '10px', height: '14px', marginLeft: '-5px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  dot: { width: '8px', height: '8px', transform: 'rotate(45deg)', borderRadius: '1px' },
  axis: { position: 'absolute', height: '14px', fontSize: '10px', color: tokens.colorNeutralForeground3 },
  tick: { position: 'absolute', top: 0, transform: 'translateX(-50%)', whiteSpace: 'nowrap' },
  brushDim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.28)', pointerEvents: 'none' },
  brush: { position: 'absolute', border: `2px solid ${tokens.colorBrandStroke1}`, borderRadius: tokens.borderRadiusMedium, pointerEvents: 'none', boxSizing: 'border-box' },
  cursor: { position: 'absolute', width: '2px', marginLeft: '-1px', backgroundColor: tokens.colorNeutralForeground1, pointerEvents: 'none', borderRadius: '1px' },
  bubble: { position: 'absolute', transform: 'translate(-50%, 0)', padding: '1px 6px', borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralForeground1, color: tokens.colorNeutralBackground1, fontSize: '11px', fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap', pointerEvents: 'none', fontVariantNumeric: 'tabular-nums', zIndex: 2 },
  list: { maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1px', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '4px' },
  row: { display: 'grid', gridTemplateColumns: '58px 20px 1fr', alignItems: 'center', gap: '6px', padding: '3px 6px', borderRadius: tokens.borderRadiusMedium, cursor: 'pointer', fontSize: tokens.fontSizeBase200, ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  rowTime: { color: tokens.colorNeutralForeground3, fontVariantNumeric: 'tabular-nums' },
  rowText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
});

const LANE_X = 48; // left gutter for lane labels
const SEV_COLOR: Record<TimelineAlert['severity'], string> = { danger: tokens.colorPaletteRedBackground3, warning: tokens.colorPaletteMarigoldBackground3, info: tokens.colorNeutralForeground3 };

/** Flight Review mode colours, darkened a little so white labels stay readable and the strip is calmer. */
function laneColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * 0.78 + 0x30 * 0.22);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

function niceStep(span: number, px: number): number {
  const target = span / Math.max(2, px / 90);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s >= target) ?? 3600;
}

/**
 * Whole-flight navigator: flight modes, armed / in-air, time-located alerts and the current zoom window.
 * Drag to zoom on a stretch, click a mode to zoom on it, double-click to reset. The cursor shows where the
 * pointer is on any chart, the map or the XY view, and moving over the timeline moves the cursor on every chart.
 */
export function FlightTimeline({ log, title }: { log: LogSummary; title?: React.ReactNode }) {
  const s = useStyles();
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const range = useTimeRange(log.id);
  const cur = useCursorT();
  const [open, setOpen] = useState<boolean>(prefs.get('timelineOpen', false));
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const t0 = Math.min(0, log.modes[0]?.t0 ?? 0), t1 = log.durationS;
  const w = Math.max(10, width - LANE_X);
  const x = (t: number) => LANE_X + ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0)) * w;
  const tAt = (px: number) => t0 + ((px - LANE_X) / w) * (t1 - t0);
  const counts = useMemo(() => ({
    danger: log.alerts.filter((a) => a.severity === 'danger').length,
    warning: log.alerts.filter((a) => a.severity === 'warning').length,
  }), [log.alerts]);
  const step = niceStep(t1 - t0, w);
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  const curMode = cur != null ? log.modes.find((m) => cur >= m.t0 && cur < m.t1) : undefined;
  const zoomTo = (a: number, b: number) => timeSync.set(log.id, [Math.max(t0, a), Math.min(t1, b)]);

  const Y_MODE = 0, Y_STATUS = 28, Y_ALERT = 40, Y_AXIS = 58, H = 72;
  const onDown = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < LANE_X) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag([px, px]);
  };
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = Math.min(LANE_X + w, Math.max(LANE_X, e.clientX - r.left));
    cursorSync.set(tAt(px), 'ext');
    if (drag) setDrag([drag[0], px]);
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const [a, b] = drag;
    setDrag(null);
    if (Math.abs(b - a) > 5) { zoomTo(tAt(Math.min(a, b)), tAt(Math.max(a, b))); return; }
    // click: zoom on the flight mode under the pointer (only on the mode lane)
    const r = ref.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y <= Y_MODE + 22) {
      const t = tAt(a);
      const m = log.modes.find((mm) => t >= mm.t0 && t < mm.t1);
      if (m) zoomTo(m.t0, m.t1);
    }
  };

  const zoomed = range && (range[0] > t0 + 1e-6 || range[1] < t1 - 1e-6);
  return (
    <div className={s.root}>
      <div className={s.head}>
        <div className={s.chips}>{title}</div>
        {zoomed && (
          <Button size="small" appearance="subtle" icon={<ArrowMaximizeRegular />} onClick={() => timeSync.set(log.id, null)}>
            {fmtTime(range![0])} – {fmtTime(range![1])} · Show whole flight
          </Button>
        )}
        <Button size="small" appearance="subtle" icon={open ? <ChevronUpRegular /> : <ChevronDownRegular />} iconPosition="after"
          onClick={() => { setOpen(!open); prefs.set('timelineOpen', !open); }}>
          Alerts
          {counts.danger > 0 && <Badge size="small" color="danger" style={{ marginLeft: 6 }}>{counts.danger}</Badge>}
          {counts.warning > 0 && <Badge size="small" color="warning" style={{ marginLeft: 4 }}>{counts.warning}</Badge>}
        </Button>
      </div>
      <div ref={ref} className={s.track} style={{ height: H }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => { if (!drag) cursorSync.set(null, 'ext'); }}
        onDoubleClick={() => timeSync.set(log.id, null)} role="group" aria-label="Flight timeline">
        <span className={s.laneLabel} style={{ top: Y_MODE + 6 }}>Mode</span>
        <div className={s.modeLane} style={{ top: Y_MODE, left: LANE_X, width: w }}>
          {log.modes.map((m, i) => {
            const a = x(m.t0) - LANE_X, b = x(m.t1) - LANE_X;
            const label = b - a > m.name.length * 6.6 + 10 ? m.name : b - a > 22 ? m.name.slice(0, 3) : '';
            return <div key={i} className={s.seg} style={{ left: a, width: Math.max(1, b - a), backgroundColor: laneColor(m.color) }} title={`${m.name}: ${fmtTime(m.t0)} – ${fmtTime(m.t1)} (${(m.t1 - m.t0).toFixed(0)} s)`}>{label}</div>;
          })}
        </div>
        <span className={s.laneLabel} style={{ top: Y_STATUS - 2 }}>In air</span>
        <div className={s.statusLane} style={{ top: Y_STATUS, left: LANE_X, width: w }}>
          {log.armed.map(([a, b], i) => <div key={`r${i}`} className={s.armed} style={{ left: x(a) - LANE_X, width: Math.max(1, x(b) - x(a)) }} title={`Armed ${fmtTime(a)} – ${fmtTime(b)}`} />)}
          {log.airborne.map(([a, b], i) => <div key={`a${i}`} className={s.air} style={{ left: x(a) - LANE_X, width: Math.max(1, x(b) - x(a)) }} title={`In air ${fmtTime(a)} – ${fmtTime(b)}`} />)}
        </div>
        <span className={s.laneLabel} style={{ top: Y_ALERT + 2 }}>Alerts</span>
        <div className={s.alertLane} style={{ top: Y_ALERT, left: 0, width: LANE_X + w }}>
          {log.alerts.filter((a) => a.severity !== 'info' || a.kind === 'param').map((a, i) => (
            <Tooltip key={i} relationship="description" content={`${fmtTime(a.t)} · ${a.text}`}>
              <div className={s.mark} style={{ left: Math.max(LANE_X + 5, x(a.t)) }} onPointerDown={(e) => e.stopPropagation()} onClick={() => { zoomTo(a.t - 10, a.t + 10); cursorSync.set(a.t, 'ext'); }}>
                <div className={s.dot} style={{ backgroundColor: a.kind === 'param' ? tokens.colorBrandForeground1 : SEV_COLOR[a.severity] }} />
              </div>
            </Tooltip>
          ))}
        </div>
        <div className={s.axis} style={{ top: Y_AXIS, left: 0, width: LANE_X + w }}>
          {ticks.map((t) => <span key={t} className={s.tick} style={{ left: x(t) }}>{fmtTime(t)}</span>)}
        </div>
        {zoomed && (
          <>
            <div className={s.brushDim} style={{ top: 0, height: Y_AXIS - 2, left: LANE_X, width: Math.max(0, x(range![0]) - LANE_X) }} />
            <div className={s.brushDim} style={{ top: 0, height: Y_AXIS - 2, left: x(range![1]), width: Math.max(0, LANE_X + w - x(range![1])) }} />
            <div className={s.brush} style={{ top: -3, height: Y_AXIS + 1, left: x(range![0]) - 1, width: Math.max(3, x(range![1]) - x(range![0]) + 2) }} />
          </>
        )}
        {drag && <div className={s.brush} style={{ top: -3, height: Y_AXIS + 1, left: Math.min(...drag), width: Math.abs(drag[1] - drag[0]) }} />}
        {cur != null && cur >= t0 && cur <= t1 && (
          <>
            <div className={s.cursor} style={{ left: x(cur), top: -2, height: Y_AXIS }} />
            <div className={s.bubble} style={{ top: Y_AXIS - 2, left: Math.min(LANE_X + w - 60, Math.max(LANE_X + 60, x(cur))) }}>{fmtTime(cur)}{curMode ? ` · ${curMode.name}` : ''}</div>
          </>
        )}
      </div>
      {open && (
        <div className={s.list} role="list" aria-label="Alerts">
          {log.alerts.length === 0 && <Caption1 className={s.muted}>No alerts in this log.</Caption1>}
          {log.alerts.map((a, i) => (
            <div key={i} role="listitem" className={mergeClasses(s.row)} onClick={() => { zoomTo(a.t - 10, a.t + 10); cursorSync.set(a.t, 'ext'); }} title={a.detail ?? a.text}
              onMouseEnter={() => cursorSync.set(a.t, 'ext')}>
              <span className={s.rowTime}>{fmtTime(a.t)}</span>
              {toneIcon(a.severity === 'info' ? (a.kind === 'takeoff' || a.kind === 'landing' ? 'good' : 'info') : a.severity)}
              <span className={s.rowText}>{a.text}<span className={s.muted}>{a.kind === 'event' || a.kind === 'message' ? '' : `  · ${a.kind}`}</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

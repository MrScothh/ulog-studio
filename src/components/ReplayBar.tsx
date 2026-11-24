import { useEffect, useRef, useState } from 'react';
import { makeStyles, tokens, Button, Tooltip, ToggleButton, Caption1 } from '@fluentui/react-components';
import { PlayFilled, PauseFilled, PreviousRegular } from '@fluentui/react-icons';
import type { ReplaySpec } from '../core/types';
import { useChartCtx } from '../charts/ChartContext';
import { cursorSync, useCursorT } from '../charts/timeSync';
import { replayState, locate, lerp, lerpDeg } from '../charts/replayState';
import { fmtTime } from '../charts/theme';
import { prefs } from '../app/prefs';

const SPEEDS = [1, 2, 5, 10, 20];

const useStyles = makeStyles({
  bar: {
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '10px 12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
  },
  slider: { flexGrow: 1, minWidth: '220px' },
  time: { fontVariantNumeric: 'tabular-nums', minWidth: '118px', fontWeight: tokens.fontWeightSemibold },
  speeds: { display: 'inline-flex', gap: '2px', padding: '2px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  readouts: { display: 'flex', gap: '18px', flexWrap: 'wrap', width: '100%', paddingTop: '2px' },
  ro: { display: 'flex', flexDirection: 'column', minWidth: '78px' },
  roLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  roValue: { fontVariantNumeric: 'tabular-nums', fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  mode: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  swatch: { width: '10px', height: '10px', borderRadius: '3px' },
});

/**
 * Flight replay: plays the flight back at 1–20× real time. The drone moves on the map and on the top view,
 * the timeline cursor follows, and the readouts show height, speed, climb rate and heading.
 */
export function ReplayBar({ spec }: { spec: ReplaySpec }) {
  const s = useStyles();
  const ctx = useChartCtx();
  const cur = useCursorT();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(prefs.get('replaySpeed', 5));
  const [head, setHead] = useState(spec.start);
  const headRef = useRef(spec.start);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // playback loop
  useEffect(() => {
    if (!playing) return;
    replayState.set({ playing: true });
    let raf = 0, last = performance.now(), lastUi = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      let t = headRef.current + dt * speedRef.current;
      if (t >= spec.t1) { t = spec.t1; setPlaying(false); }
      headRef.current = t;
      cursorSync.set(t, 'ext');
      if (now - lastUi > 33) { setHead(t); lastUi = now; }
      if (t < spec.t1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); replayState.set({ playing: false }); setHead(headRef.current); };
  }, [playing, spec]);

  useEffect(() => () => { replayState.set({ playing: false }); }, []);

  const seek = (t: number) => { headRef.current = t; setHead(t); cursorSync.set(t, 'ext'); };
  const toggle = () => {
    if (!playing && headRef.current >= spec.t1 - 0.05) seek(spec.start);
    setPlaying(!playing);
  };

  // readouts: replay head while playing, otherwise wherever the cursor is (hover on charts/map) or the head
  const t = playing ? head : cur ?? head;
  const [i, f] = locate(spec.t, t);
  const h = lerp(spec.height, i, f), v = lerp(spec.speed, i, f), vz = lerp(spec.vz, i, f), hd = lerpDeg(spec.hdg, i, f);
  const mode = ctx.modes.find((m) => t >= m.t0 && t < m.t1);
  const n = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');

  return (
    <div className={s.bar} role="group" aria-label="Flight replay"
      onKeyDown={(e) => { if (e.key === ' ' && (e.target as HTMLElement).getAttribute('role') !== 'slider') { e.preventDefault(); toggle(); } }}>
      <Tooltip relationship="label" content={playing ? 'Pause (space)' : 'Play (space)'}>
        <Button appearance="primary" shape="circular" icon={playing ? <PauseFilled /> : <PlayFilled />} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} />
      </Tooltip>
      <Tooltip relationship="label" content="Back to takeoff"><Button appearance="subtle" icon={<PreviousRegular />} onClick={() => seek(spec.start)} /></Tooltip>
      <span className={s.time}>{fmtTime(head)} / {fmtTime(spec.t1)}</span>
      <input type="range" className={`${s.slider} replay-range`} min={spec.t0} max={spec.t1} step={0.1} value={head} aria-label="Replay position"
        style={{ ['--p' as string]: `${(((head - spec.t0) / (spec.t1 - spec.t0 || 1)) * 100).toFixed(2)}%` }}
        onChange={(e) => seek(Number(e.target.value))} />
      <div className={s.speeds} role="radiogroup" aria-label="Replay speed">
        {SPEEDS.map((x) => (
          <ToggleButton key={x} size="small" appearance="subtle" checked={speed === x} onClick={() => { setSpeed(x); prefs.set('replaySpeed', x); }}>{x}×</ToggleButton>
        ))}
      </div>
      <div className={s.readouts}>
        <div className={s.ro}><span className={s.roLabel}>Mode</span><span className={`${s.roValue} ${s.mode}`}>{mode && <span className={s.swatch} style={{ backgroundColor: mode.color }} />}{mode?.name ?? '–'}</span></div>
        <div className={s.ro}><span className={s.roLabel}>Height</span><span className={s.roValue}>{n(h)} m</span></div>
        <div className={s.ro}><span className={s.roLabel}>Ground speed</span><span className={s.roValue}>{n(v)} m/s</span></div>
        <div className={s.ro}><span className={s.roLabel}>Climb rate</span><span className={s.roValue}>{n(vz)} m/s</span></div>
        <div className={s.ro}><span className={s.roLabel}>Heading</span><span className={s.roValue}>{Number.isFinite(hd) ? `${((hd % 360) + 360) % 360 | 0}°` : '–'}</span></div>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, alignSelf: 'flex-end' }}>{playing ? `Playing at ${speed}×` : cur != null ? 'Showing the point under the cursor' : 'Press play, or drag the slider'}</Caption1>
      </div>
    </div>
  );
}

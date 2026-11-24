import { useEffect, useMemo, useRef, useState } from 'react';
import { makeStyles, tokens, Field, SpinButton, Button, Spinner, Caption1, Subtitle2, Tooltip, MessageBar, MessageBarBody, Body1Strong } from '@fluentui/react-components';
import { ArrowResetRegular, DocumentArrowDownRegular, ZoomFitRegular } from '@fluentui/react-icons';
import type { LogSummary, PageSpec } from '../core/types';
import type { Gains } from '../core/analysis/plantid';
import { engine } from '../app/engineClient';
import { PageView } from '../components/Sections';
import { timeSync } from '../charts/timeSync';
import { exportParams } from './paramExport';

const AX = ['roll', 'pitch', 'yaw'] as const;
type Ax = (typeof AX)[number];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  panel: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1 },
  grid: { display: 'grid', gridTemplateColumns: '64px repeat(4, 112px) 1fr', gap: '8px 14px', alignItems: 'center', overflowX: 'auto' },
  head: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  win: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
});

export function RateLoopPage({ log }: { log: LogSummary }) {
  const s = useStyles();
  const [logged, setLogged] = useState<Record<Ax, Gains> | null>(null);
  const [gains, setGains] = useState<Record<Ax, Gains> | null>(null);
  const [windows, setWindows] = useState<Partial<Record<Ax, [number, number]>>>({});
  const [page, setPage] = useState<PageSpec | null>(null);
  const [fitWin, setFitWin] = useState<Partial<Record<Ax, [number, number]>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rid = useRef(0);

  useEffect(() => {
    setLogged(null); setGains(null); setWindows({}); setPage(null);
    engine().rateLoop(log.id, {}).then((r) => { setLogged(r.gains); setGains(r.gains); }).catch((e) => setErr(String(e?.message ?? e)));
  }, [log.id]);

  const req = useMemo(() => gains && ({ gains, windows }), [gains, windows]);
  useEffect(() => {
    if (!req) return;
    const id = ++rid.current;
    setBusy(true);
    const h = setTimeout(() => {
      engine().rateLoop(log.id, req).then((r) => {
        if (id !== rid.current) return;
        setPage(r);
        setFitWin(Object.fromEntries(Object.entries(r.fits).map(([k, f]) => [k, [f!.t0, f!.t1]])) as Partial<Record<Ax, [number, number]>>);
        setBusy(false);
      }).catch((e) => { setErr(String(e?.message ?? e)); setBusy(false); });
    }, 300);
    return () => clearTimeout(h);
  }, [req, log.id]);

  if (err) return <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>;
  if (!gains || !logged) return <Spinner label="Identifying the plant…" />;
  const setG = (a: Ax, k: keyof Gains) => (v: number) => setGains({ ...gains, [a]: { ...gains[a], [k]: v } });
  const changed: [string, number][] = [];
  for (const a of AX) for (const k of ['k', 'p', 'i', 'd'] as const) if (gains[a][k] !== logged[a][k]) changed.push([`MC_${a.toUpperCase()}RATE_${k.toUpperCase()}`, gains[a][k]]);
  const useZoom = (a: Ax) => { const r = timeSync.get(log.id); if (r) setWindows({ ...windows, [a]: r }); };
  const head = page ? { ...page, sections: page.sections.slice(0, 1) } : null;
  const rest = page ? { ...page, sections: page.sections.slice(1) } : null;
  return (
    <div className={s.root}>
      {head ? <PageView page={head} /> : <Spinner label="Identifying the airframe…" />}
      <div className={s.panel}>
        <Subtitle2>Try other gains</Subtitle2>
        <Caption1 className={s.hint}>MC_*RATE_K multiplies P, I and D together. The margins above update with the values below; the airframe model stays the one identified on this flight. Nothing is sent to the vehicle.</Caption1>
        <div className={s.grid}>
          <span />
          {['K', 'P', 'I', 'D'].map((h) => <span key={h} className={s.head}>MC_*RATE_{h}</span>)}
          <span className={s.head}>Stick inputs used</span>
          {AX.map((a) => (
            <div key={a} style={{ display: 'contents' }}>
              <Body1Strong style={{ textTransform: 'capitalize' }}>{a}</Body1Strong>
              {(['k', 'p', 'i', 'd'] as const).map((k) => (
                <Field key={k} size="small" hint={`flown ${logged[a][k]}`}>
                  <SpinButton size="small" value={gains[a][k]} step={k === 'd' ? 0.0002 : k === 'k' ? 0.05 : 0.01} min={0} max={10} precision={k === 'd' ? 4 : 3}
                    onChange={(_, d) => { const v = d.value ?? Number(d.displayValue); if (Number.isFinite(v)) setG(a, k)(v as number); }} />
                </Field>
              ))}
              <div className={s.win}>
                <Caption1>{fitWin[a] ? `${fitWin[a]![0].toFixed(1)}–${fitWin[a]![1].toFixed(1)} s${windows[a] ? ' (manual)' : ' (auto)'}` : 'no window'}</Caption1>
                <Tooltip relationship="description" content="Identify on the time range currently zoomed in the plots (zoom on clean stick doublets first)."><Button size="small" icon={<ZoomFitRegular />} onClick={() => useZoom(a)}>Use zoom range</Button></Tooltip>
                {windows[a] && <Button size="small" appearance="subtle" onClick={() => { const w = { ...windows }; delete w[a]; setWindows(w); }}>Auto</Button>}
              </div>
            </div>
          ))}
        </div>
        <div className={s.actions}>
          <Button icon={<ArrowResetRegular />} onClick={() => setGains(logged)}>Reset to log values</Button>
          <Tooltip relationship="description" content="Writes a QGroundControl .params file with only the changed gains. Nothing is sent to the vehicle.">
            <Button icon={<DocumentArrowDownRegular />} disabled={!changed.length} onClick={() => exportParams(changed, `${log.fileName.replace(/\.ulg$/i, '')}_rate_gains.params`)}>Export changed (.params)</Button>
          </Tooltip>
          {busy && <Spinner size="tiny" label="Computing…" />}
        </div>
      </div>
      {rest && <PageView page={rest} />}
    </div>
  );
}

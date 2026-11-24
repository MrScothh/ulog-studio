import { useEffect, useMemo, useRef, useState } from 'react';
import { makeStyles, tokens, Field, SpinButton, Button, Spinner, Switch, Caption1, Subtitle2, Tooltip, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ArrowResetRegular, DocumentArrowDownRegular } from '@fluentui/react-icons';
import type { LogSummary, PageSpec } from '../core/types';
import type { FilterConfig } from '../core/analysis/filters';
import { engine } from '../app/engineClient';
import { PageView } from '../components/Sections';
import { timeSync } from '../charts/timeSync';
import { exportParams } from './paramExport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  panel: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 14px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1 },
  row: { display: 'flex', flexWrap: 'wrap', gap: '12px 16px', alignItems: 'flex-end' },
  spin: { width: '112px' },
  actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
});

type Edit = { nf0: number; bw0: number; nf1: number; bw1: number; lpf: number; dlpf: number };

function NumField({ label, value, onChange, step = 1, min = 0, max = 1000, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; hint?: string }) {
  const s = useStyles();
  return (
    <Field label={label} hint={hint} size="small">
      <SpinButton className={s.spin} size="small" value={value} step={step} min={min} max={max}
        onChange={(_, d) => { const v = d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : NaN); if (Number.isFinite(v)) onChange(v as number); }} />
    </Field>
  );
}

export function FiltersPage({ log }: { log: LogSummary }) {
  const s = useStyles();
  const [cur, setCur] = useState<FilterConfig | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [useRange, setUseRange] = useState(false);
  const [page, setPage] = useState<(PageSpec & { rateSource: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  // initial: current config from the log
  useEffect(() => {
    let alive = true;
    setCur(null); setEdit(null); setPage(null);
    engine().filters(log.id, { replay: false }).then((r) => {
      if (!alive) return;
      setCur(r.current);
      setEdit({ nf0: r.current.notches[0].f, bw0: r.current.notches[0].bw, nf1: r.current.notches[1].f, bw1: r.current.notches[1].bw, lpf: r.current.lpf, dlpf: r.current.dlpf });
    }).catch((e) => setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [log.id]);

  const proposed = useMemo(() => edit && ({ notches: [{ f: edit.nf0, bw: edit.bw0 }, { f: edit.nf1, bw: edit.bw1 }], lpf: edit.lpf, dlpf: edit.dlpf }), [edit]);

  useEffect(() => {
    if (!proposed) return;
    const id = ++reqId.current;
    setBusy(true);
    const range = useRange ? timeSync.get(log.id) ?? undefined : undefined;
    const h = setTimeout(() => {
      engine().filters(log.id, { proposed, range, replay: true }).then((r) => { if (id === reqId.current) { setPage(r); setBusy(false); } })
        .catch((e) => { setErr(String(e?.message ?? e)); setBusy(false); });
    }, 350);
    return () => clearTimeout(h);
  }, [proposed, useRange, log.id]);

  if (err) return <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>;
  if (!edit || !cur) return <Spinner label="Reading filter configuration…" />;
  const set = (k: keyof Edit) => (v: number) => setEdit({ ...edit, [k]: v });
  const changed: [string, number][] = [];
  if (edit.nf0 !== cur.notches[0].f) changed.push(['IMU_GYRO_NF0_FRQ', edit.nf0]);
  if (edit.bw0 !== cur.notches[0].bw) changed.push(['IMU_GYRO_NF0_BW', edit.bw0]);
  if (edit.nf1 !== cur.notches[1].f) changed.push(['IMU_GYRO_NF1_FRQ', edit.nf1]);
  if (edit.bw1 !== cur.notches[1].bw) changed.push(['IMU_GYRO_NF1_BW', edit.bw1]);
  if (edit.lpf !== cur.lpf) changed.push(['IMU_GYRO_CUTOFF', edit.lpf]);
  if (edit.dlpf !== cur.dlpf) changed.push(['IMU_DGYRO_CUTOFF', edit.dlpf]);

  return (
    <div className={s.root}>
      <div className={s.panel}>
        <Subtitle2>Proposed IMU_GYRO_* filters</Subtitle2>
        <div className={s.row}>
          <NumField label="NF0 frequency [Hz]" value={edit.nf0} onChange={set('nf0')} hint={`log: ${cur.notches[0].f}`} />
          <NumField label="NF0 bandwidth [Hz]" value={edit.bw0} onChange={set('bw0')} hint={`log: ${cur.notches[0].bw}`} />
          <NumField label="NF1 frequency [Hz]" value={edit.nf1} onChange={set('nf1')} hint={`log: ${cur.notches[1].f}`} />
          <NumField label="NF1 bandwidth [Hz]" value={edit.bw1} onChange={set('bw1')} hint={`log: ${cur.notches[1].bw}`} />
          <NumField label="Gyro LPF [Hz]" value={edit.lpf} onChange={set('lpf')} hint={`log: ${cur.lpf}`} />
          <NumField label="D-term LPF [Hz]" value={edit.dlpf} onChange={set('dlpf')} hint={`log: ${cur.dlpf}`} />
        </div>
        <div className={s.actions}>
          <Button icon={<ArrowResetRegular />} onClick={() => setEdit({ nf0: cur.notches[0].f, bw0: cur.notches[0].bw, nf1: cur.notches[1].f, bw1: cur.notches[1].bw, lpf: cur.lpf, dlpf: cur.dlpf })}>Reset to log values</Button>
          <Tooltip relationship="description" content="Writes a QGroundControl .params file with only the changed parameters. Nothing is sent to the vehicle.">
            <Button icon={<DocumentArrowDownRegular />} disabled={!changed.length} onClick={() => exportParams(changed, `${log.fileName.replace(/\.ulg$/i, '')}_filters.params`)}>Export changed (.params)</Button>
          </Tooltip>
          <Switch checked={useRange} onChange={(_, d) => setUseRange(d.checked)} label="Replay on the current zoom range (instead of quiet hover)" />
          {busy && <Spinner size="tiny" label="Replaying…" />}
          <Caption1 className={s.hint}>Filter rate: {page?.rateSource ?? `${cur.fs.toFixed(0)} Hz`}</Caption1>
        </div>
      </div>
      {page && <PageView page={page} />}
    </div>
  );
}

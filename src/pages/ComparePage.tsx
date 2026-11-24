import { useEffect, useState } from 'react';
import { makeStyles, tokens, Checkbox, Button, Spinner, Subtitle2, Caption1, Switch, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import type { PageSpec } from '../core/types';
import { useStore } from '../app/store';
import { engine } from '../app/engineClient';
import { PageView } from '../components/Sections';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '20px' },
  panel: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1 },
  list: { display: 'flex', flexWrap: 'wrap', gap: '2px 18px' },
  actions: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
});

function Selector({ sel, setSel, includeFiles }: { sel: Set<string>; setSel: (s: Set<string>) => void; includeFiles: boolean }) {
  const s = useStyles();
  const logs = useStore((x) => x.logs);
  const files = useStore((x) => x.paramFiles);
  const toggle = (k: string, v: boolean) => { const n = new Set(sel); if (v) n.add(k); else n.delete(k); setSel(n); };
  return (
    <>
      <div className={s.list}>
        {logs.map((l) => <Checkbox key={l.id} label={`${l.fileName}${l.utcStart ? ` (${new Date(l.utcStart).toLocaleString()})` : ''}`} checked={sel.has(l.id)} onChange={(_, d) => toggle(l.id, !!d.checked)} />)}
      </div>
      {includeFiles && (files.length ? (
        <div className={s.list}>
          {files.map((f) => <Checkbox key={f.name} label={`${f.name} (${f.count} params)`} checked={sel.has(`file:${f.name}`)} onChange={(_, d) => toggle(`file:${f.name}`, !!d.checked)} />)}
        </div>
      ) : <Caption1 className={s.hint}>Drop QGroundControl .params files anywhere in the window to compare them too.</Caption1>)}
    </>
  );
}

export function ComparePage() {
  const s = useStyles();
  const logs = useStore((x) => x.logs);
  const [sel, setSel] = useState<Set<string>>(new Set(logs.map((l) => l.id)));
  const [page, setPage] = useState<PageSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSel((old) => new Set([...old, ...logs.map((l) => l.id)].filter((k) => k.startsWith('file:') || logs.some((l) => l.id === k)))); }, [logs]);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const ids = logs.map((l) => l.id).filter((id) => sel.has(id));
      const files = [...sel].filter((k) => k.startsWith('file:')).map((k) => k.slice(5));
      setPage(await engine().compare(ids, files));
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };
  useEffect(() => { if (logs.length >= 2 && !page) void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <div className={s.root}>
      <div className={s.panel}>
        <Subtitle2>Flights to compare</Subtitle2>
        <Selector sel={sel} setSel={setSel} includeFiles />
        <div className={s.actions}>
          <Button appearance="primary" icon={<ArrowSyncRegular />} disabled={busy || [...sel].filter((k) => !k.startsWith('file:')).length < 1} onClick={run}>Compare</Button>
          {busy && <Spinner size="tiny" label="Analysing every flight…" />}
          <Caption1 className={s.hint}>Load several .ulg files at once (drag & drop) to compare them on identical metrics.</Caption1>
        </div>
      </div>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
      {page && <PageView page={page} />}
    </div>
  );
}

export function ParamDiffPage() {
  const s = useStyles();
  const logs = useStore((x) => x.logs);
  const files = useStore((x) => x.paramFiles);
  const [sel, setSel] = useState<Set<string>>(new Set([...logs.map((l) => l.id), ...files.map((f) => `file:${f.name}`)]));
  const [missing, setMissing] = useState(false);
  const [page, setPage] = useState<PageSpec | null>(null);
  useEffect(() => { setSel((old) => new Set([...old, ...files.map((f) => `file:${f.name}`)])); }, [files]);
  useEffect(() => {
    const ordered = [...logs.map((l) => l.id), ...files.map((f) => `file:${f.name}`)].filter((k) => sel.has(k));
    if (ordered.length < 2) { setPage(null); return; }
    void engine().paramDiff(ordered, missing).then(setPage);
  }, [sel, missing, logs, files]);
  return (
    <div className={s.root}>
      <div className={s.panel}>
        <Subtitle2>Parameter sets</Subtitle2>
        <Selector sel={sel} setSel={setSel} includeFiles />
        <Switch checked={missing} onChange={(_, d) => setMissing(d.checked)} label="Include parameters missing from some sets" />
      </div>
      {page ? <PageView page={page} /> : <Caption1 className={s.hint}>Select at least two logs or .params files.</Caption1>}
    </div>
  );
}

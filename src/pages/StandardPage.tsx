import { useEffect, useState } from 'react';
import { Spinner, MessageBar, MessageBarBody } from '@fluentui/react-components';
import type { PageSpec, LogSummary } from '../core/types';
import { getPage, PageKey } from '../app/store';
import { PageView } from '../components/Sections';

export function StandardPage({ log, page }: { log: LogSummary; page: PageKey }) {
  const [spec, setSpec] = useState<PageSpec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSpec(null); setErr(null);
    getPage(log.id, page).then((p) => alive && setSpec(p)).catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [log.id, page]);
  if (err) return <MessageBar intent="error"><MessageBarBody>Analysis failed: {err}</MessageBarBody></MessageBar>;
  if (!spec) return <Spinner label="Analysing…" style={{ marginTop: 48 }} />;
  return <PageView page={spec} />;
}

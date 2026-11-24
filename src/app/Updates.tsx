import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Tooltip, ProgressBar, Body1, Caption1, Field, Input, MessageBar, MessageBarBody, Link, CounterBadge,
} from '@fluentui/react-components';
import { ArrowSyncCircleRegular } from '@fluentui/react-icons';
import { checkForUpdate, installUpdate, getUpdateSettings, setUpdateToken, UpdateInfo, APP_VERSION } from './platform';

/** Desktop auto-update: checks the GitHub Releases of the repository, verifies the signature, installs. */
export function UpdateButton() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settings, setSettings] = useState<{ repo: string; hasStoredToken: boolean; tokenSource?: string } | null>(null);
  const [token, setToken] = useState('');

  const check = async () => {
    setChecking(true); setErr(null);
    const r = await checkForUpdate();
    setInfo(r);
    if (r.error) setErr(r.error);
    setChecking(false);
  };
  useEffect(() => { const h = setTimeout(() => void check(), 4000); return () => clearTimeout(h); }, []);
  useEffect(() => { if (open) void getUpdateSettings().then(setSettings).catch(() => undefined); }, [open]);

  const install = async () => {
    setErr(null); setProgress(0);
    try {
      await installUpdate((done, total) => setProgress(total ? done / total : null));
    } catch (e) { setErr(String(e)); setProgress(null); }
  };
  const saveToken = async (t: string | null) => { await setUpdateToken(t); setToken(''); setSettings(await getUpdateSettings()); await check(); };

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Tooltip content={info?.available ? `Update ${info.version} available` : 'Check for updates'} relationship="label">
          <Button appearance="subtle" icon={<ArrowSyncCircleRegular />}>{info?.available ? <CounterBadge count={1} size="small" dot /> : null}</Button>
        </Tooltip>
      </DialogTrigger>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Updates</DialogTitle>
          <DialogContent style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Body1>Installed version: <b>{APP_VERSION}</b>{info?.available ? <> — new version <b>{info.version}</b> available.</> : info && !info.error ? ' — up to date.' : ''}</Body1>
            {info?.notes && <Caption1 style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{info.notes}</Caption1>}
            {progress !== null && <ProgressBar value={progress ?? undefined} />}
            {err && <MessageBar intent="warning"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {settings && (
              <>
                <Caption1>Updates come from the releases of <b>{settings.repo}</b> on GitHub and are installed only if their signature matches. Token: {settings.hasStoredToken ? 'stored in Windows Credential Manager' : settings.tokenSource ? `from ${settings.tokenSource}` : 'none (not needed for a public repository)'}.</Caption1>
                <Field label="GitHub token (optional)" hint={<>Only needed for a private fork, or to raise the API rate limit. The GitHub CLI login (<Link href="https://cli.github.com" target="_blank">gh auth login</Link>) is used automatically; otherwise use a fine-grained token with “Contents: read”.</>}>
                  <Input type="password" value={token} onChange={(_, d) => setToken(d.value)} placeholder="github_pat_…" />
                </Field>
              </>
            )}
          </DialogContent>
          <DialogActions>
            {settings?.hasStoredToken && <Button onClick={() => saveToken(null)}>Remove token</Button>}
            {token && <Button onClick={() => saveToken(token)}>Save token</Button>}
            <Button onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check now'}</Button>
            <Button appearance="primary" disabled={!info?.available || progress !== null} onClick={install}>Install and restart</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

import iconUrl from '../assets/icon.svg';
import { makeStyles, tokens, Button, Title2, Body1, Caption1 } from '@fluentui/react-components';
import { FolderOpenRegular, ShieldLockRegular, PlugDisconnectedRegular, DocumentMultipleRegular } from '@fluentui/react-icons';
import { APP_VERSION, BUILD_TARGET } from './platform';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', padding: '72px 16px', textAlign: 'center' },
  zone: { width: 'min(720px, 100%)', padding: '40px 24px', border: `2px dashed ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' },
  points: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', width: 'min(720px, 100%)', textAlign: 'left' },
  point: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}` },
  icon: { fontSize: '20px', color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function Welcome({ onOpen }: { onOpen: () => void }) {
  const s = useStyles();
  return (
    <div className={s.root}>
      <div className={s.zone}>
        <img src={iconUrl} width={56} height={56} alt="" />
        <Title2 as="h1" style={{ margin: 0 }}>Analyse PX4 flight logs</Title2>
        <Body1 className={s.muted}>Drop one or more .ulg logs here — and QGroundControl .params files to compare parameters.</Body1>
        <Button appearance="primary" size="large" icon={<FolderOpenRegular />} onClick={onOpen}>Open logs</Button>
      </div>
      <div className={s.points}>
        <div className={s.point}><ShieldLockRegular className={s.icon} /><div><Body1 block><b>Private</b></Body1><Caption1 className={s.muted}>Logs are parsed on this computer and never uploaded.</Caption1></div></div>
        <div className={s.point}><PlugDisconnectedRegular className={s.icon} /><div><Body1 block><b>Offline</b></Body1><Caption1 className={s.muted}>Event and parameter metadata are built in; no network needed.</Caption1></div></div>
        <div className={s.point}><DocumentMultipleRegular className={s.icon} /><div><Body1 block><b>PX4 v1.17+</b></Body1><Caption1 className={s.muted}>Flight Review plots plus tuning analyses and multi-flight comparison.</Caption1></div></div>
      </div>
      <Caption1 className={s.muted}>ULog Studio {APP_VERSION} · {BUILD_TARGET === 'desktop' ? 'desktop' : BUILD_TARGET === 'pwa' ? 'web app' : 'single-file web app'}</Caption1>
    </div>
  );
}

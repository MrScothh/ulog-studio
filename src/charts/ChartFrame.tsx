import { ReactNode } from 'react';
import { makeStyles, tokens, Tooltip, Button, Caption1 } from '@fluentui/react-components';
import { ArrowMaximizeRegular, ImageRegular, ArrowDownloadRegular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  frame: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '10px 12px 8px 12px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '28px' },
  title: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: { display: 'flex', gap: '2px', opacity: 0.85 },
  note: { color: tokens.colorNeutralForeground3 },
  body: { position: 'relative', minWidth: 0 },
});

export interface ChartFrameProps {
  title?: string;
  note?: string;
  children: ReactNode;
  onResetZoom?: () => void;
  onSavePng?: () => void;
  onSaveCsv?: () => void;
  extra?: ReactNode;
  bodyRef?: React.Ref<HTMLDivElement>;
}

export function ChartFrame({ title, note, children, onResetZoom, onSavePng, onSaveCsv, extra, bodyRef }: ChartFrameProps) {
  const s = useStyles();
  return (
    <section className={`${s.frame} chart-frame`} aria-label={title}>
      {(title || onResetZoom || onSavePng || onSaveCsv || extra) && (
        <div className={s.head}>
          <div className={s.title} title={title}>{title}</div>
          {extra}
          <div className={`${s.actions} chart-actions`}>
            {onResetZoom && <Tooltip content="Reset zoom (double-click)" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowMaximizeRegular />} onClick={onResetZoom} /></Tooltip>}
            {onSavePng && <Tooltip content="Save as PNG" relationship="label"><Button size="small" appearance="subtle" icon={<ImageRegular />} onClick={onSavePng} /></Tooltip>}
            {onSaveCsv && <Tooltip content="Export data as CSV" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowDownloadRegular />} onClick={onSaveCsv} /></Tooltip>}
          </div>
        </div>
      )}
      <div className={s.body} ref={bodyRef}>{children}</div>
      {note && <Caption1 className={s.note}>{note}</Caption1>}
    </section>
  );
}

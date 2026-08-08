import { Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { cn, formatDate } from '../../lib/utils';

const TONE_DOT = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-muted-foreground/50',
};

export function IntegrationCard({ icon, name, statusLabel, tone = 'muted', description, lastSyncAt, actions = [], errorMessage }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-lg">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">{name}</h3>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
              {statusLabel}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          {lastSyncAt && <p className="mt-1 text-[11px] text-muted-foreground">Dernière synchronisation : {formatDate(lastSyncAt, { withTime: true })}</p>}
          {errorMessage && <p className="mt-1.5 rounded-md bg-danger/10 px-2 py-1 text-[11px] text-danger">{errorMessage}</p>}
        </div>
      </div>

      {actions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {actions.map((action) => (
            <Button key={action.label} size="sm" variant={action.variant || 'outline'} onClick={action.onClick} disabled={action.loading} className={action.className}>
              {action.loading && <Loader2 className="animate-spin" />}
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

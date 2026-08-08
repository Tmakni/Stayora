import { cn } from '../../lib/utils';

export function MetricCard({ icon: Icon, label, value, hint, tone = 'default', className }) {
  const toneClasses = {
    default: 'text-foreground bg-muted',
    primary: 'text-primary bg-primary/10',
    secondary: 'text-secondary bg-secondary/10',
    success: 'text-success bg-success/10',
    warning: 'text-warning bg-warning/10',
    danger: 'text-danger bg-danger/10',
  };

  return (
    <div className={cn('rounded-lg border border-border bg-card p-4', className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {Icon && (
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', toneClasses[tone])}>
            <Icon className="size-3.5" />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

const TONE_CLASSES = {
  primary: 'bg-primary/10 text-primary',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  secondary: 'bg-secondary/10 text-secondary',
};

export function PriorityTaskCard({ icon: Icon, title, count, description, tone = 'primary', onClick, className }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
    >
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', TONE_CLASSES[tone])}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {count != null && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none', TONE_CLASSES[tone])}>
              {count}
            </span>
          )}
        </span>
        {description && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{description}</span>}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

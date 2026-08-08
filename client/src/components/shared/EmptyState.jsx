import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

export function EmptyState({ icon: Icon, title, description, action, className, compact = false }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'py-8 px-4' : 'py-16 px-6', className)}>
      {Icon && (
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && (
        <Button className="mt-4" size="sm" onClick={action.onClick} variant={action.variant || 'default'}>
          {action.icon && <action.icon />}
          {action.label}
        </Button>
      )}
    </div>
  );
}

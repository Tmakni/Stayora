import { AlertTriangle, WifiOff } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';

export function ErrorState({ title = 'Une erreur est survenue', description, onRetry, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-14 px-6 text-center', className)}>
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        <AlertTriangle className="size-5" />
      </div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {onRetry && (
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}

export function OfflineBanner({ className }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs font-medium text-warning', className)}>
      <WifiOff className="size-3.5 shrink-0" />
      Connexion perdue — nouvelle tentative en cours…
    </div>
  );
}

import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            'group toast rounded-lg border border-border bg-card text-card-foreground shadow-popover text-sm p-3',
          title: 'font-medium',
          description: 'text-muted-foreground text-xs',
          actionButton: 'bg-primary text-primary-foreground',
          cancelButton: 'bg-muted text-muted-foreground',
          success: '!border-success/20',
          error: '!border-danger/20',
        },
      }}
    />
  );
}

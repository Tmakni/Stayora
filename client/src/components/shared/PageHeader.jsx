import { cn } from '../../lib/utils';

export function PageHeader({ title, description, actions, className }) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageContainer({ children, className }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-7', className)}>{children}</div>;
}

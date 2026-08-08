import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-normal',
  {
    variants: {
      tone: {
        default: 'bg-muted text-foreground border-transparent',
        primary: 'bg-primary/10 text-primary border-primary/15',
        secondary: 'bg-secondary/10 text-secondary border-secondary/15',
        success: 'bg-success/10 text-success border-success/15',
        warning: 'bg-warning/10 text-warning border-warning/15',
        danger: 'bg-danger/10 text-danger border-danger/15',
        muted: 'bg-muted text-muted-foreground border-transparent',
        outline: 'bg-transparent text-foreground border-border',
      },
    },
    defaultVariants: { tone: 'default' },
  }
);

export function Badge({ className, tone, ...props }) {
  return <span className={cn(badgeVariants({ tone, className }))} {...props} />;
}

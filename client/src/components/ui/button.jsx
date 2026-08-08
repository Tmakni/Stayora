import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-xs',
        secondary: 'bg-secondary text-secondary-foreground hover:opacity-90 shadow-xs',
        outline: 'border border-border bg-transparent text-foreground hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
        subtle: 'bg-muted text-foreground hover:bg-border/60',
        danger: 'bg-danger text-danger-foreground hover:opacity-90 shadow-xs',
        link: 'text-primary underline-offset-4 hover:underline',
        gradient: 'michel-gradient text-white shadow-sm hover:opacity-95',
      },
      size: {
        default: 'h-9 px-3.5 [&_svg]:size-4',
        sm: 'h-8 px-2.5 text-[13px] [&_svg]:size-3.5',
        lg: 'h-11 px-5 text-[15px] [&_svg]:size-[18px]',
        icon: 'size-9 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const Button = forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = 'Button';

export { Button, buttonVariants };

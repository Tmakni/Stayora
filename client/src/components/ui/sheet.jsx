import { forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

// A bottom/side "sheet" built on Radix Dialog — used for the mobile sidebar
// drawer and bottom-sheet panels (reservation details, iCal event details...).
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetPortal = DialogPrimitive.Portal;

export const SheetOverlay = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[2px] data-[state=open]:animate-fade-in', className)}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

const SIDE_CLASSES = {
  bottom:
    'inset-x-0 bottom-0 rounded-t-xl border-t border-border max-h-[88vh] data-[state=open]:animate-slide-up',
  left: 'inset-y-0 left-0 h-full w-72 border-r border-border',
  right: 'inset-y-0 right-0 h-full w-72 border-l border-border',
};

export const SheetContent = forwardRef(({ className, side = 'bottom', children, hideClose, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col bg-card p-4 shadow-popover focus:outline-none',
        SIDE_CLASSES[side],
        className
      )}
      {...props}
    >
      {side === 'bottom' && (
        <div className="mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-border" aria-hidden="true" />
      )}
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" />
          <span className="sr-only">Fermer</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = 'SheetContent';

export const SheetTitle = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-base font-semibold text-foreground', className)} {...props} />
));
SheetTitle.displayName = 'SheetTitle';

export const SheetDescription = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
SheetDescription.displayName = 'SheetDescription';

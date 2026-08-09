import { NavLink } from 'react-router-dom';
import { MOBILE_NAV_ITEMS } from '../../lib/constants';
import { cn } from '../../lib/utils';

/**
 * Mobile tab bar.
 *
 * Sizing notes:
 *  - `min-w-0` on the links plus `truncate` on the label is what keeps five
 *    tabs inside a 360px viewport. Without it a long label makes the flex row
 *    exceed the screen width and the whole page scrolls sideways.
 *  - `h-14` gives every tab a 56px target, comfortably above the ~44px
 *    minimum, and `pb-safe` lifts it clear of the iPhone home indicator.
 */
export function MobileBottomNav({ className }) {
  return (
    <nav
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-border bg-card/95 px-safe backdrop-blur pb-safe lg:hidden',
        className
      )}
      aria-label="Navigation principale"
    >
      {MOBILE_NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium text-muted-foreground transition-colors',
              isActive && 'text-primary'
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon className={cn('size-5 shrink-0', isActive && 'stroke-[2.25]')} />
              <span className="w-full truncate text-center leading-tight">{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

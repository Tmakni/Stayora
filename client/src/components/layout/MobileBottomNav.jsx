import { NavLink } from 'react-router-dom';
import { MOBILE_NAV_ITEMS } from '../../lib/constants';
import { cn } from '../../lib/utils';

export function MobileBottomNav() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-border bg-card/95 backdrop-blur pb-safe lg:hidden"
      aria-label="Navigation principale"
    >
      {MOBILE_NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'flex min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground transition-colors',
              isActive && 'text-primary'
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon className={cn('size-5', isActive && 'stroke-[2.25]')} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

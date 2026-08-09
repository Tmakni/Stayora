import { useState } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { TopHeader } from './TopHeader';
import { AppSidebar } from './AppSidebar';
import { MobileBottomNav } from './MobileBottomNav';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { MichelMark } from '../shared/MichelMark';
import { NAV_ITEMS } from '../../lib/constants';
import { cn } from '../../lib/utils';

/**
 * Is the mobile viewport showing a single conversation?
 *
 * On phones an open thread takes the whole screen: the tab bar and the app
 * header would otherwise eat ~110px of an already short viewport and push the
 * reply box under the on-screen keyboard. Desktop keeps the three-pane layout,
 * so this only ever applies below `lg`.
 */
function useIsMobileConversationDetail() {
  const location = useLocation();
  // /conversations/:id — the list itself (/conversations) stays chrome-full.
  return /^\/conversations\/[^/]+$/.test(location.pathname);
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const isConversationDetail = useIsMobileConversationDetail();

  return (
    // h-dvh (not h-screen) so the shell tracks the *visible* viewport when the
    // mobile browser chrome and the on-screen keyboard appear.
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <div className={cn(isConversationDetail && 'hidden lg:block')}>
        <TopHeader onOpenMobileNav={() => setMobileNavOpen(true)} />
      </div>

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main
          className={cn(
            'min-w-0 flex-1 overflow-y-auto px-safe lg:pb-0',
            // Clear the fixed tab bar + home indicator, except when the tab bar
            // is hidden for a full-screen thread.
            isConversationDetail ? 'pb-0' : 'pb-nav-safe lg:pb-0'
          )}
        >
          <Outlet />
        </main>
      </div>

      <MobileBottomNav className={cn(isConversationDetail && 'hidden')} />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[min(20rem,85vw)] pb-safe pt-safe">
          <SheetTitle className="flex items-center gap-2">
            <MichelMark className="size-6" /> Michel
          </SheetTitle>
          <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setMobileNavOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-12 items-center gap-3 rounded-md px-3 py-3 text-sm font-medium text-muted-foreground transition-colors',
                    isActive && 'bg-primary/[0.07] text-primary'
                  )
                }
              >
                <item.icon className="size-[18px] shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}

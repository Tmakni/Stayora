import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { TopHeader } from './TopHeader';
import { AppSidebar } from './AppSidebar';
import { MobileBottomNav } from './MobileBottomNav';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { MichelMark } from '../shared/MichelMark';
import { NAV_ITEMS } from '../../lib/constants';
import { cn } from '../../lib/utils';

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopHeader onOpenMobileNav={() => setMobileNavOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <AppSidebar />

        <main className="min-w-0 flex-1 overflow-y-auto pb-16 lg:pb-0">
          <Outlet />
        </main>
      </div>

      <MobileBottomNav />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72">
          <SheetTitle className="flex items-center gap-2">
            <MichelMark className="size-6" /> Michel
          </SheetTitle>
          <nav className="mt-4 flex-1 space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setMobileNavOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors',
                    isActive && 'bg-primary/[0.07] text-primary'
                  )
                }
              >
                <item.icon className="size-[18px]" />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}

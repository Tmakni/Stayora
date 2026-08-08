import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { NAV_ITEMS } from '../../lib/constants';
import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '../ui/tooltip';

const COLLAPSE_KEY = 'michel-sidebar-collapsed';

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');

  function toggle() {
    setCollapsed((prev) => {
      localStorage.setItem(COLLAPSE_KEY, prev ? '0' : '1');
      return !prev;
    });
  }

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        className={cn(
          'hidden h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 lg:flex',
          collapsed ? 'w-[68px]' : 'w-[236px]'
        )}
      >
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2.5">
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </nav>

        <div className="border-t border-border p-2.5">
          <button
            type="button"
            onClick={toggle}
            className="flex w-full items-center justify-center gap-2 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? 'Développer la barre latérale' : 'Réduire la barre latérale'}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : (
              <>
                <ChevronsLeft className="size-4" /> Réduire
              </>
            )}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}

function SidebarLink({ item, collapsed }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          collapsed && 'justify-center px-0',
          isActive && 'bg-primary/[0.07] text-primary hover:bg-primary/[0.09] hover:text-primary'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0'
            )}
          />
          <item.icon className="size-[18px] shrink-0" />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

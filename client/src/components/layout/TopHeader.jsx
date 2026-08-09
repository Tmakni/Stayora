import { Link, useNavigate } from 'react-router-dom';
import { Menu, Bell, LogOut, Settings, ChevronDown } from 'lucide-react';
import { MichelMark } from '../shared/MichelMark';
import { useAuth } from '../../lib/auth.jsx';
import { useMichelActiveStatus } from '../../hooks/useIntegrations';
import { useConversations } from '../../hooks/useConversations';
import { initials, truncate, guestDisplayName } from '../../lib/utils';
import { Button } from '../ui/button';
import { Avatar, AvatarFallback } from '../ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';

export function TopHeader({ onOpenMobileNav }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { active } = useMichelActiveStatus();
  const { data: conversations } = useConversations({ refetchInterval: 30_000 });

  const needsAttention = (conversations || []).filter((c) => c.booking_status === 'inquiry' || c.booking_status === 'request').slice(0, 5);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <header className="sticky top-0 z-40 grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border bg-card/95 px-3 backdrop-blur pt-safe sm:px-4">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Ouvrir le menu">
          <Menu />
        </Button>
      </div>

      {/* Negative margin keeps the visual position identical while giving the
          link a full-height (44px+) tap target on touch devices. */}
      <Link to="/" className="-my-2 flex min-h-11 items-center gap-2 justify-self-center px-2 py-2">
        <MichelMark className="size-6" />
        <span className="text-[15px] font-semibold tracking-tight text-foreground">Michel</span>
      </Link>

      <div className="flex items-center justify-end gap-1.5 sm:gap-2">
        <span
          className="hidden items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline-flex"
          title={active ? 'Michel surveille vos messages en continu' : 'Connectez une intégration pour activer Michel'}
        >
          <span className={`size-1.5 rounded-full ${active ? 'bg-success animate-pulse-dot' : 'bg-muted-foreground/50'}`} />
          {active ? 'Michel est actif' : 'Michel en veille'}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
              <Bell className="size-[18px]" />
              {needsAttention.length > 0 && (
                <span className="absolute right-1.5 top-1.5 flex size-2 rounded-full bg-danger" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80">
            <DropdownMenuLabel>À traiter</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {needsAttention.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">Rien à signaler pour le moment.</div>
            )}
            {needsAttention.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => navigate(`/conversations/${c.id}`)}>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">{guestDisplayName(c)}</span>
                  <span className="text-xs text-muted-foreground">
                    {truncate(c.last_message || 'Nouvelle conversation', 60)}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1 rounded-full p-0.5 pr-1.5 transition-colors hover:bg-muted" aria-label="Menu profil">
              <Avatar className="size-7">
                <AvatarFallback className="bg-primary/10 text-primary">{initials(user?.email)}</AvatarFallback>
              </Avatar>
              <ChevronDown className="hidden size-3.5 text-muted-foreground sm:block" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <DropdownMenuLabel className="truncate font-normal text-foreground">{user?.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/settings')}>
              <Settings /> Paramètres
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem danger onSelect={handleLogout}>
              <LogOut /> Se déconnecter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

import { useMemo, useState } from 'react';
import { Search, Plus, MessageSquare, Mail } from 'lucide-react';
import { ConversationItem } from './ConversationItem';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { ListSkeleton } from '../../components/shared/LoadingSkeleton';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';

export function ConversationList({
  conversations,
  properties,
  activeId,
  onSelect,
  isLoading,
  isError,
  onRetry,
  onNewConversation,
  onConnectGmail,
  className,
}) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.trim().toLowerCase();
    return conversations.filter((c) =>
      [c.guest_name, c.title, c.last_message].filter(Boolean).some((v) => v.toLowerCase().includes(q))
    );
  }, [conversations, search]);

  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">Conversations</h2>
        <Button size="icon-sm" variant="ghost" onClick={onNewConversation} aria-label="Nouvelle conversation">
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="border-b border-border p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un voyageur…"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <ListSkeleton rows={8} />}
        {isError && !isLoading && <ErrorState className="py-10" onRetry={onRetry} />}
        {!isLoading && !isError && filtered.length === 0 && conversations.length > 0 && (
          <EmptyState compact icon={Search} title="Aucun résultat" description="Essayez un autre nom de voyageur." />
        )}
        {!isLoading && !isError && conversations.length === 0 && (
          <EmptyState
            icon={MessageSquare}
            title="Aucune conversation"
            description="Les conversations sont créées automatiquement depuis vos emails Airbnb, Booking ou Gmail."
            action={{ label: 'Connecter Gmail', icon: Mail, onClick: onConnectGmail, variant: 'outline' }}
          />
        )}
        {!isLoading &&
          !isError &&
          filtered.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              properties={properties}
              active={String(c.id) === String(activeId)}
              onClick={() => onSelect(c.id)}
            />
          ))}
      </div>
    </div>
  );
}

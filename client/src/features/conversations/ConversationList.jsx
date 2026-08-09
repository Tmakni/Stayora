import { useEffect, useMemo, useState } from 'react';
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
  hasMore,
  isLoadingMore,
  onLoadMore,
  onNewConversation,
  onConnectGmail,
  className,
}) {
  const [search, setSearch] = useState('');
  // Debounce the query driving the filter (not the input's own value) so fast
  // typing doesn't re-filter/re-render the whole list on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 280);
    return () => clearTimeout(t);
  }, [search]);

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return conversations;
    const q = debouncedSearch.trim().toLowerCase();
    return conversations.filter((c) =>
      [c.guest_name, c.title, c.last_message].filter(Boolean).some((v) => v.toLowerCase().includes(q))
    );
  }, [conversations, debouncedSearch]);

  // O(1) lookup instead of each row doing its own O(n) find() over `properties`
  // on every render (list can be re-rendered often: 20s polling, search, etc).
  const propertiesById = useMemo(() => {
    const map = new Map();
    for (const p of properties || []) map.set(p.id, p);
    return map;
  }, [properties]);

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
              property={propertiesById.get(c.property_id)}
              active={String(c.id) === String(activeId)}
              onSelect={onSelect}
            />
          ))}

        {/* The list is paginated server-side (50 per page). Without this the
            client only ever received the first page and the rest of the
            conversations were unreachable. */}
        {!isLoading && !isError && hasMore && !debouncedSearch.trim() && (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onLoadMore?.()}
              disabled={isLoadingMore}
            >
              {isLoadingMore ? 'Chargement…' : 'Charger plus de conversations'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

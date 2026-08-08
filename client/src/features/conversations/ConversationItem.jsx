import { StatusBadge } from '../../components/shared/StatusBadge';
import { PlatformBadge } from '../../components/shared/PlatformBadge';
import { avatarColor, initials, truncate, formatDate } from '../../lib/utils';
import { isUnread } from '../../lib/readTracking';
import { cn } from '../../lib/utils';

export function ConversationItem({ conversation, active, onClick, properties }) {
  const unread = isUnread(conversation);
  const property = properties?.find((p) => p.id === conversation.property_id);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-border px-3.5 py-3 text-left transition-colors hover:bg-surface-hover',
        active && 'bg-primary/[0.06] hover:bg-primary/[0.07]'
      )}
    >
      <span className={cn('relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarColor(conversation.property_id ?? conversation.id))}>
        {initials(conversation.guest_name || conversation.title)}
        {unread && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-primary" />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={cn('truncate text-[13.5px] text-foreground', unread ? 'font-semibold' : 'font-medium')}>
            {conversation.guest_name || conversation.title}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{formatDate(conversation.updated_at)}</span>
        </span>

        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {truncate(conversation.last_message || 'Nouvelle conversation', 56)}
        </span>

        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <PlatformBadge conversation={conversation} />
          {property && (
            <span className="truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{property.name}</span>
          )}
          <StatusBadge status={conversation.booking_status} className="ml-auto" />
        </span>
      </span>
    </button>
  );
}

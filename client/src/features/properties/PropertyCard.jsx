import { Building2, MapPin, MessageSquare, CalendarCheck2, CalendarX2, Sparkles, Pencil, Trash2 } from 'lucide-react';
import { PLATFORMS, PROPERTY_TYPES } from '../../lib/constants';
import { useICalInfo } from '../../hooks/useCalendar';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export function PropertyCard({ property, conversationCount = 0, onEdit, onDelete }) {
  const icalQuery = useICalInfo(property.id, undefined, undefined);
  const connected = icalQuery.data?.connected;
  const typeLabel = PROPERTY_TYPES.find((t) => t.value === property.property_type)?.label || property.property_type;
  const isAirbnb = property.source === 'airbnb' || !!property.airbnb_listing_id;

  return (
    <div className="group overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-card">
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
        {property.main_photo_url ? (
          <img src={property.main_photo_url} alt={property.name} className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Building2 className="size-8" />
          </div>
        )}
        <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onEdit(property)}
            className="flex size-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
            aria-label="Modifier le logement"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(property)}
            className="flex size-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-danger"
            aria-label="Supprimer le logement"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">{property.name}</h3>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {property.city ? (
            <>
              <MapPin className="size-3" /> {property.city}
              {property.country ? `, ${property.country}` : ''}
            </>
          ) : (
            typeLabel
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {isAirbnb && (
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', PLATFORMS.airbnb.bg, PLATFORMS.airbnb.text)}>Airbnb</span>
          )}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              connected ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
            )}
          >
            {connected ? <CalendarCheck2 className="size-3" /> : <CalendarX2 className="size-3" />}
            {connected ? 'Calendrier connecté' : 'Calendrier non connecté'}
          </span>
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" /> {conversationCount} conversation{conversationCount > 1 ? 's' : ''}
          </span>
          <span className={cn('inline-flex items-center gap-1 font-medium', property.auto_reply_enabled ? 'text-primary' : 'text-muted-foreground')}>
            <Sparkles className="size-3.5" />
            {property.auto_reply_enabled ? 'Michel actif' : 'Manuel'}
          </span>
        </div>

        <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => onEdit(property)}>
          Gérer ce logement
        </Button>
      </div>
    </div>
  );
}

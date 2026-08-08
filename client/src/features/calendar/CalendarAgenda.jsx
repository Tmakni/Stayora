import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { CalendarX2 } from 'lucide-react';
import { getEventConfig } from '../../lib/calendarUtils';
import { EmptyState } from '../../components/shared/EmptyState';
import { cn } from '../../lib/utils';

export function CalendarAgenda({ events, onEventClick }) {
  const grouped = groupByDate(events);

  if (grouped.length === 0) {
    return <EmptyState compact icon={CalendarX2} title="Aucun événement ce mois-ci" description="Réservations et blocages apparaîtront ici." />;
  }

  return (
    <div className="space-y-4">
      {grouped.map(([date, dayEvents]) => (
        <div key={date}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {format(parseISO(date), 'EEEE d MMMM', { locale: fr })}
          </p>
          <div className="space-y-1.5">
            {dayEvents.map((e) => {
              const cfg = getEventConfig(e.type);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onEventClick(e)}
                  className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2.5 text-left"
                >
                  <span className={cn('size-2 shrink-0 rounded-full', cfg.dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{e.title}</span>
                    <span className={cn('text-xs', cfg.text)}>{cfg.label}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function groupByDate(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.start)) map.set(e.start, []);
    map.get(e.start).push(e);
  }
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

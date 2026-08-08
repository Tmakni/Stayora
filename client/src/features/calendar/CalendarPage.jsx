import { useMemo, useState } from 'react';
import { addMonths, subMonths } from 'date-fns';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { PageContainer, PageHeader } from '../../components/shared/PageHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { Button } from '../../components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { Sheet, SheetContent, SheetTitle } from '../../components/ui/sheet';
import { Skeleton } from '../../components/ui/skeleton';
import { CalendarMonthGrid } from './CalendarMonthGrid';
import { CalendarAgenda } from './CalendarAgenda';
import { ICalConnectionCard } from './ICalConnectionCard';
import { useProperties } from '../../hooks/useProperties';
import { usePropertyCalendar, useICalInfo } from '../../hooks/useCalendar';
import { getMonthGridRange, formatISODate, formatMonthLabel, mergeCalendarEvents, getEventConfig } from '../../lib/calendarUtils';
import { formatDateShort } from '../../lib/utils';

export function CalendarPage() {
  const { data: properties, isLoading: propertiesLoading } = useProperties();
  const [propertyId, setPropertyId] = useState('');
  const [monthDate, setMonthDate] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedDayEvents, setSelectedDayEvents] = useState([]);

  const activePropertyId = propertyId || (properties?.[0] ? String(properties[0].id) : '');
  const { from, to, days } = useMemo(() => getMonthGridRange(monthDate), [monthDate]);
  const fromIso = formatISODate(from);
  const toIso = formatISODate(to);

  const calendarQuery = usePropertyCalendar(activePropertyId, fromIso, toIso);
  const icalQuery = useICalInfo(activePropertyId, fromIso, toIso);

  const events = useMemo(
    () => mergeCalendarEvents(calendarQuery.data?.events || [], icalQuery.data?.events || []),
    [calendarQuery.data, icalQuery.data]
  );

  function openDay(day, dayEvents) {
    setSelectedDay(day);
    setSelectedDayEvents(dayEvents);
  }

  const noProperties = !propertiesLoading && (properties || []).length === 0;

  return (
    <PageContainer className="max-w-6xl">
      <PageHeader title="Calendrier" description="Réservations et disponibilités de vos logements." />

      {noProperties ? (
        <EmptyState
          className="mt-6"
          icon={CalendarDays}
          title="Aucun logement"
          description="Ajoutez un logement pour visualiser son calendrier."
        />
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Select value={activePropertyId} onValueChange={setPropertyId}>
              <SelectTrigger className="sm:w-64">
                <SelectValue placeholder="Choisir un logement" />
              </SelectTrigger>
              <SelectContent>
                {(properties || []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <Button variant="outline" size="icon" onClick={() => setMonthDate((d) => subMonths(d, 1))} aria-label="Mois précédent">
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-[130px] text-center text-sm font-semibold capitalize text-foreground">{formatMonthLabel(monthDate)}</span>
              <Button variant="outline" size="icon" onClick={() => setMonthDate((d) => addMonths(d, 1))} aria-label="Mois suivant">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>

          {activePropertyId && (
            <div className="mt-4">
              <ICalConnectionCard propertyId={activePropertyId} from={fromIso} to={toIso} />
            </div>
          )}

          <div className="mt-4">
            {calendarQuery.isLoading ? (
              <Skeleton className="h-96 w-full" />
            ) : (
              <>
                <div className="hidden lg:block">
                  <CalendarMonthGrid days={days} monthDate={monthDate} events={events} onDayClick={openDay} />
                  <Legend />
                </div>
                <div className="lg:hidden">
                  <CalendarAgenda events={events.filter((e) => e.start >= fromIso && e.start <= toIso)} onEventClick={(e) => openDay(null, [e])} />
                </div>
              </>
            )}
          </div>
        </>
      )}

      <Sheet open={!!selectedDayEvents.length} onOpenChange={(open) => !open && setSelectedDayEvents([])}>
        <SheetContent side="bottom" className="max-h-[70vh]">
          <SheetTitle>{selectedDay ? formatDateShort(selectedDay) : 'Détails'}</SheetTitle>
          <div className="mt-3 space-y-2 overflow-y-auto">
            {selectedDayEvents.map((e) => {
              const cfg = getEventConfig(e.type);
              return (
                <div key={e.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${cfg.dot}`} />
                    <span className="text-sm font-semibold text-foreground">{e.title}</span>
                  </div>
                  <p className={`mt-1 text-xs ${cfg.text}`}>{cfg.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Du {formatDateShort(e.start)} au {formatDateShort(e.end)}
                    {e.confirmationCode ? ` · ${e.confirmationCode}` : ''}
                  </p>
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}

function Legend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      {['reservation', 'ical', 'blocked', 'maintenance'].map((type) => {
        const cfg = getEventConfig(type);
        return (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${cfg.dot}`} /> {cfg.label}
          </span>
        );
      })}
    </div>
  );
}

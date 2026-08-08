import { addDays, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, format, isSameMonth, isSameDay, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';

export const EVENT_TYPE_CONFIG = {
  reservation: { label: 'Réservation', dot: 'bg-[#FF5A5F]', bg: 'bg-[#FF5A5F]/10', text: 'text-[#FF5A5F]' },
  ical: { label: 'iCal (réservé)', dot: 'bg-secondary', bg: 'bg-secondary/10', text: 'text-secondary' },
  maintenance: { label: 'Maintenance', dot: 'bg-warning', bg: 'bg-warning/10', text: 'text-warning' },
  blocked: { label: 'Bloqué', dot: 'bg-muted-foreground', bg: 'bg-muted', text: 'text-muted-foreground' },
};

export function getEventConfig(type) {
  return EVENT_TYPE_CONFIG[type] || EVENT_TYPE_CONFIG.blocked;
}

export function getMonthGridRange(monthDate) {
  const from = startOfWeek(startOfMonth(monthDate), { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(monthDate), { weekStartsOn: 1 });
  return { from, to, days: eachDayOfInterval({ start: from, end: to }) };
}

export function formatISODate(date) {
  return format(date, 'yyyy-MM-dd');
}

export function formatMonthLabel(date) {
  return format(date, 'MMMM yyyy', { locale: fr });
}

// Merges the two backend sources into one unified event shape:
// - /api/properties/:id/calendar -> { type: 'reservation'|'blocked'|'maintenance', ... }
// - /api/calendar/:id (iCal)     -> raw rows with no `type` (tagged 'ical' here)
export function mergeCalendarEvents(propertyEvents = [], icalEvents = []) {
  const fromPropertyEndpoint = propertyEvents.map((e) => ({
    id: e.id,
    start: e.start,
    end: e.end,
    type: e.type === 'reservation' ? 'reservation' : e.type === 'maintenance' ? 'maintenance' : 'blocked',
    title: e.title,
    status: e.status,
    confirmationCode: e.confirmationCode,
  }));

  const fromIcal = icalEvents.map((e) => ({
    id: `ical_${e.id}`,
    start: e.start_date,
    end: e.end_date,
    type: 'ical',
    title: e.summary || 'Réservé (iCal)',
    status: e.status,
  }));

  return [...fromPropertyEndpoint, ...fromIcal].sort((a, b) => (a.start < b.start ? -1 : 1));
}

export function eventsForDay(events, day) {
  const iso = formatISODate(day);
  return events.filter((e) => e.start <= iso && e.end > iso);
}

export { addDays, isSameMonth, isSameDay, parseISO };

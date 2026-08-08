import { format } from 'date-fns';
import { getEventConfig, eventsForDay, isSameMonth, formatISODate } from '../../lib/calendarUtils';
import { cn } from '../../lib/utils';

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

export function CalendarMonthGrid({ days, monthDate, events, onDayClick }) {
  const today = formatISODate(new Date());

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border bg-muted/50">
        {WEEKDAYS.map((d) => (
          <div key={d} className="p-2 text-center text-xs font-semibold text-muted-foreground">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const iso = formatISODate(day);
          const dayEvents = eventsForDay(events, day);
          const inMonth = isSameMonth(day, monthDate);
          const isToday = iso === today;

          return (
            <button
              key={iso}
              type="button"
              onClick={() => onDayClick(day, dayEvents)}
              className={cn(
                'flex min-h-[92px] flex-col items-stretch gap-1 border-b border-r border-border p-1.5 text-left transition-colors last:border-r-0 hover:bg-surface-hover',
                !inMonth && 'bg-muted/30 text-muted-foreground/50'
              )}
            >
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-xs font-medium',
                  isToday && 'bg-primary text-primary-foreground'
                )}
              >
                {format(day, 'd')}
              </span>
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                {dayEvents.slice(0, 2).map((e) => {
                  const cfg = getEventConfig(e.type);
                  return (
                    <span key={e.id} className={cn('truncate rounded px-1 py-0.5 text-[10px] font-medium', cfg.bg, cfg.text)}>
                      {e.title}
                    </span>
                  );
                })}
                {dayEvents.length > 2 && <span className="px-1 text-[10px] font-medium text-muted-foreground">+{dayEvents.length - 2} de plus</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

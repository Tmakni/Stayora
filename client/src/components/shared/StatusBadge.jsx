import { Badge } from '../ui/badge';
import { BOOKING_STATUS } from '../../lib/constants';
import { cn } from '../../lib/utils';

export function StatusBadge({ status, className }) {
  const cfg = BOOKING_STATUS[status] || { label: status || 'Inconnu', tone: 'default' };
  return (
    <Badge tone={cfg.tone} className={cn('capitalize', className)}>
      {cfg.label}
    </Badge>
  );
}

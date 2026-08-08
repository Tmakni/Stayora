import { getPlatform, PLATFORMS } from '../../lib/constants';
import { cn } from '../../lib/utils';

export function PlatformBadge({ conversation, platform, className, dotOnly = false }) {
  const key = platform || getPlatform(conversation);
  const cfg = PLATFORMS[key] || PLATFORMS.other;

  if (dotOnly) {
    return <span className={cn('inline-block size-2 rounded-full', cfg.dot, className)} title={cfg.label} />;
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', cfg.bg, cfg.text, className)}>
      <span className={cn('size-1.5 rounded-full', cfg.dot)} />
      {cfg.label}
    </span>
  );
}

import { Sparkles, Send, AlertCircle } from 'lucide-react';
import { cn, formatDate } from '../../lib/utils';

export function ChatMessage({ message }) {
  const { role, content, created_at, metadata } = message;

  if (role === 'system') {
    return (
      <div className="mx-auto flex max-w-[85%] items-start gap-2 rounded-md border border-warning/25 bg-warning/10 px-3 py-2.5 text-sm text-foreground">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <p className="text-xs font-semibold text-warning">Question pour l&apos;hôte</p>
          <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">{content}</p>
        </div>
      </div>
    );
  }

  const isOutgoing = role === 'outgoing';
  const sentViaAirbnb = metadata?.source === 'airbnb_sent';
  const aiGenerated = metadata?.source === 'ai_draft' || metadata?.source === 'ai_generated';

  return (
    <div className={cn('flex flex-col', isOutgoing ? 'items-end' : 'items-start')}>
      <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
        <span className="font-medium">{isOutgoing ? 'Vous' : 'Voyageur'}</span>
        {aiGenerated && (
          <span className="inline-flex items-center gap-0.5 text-primary">
            <Sparkles className="size-3" /> Michel
          </span>
        )}
        {sentViaAirbnb && (
          <span className="inline-flex items-center gap-0.5 text-[#FF5A5F]">
            <Send className="size-3" /> via Airbnb
          </span>
        )}
        <span>· {formatDate(created_at)}</span>
      </div>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-[13.5px] leading-relaxed sm:max-w-[70%]',
          isOutgoing ? 'bg-primary/10 text-foreground' : 'bg-muted text-foreground'
        )}
      >
        {content}
      </div>
    </div>
  );
}

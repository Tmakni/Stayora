import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Info, Loader2, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ChatMessage } from './ChatMessage';
import { AIReplyCard } from './AIReplyCard';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { PlatformBadge } from '../../components/shared/PlatformBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useConversation, useAddMessage, useSendAirbnb } from '../../hooks/useConversations';
import { useGenerateDraft } from '../../hooks/useAI';
import { avatarColor, initials } from '../../lib/utils';
import { markRead } from '../../lib/readTracking';

export function getAirbnbReplyUrl(conversation) {
  if (conversation.airbnb_reply_url) return conversation.airbnb_reply_url;
  if (conversation.airbnb_thread_id) return `https://www.airbnb.com/hosting/inbox/thread/${conversation.airbnb_thread_id}`;
  return 'https://www.airbnb.com/hosting/inbox';
}

export function ConversationThread({ id, onBack, onToggleInfo, extraContext }) {
  const { data, isLoading, isError, refetch } = useConversation(id);
  const addMessage = useAddMessage();
  const sendAirbnb = useSendAirbnb();
  const generateDraft = useGenerateDraft();

  const [composerText, setComposerText] = useState('');
  const [draft, setDraft] = useState(null);
  const [draftText, setDraftText] = useState('');
  const scrollRef = useRef(null);

  const conversation = data?.conversation;
  const messages = useMemo(() => data?.messages || [], [data]);

  useEffect(() => {
    if (id) markRead(id);
    setDraft(null);
    setDraftText('');
    setComposerText('');
  }, [id]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, draft]);

  async function sendMessage(content, { fromDraft = false } = {}) {
    if (!content.trim() || !conversation) return;
    try {
      if (conversation.has_airbnb_api) {
        await sendAirbnb.mutateAsync({ id, message: content.trim() });
        toast.success('Message envoyé via Airbnb');
      } else if (conversation.is_airbnb) {
        await navigator.clipboard?.writeText(content.trim()).catch(() => {});
        await addMessage.mutateAsync({
          id,
          payload: { role: 'outgoing', content: content.trim(), metadata: { source: fromDraft ? 'ai_draft' : 'manual' } },
        });
        window.open(getAirbnbReplyUrl(conversation), '_blank', 'noopener');
        toast.success('Message copié — collez-le dans Airbnb');
      } else {
        await addMessage.mutateAsync({
          id,
          payload: { role: 'outgoing', content: content.trim(), metadata: { source: fromDraft ? 'ai_draft' : 'manual' } },
        });
        toast.success('Réponse enregistrée');
      }
      setComposerText('');
      setDraft(null);
      setDraftText('');
    } catch (err) {
      toast.error(err.message || "Échec de l'envoi");
    }
  }

  async function handleGenerateDraft() {
    if (!conversation) return;
    const lastIncoming = [...messages].reverse().find((m) => m.role === 'incoming');
    let parsedExtra = {};
    if (extraContext?.trim()) {
      try {
        parsedExtra = JSON.parse(extraContext);
      } catch {
        toast.error('Le contexte supplémentaire doit être un JSON valide.');
        return;
      }
    }
    try {
      const result = await generateDraft.mutateAsync({
        conversation_id: Number(id),
        incoming_message: lastIncoming?.content || conversation.title,
        booking_status: conversation.booking_status,
        property_context: parsedExtra,
      });
      setDraft(result);
      setDraftText(result.draft_reply || '');
    } catch (err) {
      toast.error(err.message || 'Impossible de générer une réponse.');
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border p-3">
          <Skeleton className="size-9 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex-1 space-y-3 p-4">
          <Skeleton className="h-16 w-2/3" />
          <Skeleton className="ml-auto h-12 w-1/2" />
          <Skeleton className="h-16 w-2/3" />
        </div>
      </div>
    );
  }

  if (isError || !conversation) {
    return <ErrorState className="h-full" title="Conversation introuvable" onRetry={refetch} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border p-3">
        <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" onClick={onBack} aria-label="Retour">
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColor(
            conversation.property_id ?? conversation.id
          )}`}
        >
          {initials(conversation.guest_name || conversation.title)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{conversation.guest_name || conversation.title}</p>
          <div className="flex items-center gap-1.5">
            <PlatformBadge conversation={conversation} />
            <StatusBadge status={conversation.booking_status} />
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onToggleInfo} aria-label="Afficher les informations">
          <Info className="size-[18px]" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3.5 overflow-y-auto p-3.5" role="log" aria-live="polite">
        {messages.length === 0 && (
          <EmptyState compact icon={Sparkles} title="Aucun message pour le moment" description="Les messages échangés avec ce voyageur apparaîtront ici." />
        )}
        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}
      </div>

      <div className="shrink-0 space-y-2.5 border-t border-border bg-card p-3 pb-safe">
        {draft && (
          <AIReplyCard
            draft={draft}
            text={draftText}
            onTextChange={setDraftText}
            regenerating={generateDraft.isPending}
            sending={addMessage.isPending || sendAirbnb.isPending}
            onRegenerate={handleGenerateDraft}
            onCopy={() => {
              navigator.clipboard?.writeText(draftText).catch(() => {});
              toast.success('Copié dans le presse-papiers');
            }}
            onValidateSend={() => sendMessage(draftText, { fromDraft: true })}
            onClose={() => {
              setDraft(null);
              setDraftText('');
            }}
          />
        )}

        {!draft && (
          <>
            <Textarea
              rows={2}
              placeholder="Écrivez votre réponse…"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              className="resize-none"
            />
            <div className="flex items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={handleGenerateDraft} disabled={generateDraft.isPending}>
                {generateDraft.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Générer un message IA
              </Button>
              <Button
                size="sm"
                onClick={() => sendMessage(composerText)}
                disabled={!composerText.trim() || addMessage.isPending || sendAirbnb.isPending}
              >
                {addMessage.isPending || sendAirbnb.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                Envoyer
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Info, Loader2, Send, Sparkles, ExternalLink, RotateCw, CheckCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { ChatMessage } from './ChatMessage';
import { AIReplyCard } from './AIReplyCard';
import { NoReplyNeededCard } from './NoReplyNeededCard';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { PlatformBadge } from '../../components/shared/PlatformBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { Skeleton } from '../../components/ui/skeleton';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useConversation, useAddMessage, useSendAirbnb, useSendReply, useReplyStatus, useRetryReply } from '../../hooks/useConversations';
import { useGenerateDraft } from '../../hooks/useAI';
import { avatarColor, initials, guestDisplayName } from '../../lib/utils';
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
  const sendReply = useSendReply();
  const retryReply = useRetryReply();
  const generateDraft = useGenerateDraft();
  const replyStatus = useReplyStatus(id);

  const [composerText, setComposerText] = useState('');
  const [draft, setDraft] = useState(null);
  const [draftText, setDraftText] = useState('');
  // Verdict « ce fil n'attend pas de réponse ». Tenu à part du brouillon : les
  // deux s'excluent, et le serveur ne renvoie jamais les deux à la fois.
  const [noReply, setNoReply] = useState(null);
  const scrollRef = useRef(null);

  // Synchronous double-submit guards. `isPending` is React state and only
  // flips on the NEXT render, so two taps in the same frame — routine on a
  // phone — both get through. For the Airbnb path that means the guest
  // genuinely receives the message twice (unlike addMessage, the send-to-Airbnb
  // endpoint has no server-side duplicate check).
  const sendingRef = useRef(false);
  const generatingRef = useRef(false);

  const conversation = data?.conversation;
  const messages = useMemo(() => data?.messages || [], [data]);

  // Can we answer by replying to the Airbnb notification mail? The server
  // decides — it is the only side that knows whether a usable Reply-To was
  // captured and whether the Gmail token carries the send scope.
  const canReplyByEmail = replyStatus.data?.can_reply === true;
  const needsReauthorization = replyStatus.data?.needs_reauthorization === true;
  const needsResync = replyStatus.data?.needs_resync === true;
  const delivery = replyStatus.data?.latest || null;
  const isDelivering = delivery?.status === 'pending' || delivery?.status === 'sending';

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
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      // Preferred path: reply to the Airbnb notification straight from the
      // host's Gmail. One button, no redirect to Airbnb or Gmail — the message
      // lands in the right Airbnb conversation because Airbnb routes the mail
      // back through its per-thread Reply-To address.
      if (canReplyByEmail) {
        const result = await sendReply.mutateAsync({ id, message: content.trim() });
        if (result?.duplicate) {
          toast.info(result.message || 'Une réponse à ce message est déjà en cours.');
        } else {
          toast.success('Envoi en cours vers Airbnb…');
        }
      } else if (conversation.has_airbnb_api) {
        await sendAirbnb.mutateAsync({ id, message: content.trim() });
        toast.success('Message envoyé via Airbnb');
      } else if (conversation.is_airbnb) {
        // Legacy fallback, only when e-mail replying is unavailable.
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
      if (err.data?.needs_reauthorization) {
        toast.error("Autorisation d'envoi Gmail manquante — reconnectez votre compte dans Intégrations.");
      } else {
        toast.error(err.message || "Échec de l'envoi");
      }
    } finally {
      sendingRef.current = false;
    }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.force] l'hôte a lu le verdict « aucune réponse
   *   nécessaire » et demande un brouillon malgré tout.
   */
  async function handleGenerateDraft({ force = false } = {}) {
    if (!conversation) return;
    // Each call is a billed model request — never let a double tap fire two.
    if (generatingRef.current) return;
    generatingRef.current = true;
    const lastIncoming = [...messages].reverse().find((m) => m.role === 'incoming');
    let parsedExtra = {};
    if (extraContext?.trim()) {
      try {
        parsedExtra = JSON.parse(extraContext);
      } catch {
        toast.error('Le contexte supplémentaire doit être un JSON valide.');
        // Release the guard on this early exit, otherwise the button stays
        // permanently dead for the rest of the session.
        generatingRef.current = false;
        return;
      }
    }
    try {
      const result = await generateDraft.mutateAsync({
        conversation_id: Number(id),
        incoming_message: lastIncoming?.content || conversation.title,
        booking_status: conversation.booking_status,
        property_context: parsedExtra,
        force,
      });

      // Le serveur a jugé qu'il n'y avait rien à répondre : pas de brouillon,
      // un motif. On n'ouvre PAS la carte de suggestion — il n'y a rien dedans,
      // et une zone de texte vide sous un bouton « Envoyer » n'aide personne.
      if (result.reply_needed === false) {
        setDraft(null);
        setDraftText('');
        setNoReply(result);
        return;
      }

      setNoReply(null);
      setDraft(result);
      setDraftText(result.draft_reply || '');
    } catch (err) {
      toast.error(err.message || 'Impossible de générer une réponse.');
    } finally {
      generatingRef.current = false;
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
      {/* On mobile this thread is full-screen (AppShell hides the app header and
          tab bar), so the thread header carries the top safe-area inset itself. */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-card p-3 pt-safe lg:pt-3">
        <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" onClick={onBack} aria-label="Retour">
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColor(
            conversation.property_id ?? conversation.id
          )}`}
        >
          {initials(guestDisplayName(conversation))}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{guestDisplayName(conversation)}</p>
          {/* Le logement concerné, sous le nom du voyageur. Ce sont les deux
              seules choses à savoir pour répondre, et l'en-tête ne portait que
              la première : sur un compte à plusieurs logements, il fallait
              ouvrir le panneau d'informations pour savoir de quel logement on
              parlait. Vient du serveur avec la conversation, donc jamais
              recoupé à l'écran et jamais celui d'un autre compte. */}
          {conversation.property_name && (
            <p className="truncate text-xs text-muted-foreground">{conversation.property_name}</p>
          )}
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
        {/* Delivery state of the last queued reply. Only shown when there is
            something to say, so the composer stays uncluttered on a phone. */}
        {delivery && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {isDelivering && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-1 font-medium text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {delivery.status === 'pending' ? 'En attente' : 'Envoi…'}
              </span>
            )}
            {delivery.status === 'sent' && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-1 font-medium text-success">
                <CheckCheck className="size-3" />
                Envoyé sur Airbnb
              </span>
            )}
            {delivery.status === 'failed' && (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-2 py-1 font-medium text-danger">
                  <AlertTriangle className="size-3" />
                  Échec de l&apos;envoi
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={async () => {
                    try {
                      // Re-arms the same queue row — pressing this repeatedly
                      // can never produce a second message.
                      await retryReply.mutateAsync({ id, queueId: delivery.id });
                      toast.success('Nouvelle tentative lancée');
                    } catch (err) {
                      toast.error(err.message || 'Impossible de réessayer');
                    }
                  }}
                  disabled={retryReply.isPending}
                >
                  {retryReply.isPending ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
                  Réessayer
                </Button>
              </>
            )}
            {delivery.mode === 'auto' && delivery.status === 'sent' && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                Envoyé automatiquement par Michel
              </span>
            )}
            {delivery.status === 'failed' && delivery.error && (
              <span className="w-full truncate text-muted-foreground" title={delivery.error}>
                {delivery.error}
              </span>
            )}
          </div>
        )}

        {/* Why the one-click send is unavailable, and what to do about it. */}
        {!canReplyByEmail && (needsReauthorization || needsResync) && (
          <p className="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-foreground">
            {needsReauthorization
              ? "Pour envoyer directement depuis Michel, reconnectez votre compte Gmail (Intégrations → Réautoriser) afin d'autoriser l'envoi."
              : "Les en-têtes de réponse ne sont pas encore enregistrés pour cette conversation. Lancez une synchronisation Gmail."}
          </p>
        )}

        {draft && (
          <AIReplyCard
            draft={draft}
            text={draftText}
            onTextChange={setDraftText}
            regenerating={generateDraft.isPending}
            sending={addMessage.isPending || sendAirbnb.isPending}
            // Régénérer relance la vérification : si l'hôte a répondu
            // entre-temps, il doit le savoir plutôt que recevoir un brouillon.
            onRegenerate={() => handleGenerateDraft()}
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

        {noReply && !draft && (
          <NoReplyNeededCard
            verdict={noReply}
            generating={generateDraft.isPending}
            onForce={() => handleGenerateDraft({ force: true })}
            onClose={() => setNoReply(null)}
          />
        )}

        {!draft && (
          <>
            <Textarea
              rows={2}
              placeholder="Écrivez votre réponse…"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              className="max-h-40 resize-none"
              enterKeyHint="enter"
            />
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                className="min-w-0 flex-1 sm:flex-none"
                onClick={() => handleGenerateDraft()}
                disabled={generateDraft.isPending}
              >
                {generateDraft.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {/* The full label does not fit next to "Envoyer" at 360px. */}
                <span className="truncate sm:hidden">Message IA</span>
                <span className="hidden truncate sm:inline">Générer un message IA</span>
              </Button>
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => sendMessage(composerText)}
                disabled={
                  !composerText.trim() || addMessage.isPending || sendAirbnb.isPending || sendReply.isPending
                }
              >
                {addMessage.isPending || sendAirbnb.isPending || sendReply.isPending
                  ? <Loader2 className="animate-spin" />
                  : <Send />}
                {canReplyByEmail ? 'Envoyer sur Airbnb' : 'Envoyer'}
              </Button>
            </div>

            {/* Secondary escape hatch — kept because the Airbnb link is still
                useful, but it is no longer the way a reply is sent. */}
            {conversation.is_airbnb && (
              <a
                href={getAirbnbReplyUrl(conversation)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                <ExternalLink className="size-3.5" />
                Ouvrir dans Airbnb
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { ConversationList } from './ConversationList';
import { ConversationThread } from './ConversationThread';
import { ReservationDetails } from './ReservationDetails';
import { NewConversationDialog } from './NewConversationDialog';
import { EmptyState } from '../../components/shared/EmptyState';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '../../components/ui/sheet';
import { useConversations, useConversation } from '../../hooks/useConversations';
import { useProperties } from '../../hooks/useProperties';
import { cn } from '../../lib/utils';

export function ConversationsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const conversationsQuery = useConversations();
  const propertiesQuery = useProperties();
  const detailQuery = useConversation(id);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [infoSheetOpen, setInfoSheetOpen] = useState(false);
  const [extraContext, setExtraContext] = useState('');

  useEffect(() => {
    setExtraContext('');
  }, [id]);

  function handleToggleInfo() {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setInfoSheetOpen(true);
    } else {
      setInfoOpen((v) => !v);
    }
  }

  // Stable reference so ConversationList's memoized rows don't all re-render
  // just because ConversationsPage re-rendered (e.g. on every polling refetch).
  const handleSelectConversation = useCallback((cid) => navigate(`/conversations/${cid}`), [navigate]);

  return (
    <div className="flex h-full">
      <div className={cn('w-full shrink-0 lg:block lg:w-[340px] lg:border-r lg:border-border', id && 'hidden lg:block')}>
        <ConversationList
          conversations={conversationsQuery.data || []}
          properties={propertiesQuery.data || []}
          activeId={id}
          isLoading={conversationsQuery.isLoading}
          isError={conversationsQuery.isError}
          onRetry={conversationsQuery.refetch}
          hasMore={conversationsQuery.hasNextPage}
          isLoadingMore={conversationsQuery.isFetchingNextPage}
          onLoadMore={conversationsQuery.fetchNextPage}
          onSelect={handleSelectConversation}
          onNewConversation={() => setNewDialogOpen(true)}
          onConnectGmail={() => navigate('/integrations')}
        />
      </div>

      <div className={cn('min-w-0 flex-1', !id && 'hidden lg:flex lg:flex-col')}>
        {id ? (
          <ConversationThread id={id} onBack={() => navigate('/conversations')} onToggleInfo={handleToggleInfo} extraContext={extraContext} />
        ) : (
          <EmptyState
            className="flex h-full flex-col items-center justify-center"
            icon={MessageSquare}
            title="Sélectionnez une conversation"
            description="Choisissez un voyageur dans la liste pour afficher l'échange."
          />
        )}
      </div>

      {id && infoOpen && (
        <div className="hidden w-[300px] shrink-0 border-l border-border lg:block">
          <ReservationDetails
            conversation={detailQuery.data?.conversation}
            onClose={() => setInfoOpen(false)}
            extraContext={extraContext}
            onExtraContextChange={setExtraContext}
          />
        </div>
      )}

      <Sheet open={infoSheetOpen} onOpenChange={setInfoSheetOpen}>
        <SheetContent side="bottom" className="h-[82vh] p-0">
          <SheetTitle className="sr-only">Informations de la réservation</SheetTitle>
          <SheetDescription className="sr-only">Détails du voyageur, du logement et de la réservation.</SheetDescription>
          <ReservationDetails
            conversation={detailQuery.data?.conversation}
            onClose={() => setInfoSheetOpen(false)}
            extraContext={extraContext}
            onExtraContextChange={setExtraContext}
          />
        </SheetContent>
      </Sheet>

      <NewConversationDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} onCreated={(newId) => navigate(`/conversations/${newId}`)} />
    </div>
  );
}

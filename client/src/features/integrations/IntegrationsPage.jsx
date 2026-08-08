import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CalendarClock } from 'lucide-react';
import { PageContainer, PageHeader } from '../../components/shared/PageHeader';
import { IntegrationCard } from '../../components/shared/IntegrationCard';
import { Skeleton } from '../../components/ui/skeleton';
import {
  useGmailAccounts,
  useAirbnbAccounts,
  useGmailAuthUrl,
  useRemoveGmailAccount,
  useReauthorizeGmail,
  useFullSyncAirbnb,
  useRemoveAirbnbAccount,
} from '../../hooks/useIntegrations';

export function IntegrationsPage() {
  const navigate = useNavigate();
  const gmailQuery = useGmailAccounts();
  const airbnbQuery = useAirbnbAccounts();

  const gmailAuthUrl = useGmailAuthUrl();
  const removeGmail = useRemoveGmailAccount();
  const reauthorizeGmail = useReauthorizeGmail();
  const fullSyncAirbnb = useFullSyncAirbnb();
  const removeAirbnb = useRemoveAirbnbAccount();

  const gmailAccounts = gmailQuery.data?.accounts || [];
  const airbnbAccounts = airbnbQuery.data?.accounts || [];
  const gmailConnected = gmailAccounts.some((a) => a.is_active);
  const loading = gmailQuery.isLoading || airbnbQuery.isLoading;

  async function handleConnectGmail() {
    try {
      const { url } = await gmailAuthUrl.mutateAsync();
      window.location.href = url;
    } catch (err) {
      toast.error(err.message || 'Impossible de démarrer la connexion Gmail.');
    }
  }

  async function handleReauthorizeGmail(accountId) {
    try {
      const { url } = await reauthorizeGmail.mutateAsync(accountId);
      window.location.href = url;
    } catch (err) {
      toast.error(err.message || 'Échec de la réautorisation.');
    }
  }

  async function handleRemoveGmail(accountId) {
    try {
      await removeGmail.mutateAsync(accountId);
      toast.success('Compte Gmail déconnecté');
    } catch (err) {
      toast.error(err.message || 'Échec de la suppression.');
    }
  }

  async function handleSyncAirbnb(accountId) {
    try {
      await fullSyncAirbnb.mutateAsync(accountId);
      toast.success('Synchronisation Airbnb lancée');
    } catch (err) {
      toast.error(err.message || 'Échec de la synchronisation.');
    }
  }

  async function handleRemoveAirbnb(accountId) {
    try {
      await removeAirbnb.mutateAsync(accountId);
      toast.success('Compte Airbnb déconnecté');
    } catch (err) {
      toast.error(err.message || 'Échec de la suppression.');
    }
  }

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader title="Intégrations" description="Connectez vos canaux pour que Michel centralise vos conversations." />

      {loading ? (
        <div className="mt-5 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {gmailAccounts.length === 0 ? (
            <IntegrationCard
              icon="✉️"
              name="Gmail"
              statusLabel="Non connecté"
              tone="muted"
              description="Recevez et synchronisez automatiquement les messages Airbnb, Booking et Vrbo qui arrivent dans votre boîte Gmail."
              actions={[{ label: 'Connecter Gmail', onClick: handleConnectGmail, variant: 'default', loading: gmailAuthUrl.isPending }]}
            />
          ) : (
            gmailAccounts.map((acc) => (
              <IntegrationCard
                key={acc.id}
                icon="✉️"
                name={`Gmail — ${acc.email}`}
                statusLabel={acc.sync_status === 'error' ? 'Erreur' : acc.is_active ? 'Connecté' : 'Inactif'}
                tone={acc.sync_status === 'error' ? 'danger' : acc.is_active ? 'success' : 'muted'}
                description="Synchronisation automatique des messages voyageurs toutes les 60 secondes."
                lastSyncAt={acc.last_sync_at}
                errorMessage={acc.sync_status === 'error' ? acc.sync_error || 'Le token a peut-être expiré — réautorisez le compte.' : null}
                actions={[
                  ...(acc.sync_status === 'error'
                    ? [{ label: 'Réautoriser', onClick: () => handleReauthorizeGmail(acc.id), variant: 'default', loading: reauthorizeGmail.isPending }]
                    : []),
                  { label: 'Déconnecter', onClick: () => handleRemoveGmail(acc.id), variant: 'outline', loading: removeGmail.isPending, className: 'text-danger' },
                ]}
              />
            ))
          )}

          <IntegrationCard
            icon="🅰️"
            name="Airbnb"
            statusLabel={airbnbAccounts.some((a) => a.is_active) ? 'Connecté' : 'Non connecté'}
            tone={airbnbAccounts.some((a) => a.is_active) ? 'success' : 'muted'}
            description={
              airbnbAccounts.length > 0
                ? `${airbnbAccounts.length} compte(s) lié(s) pour la synchronisation des messages et réservations.`
                : "Importez vos logements depuis Airbnb pour démarrer — c'est ce qui active la centralisation des messages."
            }
            lastSyncAt={airbnbAccounts[0]?.last_sync_at}
            errorMessage={airbnbAccounts.find((a) => a.sync_status === 'error')?.sync_error}
            actions={
              airbnbAccounts.length > 0
                ? [
                    { label: 'Synchroniser', onClick: () => handleSyncAirbnb(airbnbAccounts[0].id), loading: fullSyncAirbnb.isPending },
                    { label: 'Déconnecter', onClick: () => handleRemoveAirbnb(airbnbAccounts[0].id), loading: removeAirbnb.isPending, className: 'text-danger' },
                  ]
                : [{ label: 'Importer mes logements', onClick: () => navigate('/properties', { state: { openAdd: true } }), variant: 'default' }]
            }
          />

          <IntegrationCard
            icon="🅱️"
            name="Booking.com"
            statusLabel={gmailConnected ? 'Détection automatique via Gmail' : 'Connectez Gmail'}
            tone={gmailConnected ? 'success' : 'warning'}
            description="Booking.com n'a pas d'API de connexion directe : les messages voyageurs sont détectés automatiquement dans votre Gmail connecté."
            actions={!gmailConnected ? [{ label: 'Connecter Gmail', onClick: handleConnectGmail, loading: gmailAuthUrl.isPending }] : []}
          />

          <IntegrationCard
            icon="🏡"
            name="Vrbo"
            statusLabel={gmailConnected ? 'Détection automatique via Gmail' : 'Connectez Gmail'}
            tone={gmailConnected ? 'success' : 'warning'}
            description="Comme Booking.com, les messages Vrbo sont détectés automatiquement via votre Gmail connecté."
            actions={!gmailConnected ? [{ label: 'Connecter Gmail', onClick: handleConnectGmail, loading: gmailAuthUrl.isPending }] : []}
          />

          <IntegrationCard
            icon={<CalendarClock className="size-5 text-muted-foreground" />}
            name="Calendrier iCal"
            statusLabel="Par logement"
            tone="muted"
            description="Chaque logement peut être connecté à son propre calendrier iCal (Airbnb, Booking, Vrbo…) depuis la page Calendrier."
            actions={[{ label: 'Gérer les calendriers', onClick: () => navigate('/calendar') }]}
          />
        </div>
      )}
    </PageContainer>
  );
}

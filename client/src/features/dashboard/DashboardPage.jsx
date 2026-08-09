import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  AlertTriangle,
  ClipboardList,
  Clock,
  Wand2,
  CalendarDays,
  PlusCircle,
  Building2,
  Info,
} from 'lucide-react';
import { PageContainer } from '../../components/shared/PageHeader';
import { MetricCard } from '../../components/shared/MetricCard';
import { PriorityTaskCard } from '../../components/shared/PriorityTaskCard';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { PlatformBadge } from '../../components/shared/PlatformBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { MetricCardsSkeleton, ListSkeleton } from '../../components/shared/LoadingSkeleton';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '../../components/ui/tooltip';
import { useAuth } from '../../lib/auth.jsx';
import { useConversations } from '../../hooks/useConversations';
import { useProperties } from '../../hooks/useProperties';
import { useMichelActiveStatus } from '../../hooks/useIntegrations';
import { buildDashboardInsights, formatMinutes } from '../../lib/insights';
import { avatarColor, initials, truncate, formatDate, guestDisplayName } from '../../lib/utils';

export function DashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { active: michelActive } = useMichelActiveStatus();
  const conversationsQuery = useConversations();
  const propertiesQuery = useProperties();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';

  const insights = useMemo(
    () => buildDashboardInsights(conversationsQuery.data || [], propertiesQuery.data || []),
    [conversationsQuery.data, propertiesQuery.data]
  );

  const loading = conversationsQuery.isLoading || propertiesQuery.isLoading;
  const error = conversationsQuery.isError || propertiesQuery.isError;
  const noData = !loading && (propertiesQuery.data || []).length === 0 && (conversationsQuery.data || []).length === 0;

  function handleGenerateReply() {
    const target = insights.urgent[0] || insights.pending[0];
    navigate(target ? `/conversations/${target.id}` : '/conversations');
  }

  return (
    <PageContainer className="max-w-6xl">
      <div className="rounded-lg border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Espace de {user?.email?.split('@')[0] || 'l\u2019hôte'}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {greeting}, voici ce que Michel a géré aujourd&apos;hui
            </h1>
            <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <span className={`size-1.5 rounded-full ${michelActive ? 'bg-success animate-pulse-dot' : 'bg-muted-foreground/50'}`} />
              {michelActive ? 'Michel est actif' : 'Michel en veille — connectez une intégration'}
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5 sm:flex sm:flex-wrap">
          <QuickAction icon={AlertTriangle} label="Messages urgents" onClick={() => navigate('/conversations')} />
          <QuickAction icon={Wand2} label="Générer une réponse" onClick={handleGenerateReply} />
          <QuickAction icon={CalendarDays} label="Vérifier le calendrier" onClick={() => navigate('/calendar')} />
          <QuickAction icon={PlusCircle} label="Ajouter un logement" onClick={() => navigate('/properties', { state: { openAdd: true } })} />
        </div>
      </div>

      {error && <ErrorState className="mt-6" onRetry={() => { conversationsQuery.refetch(); propertiesQuery.refetch(); }} />}

      {!error && noData && (
        <EmptyState
          className="mt-6"
          icon={Sparkles}
          title="Bienvenue sur Michel"
          description="Ajoutez votre premier logement et connectez Gmail ou Airbnb pour que Michel commence à préparer vos réponses."
          action={{ label: 'Ajouter un logement', icon: PlusCircle, onClick: () => navigate('/properties', { state: { openAdd: true } }) }}
        />
      )}

      {!error && !noData && (
        <>
          <section className="mt-6">
            <h2 className="mb-2.5 text-sm font-semibold text-foreground">À traiter maintenant</h2>
            {loading ? (
              <ListSkeleton rows={3} />
            ) : (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <PriorityTaskCard
                  icon={ClipboardList}
                  tone="primary"
                  title="Réponses à valider"
                  count={insights.pending.length}
                  description={insights.pending[0] ? `${guestDisplayName(insights.pending[0])}` : 'Aucune en attente'}
                  onClick={() => navigate('/conversations')}
                />
                <PriorityTaskCard
                  icon={AlertTriangle}
                  tone="danger"
                  title="Messages urgents"
                  count={insights.urgent.length}
                  description={insights.urgent[0] ? 'En attente depuis plus de 6h' : 'Rien d\u2019urgent'}
                  onClick={() => navigate(insights.urgent[0] ? `/conversations/${insights.urgent[0].id}` : '/conversations')}
                />
                <PriorityTaskCard
                  icon={Building2}
                  tone="warning"
                  title="Informations manquantes"
                  count={insights.incompleteProperties.length}
                  description={insights.incompleteProperties[0] ? insights.incompleteProperties[0].name : 'Profils complets'}
                  onClick={() => navigate('/properties')}
                />
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="mb-2.5 flex items-center gap-1.5">
              <h2 className="text-sm font-semibold text-foreground">Vue d&apos;ensemble</h2>
            </div>
            {loading ? (
              <MetricCardsSkeleton />
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MetricCard icon={Sparkles} tone="primary" label="Réponses auto actives" value={insights.activeAutoReply} hint="Logements avec IA activée" />
                <MetricCard icon={ClipboardList} tone="secondary" label="Conversations à valider" value={insights.pending.length} hint="Inquiry / demande" />
                <MetricCard
                  icon={Clock}
                  tone="success"
                  label={
                    <span className="inline-flex items-center gap-1">
                      Temps de réponse moyen
                      <InfoHint text="Estimation basée sur l'activité récente des conversations, pas une mesure exacte." />
                    </span>
                  }
                  value={formatMinutes(insights.avgResponseMinutes)}
                  hint="Estimation"
                />
                <MetricCard icon={AlertTriangle} tone="danger" label="Nécessite une intervention" value={insights.urgent.length} hint="Sans réponse depuis 6h+" />
              </div>
            )}
          </section>

          <section className="mt-6 pb-4">
            <h2 className="mb-2.5 text-sm font-semibold text-foreground">Activité récente de Michel</h2>
            {loading ? (
              <div className="rounded-lg border border-border bg-card">
                <ListSkeleton rows={4} />
              </div>
            ) : insights.recentActivity.length === 0 ? (
              <EmptyState compact icon={ClipboardList} title="Aucune activité récente" />
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {insights.recentActivity.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/conversations/${c.id}`)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${avatarColor(c.id)}`}>
                      {initials(guestDisplayName(c))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{guestDisplayName(c)}</span>
                        <PlatformBadge conversation={c} dotOnly />
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">{truncate(c.last_message || 'Nouvelle conversation', 70)}</span>
                    </span>
                    <span className="hidden shrink-0 sm:block">
                      <StatusBadge status={c.booking_status} />
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDate(c.updated_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </PageContainer>
  );
}

function QuickAction({ icon: Icon, label, onClick }) {
  return (
    <Button variant="outline" size="sm" className="justify-start gap-2 bg-card" onClick={onClick}>
      <Icon className="size-4 text-primary" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function InfoHint({ text }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="size-3 cursor-help text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px]">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

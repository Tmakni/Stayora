import { toast } from 'sonner';
import { Zap, Building2 } from 'lucide-react';
import { PageContainer, PageHeader } from '../../components/shared/PageHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { ListSkeleton } from '../../components/shared/LoadingSkeleton';
import { MetricCard } from '../../components/shared/MetricCard';
import { Switch } from '../../components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { useProperties, useUpdateProperty } from '../../hooks/useProperties';
import { REPLY_TONES } from '../../lib/constants';

export function AutomationsPage() {
  const propertiesQuery = useProperties();
  const updateProperty = useUpdateProperty();

  const properties = propertiesQuery.data || [];
  const activeCount = properties.filter((p) => p.auto_reply_enabled).length;

  async function toggleAutoReply(property, enabled) {
    try {
      await updateProperty.mutateAsync({ id: property.id, payload: { auto_reply_enabled: enabled } });
      toast.success(enabled ? `Réponses automatiques activées pour ${property.name}` : `Réponses automatiques désactivées pour ${property.name}`);
    } catch (err) {
      toast.error(err.message || 'Échec de la mise à jour.');
    }
  }

  async function changeTone(property, tone) {
    try {
      await updateProperty.mutateAsync({ id: property.id, payload: { reply_tone: tone } });
      toast.success('Ton de réponse mis à jour');
    } catch (err) {
      toast.error(err.message || 'Échec de la mise à jour.');
    }
  }

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader title="Automatisations" description="Pilotez les réponses automatiques de Michel, logement par logement." />

      {propertiesQuery.isLoading ? (
        <div className="mt-5">
          <ListSkeleton rows={4} />
        </div>
      ) : propertiesQuery.isError ? (
        <ErrorState className="mt-5" onRetry={propertiesQuery.refetch} />
      ) : properties.length === 0 ? (
        <EmptyState className="mt-5" icon={Building2} title="Aucun logement" description="Ajoutez un logement pour configurer ses automatisations." />
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:max-w-sm">
            <MetricCard icon={Zap} tone="primary" label="Logements automatisés" value={`${activeCount}/${properties.length}`} />
          </div>

          <div className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
            {properties.map((p) => (
              <div key={p.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground">{p.auto_reply_enabled ? 'Michel prépare des réponses automatiquement' : 'Réponses manuelles uniquement'}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {p.auto_reply_enabled && (
                    <Select value={p.reply_tone || 'professional'} onValueChange={(v) => changeTone(p, v)}>
                      <SelectTrigger className="h-8 w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {REPLY_TONES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Switch checked={!!p.auto_reply_enabled} onCheckedChange={(v) => toggleAutoReply(p, v)} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </PageContainer>
  );
}

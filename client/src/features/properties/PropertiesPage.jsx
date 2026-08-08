import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, Plus, Download } from 'lucide-react';
import { PageContainer, PageHeader } from '../../components/shared/PageHeader';
import { EmptyState } from '../../components/shared/EmptyState';
import { ErrorState } from '../../components/shared/ErrorState';
import { CardGridSkeleton } from '../../components/shared/LoadingSkeleton';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog';
import { Button } from '../../components/ui/button';
import { PropertyCard } from './PropertyCard';
import { PropertyFormDialog } from './PropertyFormDialog';
import { AirbnbImportDialog } from './AirbnbImportDialog';
import { useProperties, useDeleteProperty } from '../../hooks/useProperties';
import { useConversations } from '../../hooks/useConversations';

export function PropertiesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const propertiesQuery = useProperties();
  const conversationsQuery = useConversations();
  const deleteProperty = useDeleteProperty();

  const [formOpen, setFormOpen] = useState(false);
  const [editingProperty, setEditingProperty] = useState(null);
  const [importedData, setImportedData] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    if (location.state?.openAdd) {
      setImportOpen(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, location.pathname, navigate]);

  const conversationCounts = useMemo(() => {
    const counts = {};
    for (const c of conversationsQuery.data || []) {
      if (c.property_id) counts[c.property_id] = (counts[c.property_id] || 0) + 1;
    }
    return counts;
  }, [conversationsQuery.data]);

  function openCreateDialog() {
    setEditingProperty(null);
    setImportedData(null);
    setFormOpen(true);
  }

  function openEditDialog(property) {
    setEditingProperty(property);
    setImportedData(null);
    setFormOpen(true);
  }

  function handleImported(result) {
    setEditingProperty(null);
    setImportedData(result);
    setFormOpen(true);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteProperty.mutateAsync(deleteTarget.id);
      toast.success('Logement supprimé');
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err.message || 'Échec de la suppression.');
    }
  }

  const properties = propertiesQuery.data || [];

  return (
    <PageContainer>
      <PageHeader
        title="Mes logements"
        description="Centralisez les informations utiles de chaque logement pour des réponses IA fiables."
        actions={
          <Button size="sm" onClick={() => setImportOpen(true)}>
            <Download className="size-4" /> Importer depuis Airbnb
          </Button>
        }
      />

      <div className="mt-5">
        {propertiesQuery.isLoading && <CardGridSkeleton />}

        {propertiesQuery.isError && <ErrorState onRetry={propertiesQuery.refetch} />}

        {!propertiesQuery.isLoading && !propertiesQuery.isError && properties.length === 0 && (
          <EmptyState
            icon={Building2}
            title="Aucun logement"
            description="Importez votre logement depuis Airbnb ou ajoutez-le manuellement."
            action={{ label: 'Importer depuis Airbnb', icon: Download, onClick: () => setImportOpen(true) }}
          />
        )}

        {!propertiesQuery.isLoading && !propertiesQuery.isError && properties.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {properties.map((p) => (
                <PropertyCard
                  key={p.id}
                  property={p}
                  conversationCount={conversationCounts[p.id] || 0}
                  onEdit={openEditDialog}
                  onDelete={setDeleteTarget}
                />
              ))}
              <button
                type="button"
                onClick={openCreateDialog}
                className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <Plus className="size-5" />
                Ajouter manuellement
              </button>
            </div>
          </>
        )}
      </div>

      <AirbnbImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleImported} />

      <PropertyFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        property={editingProperty}
        imported={importedData}
        onSaved={() => {
          setEditingProperty(null);
          setImportedData(null);
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Supprimer ce logement ?"
        description={`« ${deleteTarget?.name} » sera définitivement supprimé. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        danger
        loading={deleteProperty.isPending}
        onConfirm={confirmDelete}
      />
    </PageContainer>
  );
}

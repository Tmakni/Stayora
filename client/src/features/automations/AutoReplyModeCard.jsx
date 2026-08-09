import { toast } from 'sonner';
import { ShieldCheck, Bot, OctagonX, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { useAutoReplySettings, useUpdateAutoReplySettings } from '../../hooks/useConversations';
import { cn } from '../../lib/utils';

/**
 * Sending mode: manual validation vs 24/7 automatic, plus the emergency stop.
 *
 * Automatic is off by default and has to be turned on deliberately — the whole
 * point of this card is that the state is impossible to misread, because the
 * consequence of being wrong is a message going to a real guest unattended.
 */
export function AutoReplyModeCard({ properties = [] }) {
  const settingsQuery = useAutoReplySettings();
  const updateSettings = useUpdateAutoReplySettings();

  const settings = settingsQuery.data;
  const mode = settings?.mode || 'manual';
  const paused = !!settings?.paused;
  const canSend = settings?.can_send === true;
  const isAuto = mode === 'auto' && !paused;

  async function update(payload, successMessage) {
    try {
      await updateSettings.mutateAsync(payload);
      if (successMessage) toast.success(successMessage);
    } catch (err) {
      toast.error(err.message || 'Échec de la mise à jour.');
    }
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Chargement des réglages…
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Mode d&apos;envoi</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Michel répond au voyageur en répondant à l&apos;e-mail Airbnb depuis votre Gmail.
          </p>
        </div>

        {/* Unmissable state pill — this is the thing you check at a glance. */}
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            paused && 'bg-danger/10 text-danger',
            !paused && isAuto && 'bg-success/10 text-success',
            !paused && !isAuto && 'bg-muted text-muted-foreground'
          )}
        >
          {paused ? <OctagonX className="size-3.5" /> : isAuto ? <Bot className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
          {paused ? 'Arrêt d’urgence actif' : isAuto ? 'Automatique 24 h/24' : 'Validation manuelle'}
        </span>
      </div>

      {!canSend && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            Votre compte Gmail n&apos;autorise pas encore l&apos;envoi. Allez dans <strong>Intégrations</strong> et
            cliquez <strong>Réautoriser</strong> — sans cela, ni l&apos;envoi manuel ni l&apos;envoi automatique ne
            fonctionneront.
          </span>
        </p>
      )}

      <div className="space-y-1.5">
        <label htmlFor="auto-reply-mode" className="text-xs font-medium text-foreground">
          Réglage global
        </label>
        <Select
          value={mode}
          onValueChange={(value) =>
            update(
              { mode: value },
              value === 'auto'
                ? 'Envoi automatique activé — Michel répondra seul aux demandes simples.'
                : 'Validation manuelle activée.'
            )
          }
          disabled={updateSettings.isPending || paused}
        >
          <SelectTrigger id="auto-reply-mode" className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Validation manuelle</SelectItem>
            <SelectItem value="auto">Automatique 24 h/24</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          En automatique, seules les demandes factuelles connues (horaires, wifi, parking, équipements, règles)
          partent seules. Annulation, remboursement, prix, modification, litige, urgence ou information absente
          de la fiche passent toujours par vous.
        </p>
      </div>

      {/* Per-property override. NULL means "follow the global setting". */}
      {properties.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Par logement</p>
          <div className="space-y-2">
            {properties.map((property) => (
              <div
                key={property.id}
                className="flex flex-col gap-2 rounded-md border border-border p-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 truncate text-sm text-foreground">{property.name}</span>
                <Select
                  value={property.mode ?? 'inherit'}
                  onValueChange={(value) =>
                    update(
                      { property_id: property.id, property_mode: value === 'inherit' ? null : value },
                      `Réglage mis à jour pour ${property.name}`
                    )
                  }
                  disabled={updateSettings.isPending || paused}
                >
                  <SelectTrigger className="w-full sm:w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Suivre le réglage global</SelectItem>
                    <SelectItem value="manual">Validation manuelle</SelectItem>
                    <SelectItem value="auto">Automatique 24 h/24</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Emergency stop. Also cancels replies already waiting in the queue —
          otherwise pressing stop would still let queued messages go out. */}
      <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {paused
            ? 'Tous les envois automatiques sont suspendus. Les réponses en attente ont été annulées.'
            : 'Coupe immédiatement tout envoi automatique, quels que soient les réglages ci-dessus.'}
        </p>
        <Button
          variant={paused ? 'outline' : 'danger'}
          size="sm"
          className="w-full shrink-0 sm:w-auto"
          onClick={() =>
            update(
              { paused: !paused },
              paused ? 'Envois automatiques réactivés.' : "Arrêt d'urgence activé — plus aucun envoi automatique."
            )
          }
          disabled={updateSettings.isPending}
        >
          {updateSettings.isPending ? <Loader2 className="animate-spin" /> : <OctagonX />}
          {paused ? "Lever l'arrêt d'urgence" : "Arrêt d'urgence"}
        </Button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Home, Users, PawPrint, Wifi, KeyRound, MapPin, X, ChevronRight, ChevronDown } from 'lucide-react';
import { PlatformBadge } from '../../components/shared/PlatformBadge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import { BOOKING_STATUS_OPTIONS } from '../../lib/constants';
import { useUpdateConversation } from '../../hooks/useConversations';
import { formatDate } from '../../lib/utils';

function Field({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1.5 text-sm">
      {Icon && <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0">
        <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-foreground">{value}</span>
      </span>
    </div>
  );
}

export function ReservationDetails({
  conversation,
  onClose,
  showCloseButton = true,
  extraContext,
  onExtraContextChange,
}) {
  const [editingContext, setEditingContext] = useState(false);
  const updateConversation = useUpdateConversation();
  const ctx = conversation?.property_context?.context || {};
  const propertyName = conversation?.property_context?.name;

  async function handleStatusChange(status) {
    try {
      await updateConversation.mutateAsync({ id: conversation.id, payload: { booking_status: status } });
      toast.success('Statut mis à jour');
    } catch (err) {
      toast.error(err.message || 'Échec de la mise à jour du statut');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border p-3.5">
        <h3 className="text-sm font-semibold text-foreground">Informations</h3>
        {showCloseButton && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer le panneau">
            <X className="size-4" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3.5">
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Réservation</h4>
          <div className="mt-1.5 divide-y divide-border/70">
            <Field label="Voyageur" value={conversation?.guest_name || conversation?.title} />
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Plateforme</span>
              <PlatformBadge conversation={conversation} />
            </div>
            <div className="flex items-center justify-between gap-2 py-1.5">
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">Statut</span>
              <Select value={conversation?.booking_status} onValueChange={handleStatusChange} disabled={updateConversation.isPending}>
                <SelectTrigger className="h-7 w-auto gap-1.5 border-none bg-muted px-2 text-xs shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BOOKING_STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field label="Créée le" value={conversation?.created_at ? formatDate(conversation.created_at, { absolute: true, withTime: true }) : null} />
          </div>
        </section>

        {conversation?.property_id && (
          <section className="mt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Logement associé</h4>
              <Link to="/properties" className="inline-flex items-center text-xs font-medium text-primary hover:underline">
                Voir <ChevronRight className="size-3" />
              </Link>
            </div>
            <div className="mt-1.5 divide-y divide-border/70">
              <Field icon={Home} label="Nom" value={propertyName} />
              <Field icon={Users} label="Capacité max." value={ctx.max_guests ? `${ctx.max_guests} voyageurs` : null} />
              <Field icon={PawPrint} label="Animaux" value={ctx.rules_detail ? (ctx.rules_detail.pets ? 'Acceptés' : 'Non autorisés') : null} />
              <Field icon={Wifi} label="Wi-Fi" value={ctx.wifi_name ? `${ctx.wifi_name}${ctx.wifi_password ? ' · ' + ctx.wifi_password : ''}` : null} />
              <Field icon={KeyRound} label="Arrivée" value={ctx.check_in_time ? `Dès ${ctx.check_in_time}` : null} />
              <Field icon={MapPin} label="Adresse" value={ctx.address} />
            </div>

            {ctx.amenities && (
              <div className="mt-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Équipements pour Michel</span>
                <p className="mt-1 text-xs leading-relaxed text-foreground">{ctx.amenities}</p>
              </div>
            )}

            {ctx.rules && (
              <div className="mt-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Règles du logement</span>
                <p className="mt-1 text-xs leading-relaxed text-foreground">{ctx.rules}</p>
              </div>
            )}
          </section>
        )}

        <section className="mt-4">
          <button
            type="button"
            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            onClick={() => setEditingContext((v) => !v)}
          >
            Contexte supplémentaire pour Michel
            <ChevronDown className={`size-3.5 transition-transform ${editingContext ? 'rotate-180' : ''}`} />
          </button>
          {editingContext && (
            <div className="mt-2 space-y-2">
              <Textarea
                rows={4}
                placeholder='{"note": "Le voyageur arrive en avance"}'
                value={extraContext}
                onChange={(e) => onExtraContextChange(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Ajouté à la prochaine génération de réponse par Michel (non enregistré sur le logement).
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

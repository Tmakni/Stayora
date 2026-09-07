import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  BadgeCheck, Check, ChevronDown, Info, Loader2, Pencil, ShieldAlert, TriangleAlert, X,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import {
  usePendingFacts, useConfirmFact, useRejectFact, useConfirmAllFacts,
} from '../../hooks/useProperties';

/**
 * Centre de vérification.
 *
 * CE QUE CET ÉCRAN PROMET, ET CE QU'IL NE PROMET PAS
 * --------------------------------------------------
 * Il ne dit jamais « voici l'heure d'arrivée de votre logement ». Il dit « je
 * l'ai lue 14 fois, dans 11 réservations, sur 6 mois, sans contradiction — est-ce
 * bien ça ? ». La nuance n'est pas cosmétique : rien de ce qui est affiché ici
 * n'a été écrit dans la fiche, sauf les faits marqués comme déjà appliqués.
 *
 * Chaque carte porte donc SES CHIFFRES. C'est la seule façon pour l'hôte de
 * juger : « vu dans 11 réservations » se vérifie, « Michel pense que » ne se
 * vérifie pas.
 *
 * « TOUT CONFIRMER » NE PREND PAS TOUT
 * ------------------------------------
 * Le bouton ne vaut que pour les informations sans conflit et non sensibles.
 * Un code de boîte à clés reste à confirmer un par un, même vu cinquante fois :
 * il a pu changer hier sans qu'aucun message ne le dise. Le compteur du bouton
 * annonce exactement ce qu'il va confirmer.
 */

const STATUS_STYLE = {
  HIGH_CONFIDENCE: {
    label: 'Très probable',
    className: 'bg-success/10 text-success',
    icon: BadgeCheck,
  },
  REQUIRES_CONFIRMATION: {
    label: 'À confirmer',
    className: 'bg-warning/10 text-warning',
    icon: ShieldAlert,
  },
  UNSTABLE: {
    label: 'Plusieurs valeurs',
    className: 'bg-destructive/10 text-destructive',
    icon: TriangleAlert,
  },
  VERIFIED: {
    label: 'A peut-être changé',
    className: 'bg-warning/10 text-warning',
    icon: TriangleAlert,
  },
};

/** Les informations sensibles sont annoncées comme telles, pas noyées. */
const SENSITIVE_KEYS = new Set(['wifi_password', 'access_code', 'gate_code']);

function formatMonths(first, last) {
  if (!first || !last) return null;
  if (first === last) return `le ${first}`;
  return `du ${first} au ${last}`;
}

function FactCard({ propertyId, fact, onDone }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.value || '');
  const [open, setOpen] = useState(false);

  const confirmFact = useConfirmFact();
  const rejectFact = useRejectFact();
  const busy = confirmFact.isPending || rejectFact.isPending;

  const style = STATUS_STYLE[fact.status] || STATUS_STYLE.REQUIRES_CONFIRMATION;
  const StatusIcon = style.icon;
  const sensitive = SENSITIVE_KEYS.has(fact.fact_key);

  async function confirm(value) {
    try {
      await confirmFact.mutateAsync({ id: propertyId, factId: fact.id, value });
      toast.success(`${fact.label} enregistré`);
      setEditing(false);
      onDone?.();
    } catch (err) {
      toast.error(err.message || "Impossible d'enregistrer.");
    }
  }

  async function reject() {
    try {
      await rejectFact.mutateAsync({ id: propertyId, factId: fact.id });
      toast.success(`${fact.label} écarté`);
      onDone?.();
    } catch (err) {
      toast.error(err.message || "Impossible d'écarter.");
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{fact.label}</p>
          {editing ? (
            <Input
              className="mt-1 h-9"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`Corriger ${fact.label}`}
            />
          ) : (
            <p className="mt-0.5 break-words text-sm text-muted-foreground">{fact.value}</p>
          )}

          {/* Un changement détecté n'est pas appliqué : il est annoncé. */}
          {fact.possible_change && fact.previous_value && (
            <p className="mt-1 text-xs text-warning">
              Semble être passé de « {fact.previous_value} » à « {fact.value} ».
            </p>
          )}
        </div>

        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${style.className}`}>
          <StatusIcon className="size-3 shrink-0" aria-hidden="true" />
          {style.label}
        </span>
      </div>

      {/* Les chiffres sur lesquels repose la proposition. C'est ce qui rend la
          confirmation possible sans relire les conversations. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        Trouvé dans {fact.distinct_reservations} réservation{fact.distinct_reservations > 1 ? 's' : ''}
        {fact.contradiction_count > 0 && ` · ${fact.contradiction_count} message(s) disent autre chose`}
      </button>

      {open && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted p-2 text-xs text-muted-foreground">
          <dt>Messages concordants</dt><dd className="text-foreground">{fact.evidence_count}</dd>
          <dt>Conversations</dt><dd className="text-foreground">{fact.distinct_conversations}</dd>
          <dt>Réservations</dt><dd className="text-foreground">{fact.distinct_reservations}</dd>
          <dt>Périodes distinctes</dt><dd className="text-foreground">{fact.distinct_periods}</dd>
          <dt>Contradictions</dt><dd className="text-foreground">{fact.contradiction_count}</dd>
          <dt>Observé</dt>
          <dd className="text-foreground">{formatMonths(fact.first_seen, fact.last_seen) || '—'}</dd>
        </dl>
      )}

      {sensitive && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          Information sensible : elle a pu changer depuis. Michel ne l&apos;enregistrera
          que si vous la confirmez.
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={busy || !draft.trim()} onClick={() => confirm(draft.trim())}>
              {busy && <Loader2 className="animate-spin" />} Enregistrer
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
              Annuler
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => confirm(null)}>
              {confirmFact.isPending && <Loader2 className="animate-spin" />}
              <Check /> Confirmer
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(fact.value || ''); setEditing(true); }}>
              <Pencil /> Modifier
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={reject}>
              <X /> Ce n&apos;est pas ça
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function PropertySection({ entry }) {
  const confirmAll = useConfirmAllFacts();
  const safeCount = entry.facts.filter((f) => f.bulk_confirmable).length;

  async function handleConfirmAll() {
    try {
      const result = await confirmAll.mutateAsync(entry.property_id);
      toast.success(
        result.confirmed > 0
          ? `${result.confirmed} information(s) confirmée(s)`
          : 'Rien à confirmer sans vérification'
      );
    } catch (err) {
      toast.error(err.message || 'Échec de la confirmation.');
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{entry.property_name}</h3>
        {safeCount > 0 && (
          <Button size="sm" variant="outline" disabled={confirmAll.isPending} onClick={handleConfirmAll}>
            {confirmAll.isPending && <Loader2 className="animate-spin" />}
            Confirmer les {safeCount} sans conflit
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {entry.facts.map((fact) => (
          <FactCard key={fact.id} propertyId={entry.property_id} fact={fact} />
        ))}
      </div>
    </section>
  );
}

/**
 * Bandeau d'appel + boîte de dialogue. Le bandeau ne s'affiche que s'il y a
 * réellement quelque chose à vérifier : un écran vide ne rend service à
 * personne.
 */
export function FactVerificationBanner() {
  const [open, setOpen] = useState(false);
  const pending = usePendingFacts();

  const properties = useMemo(() => pending.data?.properties || [], [pending.data]);
  const total = pending.data?.total || 0;

  if (pending.isLoading || pending.isError || total === 0) return null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
        <p className="text-sm text-foreground">
          Michel a repéré <strong>{total} information{total > 1 ? 's' : ''}</strong> dans vos
          conversations, sur {properties.length} logement{properties.length > 1 ? 's' : ''}.
          Rien n&apos;est enregistré sans votre accord.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>Vérifier</Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Informations à vérifier</DialogTitle>
            <DialogDescription>
              Chacune vient de vos propres messages aux voyageurs. Les chiffres disent sur
              quoi elle repose : à vous de confirmer, corriger ou écarter.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {properties.map((entry) => (
              <PropertySection key={entry.property_id} entry={entry} />
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Fermer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

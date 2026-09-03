import { CheckCircle2, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '../../components/ui/button';

/**
 * Verdict « ce fil n'attend pas de réponse ».
 *
 * Rendu À LA PLACE du brouillon, jamais à côté : le serveur ne renvoie aucun
 * texte dans ce cas, précisément pour qu'il n'y ait rien à envoyer par
 * inadvertance. Afficher un motif sous une zone de saisie pré-remplie
 * reviendrait à laisser le geste dangereux à portée de pouce.
 *
 * Le ton est délibérément neutre : ce n'est pas une erreur, c'est un travail
 * évité. L'hôte garde la main avec « Générer quand même », parce que les motifs
 * sont des formes reconnues, pas une lecture du sens — écrire une relance sur
 * un fil auquel on a déjà répondu reste parfaitement légitime.
 */
export function NoReplyNeededCard({ verdict, onForce, onClose, generating }) {
  if (!verdict) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CheckCircle2 className="size-4 text-success" />
          Aucune réponse nécessaire
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Fermer"
        >
          <X className="size-4" />
        </button>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">{verdict.reply_needed_reason}</p>

      <p className="mt-2 text-xs text-muted-foreground">
        Michel n&apos;a rien rédigé, et rien n&apos;a été envoyé au voyageur.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onForce} disabled={generating}>
          {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Générer quand même
        </Button>
      </div>
    </div>
  );
}

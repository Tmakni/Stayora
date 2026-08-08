import { Sparkles, RefreshCw, Copy, Loader2, X, Send } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Label } from '../../components/ui/label';
import { INTENT_LABELS, RISK_LEVELS } from '../../lib/constants';

export function AIReplyCard({
  draft,
  text,
  onTextChange,
  onRegenerate,
  onValidateSend,
  onCopy,
  regenerating,
  sending,
  sendLabel = 'Valider et envoyer',
  onClose,
}) {
  const riskCfg = draft?.risk_level ? RISK_LEVELS[draft.risk_level] : null;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.035] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <Sparkles className="size-4" />
          Suggestion de Michel
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Fermer la suggestion">
          <X className="size-4" />
        </button>
      </div>

      {(draft?.intent || riskCfg || draft?.escalate) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {draft?.intent && <Badge tone="outline">{INTENT_LABELS[draft.intent] || draft.intent}</Badge>}
          {riskCfg && <Badge tone={riskCfg.tone}>{riskCfg.label}</Badge>}
          {draft?.escalate && <Badge tone="danger">Escalade recommandée</Badge>}
        </div>
      )}

      {draft?.host_note && (
        <div className="mt-2.5 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Note : </span>
          {draft.host_note}
        </div>
      )}

      {draft?.host_question && (
        <div className="mt-2.5 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
          <span className="font-medium text-warning">Michel a besoin de votre réponse : </span>
          {draft.host_question}
        </div>
      )}

      {Array.isArray(draft?.missing_info_questions) && draft.missing_info_questions.length > 0 && (
        <div className="mt-2.5 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
          <p className="font-medium text-warning">Informations manquantes :</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {draft.missing_info_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      <Label className="mb-1 mt-3 block">Réponse (modifiable)</Label>
      <Textarea rows={5} value={text} onChange={(e) => onTextChange(e.target.value)} className="bg-background" />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Régénérer
        </Button>
        <Button variant="outline" size="sm" onClick={onCopy}>
          <Copy /> Copier
        </Button>
        <Button size="sm" className="ml-auto" onClick={onValidateSend} disabled={sending || !text.trim()}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}

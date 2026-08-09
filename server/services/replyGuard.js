/**
 * Reply Guard — décide si une réponse IA peut être envoyée automatiquement.
 *
 * Point de contrôle UNIQUE avant tout envoi automatique à un voyageur.
 * Toute nouvelle voie d'auto-réponse (Superhot, Airbnb, Gmail…) DOIT passer
 * par shouldAutoSend() plutôt que de refaire ses propres vérifications.
 *
 * Le principe est de faillir en silence plutôt que d'envoyer : dans le doute,
 * on laisse le brouillon à l'hôte. Un message non envoyé est un désagrément ;
 * un message vide, hors-sujet ou déplacé envoyé à un voyageur est une faute
 * visible par le client final.
 */

// Messages de politesse qui ne demandent aucune réponse ("merci", "ok", "parfait"…).
// Filet de sécurité déterministe : le modèle est censé poser no_reply_needed,
// mais on ne dépend pas de lui pour éviter d'envoyer une réponse inutile.
// Le motif se répète pour couvrir les enchaînements courants ("super merci",
// "ok parfait merci beaucoup").
const COURTESY_WORD =
  "(?:merci(?:\\s+beaucoup|\\s+infiniment)?|thanks(?:\\s+a\\s+lot)?|thank\\s+you|ok|okay|d'accord|daccord|super|parfait|top|cool|nickel|g[ée]nial|impeccable|c'est\\s+not[ée]|c'est\\s+parfait|tr[èe]s\\s+bien|bien\\s+re[çc]u|no[ée]|great|perfect|awesome|noted|got\\s+it|bonne\\s+journ[ée]e|bonne\\s+soir[ée]e|[\\p{Emoji_Presentation}\\p{Extended_Pictographic}])";
const COURTESY_ONLY = new RegExp(
  `^(?:${COURTESY_WORD}[\\s.!,;]*)+$`,
  'iu'
);

// Un message réduit à des emojis / de la ponctuation n'appelle pas de réponse.
const EMOJI_OR_PUNCT_ONLY = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}.!?,;:…-]+$/u;

/**
 * Un message de simple politesse n'attend pas de réponse.
 * On ne se fie pas au seul jugement du modèle.
 */
function isCourtesyOnly(message) {
  if (typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (!trimmed) return true;
  // Au-delà de quelques mots, ce n'est plus une simple formule de politesse
  // ("merci, par contre le chauffage ne marche pas" doit obtenir une réponse).
  if (trimmed.length > 40) return false;
  return COURTESY_ONLY.test(trimmed) || EMOJI_OR_PUNCT_ONLY.test(trimmed);
}

/**
 * Décide si le brouillon peut partir sans relecture humaine.
 *
 * @param {object} aiResult      Résultat de generateDraftReply()
 * @param {object} opts
 * @param {string} opts.incomingMessage  Message reçu du voyageur
 * @param {boolean} opts.autoReplyEnabled  Interrupteur du logement
 * @returns {{allowed: boolean, reason: string}} reason est un code stable, journalisable
 */
function shouldAutoSend(aiResult, { incomingMessage = '', autoReplyEnabled = false } = {}) {
  if (!autoReplyEnabled) {
    return { allowed: false, reason: 'auto_reply_disabled' };
  }
  if (!aiResult) {
    return { allowed: false, reason: 'no_ai_result' };
  }

  // Le modèle demande explicitement l'intervention de l'hôte
  if (aiResult.needs_host === true) {
    return { allowed: false, reason: 'needs_host' };
  }

  // Le modèle estime qu'aucune réponse n'est attendue
  if (aiResult.no_reply_needed === true) {
    return { allowed: false, reason: 'no_reply_needed' };
  }

  // Filet déterministe : simple politesse, indépendamment de l'avis du modèle
  if (isCourtesyOnly(incomingMessage)) {
    return { allowed: false, reason: 'courtesy_message' };
  }

  // Sujet sensible (litige, annulation, négociation…) : l'hôte tranche
  if (aiResult.escalate === true) {
    return { allowed: false, reason: 'escalated' };
  }

  // Urgence, mise en cause juridique, sécurité… jamais en automatique
  if (aiResult.risk_level === 'high') {
    return { allowed: false, reason: 'high_risk' };
  }

  // Jamais envoyer du vide : garde-fou ultime contre les messages blancs
  const draft = typeof aiResult.draft_reply === 'string' ? aiResult.draft_reply.trim() : '';
  if (!draft) {
    return { allowed: false, reason: 'empty_draft' };
  }

  // Un brouillon d'un ou deux mots trahit presque toujours une génération ratée
  if (draft.length < 15) {
    return { allowed: false, reason: 'draft_too_short' };
  }

  // Le modèle a laissé un marqueur à compléter — ne jamais l'envoyer tel quel
  if (/\[[^\]]{2,40}\]|\{\{[^}]+\}\}|XXXX|À COMPLÉTER|TODO/i.test(draft)) {
    return { allowed: false, reason: 'unfilled_placeholder' };
  }

  return { allowed: true, reason: 'ok' };
}

/** Message lisible par l'hôte expliquant pourquoi l'envoi automatique a été retenu. */
const REASON_LABELS = {
  auto_reply_disabled: 'Réponses automatiques désactivées pour ce logement.',
  no_ai_result: "La génération de réponse a échoué.",
  needs_host: "Michel a besoin d'une information que vous seul possédez.",
  no_reply_needed: "Ce message n'appelle pas de réponse.",
  courtesy_message: "Simple message de politesse — aucune réponse nécessaire.",
  escalated: 'Sujet sensible — votre relecture est requise avant envoi.',
  high_risk: 'Message à risque élevé — votre relecture est requise avant envoi.',
  empty_draft: 'La réponse générée était vide.',
  draft_too_short: 'La réponse générée était trop courte pour être fiable.',
  unfilled_placeholder: 'La réponse générée contenait un champ non complété.',
  ok: 'Envoyée automatiquement.',
};

function describeReason(reason) {
  return REASON_LABELS[reason] || reason;
}

module.exports = { shouldAutoSend, isCourtesyOnly, describeReason };

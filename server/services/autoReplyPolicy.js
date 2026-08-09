/**
 * Auto-reply policy — decides whether a generated answer may be sent without
 * a human looking at it.
 *
 * The default answer is NO. Automatic sending is only allowed when every one of
 * these holds:
 *
 *   - the account (and the property) is explicitly in automatic mode;
 *   - the emergency stop is off;
 *   - the guest's question falls in a narrow set of factual topics;
 *   - the model did not flag escalation, missing information, or risk;
 *   - the answer is non-empty, plausible in length, and free of the
 *     "I don't know / contact the host" hedges that mean it has nothing to say.
 *
 * Anything touching money, dates, complaints, safety or legal matters is forced
 * to manual review no matter how confident the model claims to be — those are
 * the cases where an autonomous wrong answer costs the host real money or trust.
 *
 * Pure module: no DB, no network, so every rule is directly unit-testable.
 */

const { INTENTS } = require('./intentClassifier');

/** Modes stored on users.auto_reply_mode / property_profiles.auto_reply_mode. */
const MODES = {
  MANUAL: 'manual',
  AUTO: 'auto',
};

/**
 * Topics safe enough to answer unattended: each is a lookup of a fact the host
 * has already recorded on the property. Nothing here commits the host to
 * anything or moves money.
 */
const AUTO_SAFE_INTENTS = new Set([
  INTENTS.CHECK_IN,
  INTENTS.CHECK_OUT,
  INTENTS.WIFI,
  INTENTS.PARKING,
  INTENTS.AMENITIES,
  INTENTS.LOCATION,
  INTENTS.RULES,
]);

/**
 * Topics that ALWAYS require a human, whatever the model reports.
 * Cancellation/refund, price negotiation, booking changes, complaints and
 * anything flagged risky.
 */
const ALWAYS_MANUAL_INTENTS = new Set([
  INTENTS.CANCELLATION,
  INTENTS.PRICE_NEGOTIATION,
  INTENTS.MODIFICATION,
  INTENTS.PROBLEM,
]);

/**
 * Phrases that show the answer is not actually an answer. If the model produced
 * one of these, sending it unattended just wastes the guest's time.
 */
const HEDGE_PATTERNS = [
  /je ne (?:sais|suis) pas\b/i,
  /je n['’]ai pas (?:cette |l['’])?information/i,
  /je vais? (?:me renseigner|vérifier|demander)/i,
  /contactez? (?:votre |l['’])?hôte/i,
  /l['’]hôte (?:vous )?(?:re)?viendra vers vous/i,
  /i (?:don'?t|do not) know\b/i,
  /i'?ll (?:check|find out|ask)\b/i,
  /please contact (?:the |your )?host/i,
  /\[.*?(manquant|missing|à compléter).*?\]/i,
  /%[a-z_]+%/i,
];

/**
 * Sensitive wording that must reach a human even when the intent classifier
 * lands somewhere harmless. Deliberately broader than intent detection: a
 * false positive only costs a manual review, a false negative sends the wrong
 * answer to the guest.
 */
const SENSITIVE_PATTERNS = [
  /rembours|refund|avoir|geste commercial/i,
  /annul|cancel/i,
  /litige|dispute|plainte|complaint|réclamation/i,
  /avocat|lawyer|juridique|legal|tribunal|police|assurance|insurance/i,
  /urgen[ct]|emergency|secours|blessé|injur|incendie|fire|fuite de gaz/i,
  /dégât|degat|damage|cassé|broken|abîmé|détérior/i,
  /remise|réduction|discount|moins cher|negoci|négoci|prix|tarif|price/i,
  /modifier (?:ma |la )?réservation|changer (?:les |mes )?dates|change (?:my )?(?:booking|dates)/i,
  /caution|deposit|paiement|payment|facture|invoice|virement/i,
  /surbooking|overbook|double réservation/i,
];

const MIN_REPLY_CHARS = 20;
const MAX_REPLY_CHARS = 2000;

/**
 * Effective mode for a conversation: the property's setting wins when set,
 * otherwise the account default. The emergency stop overrides everything.
 */
function resolveMode({ userMode, propertyMode, paused }) {
  if (paused) return MODES.MANUAL;
  const mode = propertyMode || userMode || MODES.MANUAL;
  return mode === MODES.AUTO ? MODES.AUTO : MODES.MANUAL;
}

/**
 * May this generated answer be sent automatically?
 *
 * @param {object} input
 * @param {string} input.incomingMessage      the guest's text
 * @param {object} input.aiResult             aiService output
 * @param {string} [input.userMode]           users.auto_reply_mode
 * @param {string} [input.propertyMode]       property_profiles.auto_reply_mode
 * @param {boolean} [input.paused]            users.auto_reply_paused
 * @returns {{allowed: boolean, mode: string, reason: string, code: string}}
 */
function evaluateAutoReply({
  incomingMessage = '',
  aiResult = {},
  userMode = MODES.MANUAL,
  propertyMode = null,
  paused = false,
}) {
  const mode = resolveMode({ userMode, propertyMode, paused });

  const deny = (code, reason) => ({ allowed: false, mode, reason, code });

  if (paused) return deny('emergency_stop', "Arrêt d'urgence activé");
  if (mode !== MODES.AUTO) return deny('manual_mode', 'Mode validation manuelle');

  // ── Model's own refusals ────────────────────────────────────────────────
  if (aiResult.no_reply_needed) return deny('no_reply_needed', 'Message de courtoisie, aucune réponse nécessaire');
  if (aiResult.escalate) return deny('ai_escalate', "L'IA demande l'intervention de l'hôte");
  if (aiResult.needs_host) return deny('ai_needs_host', "Information absente de la fiche logement");
  if (aiResult.risk_level === 'high') return deny('risk_high', 'Risque élevé détecté');
  if (aiResult.risk_level === 'medium') return deny('risk_medium', 'Risque moyen — validation requise');

  // ── Topic gates ─────────────────────────────────────────────────────────
  const intent = aiResult.intent || INTENTS.OTHER;
  if (ALWAYS_MANUAL_INTENTS.has(intent)) {
    return deny('intent_sensitive', `Sujet sensible (${intent})`);
  }
  if (!AUTO_SAFE_INTENTS.has(intent)) {
    // OTHER and BOOKING_INQUIRY land here: too open-ended to answer unattended.
    return deny('intent_not_whitelisted', `Sujet hors périmètre automatique (${intent})`);
  }

  // Wording check on the guest's own message, independent of the classifier.
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(incomingMessage)) {
      return deny('sensitive_wording', 'Le message contient un sujet sensible');
    }
  }

  // ── The answer itself ───────────────────────────────────────────────────
  const reply = String(aiResult.draft_reply || '').trim();
  if (!reply) return deny('empty_reply', 'Réponse vide');
  if (reply.length < MIN_REPLY_CHARS) return deny('reply_too_short', 'Réponse trop courte pour être fiable');
  if (reply.length > MAX_REPLY_CHARS) return deny('reply_too_long', 'Réponse anormalement longue');

  for (const pattern of HEDGE_PATTERNS) {
    if (pattern.test(reply)) {
      return deny('reply_hedged', "La réponse n'apporte pas l'information demandée");
    }
  }

  // A question mark aimed back at the guest usually means the model needs
  // something before it can answer — that is a draft, not a send.
  if (/\?\s*$/.test(reply) && reply.length < 120) {
    return deny('reply_is_question', 'La réponse est elle-même une question');
  }

  return {
    allowed: true,
    mode,
    reason: `Sujet factuel (${intent}), informations disponibles`,
    code: 'auto_ok',
  };
}

module.exports = {
  MODES,
  AUTO_SAFE_INTENTS,
  ALWAYS_MANUAL_INTENTS,
  HEDGE_PATTERNS,
  SENSITIVE_PATTERNS,
  MIN_REPLY_CHARS,
  MAX_REPLY_CHARS,
  resolveMode,
  evaluateAutoReply,
};

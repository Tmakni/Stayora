/**
 * « Ce fil attend-il vraiment une réponse, maintenant ? »
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Trois vérifications déterministes répondaient déjà à cette question, mais
 * chacune vivait à un endroit différent et n'était appliquée QUE sur le chemin
 * automatique :
 *
 *   - `hostRepliedLast` (replyContextService) — l'hôte a déjà répondu ;
 *   - `evaluateClosure` (conversationClosure) — le séjour est terminé ;
 *   - `isCourtesyOnly`  (replyGuard)          — « merci ! » n'appelle rien.
 *
 * La génération manuelle — le bouton « Générer », c'est-à-dire POST /api/ai/draft
 * — n'en appliquait AUCUNE. Elle appelait le modèle sans condition et rendait un
 * brouillon, y compris sur un fil où l'hôte venait de répondre, sur un séjour
 * clos depuis trois semaines, ou en face d'un « merci beaucoup ! ». L'hôte se
 * retrouvait donc avec un message à envoyer qui n'avait aucune raison d'exister,
 * et rien à l'écran ne le signalait.
 *
 * Ce module rassemble les trois signaux en UNE réponse, pour que les deux
 * chemins — automatique et manuel — partagent la même définition et ne puissent
 * plus diverger.
 *
 * CE QU'IL NE FAIT PAS
 * --------------------
 * Il ne juge pas la QUALITÉ d'un brouillon (longueur, formules d'esquive,
 * champs non remplis) : c'est le rôle de replyGuard. Il ne décide pas non plus
 * d'un ENVOI sans relecture : c'est autoReplyPolicy. Il répond à la question
 * d'avant, celle qu'on ne posait pas.
 *
 * Il n'interdit rien non plus. Sur le chemin manuel, son verdict est une
 * information rendue à l'hôte, qui garde la main : c'est lui qui décide de
 * générer quand même. Un faux positif coûte donc un clic, jamais un blocage.
 *
 * Module pur : aucune base, aucun réseau, tout est testable directement.
 */

const { evaluateClosure, isStillAsking } = require('./conversationClosure');
const { isCourtesyOnly } = require('./replyGuard');

/**
 * Phrases par lesquelles le voyageur dit lui-même qu'il n'attend rien.
 *
 * Distinct de la politesse pure de replyGuard : ici le message peut être long
 * et parfaitement construit ("Parfait, tout est clair, je vous laisse, à
 * bientôt !"). Ce n'est pas une formule courte, c'est une clôture explicite.
 *
 * Le garde `isStillAsking` de conversationClosure reprend la main juste après :
 * une question dans la même phrase annule la clôture.
 */
const NO_ANSWER_EXPECTED_PATTERNS = [
  /\b(?:pas|aucun)\s+(?:de\s+)?(?:besoin|souci|probl[èe]me)\b[^.!?\n]{0,30}\b(?:r[ée]pondre|r[ée]ponse)\b/i,
  /\b(?:inutile|pas la peine|pas besoin)\s+de\s+(?:me\s+)?r[ée]pondre\b/i,
  /\bje vous laisse\b/i,
  /\bc'est (?:tout )?(?:bon|clair|not[ée])\b[^.!?\n]{0,20}$/i,
  /\btout est (?:bon|clair|parfait|ok)\b[^.!?\n]{0,20}$/i,
  /\bno (?:need|reply) (?:to )?(?:answer|reply|respond)\b/i,
  /\ball (?:good|clear|set)\b[^.!?\n]{0,20}$/i,
];

/** Codes de verdict — stables, journalisables, réutilisés par le client. */
const NECESSITY = {
  OK: 'reply_needed',
  NO_INCOMING: 'no_incoming_message',
  HOST_REPLIED_LAST: 'host_replied_last',
  CLOSED: 'conversation_closed',
  COURTESY: 'courtesy_message',
  NO_ANSWER_EXPECTED: 'no_answer_expected',
};

/** Formulations rendues à l'hôte, en français, sans jargon de code. */
const NECESSITY_LABELS = {
  [NECESSITY.NO_INCOMING]: "Aucun message du voyageur à traiter dans ce fil.",
  [NECESSITY.HOST_REPLIED_LAST]: "Vous avez déjà répondu au dernier message du voyageur.",
  [NECESSITY.CLOSED]: 'La conversation est terminée.',
  [NECESSITY.COURTESY]: "Le dernier message est une simple politesse — il n'appelle pas de réponse.",
  [NECESSITY.NO_ANSWER_EXPECTED]: "Le voyageur indique qu'il n'attend pas de réponse.",
  [NECESSITY.OK]: 'Le voyageur attend une réponse.',
};

/**
 * Le dernier message du voyageur dit-il explicitement qu'il n'attend rien ?
 * Une question dans le même message annule ce constat.
 */
function saysNoAnswerExpected(text) {
  const value = String(text || '');
  if (isStillAsking(value)) return false;
  return NO_ANSWER_EXPECTED_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Ce fil attend-il une réponse ?
 *
 * @param {object} input
 * @param {Array<{id?: number, role: string, content: string, created_at?: *}>} input.recent
 *        Messages du PLUS RÉCENT au plus ancien, tels que les rend
 *        replyContextService.getLatestGuestMessage().
 * @param {string}  [input.bookingStatus]   conversations.booking_status
 * @param {string}  [input.incomingMessage] texte à juger ; par défaut, le
 *        dernier message entrant de `recent`. Le chemin automatique le fournit
 *        car il concatène les rafales du voyageur avant d'appeler.
 * @param {Date|number} [input.now]         horloge injectable, pour les tests
 * @returns {{needed: boolean, code: string, reason: string, closureCode: string|null}}
 */
function evaluateReplyNecessity({
  recent = [],
  bookingStatus = null,
  incomingMessage = null,
  now = Date.now(),
} = {}) {
  const messages = Array.isArray(recent) ? recent : [];

  const verdict = (needed, code, reason, closureCode = null) => ({
    needed,
    code,
    reason: reason || NECESSITY_LABELS[code] || code,
    closureCode,
  });

  // ── Y a-t-il seulement quelque chose à traiter ? ─────────────────────────
  const lastIncoming = messages.find((m) => m && m.role === 'incoming') || null;
  if (!lastIncoming) {
    return verdict(false, NECESSITY.NO_INCOMING);
  }

  // ── L'hôte a-t-il déjà répondu ? ─────────────────────────────────────────
  //
  // Vérifié en premier parce que c'est le constat le plus concret et le plus
  // fréquent : il ne s'agit pas d'interpréter un texte, seulement de regarder
  // qui a parlé en dernier. Rien n'attend de réponse quand un message sortant
  // est la chose la plus récente du fil.
  //
  // C'est le seul motif que l'hôte contourne couramment à la main — écrire une
  // relance est légitime — d'où le passage en force côté appelant.
  const newest = messages[0];
  if (newest && newest.role === 'outgoing') {
    return verdict(false, NECESSITY.HOST_REPLIED_LAST);
  }

  // Texte jugé : celui que l'appelant impose, sinon le dernier entrant.
  const text = incomingMessage != null && String(incomingMessage).trim() !== ''
    ? String(incomingMessage)
    : String(lastIncoming.content || '');

  // ── Le fil est-il clos ? ─────────────────────────────────────────────────
  // Séjour terminé, notification d'évaluation Airbnb, adieux, fil dormant.
  const closure = evaluateClosure({ recent: messages, bookingStatus, now });
  if (closure.closed) {
    return verdict(false, NECESSITY.CLOSED, closure.reason, closure.code);
  }

  // ── Simple politesse ? ───────────────────────────────────────────────────
  // Filet déterministe indépendant du modèle : répondre un paragraphe à
  // « merci ! » est la façon la plus visible de passer pour un robot.
  if (isCourtesyOnly(text)) {
    return verdict(false, NECESSITY.COURTESY);
  }

  // ── Le voyageur dit lui-même qu'il n'attend rien ? ───────────────────────
  if (saysNoAnswerExpected(text)) {
    return verdict(false, NECESSITY.NO_ANSWER_EXPECTED);
  }

  return verdict(true, NECESSITY.OK);
}

module.exports = {
  evaluateReplyNecessity,
  saysNoAnswerExpected,
  NECESSITY,
  NECESSITY_LABELS,
};

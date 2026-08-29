/**
 * Conversation closure — "does this thread still need an answer at all?"
 *
 * The auto-reply pipeline had gates for *what* to answer (topic, risk, missing
 * information) but none for *whether the conversation is still open*. A stay
 * that ended three weeks ago, a guest signing off with "merci pour tout, on a
 * laissé les clés sur la table", an Airbnb review-request notification — all of
 * those still produced a queued reply, because the only "nothing to say here"
 * signal was the model's own `no_reply_needed`, and the model was being asked
 * about the last message in isolation.
 *
 * Answering a closed conversation is not a small annoyance: it reopens a thread
 * the guest considers finished, and it does so unattended, in the host's voice.
 *
 * Everything here is deterministic and reads only stored messages, so it can be
 * unit-tested and never depends on the model agreeing with it. A false positive
 * costs one manual review (the draft is still saved for the host); a false
 * negative sends a robot message into a finished conversation.
 */

/**
 * The guest is signing off. These are closing moves, not questions: nothing in
 * them asks the host for anything.
 *
 * Deliberately requires a farewell/handover phrase rather than mere politeness —
 * "merci" alone is handled by the courtesy net in replyGuard, and a guest can
 * perfectly well write "merci !" in the middle of an active conversation.
 */
const FAREWELL_PATTERNS = [
  /\bmerci (?:beaucoup |infiniment |encore )?pour (?:tout|ce séjour|le séjour|votre accueil|l['’]accueil)/i,
  /\bc['’](?:était|etait) (?:parfait|super|génial|genial|top|impeccable|nickel)\b/i,
  /\b(?:excellent|super|très bon|tres bon|merveilleux) séjour\b/i,
  /\bnous (?:avons|sommes) (?:passé|passe|adoré|adore)\b[^.!?\n]{0,30}\bséjour\b/i,
  /\bon (?:a|est) (?:bien )?(?:laissé|laisse|rendu|parti|partis)\b[^.!?\n]{0,25}\b(?:clés?|cles?|logement|appartement|maison|studio)\b/i,
  /\b(?:j['’]ai|nous avons) laissé les clés\b/i,
  /\b(?:au revoir|bonne continuation|bonne route|bon retour|prenez soin)\b/i,
  /\bà (?:une prochaine|bientôt j['’]espère)\b/i,
  /\bwe (?:had|really enjoyed) (?:a )?(?:great|wonderful|lovely|amazing)\b[^.!?\n]{0,20}\bstay\b/i,
  /\bthank(?:s| you)(?: so much| very much)? for (?:everything|the stay|your hospitality|hosting)/i,
  /\b(?:left|leaving) the keys?\b/i,
  /\b(?:goodbye|farewell|safe travels|take care)\b/i,
  /\bwe(?:'ve| have)? (?:checked out|left)\b/i,
  /\bnous (?:avons|sommes) (?:fait le check.?out|partis?)\b/i,
];

/**
 * Airbnb's own end-of-stay notifications. When one of these is the newest thing
 * in the thread, Airbnb itself considers the stay finished.
 */
/**
 * No `\b` next to an accented letter anywhere below.
 *
 * `\b` is ASCII-only in JavaScript: "é" is not a word character to it, so
 * `/\bécrire/` can never match "Écrivez" at the start of a sentence, and
 * `/passé\b/` never matches "passé " either — the boundary needs a word/
 * non-word transition and both sides are non-word. Every accented alternative
 * is therefore anchored on whitespace or start-of-string instead, and the verbs
 * are matched by stem so conjugations are covered.
 */
const REVIEW_NOTIFICATION_PATTERNS = [
  /(?:^|\s)(?:écri|ecri|rédig|redig|laiss)\w*\s+(?:un |une |votre )?(?:commentaire|évaluation|evaluation|avis)/i,
  /\bwrite (?:a |your )?review\b/i,
  /(?:^|\s)comment\s+s['’]est\s+(?:passé|passe|déroulé|deroule)/i,
  /\bhow was your (?:stay|trip)\b/i,
  /(?:^|\s)(?:évaluez|evaluez|notez)\s+(?:votre|le)\s+(?:séjour|sejour)/i,
  /(?:^|\s)votre\s+(?:séjour|sejour)\b[^.!?\n]{0,60}(?:est|s['’]est)\s+(?:terminé|termine|fini)/i,
  /\byour (?:stay|trip) (?:with|at) .{1,60} (?:has ended|is over)\b/i,
  /(?:^|\s)(?:partagez|donnez)\s+(?:votre|un)\s+avis/i,
];

/**
 * A question mark, or an explicit request, means the guest still wants
 * something — that outranks any farewell wording in the same message
 * ("merci pour tout ! au fait, on récupère la caution comment ?").
 */
const STILL_ASKING_PATTERNS = [
  /\?/,
  /\b(?:pourriez|pouvez|peux-tu|pouvez-vous|serait-il possible|est-ce que)\b/i,
  /\b(?:j['’]ai besoin|nous avons besoin|il me faut|il nous faut)\b/i,
  /\b(?:could|can|would) you\b/i,
  /\b(?:i|we) need\b/i,
  /\bplease (?:send|confirm|let me know|tell)\b/i,
];

/** Days after which a thread with no guest activity is treated as dormant. */
const DORMANT_DAYS = 30;

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Does this single guest message still ask for something?
 * Exported because the courtesy/closure distinction turns on it.
 */
function isStillAsking(message) {
  return matchesAny(STILL_ASKING_PATTERNS, String(message || ''));
}

/**
 * Is this conversation finished?
 *
 * @param {object} input
 * @param {Array<{role: string, content: string, created_at: *}>} input.recent
 *        Newest-first message rows, as returned by getLatestGuestMessage().
 * @param {string} [input.bookingStatus] conversations.booking_status
 * @param {Date|number} [input.now] injectable clock, for tests
 * @returns {{closed: boolean, reason: string|null, code: string|null}}
 */
function evaluateClosure({ recent = [], bookingStatus = null, now = Date.now() } = {}) {
  const open = { closed: false, reason: null, code: null };

  const messages = Array.isArray(recent) ? recent : [];
  if (messages.length === 0) return open;

  const lastIncoming = messages.find((m) => m.role === 'incoming');
  if (!lastIncoming) return open;

  const lastText = String(lastIncoming.content || '');

  // Airbnb says the stay is over.
  //
  // Checked before the "still asking" guard because Airbnb phrases its own
  // end-of-stay prompts AS questions — "Comment s'est passé votre séjour ?" —
  // so the guard would read a system notification as a guest waiting for an
  // answer, and Michel would helpfully tell the guest how their stay went.
  if (matchesAny(REVIEW_NOTIFICATION_PATTERNS, lastText)) {
    return {
      closed: true,
      reason: 'Le séjour est terminé (notification d\'évaluation Airbnb)',
      code: 'stay_ended',
    };
  }

  // An outstanding question keeps the conversation open no matter what else the
  // message says, and no matter how the stay is filed, so a genuine request can
  // never be silenced by a farewell in the same breath.
  if (isStillAsking(lastText)) return open;

  // The guest signed off.
  if (matchesAny(FAREWELL_PATTERNS, lastText)) {
    return {
      closed: true,
      reason: 'Le voyageur a pris congé — la conversation est terminée',
      code: 'guest_signed_off',
    };
  }

  // Checked out AND nothing pending: the stay is behind us and the last thing
  // the guest wrote asks for nothing.
  if (bookingStatus === 'checkedout') {
    return {
      closed: true,
      reason: 'Séjour terminé (check-out) et aucune question en attente',
      code: 'checked_out',
    };
  }

  // Dormant: the guest last wrote a long time ago and asked nothing. Answering
  // now would arrive out of nowhere.
  const lastMs = toMillis(lastIncoming.created_at);
  if (Number.isFinite(lastMs)) {
    const ageDays = (toMillis(now) - lastMs) / 86_400_000;
    if (ageDays > DORMANT_DAYS) {
      return {
        closed: true,
        reason: `Aucun message du voyageur depuis ${Math.round(ageDays)} jours`,
        code: 'dormant',
      };
    }
  }

  return open;
}

/**
 * Parse a timestamp written either by the DB's NOW() (UTC, no zone marker) or
 * as a Date/epoch. Mirrors outboundQueue.parseDbTimestamp: reading a
 * zone-less UTC string with `new Date()` would shift it by the host's offset.
 */
function toMillis(value) {
  if (value == null) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return NaN;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text).getTime();
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

module.exports = {
  evaluateClosure,
  isStillAsking,
  FAREWELL_PATTERNS,
  REVIEW_NOTIFICATION_PATTERNS,
  DORMANT_DAYS,
};

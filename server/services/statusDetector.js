/**
 * Auto-detect conversation booking_status based on message history.
 * Statuses progress:  inquiry → request → confirmed → checkedin → checkedout
 * A status can only move forward, never backward.
 */

const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');

const STATUS_ORDER = ['inquiry', 'request', 'confirmed', 'checkedin', 'checkedout'];

// Keywords / patterns to detect each status (FR + EN)
const STATUS_PATTERNS = {
  checkedout: [
    /\b(check.?out|départ|parti|left|departed|checked\s*out|quitt[eé])\b/i,
    /\b(merci.*séjour|thank.*stay|avis|review|comment.*s[eé]jour)\b/i,
    /\b(c'était super|was great|wonderful stay|bon retour)\b/i
  ],
  checkedin: [
    /\b(check.?in|arriv[eé]|arrived|install[eé]|settled|on est l[àa]|we.?re here)\b/i,
    /\b(bien arriv|just arrived|dans l'appart|dans le logement|inside the)\b/i,
    /\b(code.*march[eé]|key works|clé.*fonctionne|trouvé.*logement)\b/i
  ],
  confirmed: [
    /\b(confirm[eé]|confirmed|réservation.*accept|booking.*accept|r[eé]sa.*valid)\b/i,
    /\b(hâte|look.*forward|can't wait|vivement|impatient)\b/i,
    /\b(paiement.*effectu|payment.*done|pay[eé]|paid)\b/i,
    /\b(réservation.*confirm|reservation.*confirm|booking.*confirm)\b/i
  ],
  request: [
    /\b(r[eé]serv|book|r[eé]sa)\b/i,
    /\b(souhaite.*r[eé]server|like to book|want to book|je voudrais.*r[eé]serv)\b/i,
    /\b(pour \d+ nuit|for \d+ night|\d+ personnes|\d+ guests)\b/i,
    /\b(du \d+.*au \d+|from.*to.*\d{1,2})/i,
    /\b(demande de r[eé]servation|booking request|reservation request)\b/i,
    /\b(combien.*nuit|price.*night|tarif|rate)\b/i
  ]
};

/**
 * Detect the most likely booking_status based on all messages in a conversation.
 * Returns the detected status string.
 */
function detectStatusFromMessages(messages) {
  // Concatenate all messages (most recent first for priority)
  const allText = messages.map(m => m.content || '').join('\n');
  // Also check last 3 messages separately for recency
  const recentText = messages.slice(-3).map(m => m.content || '').join('\n');

  // Check in reverse order of progression (highest status first)
  for (const status of ['checkedout', 'checkedin', 'confirmed', 'request']) {
    const patterns = STATUS_PATTERNS[status];
    for (const pat of patterns) {
      // For checkedout/checkedin, only check recent messages (last 3)
      if ((status === 'checkedout' || status === 'checkedin') && pat.test(recentText)) {
        return status;
      }
      // For confirmed/request, check all messages
      if ((status === 'confirmed' || status === 'request') && pat.test(allText)) {
        return status;
      }
    }
  }

  return 'inquiry';
}

/**
 * Update conversation status if the detected status is further in the progression.
 * @param {number} conversationId
 * @returns {string|null} new status if updated, null if unchanged
 */
async function autoUpdateStatus(conversationId) {
  try {
    const db = getDatabase();

    // Get current status
    const convRows = await db.query(
      'SELECT booking_status FROM conversations WHERE id = ?',
      [conversationId]
    );
    if (convRows.length === 0) return null;

    const currentStatus = convRows[0].booking_status || 'inquiry';
    const currentIdx = STATUS_ORDER.indexOf(currentStatus);

    // Get all messages
    const messages = await db.query(
      'SELECT content, role, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [conversationId]
    );
    if (messages.length === 0) return null;

    const detected = detectStatusFromMessages(messages);
    const detectedIdx = STATUS_ORDER.indexOf(detected);

    // Only move forward, never back
    if (detectedIdx > currentIdx) {
      await db.query(
        'UPDATE conversations SET booking_status = ? WHERE id = ?',
        [detected, conversationId]
      );
      logger.info(`[StatusDetector] Conversation ${conversationId}: ${currentStatus} → ${detected}`);
      return detected;
    }

    return null;
  } catch (err) {
    logger.error('[StatusDetector] Error:', err.message);
    return null;
  }
}

module.exports = { autoUpdateStatus, detectStatusFromMessages, STATUS_ORDER };

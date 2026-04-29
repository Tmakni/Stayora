/**
 * Property Q&A Knowledge Base Service
 *
 * Extracts guest-question / host-answer pairs from past conversations
 * and uses them to improve AI replies for future guests.
 *
 * How it works:
 *   1. extractConversationQA()  — scans a conversation for (incoming→outgoing)
 *      message pairs and stores them in property_qa.
 *   2. getRelevantQA()          — given a guest question and a property, returns
 *      the most relevant past Q&A pairs via keyword overlap scoring.
 *   3. formatQAForPrompt()      — formats the Q&As into a prompt-ready string.
 */
const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');

// ── Minimum lengths to bother storing a Q&A ──
const MIN_QUESTION_LEN = 10;
const MIN_ANSWER_LEN   = 15;
const MAX_QA_IN_PROMPT = 6;   // Max Q&As injected into the AI prompt

// ================================================================
// Extraction
// ================================================================

/**
 * Scan a conversation and persist all new guest-question / host-answer pairs.
 * Call this after every Gmail sync or after an outgoing message is sent.
 *
 * @param {number} conversationId
 * @returns {number} count of new pairs stored
 */
async function extractConversationQA(conversationId) {
  const db = getDatabase();

  // Get conversation metadata
  const convRows = await db.query(
    'SELECT user_id, property_id FROM conversations WHERE id = ?',
    [conversationId]
  );
  if (!convRows.length || !convRows[0].property_id) return 0;

  const { user_id, property_id } = convRows[0];

  // Get all messages in chronological order
  const messages = await db.query(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId]
  );

  // Get already-indexed message IDs to avoid duplicates
  const existingRows = await db.query(
    'SELECT incoming_message_id FROM property_qa WHERE conversation_id = ? AND incoming_message_id IS NOT NULL',
    [conversationId]
  );
  const existingIncoming = new Set(existingRows.map(r => r.incoming_message_id));

  let newPairs = 0;

  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];

    // We want: incoming question followed by the NEXT outgoing reply
    if (msg.role !== 'incoming') continue;
    if (existingIncoming.has(msg.id)) continue;

    const question = msg.content ? msg.content.trim() : '';
    if (question.length < MIN_QUESTION_LEN) continue;

    // Find the immediately following outgoing message
    const reply = messages.slice(i + 1).find(m => m.role === 'outgoing');
    if (!reply) continue;

    const answer = reply.content ? reply.content.trim() : '';
    if (answer.length < MIN_ANSWER_LEN) continue;

    try {
      await db.query(
        `INSERT INTO property_qa
           (user_id, property_id, question, answer, source, conversation_id, incoming_message_id, outgoing_message_id)
         VALUES (?, ?, ?, ?, 'host_reply', ?, ?, ?)`,
        [user_id, property_id, question, answer, conversationId, msg.id, reply.id]
      );
      newPairs++;
    } catch (err) {
      // Duplicate key or other error — skip silently
      logger.debug(`property_qa insert skipped for msg ${msg.id}: ${err.message}`);
    }
  }

  if (newPairs > 0) {
    logger.info(`propertyQA: extracted ${newPairs} new Q&A pair(s) from conversation ${conversationId}`);
  }
  return newPairs;
}

/**
 * Extract Q&A pairs from ALL conversations for a property.
 * Useful as a one-shot backfill for existing data.
 */
async function backfillPropertyQA(userId, propertyId) {
  const db = getDatabase();
  const convs = await db.query(
    'SELECT id FROM conversations WHERE user_id = ? AND property_id = ?',
    [userId, propertyId]
  );
  let total = 0;
  for (const { id } of convs) {
    total += await extractConversationQA(id);
  }
  logger.info(`propertyQA: backfill complete for property ${propertyId} — ${total} pairs stored`);
  return total;
}

// ================================================================
// Retrieval
// ================================================================

/**
 * Return up to MAX_QA_IN_PROMPT Q&A pairs most relevant to the guest question.
 * Relevance is scored by keyword overlap (fast, no ML required).
 *
 * @param {number}  propertyId
 * @param {string}  guestQuestion  The incoming guest message
 * @returns {Array<{question, answer}>}
 */
async function getRelevantQA(propertyId, guestQuestion) {
  if (!propertyId || !guestQuestion) return [];

  const db = getDatabase();

  // Load all Q&As for this property (capped at 200 for performance)
  const rows = await db.query(
    `SELECT question, answer FROM property_qa WHERE property_id = ? ORDER BY created_at DESC LIMIT 200`,
    [propertyId]
  );
  if (rows.length === 0) return [];

  const queryWords = tokenize(guestQuestion);
  if (queryWords.length === 0) return rows.slice(0, MAX_QA_IN_PROMPT);

  // Score each Q&A by word overlap with the guest question
  const scored = rows.map(row => {
    const qWords = tokenize(row.question);
    const matches = queryWords.filter(w => qWords.some(qw => qw.includes(w) || w.includes(qw)));
    const score = matches.length / Math.max(queryWords.length, qWords.length, 1);
    return { ...row, score };
  });

  // Sort by score desc, take top MAX_QA_IN_PROMPT
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(r => r.score > 0)           // At least one keyword match
    .slice(0, MAX_QA_IN_PROMPT)
    .map(({ question, answer }) => ({ question, answer }));
}

/**
 * Format Q&A pairs into a prompt-ready section.
 * @param {Array<{question, answer}>} pairs
 * @returns {string}
 */
function formatQAForPrompt(pairs) {
  if (!pairs || pairs.length === 0) return '';

  const items = pairs.map((p, i) => {
    const q = p.question.replace(/\n+/g, ' ').trim();
    const a = p.answer.replace(/\n+/g, ' ').trim();
    return `Q${i + 1}: ${q}\nR${i + 1}: ${a}`;
  }).join('\n\n');

  return `RÉPONSES PASSÉES DE L'HÔTE POUR CE LOGEMENT (utilise-les comme référence de style et de contenu):\n${items}`;
}

// ================================================================
// Helpers
// ================================================================

/**
 * Tokenize text into meaningful lowercase words (remove stopwords).
 */
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'en', 'et', 'ou',
  'au', 'aux', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'me', 'te', 'se', 'y', 'on', 'ce', 'qui', 'que', 'quoi', 'dont',
  'est', 'sont', 'sera', 'était', 'avoir', 'être', 'a', 'ai', 'as',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'at',
  'to', 'for', 'and', 'or', 'but', 'with', 'by', 'from', 'it', 'its',
  'i', 'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their',
  'si', 'il', 'pas', 'ne', 'je', 'que', 'ca', 'ça', 'mon', 'ma', 'mes',
  'votre', 'vos', 'leur', 'leurs', 'tout', 'tous', 'bien', 'avoir',
  'pour', 'sur', 'avec', 'dans', 'par', 'très', 'plus', 'moins'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

module.exports = {
  extractConversationQA,
  backfillPropertyQA,
  getRelevantQA,
  formatQAForPrompt
};

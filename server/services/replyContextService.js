/**
 * Reply context resolver.
 *
 * Answers one question: "for this conversation, where does a reply actually go,
 * and under which headers?" — using only what Gmail delivered.
 *
 * This is the trust boundary for the whole reply feature. The recipient is
 * looked up from messages.email_reply_to, written at sync time from the
 * Reply-To header of a mail Gmail delivered to THIS account for THIS
 * conversation (see gmailSyncService). Nothing here reads request input, so a
 * client cannot steer a send, and the account scoping means a stale or guessed
 * conversation id cannot reach another user's mailbox.
 *
 * Airbnb rotates the Reply-To token per notification, so the newest incoming
 * message wins: older tokens can be stale for the thread.
 */

const { getDatabase } = require('../config/db');
const { validateReplyAddress, buildReplySubject, buildReferences, maskAddress } = require('./emailReplyService');
const logger = require('../utils/logger');

/**
 * Build the envelope for replying to a conversation.
 *
 * @param {number} conversationId
 * @param {number} userId  authenticated user — every query is scoped to it
 * @returns {Promise<{ok: boolean, reason?: string, context?: object}>}
 */
async function resolveReplyContext(conversationId, userId) {
  const db = getDatabase();

  // Ownership first: never look at messages before proving the conversation
  // belongs to the caller.
  const conversations = await db.query(
    `SELECT id, user_id, property_id, guest_name, title, airbnb_thread_id, airbnb_reply_url
     FROM conversations WHERE id = ? AND user_id = ?`,
    [conversationId, userId]
  );
  if (conversations.length === 0) {
    return { ok: false, reason: 'Conversation introuvable' };
  }
  const conversation = conversations[0];

  // The Gmail account that actually received this conversation's mail. Taking
  // it from the thread (rather than "any active account of the user") keeps a
  // reply going out of the same mailbox the guest is talking to, even when the
  // host has several connected.
  const threads = await db.query(
    `SELECT gt.gmail_account_id, gt.gmail_thread_id
     FROM gmail_threads gt
     WHERE gt.conversation_id = ? AND gt.user_id = ?
     ORDER BY gt.last_message_at DESC, gt.id DESC
     LIMIT 1`,
    [conversationId, userId]
  );

  let gmailAccountId = threads[0]?.gmail_account_id || null;
  let gmailThreadId = threads[0]?.gmail_thread_id || null;

  if (!gmailAccountId) {
    const accounts = await db.query(
      'SELECT id FROM gmail_accounts WHERE user_id = ? AND is_active = TRUE ORDER BY id LIMIT 1',
      [userId]
    );
    gmailAccountId = accounts[0]?.id || null;
  }
  if (!gmailAccountId) {
    return { ok: false, reason: 'Aucun compte Gmail connecté pour cette conversation' };
  }

  const accountRows = await db.query(
    'SELECT id, email, can_send, is_active FROM gmail_accounts WHERE id = ? AND user_id = ?',
    [gmailAccountId, userId]
  );
  if (accountRows.length === 0 || !accountRows[0].is_active) {
    return { ok: false, reason: 'Compte Gmail inactif' };
  }
  if (!accountRows[0].can_send) {
    return {
      ok: false,
      reason: 'GMAIL_SEND_SCOPE_MISSING',
      needsReauthorization: true,
      gmailAccountId,
    };
  }

  // Newest incoming message that carries a usable Reply-To. Outgoing messages
  // are excluded on purpose: their Reply-To is the host's own address, and
  // replying to ourselves would be a loop.
  const candidates = await db.query(
    `SELECT m.id, m.email_reply_to, m.email_message_id, m.email_references,
            m.email_subject, m.created_at, m.gmail_message_id
     FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?
     WHERE m.conversation_id = ?
       AND m.role = 'incoming'
       AND m.email_reply_to IS NOT NULL
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 5`,
    [userId, conversationId]
  );

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "Aucune adresse de réponse trouvée. Une nouvelle synchronisation Gmail est nécessaire "
        + "(les messages reçus avant cette mise à jour n'ont pas conservé leurs en-têtes).",
      needsResync: true,
    };
  }

  for (const candidate of candidates) {
    const check = validateReplyAddress(candidate.email_reply_to);
    if (!check.valid) {
      logger.warn(
        `Conversation ${conversationId} : adresse de réponse rejetée (${check.reason})`
      );
      continue;
    }

    const subject = buildReplySubject(candidate.email_subject || conversation.title);
    const references = buildReferences(candidate.email_references, candidate.email_message_id);

    return {
      ok: true,
      context: {
        userId,
        conversationId,
        propertyId: conversation.property_id || null,
        gmailAccountId,
        gmailThreadId,
        triggerMessageId: candidate.id,
        triggerGmailMessageId: candidate.gmail_message_id || null,
        toAddress: check.address,
        subject,
        inReplyTo: candidate.email_message_id || null,
        references,
        guestName: conversation.guest_name || null,
        airbnbReplyUrl: conversation.airbnb_reply_url || null,
      },
    };
  }

  return {
    ok: false,
    reason: "L'adresse de réponse de cette conversation n'est pas une adresse Airbnb reconnue",
  };
}

/**
 * Latest incoming message text — what a generated reply should answer.
 * Also reports whether the host has already replied since, which is how the
 * auto path avoids answering something the human already handled.
 */
async function getLatestGuestMessage(conversationId, userId) {
  const db = getDatabase();
  const rows = await db.query(
    `SELECT m.id, m.role, m.content, m.created_at
     FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?
     WHERE m.conversation_id = ?
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT 10`,
    [userId, conversationId]
  );
  if (rows.length === 0) return null;

  const newest = rows[0];
  const lastIncoming = rows.find((r) => r.role === 'incoming') || null;

  return {
    lastIncoming,
    // A host reply is the most recent thing in the thread → nothing to answer.
    hostRepliedLast: newest.role === 'outgoing',
    recent: rows,
  };
}

module.exports = {
  resolveReplyContext,
  getLatestGuestMessage,
  maskAddress,
};

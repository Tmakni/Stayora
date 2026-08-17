/**
 * Automatic reply orchestration.
 *
 * Two entry points, deliberately separated in time:
 *
 *   scheduleForConversation()  called right after the Gmail sync stores a new
 *                              guest message. Cheap: it only books a slot in
 *                              the queue, or pushes an existing slot back.
 *
 *   prepareQueuedReply()       called by the worker once the slot comes due.
 *                              THIS is where the model runs.
 *
 * Generating late is the point. A guest often sends three short messages in a
 * row ("bonjour" / "une question" / "c'est pour le parking"); answering the
 * first one is both robotic and usually wrong. Every new message pushes the
 * deadline back (bounded by DEBOUNCE_MAX_MS), so the model finally sees the
 * whole burst and answers it once.
 */

const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const queue = require('./outboundQueue');
const policy = require('./autoReplyPolicy');
const { resolveReplyContext, getLatestGuestMessage } = require('./replyContextService');
const { generateDraftReply } = require('./aiService');
const { getHostStyle } = require('./hostStyleService');

/**
 * Read the effective settings for a conversation.
 */
async function loadSettings(userId, propertyId) {
  const db = getDatabase();

  const users = await db.query(
    'SELECT auto_reply_mode, auto_reply_paused FROM users WHERE id = ?',
    [userId]
  );
  const user = users[0] || {};

  let propertyMode = null;
  if (propertyId) {
    const props = await db.query(
      'SELECT auto_reply_mode FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );
    propertyMode = props[0]?.auto_reply_mode || null;
  }

  return {
    userMode: user.auto_reply_mode || policy.MODES.MANUAL,
    paused: !!user.auto_reply_paused,
    propertyMode,
  };
}

/**
 * Book (or postpone) an automatic reply for a conversation.
 * Called from the sync path — must stay fast and must never throw into it.
 *
 * @returns {Promise<{scheduled: boolean, reason: string, queueId?: number}>}
 */
async function scheduleForConversation({ userId, conversationId, propertyId = null }) {
  try {
    const settings = await loadSettings(userId, propertyId);

    // Cheap gate first: in manual mode nothing is ever queued automatically.
    const mode = policy.resolveMode({
      userMode: settings.userMode,
      propertyMode: settings.propertyMode,
      paused: settings.paused,
    });
    if (mode !== policy.MODES.AUTO) {
      return { scheduled: false, reason: 'manual_mode' };
    }

    // A burst in progress: push the existing slot back instead of adding one.
    const extended = await queue.extendDebounce(conversationId, userId);
    if (extended > 0) {
      logger.info(`Réponse auto reportée pour la conversation ${conversationId} (nouveau message reçu)`);
      return { scheduled: true, reason: 'debounce_extended' };
    }

    // Don't answer if the host already replied last — the human handled it.
    const latest = await getLatestGuestMessage(conversationId, userId);
    if (!latest || !latest.lastIncoming) {
      return { scheduled: false, reason: 'no_incoming_message' };
    }
    if (latest.hostRepliedLast) {
      return { scheduled: false, reason: 'host_replied_last' };
    }

    // Resolve the envelope now: if we cannot reply at all (no Reply-To, missing
    // send scope), there is no point scheduling work that must fail later.
    const resolved = await resolveReplyContext(conversationId, userId);
    if (!resolved.ok) {
      logger.info(`Réponse auto impossible pour la conversation ${conversationId} : ${resolved.reason}`);
      return { scheduled: false, reason: resolved.reason };
    }
    const ctx = resolved.context;

    // Idempotency is keyed on the triggering guest message, so a re-sync of the
    // same mail cannot book a second reply.
    const existing = await queue.existsForTrigger({
      conversationId,
      triggerMessageId: ctx.triggerMessageId,
      gmailMessageId: ctx.triggerGmailMessageId,
      userId,
    });
    if (existing) {
      return { scheduled: false, reason: `already_${existing.status}`, queueId: existing.id };
    }

    // body_text stays NULL on purpose — the model runs when the slot comes due.
    const enqueued = await queue.enqueue({
      userId,
      gmailAccountId: ctx.gmailAccountId,
      conversationId,
      propertyId: ctx.propertyId,
      triggerMessageId: ctx.triggerMessageId,
      gmailMessageId: ctx.triggerGmailMessageId,
      mode: 'auto',
      bodyText: null,
      toAddress: ctx.toAddress,
      subject: ctx.subject,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
      gmailThreadId: ctx.gmailThreadId,
    });

    logger.info(
      `Réponse auto programmée pour la conversation ${conversationId} ` +
      `(file ${enqueued.id}, dans ~${Math.round(queue.DEBOUNCE_MS / 1000)}s)`
    );
    return { scheduled: enqueued.created, reason: 'scheduled', queueId: enqueued.id };
  } catch (err) {
    // Never let this break the sync — a missed auto-reply is recoverable, a
    // broken sync is not.
    logger.warn(`scheduleForConversation(${conversationId}) a échoué : ${err.message}`);
    return { scheduled: false, reason: 'error' };
  }
}

/**
 * Generate the body for a due automatic reply and decide whether it may go out.
 *
 * @returns {Promise<{send: boolean, bodyText?: string, decision: object}>}
 */
async function prepareQueuedReply(row) {
  const db = getDatabase();

  const settings = await loadSettings(row.user_id, row.property_id);

  // Re-check the mode at send time: the host may have switched to manual, or
  // hit the emergency stop, during the debounce window. That must be honoured.
  const mode = policy.resolveMode({
    userMode: settings.userMode,
    propertyMode: settings.propertyMode,
    paused: settings.paused,
  });
  if (mode !== policy.MODES.AUTO) {
    return { send: false, decision: { code: 'mode_changed', reason: 'Mode repassé en validation manuelle' } };
  }

  const latest = await getLatestGuestMessage(row.conversation_id, row.user_id);
  if (!latest || !latest.lastIncoming) {
    return { send: false, decision: { code: 'no_incoming_message', reason: 'Aucun message voyageur' } };
  }
  if (latest.hostRepliedLast) {
    return { send: false, decision: { code: 'host_replied', reason: "L'hôte a déjà répondu" } };
  }

  // The whole burst, oldest first — this is what the debounce was waiting for.
  const burst = latest.recent
    .filter((m) => m.role === 'incoming')
    .slice(0, 5)
    .reverse();
  const incomingMessage = burst.map((m) => m.content).join('\n\n').trim();

  // The host's own writing style, learned from THEIR past outgoing messages
  // (hostStyleService scopes every query by user_id, so one host's voice can
  // never leak into another's reply).
  //
  // Only the manual "Générer un message IA" button used to load this: the
  // automatic path never passed hostStyle, so Michel answered in the generic
  // default voice precisely when the host was not there to correct it — the
  // opposite of what automation is for. A failure here must not cancel the
  // reply, it just costs the personalisation.
  let hostStyle = null;
  try {
    hostStyle = await getHostStyle(row.user_id);
  } catch (err) {
    logger.warn(`Style de l'hôte indisponible pour l'utilisateur ${row.user_id} : ${err.message}`);
  }

  // The real state of the booking, not a hardcoded 'inquiry'. Answering a
  // confirmed guest — or someone already checked in — as though they were still
  // a prospect asking about the listing is jarring and often plainly wrong.
  let bookingStatus = 'inquiry';
  const convRows = await db.query(
    'SELECT booking_status FROM conversations WHERE id = ? AND user_id = ?',
    [row.conversation_id, row.user_id]
  );
  if (convRows[0]?.booking_status) bookingStatus = convRows[0].booking_status;

  // Property context for the model.
  let propertyContext = {};
  let airbnbListingId = null;
  if (row.property_id) {
    const props = await db.query(
      'SELECT name, context_json, airbnb_listing_id FROM property_profiles WHERE id = ? AND user_id = ?',
      [row.property_id, row.user_id]
    );
    if (props[0]) {
      try {
        propertyContext = JSON.parse(props[0].context_json || '{}');
      } catch (_) {
        propertyContext = {};
      }
      propertyContext.name = propertyContext.name || props[0].name;
      airbnbListingId = props[0].airbnb_listing_id || null;
    }
  }

  const history = latest.recent
    .slice(0, 8)
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));

  let aiResult;
  try {
    aiResult = await generateDraftReply({
      incomingMessage,
      propertyContext,
      conversationHistory: history,
      bookingStatus,
      airbnbListingId,
      hostStyle,
    });
  } catch (err) {
    return { send: false, decision: { code: 'ai_error', reason: `Génération impossible : ${err.message}` } };
  }

  const verdict = policy.evaluateAutoReply({
    incomingMessage,
    aiResult,
    userMode: settings.userMode,
    propertyMode: settings.propertyMode,
    paused: settings.paused,
  });

  const decision = {
    code: verdict.code,
    reason: verdict.reason,
    intent: aiResult.intent,
    risk_level: aiResult.risk_level,
    needs_host: !!aiResult.needs_host,
    escalate: !!aiResult.escalate,
  };

  if (!verdict.allowed) {
    return { send: false, decision, bodyText: aiResult.draft_reply || null };
  }

  return { send: true, bodyText: aiResult.draft_reply.trim(), decision };
}

module.exports = {
  loadSettings,
  scheduleForConversation,
  prepareQueuedReply,
};

/**
 * Webhook Controller – Superhot (hostaway-compatible) integration
 *
 * Superhot sends a POST to /api/webhook/superhot when a new guest message
 * arrives via Airbnb (or any connected OTA).
 *
 * Expected payload (Superhot standard):
 * {
 *   "event": "message.received",
 *   "data": {
 *     "conversation_id": "sh_123abc",
 *     "listing_id":      "sh_list_456",
 *     "guest": {
 *       "name":     "Jean Dupont",
 *       "language": "fr"
 *     },
 *     "message": {
 *       "id":      "msg_789",
 *       "body":    "Bonjour, est-ce que...",
 *       "sent_at": "2025-12-01T10:30:00Z"
 *     }
 *   }
 * }
 */

const crypto = require('crypto');
const { getDatabase } = require('../config/db');
const { generateDraftReply } = require('../services/aiService');
const config = require('../config/env');
const logger = require('../utils/logger');
const { broadcastNewMessage, broadcastConversationUpdate } = require('../services/syncScheduler');

/**
 * Verify Superhot webhook signature (HMAC-SHA256)
 * SECURITY: In production, ALWAYS require a valid signature.
 */
function verifySignature(req) {
  const secret = config.superhot.webhookSecret;
  if (!secret) {
    // In production, reject if no secret configured — never silently accept
    if (config.isProd) return false;
    // Dev mode: allow unsigned webhooks with a warning
    logger.warn('Webhook signature check skipped (no SUPERHOT_WEBHOOK_SECRET set)');
    return true;
  }

  const signature = req.headers['x-superhot-signature'] || req.headers['x-webhook-signature'];
  if (!signature) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Main webhook handler for Superhot messages
 */
async function handleSuperhot(req, res) {
  // Always respond 200 first to avoid Superhot retries
  res.status(200).json({ received: true });

  const db = getDatabase();

  // Log the webhook
  let logId = null;
  try {
    const logResult = await db.query(
      `INSERT INTO webhook_logs (provider, payload_json) VALUES ('superhot', ?)`,
      [JSON.stringify(req.body)]
    );
    logId = logResult.insertId;
  } catch (e) {
    logger.warn('Could not log webhook:', e.message);
  }

  // Verify signature
  if (!verifySignature(req)) {
    logger.warn('Invalid webhook signature from Superhot');
    if (logId) {
      await db.query('UPDATE webhook_logs SET error_message=? WHERE id=?', ['Invalid signature', logId]).catch(() => {});
    }
    return;
  }

  const payload = req.body;
  
  // Only process incoming guest messages
  if (payload.event !== 'message.received' && payload.event !== 'newMessage') {
    logger.info('Ignored webhook event:', payload.event);
    return;
  }

  try {
    const data = payload.data || payload;

    const externalConvId  = data.conversation_id  || data.reservationId || data.threadId;
    const externalListingId = data.listing_id     || data.listingMapId   || null;
    const guestName       = (data.guest && data.guest.name)     || data.guestName  || 'Voyageur';
    const guestLanguage   = (data.guest && data.guest.language) || data.language   || 'fr';
    const messageBody     = (data.message && data.message.body) || data.body       || data.text || '';

    if (!messageBody.trim()) {
      logger.info('Empty message body, skipping.');
      return;
    }

    // Find matching property by superhot_listing_id
    let property = null;
    let userId   = null;

    if (externalListingId) {
      const rows = await db.query(
        `SELECT pp.*, u.id AS owner_id
         FROM property_profiles pp
         JOIN users u ON u.id = pp.user_id
         WHERE pp.superhot_listing_id = ?
         LIMIT 1`,
        [externalListingId]
      );
      if (rows.length > 0) {
        property = rows[0];
        userId   = rows[0].owner_id;
      }
    }

    // Find or create a DB conversation linked to this Superhot thread
    let conversation = null;
    const existingConvs = await db.query(
      `SELECT id, user_id FROM conversations WHERE external_id = ? AND external_provider = 'superhot' LIMIT 1`,
      [externalConvId]
    );

    if (existingConvs.length > 0) {
      conversation = existingConvs[0];
      userId = userId || conversation.user_id;
    } else if (userId) {
      // Create new conversation
      const title = `${guestName} – ${new Date().toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })}`;
      const result = await db.query(
        `INSERT INTO conversations (user_id, title, booking_status, property_id, external_id, external_provider, guest_name, guest_language)
         VALUES (?, ?, 'inquiry', ?, ?, 'superhot', ?, ?)`,
        [userId, title, property ? property.id : null, externalConvId, guestName, guestLanguage]
      );
      conversation = { id: result.insertId, user_id: userId };
    } else {
      logger.warn('No matching property or user found for Superhot listing:', externalListingId);
      if (logId) await db.query('UPDATE webhook_logs SET error_message=? WHERE id=?', ['No matching property', logId]).catch(() => {});
      return;
    }

    // Save incoming message
    await db.query(
      `INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, 'incoming', ?, ?)`,
      [conversation.id, messageBody, JSON.stringify({ source: 'superhot', external_conv_id: externalConvId })]
    );

    // Notify connected clients of new message
    if (userId) {
      broadcastNewMessage(userId, conversation.id, { role: 'incoming', content: messageBody });
      broadcastConversationUpdate(userId);
    }

    // Build property context
    let propertyContext = {};
    if (property && property.context_json) {
      try { propertyContext = JSON.parse(property.context_json); } catch (_) {}
    }

    // Get airbnb_listing_id for potential re-fetch
    const airbnbListingId = property?.airbnb_listing_id || propertyContext?.airbnb_listing_id || null;

    // Auto-reply if enabled for this property
    const autoReplyEnabled = property && property.auto_reply_enabled;

    // Fetch conversation history (last 10 messages)
    const history = await db.query(
      `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 10`,
      [conversation.id]
    );
    const conversationHistory = history.reverse();

    // Generate AI response
    let aiResult = null;
    try {
      aiResult = await generateDraftReply({
        incomingMessage:     messageBody,
        propertyContext,
        conversationHistory,
        bookingStatus:       'inquiry',
        guestProfile:        { language: guestLanguage, name: guestName },
        airbnbListingId
      });
    } catch (aiErr) {
      logger.error('AI generation error in webhook:', aiErr.message);
    }

    if (!aiResult) {
      if (logId) await db.query('UPDATE webhook_logs SET error_message=?,conversation_id=? WHERE id=?', ['AI generation failed', conversation.id, logId]).catch(() => {});
      return;
    }

    // If AI needs host intervention — save as notification, DON'T auto-reply
    if (aiResult.needs_host) {
      const hostQuestion = aiResult.host_question || aiResult.host_note || 'Un voyageur a posé une question nécessitant votre réponse.';
      await db.query(
        `INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, 'system', ?, ?)`,
        [conversation.id, hostQuestion, JSON.stringify({ ...aiResult, source: 'ai_needs_host', auto_sent: false })]
      );
      logger.info(`AI needs host for conversation ${conversation.id} — not auto-replying. Question: ${hostQuestion}`);

      if (logId) await db.query('UPDATE webhook_logs SET conversation_id=? WHERE id=?', [conversation.id, logId]).catch(() => {});
      return;
    }

    // Save AI draft as outgoing message
    await db.query(
      `INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, 'outgoing', ?, ?)`,
      [conversation.id, aiResult.draft_reply, JSON.stringify({ ...aiResult, source: 'ai_auto', auto_sent: autoReplyEnabled })]
    );

    // Notify connected clients of AI reply
    if (userId) {
      broadcastNewMessage(userId, conversation.id, { role: 'outgoing', content: aiResult.draft_reply });
    }

    // If auto-reply is active – send via Superhot API
    if (autoReplyEnabled && config.superhot.apiKey) {
      try {
        await sendSuperhot(externalConvId, aiResult.draft_reply);
        logger.info(`Auto-reply sent via Superhot for conversation ${conversation.id}`);
      } catch (sendErr) {
        logger.error('Failed to send via Superhot API:', sendErr.message);
      }
    }

    // Update webhook log
    if (logId) {
      await db.query(
        `UPDATE webhook_logs SET processed=1, conversation_id=?, auto_replied=?, user_id=? WHERE id=?`,
        [conversation.id, autoReplyEnabled ? 1 : 0, userId, logId]
      ).catch(() => {});
    }

    logger.info(`Webhook processed: conv ${conversation.id}, auto_reply=${autoReplyEnabled}`);
  } catch (err) {
    logger.error('Webhook processing error:', err);
    if (logId) {
      await db.query('UPDATE webhook_logs SET error_message=? WHERE id=?', [err.message, logId]).catch(() => {});
    }
  }
}

/**
 * Send a reply through the Superhot API
 * Docs: https://developer.superhot.io/reference/post-message
 */
async function sendSuperhot(conversationId, replyText) {
  const res = await fetch(`https://api.superhot.io/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.superhot.apiKey}`,
      'X-Account-Key': config.superhot.accountKey || ''
    },
    body: JSON.stringify({ body: replyText, type: 'host' })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Superhot API error ${res.status}: ${errText}`);
  }

  return res.json();
}

/**
 * Get webhook logs (for dashboard)
 */
async function getWebhookLogs(req, res) {
  try {
    const db   = getDatabase();
    const logs = await db.query(
      `SELECT id, provider, processed, auto_replied, error_message, received_at, conversation_id
       FROM webhook_logs
       ORDER BY received_at DESC
       LIMIT 50`
    );
    res.json(logs);
  } catch (err) {
    logger.error('Get webhook logs error:', err);
    res.status(500).json({ error: 'Erreur lors de la recuperation des logs' });
  }
}

module.exports = { handleSuperhot, getWebhookLogs };

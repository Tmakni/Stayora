/**
 * Reply endpoints — manual send, status, retry, and the auto-reply settings.
 *
 * Design rule that runs through all of this: the client sends TEXT, never a
 * destination. The recipient, subject and threading headers are resolved
 * server-side from mail Gmail actually delivered for this conversation
 * (replyContextService). A caller cannot make the server mail an address of
 * their choosing, no matter what they post.
 */

const { getDatabase } = require('../config/db');
const { sanitizeString, validateId } = require('../utils/sanitize');
const { invalidatePattern } = require('../middleware/cache');
const logger = require('../utils/logger');
const queue = require('../services/outboundQueue');
const policy = require('../services/autoReplyPolicy');
const { resolveReplyContext } = require('../services/replyContextService');
const { noteHostMessage } = require('../services/propertyFacts');

const MAX_REPLY_CHARS = 4000;

/**
 * POST /api/conversations/:id/reply
 * Body: { message: "…" }
 *
 * Queues a reply and shows it in the thread straight away. The actual Gmail
 * send happens in the worker, so a slow or flaky Gmail call never blocks the
 * request — the UI reflects "envoi en cours" and settles to "envoyé".
 */
async function sendReply(req, res) {
  try {
    const conversationId = validateId(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'Identifiant de conversation invalide' });

    const raw = (req.body?.message || '').toString();
    if (!raw.trim()) return res.status(400).json({ error: 'Le message est vide' });
    if (raw.length > MAX_REPLY_CHARS) {
      return res.status(400).json({ error: `Message trop long (max ${MAX_REPLY_CHARS} caractères)` });
    }
    const message = sanitizeString(raw).trim();

    // Resolves ownership, the Gmail account, the recipient and the headers.
    const resolved = await resolveReplyContext(conversationId, req.userId);
    if (!resolved.ok) {
      const status = resolved.reason === 'GMAIL_SEND_SCOPE_MISSING' ? 403 : 400;
      return res.status(status).json({
        error: resolved.reason === 'GMAIL_SEND_SCOPE_MISSING'
          ? "Autorisation d'envoi Gmail manquante. Reconnectez votre compte Gmail pour permettre l'envoi."
          : resolved.reason,
        needs_reauthorization: !!resolved.needsReauthorization,
        needs_resync: !!resolved.needsResync,
      });
    }
    const ctx = resolved.context;

    const db = getDatabase();

    // Show it immediately. The host sees their message in the thread the moment
    // they press send; the queue status pill carries the delivery state.
    const inserted = await db.query(
      `INSERT INTO messages (conversation_id, role, content, metadata_json, created_at)
       VALUES (?, 'outgoing', ?, ?, NOW())`,
      [
        conversationId,
        message,
        JSON.stringify({ source: 'michel_manual_reply', pending: true }),
      ]
    );

    // Apprentissage continu (§18 de la spécification d'import).
    //
    // Ce que l'hôte vient d'écrire lui-même peut contredire un fait établi —
    // une heure d'arrivée qui a changé, un code renouvelé. On ne remplace RIEN
    // ici : un message isolé n'a ni les occurrences ni l'étalement qu'exigent
    // les seuils. On lève seulement le drapeau « a peut-être changé », et
    // l'écran de vérification posera la question.
    //
    // Seules les réponses MANUELLES alimentent ce signal. Une réponse générée
    // par Michel reprend ce que Michel croit déjà savoir : s'en servir comme
    // preuve serait un raisonnement circulaire.
    if (ctx.propertyId) {
      noteHostMessage(db, req.userId, ctx.propertyId, message).catch((err) => {
        // Un signal manqué ne doit jamais empêcher l'envoi d'une réponse.
        logger.warn(`Signal de changement non enregistré : ${err.message}`);
      });
    }

    // Idempotency key includes the manual message id, so two clicks create two
    // DIFFERENT keys only if two different messages were actually written —
    // the double-click guard is the queue row's uniqueness plus the client ref.
    const enqueued = await queue.enqueue({
      userId: req.userId,
      gmailAccountId: ctx.gmailAccountId,
      conversationId,
      propertyId: ctx.propertyId,
      triggerMessageId: ctx.triggerMessageId,
      gmailMessageId: ctx.triggerGmailMessageId,
      mode: 'manual',
      bodyText: message,
      toAddress: ctx.toAddress,
      subject: ctx.subject,
      inReplyTo: ctx.inReplyTo,
      references: ctx.references,
      gmailThreadId: ctx.gmailThreadId,
      delayMs: 0,
    });

    if (!enqueued.created && ['pending', 'sending', 'sent'].includes(enqueued.status)) {
      // A reply to this same guest message is already in flight or gone out.
      // Remove the optimistic row we just added so the thread does not show a
      // duplicate, and tell the client what happened.
      await db.query('DELETE FROM messages WHERE id = ? AND conversation_id = ?', [inserted.insertId, conversationId]);
      return res.status(200).json({
        success: true,
        duplicate: true,
        queue_id: enqueued.id,
        status: enqueued.status,
        message: 'Une réponse à ce message est déjà en cours d\'envoi.',
      });
    }

    await db.query('UPDATE conversations SET updated_at = NOW() WHERE id = ? AND user_id = ?', [conversationId, req.userId]);
    invalidatePattern(req.userId, '/api/conversations');

    logger.info(`Réponse mise en file (conversation ${conversationId}, file ${enqueued.id})`);

    // Nudge the worker so a manual send feels immediate rather than waiting for
    // the next tick. Fire-and-forget: the interval is the real guarantee.
    setImmediate(() => {
      require('../services/replyWorker').tick().catch(() => {});
    });

    return res.status(202).json({
      success: true,
      queue_id: enqueued.id,
      status: 'pending',
      message_id: inserted.insertId,
    });
  } catch (error) {
    logger.error('sendReply error:', error.message);
    return res.status(500).json({ error: "Échec de la mise en file de la réponse" });
  }
}

/**
 * GET /api/conversations/:id/reply-status
 * Delivery state of the latest queued reply + whether replying is possible.
 */
async function getReplyStatus(req, res) {
  try {
    const conversationId = validateId(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'Identifiant invalide' });

    const latest = await queue.latestForConversation(conversationId, req.userId);
    const resolved = await resolveReplyContext(conversationId, req.userId);

    let decision = null;
    if (latest?.decision_json) {
      try { decision = JSON.parse(latest.decision_json); } catch (_) {}
    }

    return res.json({
      can_reply: resolved.ok,
      // Never expose the reply address: its local part is a private per-thread token.
      reason: resolved.ok ? null : resolved.reason,
      needs_reauthorization: !!resolved.needsReauthorization,
      needs_resync: !!resolved.needsResync,
      latest: latest
        ? {
            id: latest.id,
            status: latest.status,
            mode: latest.mode,
            attempts: latest.attempts,
            error: latest.last_error,
            sent_at: latest.sent_at,
            scheduled_at: latest.scheduled_at,
            decision,
          }
        : null,
    });
  } catch (error) {
    logger.error('getReplyStatus error:', error.message);
    return res.status(500).json({ error: 'Échec de la récupération du statut' });
  }
}

/**
 * POST /api/conversations/:id/reply/:queueId/retry
 * Re-arms a failed send. Reuses the same row, so retrying can never duplicate.
 */
async function retryReply(req, res) {
  try {
    const conversationId = validateId(req.params.id);
    const queueId = validateId(req.params.queueId);
    if (!conversationId || !queueId) return res.status(400).json({ error: 'Identifiant invalide' });

    const db = getDatabase();
    const rows = await db.query(
      'SELECT id, status FROM outbound_replies WHERE id = ? AND user_id = ? AND conversation_id = ?',
      [queueId, req.userId, conversationId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Envoi introuvable' });
    if (rows[0].status === 'sent') {
      return res.status(409).json({ error: 'Ce message a déjà été envoyé.', status: 'sent' });
    }

    const ok = await queue.retry(queueId, req.userId);
    if (!ok) return res.status(409).json({ error: "Cet envoi n'est pas dans un état permettant de réessayer" });

    setImmediate(() => {
      require('../services/replyWorker').tick().catch(() => {});
    });

    return res.json({ success: true, status: 'pending' });
  } catch (error) {
    logger.error('retryReply error:', error.message);
    return res.status(500).json({ error: "Échec de la nouvelle tentative" });
  }
}

/**
 * GET /api/settings/auto-reply
 */
async function getAutoReplySettings(req, res) {
  try {
    const db = getDatabase();
    const users = await db.query(
      'SELECT auto_reply_mode, auto_reply_paused FROM users WHERE id = ?',
      [req.userId]
    );
    const properties = await db.query(
      'SELECT id, name, auto_reply_mode FROM property_profiles WHERE user_id = ? ORDER BY name',
      [req.userId]
    );
    const accounts = await db.query(
      'SELECT id, email, can_send FROM gmail_accounts WHERE user_id = ? AND is_active = TRUE',
      [req.userId]
    );

    return res.json({
      mode: users[0]?.auto_reply_mode || policy.MODES.MANUAL,
      paused: !!users[0]?.auto_reply_paused,
      can_send: accounts.some((a) => a.can_send),
      accounts: accounts.map((a) => ({ id: a.id, email: a.email, can_send: !!a.can_send })),
      properties: properties.map((p) => ({ id: p.id, name: p.name, mode: p.auto_reply_mode })),
    });
  } catch (error) {
    logger.error('getAutoReplySettings error:', error.message);
    return res.status(500).json({ error: 'Échec de la récupération des réglages' });
  }
}

/**
 * PUT /api/settings/auto-reply
 * Body: { mode?, paused?, property_id?, property_mode? }
 */
async function updateAutoReplySettings(req, res) {
  try {
    const db = getDatabase();
    const { mode, paused, property_id: propertyId, property_mode: propertyMode } = req.body || {};

    const validModes = [policy.MODES.MANUAL, policy.MODES.AUTO];

    if (mode !== undefined) {
      if (!validModes.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });
      await db.query('UPDATE users SET auto_reply_mode = ? WHERE id = ?', [mode, req.userId]);
      logger.info(`Mode de réponse global → ${mode} (user ${req.userId})`);
    }

    if (paused !== undefined) {
      await db.query('UPDATE users SET auto_reply_paused = ? WHERE id = ?', [paused ? 1 : 0, req.userId]);
      logger.info(`Arrêt d'urgence ${paused ? 'ACTIVÉ' : 'levé'} (user ${req.userId})`);

      // Turning the emergency stop on must also stop what is already queued —
      // otherwise pending automatic replies would still go out after the host
      // pressed stop.
      if (paused) {
        const cancelled = await db.query(
          `UPDATE outbound_replies SET status = 'cancelled', updated_at = NOW()
           WHERE user_id = ? AND status = 'pending' AND mode = 'auto'`,
          [req.userId]
        );
        logger.info(`Arrêt d'urgence : ${cancelled.affectedRows || 0} réponse(s) auto annulée(s)`);
      }
    }

    if (propertyId !== undefined) {
      const id = validateId(propertyId);
      if (!id) return res.status(400).json({ error: 'Logement invalide' });
      if (propertyMode !== null && propertyMode !== undefined && !validModes.includes(propertyMode)) {
        return res.status(400).json({ error: 'Mode de logement invalide' });
      }
      const updated = await db.query(
        'UPDATE property_profiles SET auto_reply_mode = ? WHERE id = ? AND user_id = ?',
        [propertyMode ?? null, id, req.userId]
      );
      if (!updated.affectedRows) return res.status(404).json({ error: 'Logement introuvable' });
    }

    return getAutoReplySettings(req, res);
  } catch (error) {
    logger.error('updateAutoReplySettings error:', error.message);
    return res.status(500).json({ error: 'Échec de la mise à jour des réglages' });
  }
}

module.exports = {
  sendReply,
  getReplyStatus,
  retryReply,
  getAutoReplySettings,
  updateAutoReplySettings,
};

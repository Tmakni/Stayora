/**
 * Reply worker — drains the outbound queue and actually sends.
 *
 * Runs inside the API process on its own interval. That is deliberate for this
 * deployment: Render's Starter web service stays up 24/7 (unlike Free, which
 * spins down), so a single always-on process is enough and avoids paying for a
 * second service. It costs nothing when the queue is empty — one indexed
 * SELECT per tick.
 *
 * Correctness relies on outboundQueue, not on this loop being a singleton:
 * claiming is a conditional UPDATE, so even if two processes ever ran (a deploy
 * overlap, a second instance), a row can only be claimed once and a guest can
 * only be answered once.
 *
 * Nothing here trusts caller input: the recipient comes from the queue row,
 * which was itself filled from headers on a received mail.
 */

const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const queue = require('./outboundQueue');
const emailReply = require('./emailReplyService');
const gmailSync = require('./gmailSyncService');

const TICK_MS = parseInt(process.env.REPLY_WORKER_INTERVAL_MS, 10) || 15_000;
/** Sends per tick. Small: Gmail rate-limits, and there is no rush. */
const MAX_PER_TICK = 5;

let timer = null;
let running = false;

/**
 * Send one queued reply.
 * @returns {Promise<'sent'|'failed'|'retry'|'skipped'>}
 */
async function processOne(row) {
  const db = getDatabase();

  // Re-check the conversation still belongs to this user. Cheap, and it means a
  // deleted/reassigned conversation can never be replied to.
  const conversations = await db.query(
    'SELECT id, user_id FROM conversations WHERE id = ? AND user_id = ?',
    [row.conversation_id, row.user_id]
  );
  if (conversations.length === 0) {
    await queue.markFailed(row.id, new Error('Conversation introuvable ou réassignée'), { permanent: true });
    return 'failed';
  }

  if (!row.to_address) {
    await queue.markFailed(row.id, new Error('Enveloppe incomplète (destinataire manquant)'), { permanent: true });
    return 'failed';
  }

  // Automatic replies are generated HERE, not when they were queued: the
  // debounce window exists so the model sees the guest's whole burst rather
  // than answering the first "bonjour". The mode and the policy are re-checked
  // at the same time, so switching to manual (or hitting the emergency stop)
  // during the wait actually stops the send.
  if (!row.body_text && row.mode === 'auto') {
    const autoReply = require('./autoReplyService');
    const prepared = await autoReply.prepareQueuedReply(row);

    if (!prepared.send) {
      // Not a failure: the answer becomes a draft for the host instead.
      await db.query(
        `UPDATE outbound_replies
         SET status = 'cancelled', body_text = ?, decision_json = ?, locked_by = NULL, locked_at = NULL, updated_at = NOW()
         WHERE id = ?`,
        [prepared.bodyText || null, JSON.stringify(prepared.decision || {}), row.id]
      );
      logger.info(
        `Réponse auto ${row.id} basculée en validation manuelle : ${prepared.decision?.reason || 'raison inconnue'}`
      );
      return 'skipped';
    }

    row.body_text = prepared.bodyText;
    await db.query(
      'UPDATE outbound_replies SET body_text = ?, decision_json = ?, updated_at = NOW() WHERE id = ?',
      [prepared.bodyText, JSON.stringify(prepared.decision || {}), row.id]
    );
  }

  if (!row.body_text) {
    await queue.markFailed(row.id, new Error('Corps du message manquant'), { permanent: true });
    return 'failed';
  }

  let account;
  try {
    account = await gmailSync.getGmailAccount(row.user_id, row.gmail_account_id);
  } catch (err) {
    // Token revoked/expired — permanent until the user reconnects.
    await queue.markFailed(row.id, err, { permanent: true });
    return 'failed';
  }
  if (!account) {
    await queue.markFailed(row.id, new Error('Compte Gmail introuvable'), { permanent: true });
    return 'failed';
  }

  try {
    const result = await emailReply.sendReply({
      account,
      to: row.to_address,
      subject: row.subject,
      bodyText: row.body_text,
      inReplyTo: row.in_reply_to,
      references: row.references_header,
      gmailThreadId: row.gmail_thread_id,
    });

    await queue.markSent(row.id, { gmailMessageId: result.id, gmailThreadId: result.threadId });

    // Record the Gmail id on the message we already showed in the UI, so the
    // next sync recognises it as ours and does not re-import it as new.
    await linkSentMessage(row, result);

    logger.info(
      `Réponse ${row.id} envoyée (conversation ${row.conversation_id}, mode ${row.mode}) → ${emailReply.maskAddress(row.to_address)}`
    );
    return 'sent';
  } catch (err) {
    // A rejected threadId is worth exactly one retry without it.
    if (err.retryWithoutThread && row.gmail_thread_id) {
      try {
        const result = await emailReply.sendReply({
          account,
          to: row.to_address,
          subject: row.subject,
          bodyText: row.body_text,
          inReplyTo: row.in_reply_to,
          references: row.references_header,
          gmailThreadId: null,
        });
        await queue.markSent(row.id, { gmailMessageId: result.id, gmailThreadId: result.threadId });
        await linkSentMessage(row, result);
        return 'sent';
      } catch (retryErr) {
        err = retryErr;
      }
    }

    const permanent = err.permanent === true || (err.retryable === false && err.permanent !== false);
    const outcome = await queue.markFailed(row.id, err, { permanent: err.permanent === true });

    if (err.message === 'GMAIL_SEND_SCOPE_MISSING') {
      // Surface it on the account so the UI can prompt for re-authorisation.
      await db.query(
        'UPDATE gmail_accounts SET can_send = 0, sync_error = ? WHERE id = ?',
        ["Autorisation d'envoi Gmail manquante — cliquez Réautoriser", row.gmail_account_id]
      ).catch(() => {});
    }

    logger.warn(
      `Réponse ${row.id} en échec (${outcome.retrying ? 'nouvelle tentative' : 'abandon'}): ${err.message}`
    );
    return outcome.retrying ? 'retry' : 'failed';
  }
}

/**
 * Make sure the sent reply exists once in the conversation, carrying its Gmail id.
 *
 * Two paths converge here:
 *   - manual send: the controller already inserted the message so the host sees
 *     it immediately; we just stamp the Gmail id on it;
 *   - automatic send: nothing existed before (the text was generated seconds
 *     ago inside the worker), so the message is inserted now.
 *
 * Recording the Gmail id matters beyond bookkeeping: the next sync walks the
 * thread and would otherwise treat our own reply as an unseen message and
 * import it a second time.
 */
async function linkSentMessage(row, result) {
  if (!result?.id || result.dryRun) return;
  const db = getDatabase();

  try {
    const updated = await db.query(
      `UPDATE messages SET gmail_message_id = ?
       WHERE conversation_id = ? AND role = 'outgoing' AND gmail_message_id IS NULL
         AND content = ?`,
      [result.id, row.conversation_id, row.body_text]
    );
    if (updated.affectedRows > 0) return;

    // Nothing to stamp — insert it (automatic path).
    const already = await db.query(
      'SELECT id FROM messages WHERE conversation_id = ? AND gmail_message_id = ? LIMIT 1',
      [row.conversation_id, result.id]
    );
    if (already.length > 0) return;

    await db.query(
      `INSERT INTO messages (conversation_id, role, content, gmail_message_id, metadata_json, created_at)
       VALUES (?, 'outgoing', ?, ?, ?, NOW())`,
      [
        row.conversation_id,
        row.body_text,
        result.id,
        JSON.stringify({
          source: 'michel_auto_reply',
          mode: row.mode,
          outbound_reply_id: row.id,
          gmail_message_id: result.id,
          gmail_thread_id: result.threadId || row.gmail_thread_id || null,
        }),
      ]
    );
    await db.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = ? AND user_id = ?',
      [row.conversation_id, row.user_id]
    );
  } catch (err) {
    logger.warn(`Impossible de lier le message envoyé ${result.id}: ${err.message}`);
  }
}

/** One pass over the queue. Exported so tests can drive it deterministically. */
async function tick() {
  if (running) return { processed: 0, skipped: true };
  running = true;

  const counts = { sent: 0, failed: 0, retry: 0, processed: 0 };
  try {
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const row = await queue.claimNext();
      if (!row) break;
      const outcome = await processOne(row);
      counts.processed++;
      if (counts[outcome] !== undefined) counts[outcome]++;
    }
  } catch (err) {
    logger.error(`Worker de réponse : erreur de cycle — ${err.message}`);
  } finally {
    running = false;
  }

  if (counts.processed > 0) {
    logger.info(`Worker de réponse : ${counts.sent} envoyée(s), ${counts.retry} à réessayer, ${counts.failed} échec(s)`);
  }
  return counts;
}

function start() {
  if (timer) return;
  logger.info(`Worker de réponse démarré (intervalle ${TICK_MS / 1000}s, worker ${queue.WORKER_ID})`);
  timer = setInterval(() => {
    tick().catch((err) => logger.error(`Worker de réponse : ${err.message}`));
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Worker de réponse arrêté');
  }
}

module.exports = { start, stop, tick, processOne, TICK_MS, MAX_PER_TICK };

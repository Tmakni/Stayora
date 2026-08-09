/**
 * Outbound reply queue.
 *
 * A guest reply must be sent exactly once. Not "usually once" — the failure
 * mode here is a real person receiving the same message twice, or two workers
 * answering the same question differently.
 *
 * The guarantees, and where each actually lives:
 *
 *  - AT MOST ONE reply per guest message → a UNIQUE index on idempotency_key
 *    (migration 017). Not an application check: two syncs racing both pass a
 *    SELECT, only one survives an INSERT.
 *  - ONE WORKER AT A TIME per row → a conditional UPDATE that flips
 *    pending→sending and stamps locked_by. The row is claimed by whoever's
 *    UPDATE reports affectedRows === 1; everyone else moves on.
 *  - ONE REPLY AT A TIME per conversation → claiming skips a conversation that
 *    already has a row in flight, so a burst of guest messages can never
 *    produce overlapping answers.
 *  - CRASH RECOVERY → a lock older than LOCK_TIMEOUT_MS is reclaimable, so a
 *    worker killed mid-send does not strand the row forever.
 *
 * Every query is scoped by user_id as well as by id: a wrong or stale id must
 * never let one account act on another's queue.
 */

const crypto = require('crypto');
const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');

const STATUS = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** A send that has been "sending" this long is assumed to be a dead worker. */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_ATTEMPTS = 5;
/** Exponential backoff, capped. Index = attempt number already made. */
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];

/**
 * Guest messages arrive in bursts ("bonjour" / "j'ai une question" / "c'est
 * pour le parking"). Answering each one separately is both robotic and wrong,
 * so the send waits for the burst to end; every new message pushes the deadline
 * back. Configurable to keep tests fast.
 */
const DEBOUNCE_MS = parseInt(process.env.AUTO_REPLY_DEBOUNCE_MS, 10) || 60_000;
const DEBOUNCE_MAX_MS = parseInt(process.env.AUTO_REPLY_DEBOUNCE_MAX_MS, 10) || 90_000;

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a timestamp written by nowIso() or by the database's own NOW().
 *
 * Both produce a UTC instant WITHOUT a zone marker ("2026-08-09 19:30:39").
 * `new Date()` reads that shape as LOCAL time, which silently shifts it by the
 * machine's offset — on a UTC+2 host the debounce ceiling landed two hours in
 * the past, so a reply meant to wait for the guest's burst fired immediately.
 * SQL comparisons were unaffected (both sides are UTC-naive), which is exactly
 * what made this easy to miss.
 */
function parseDbTimestamp(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  // Already carries a zone (ISO with Z or ±hh:mm) → trust it.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) return new Date(text).getTime();
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

/**
 * Idempotency key for a reply.
 *
 * Keyed on the conversation plus the triggering guest message, so:
 *   - re-running the sync over the same mail cannot enqueue twice;
 *   - a genuinely new guest message DOES get its own reply.
 * Hashed to stay inside the column and to avoid leaking ids into an index.
 */
function buildIdempotencyKey({ conversationId, triggerMessageId, gmailMessageId }) {
  const basis = `conv:${conversationId}|msg:${triggerMessageId || ''}|gmail:${gmailMessageId || ''}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 48);
}

function isUniqueViolation(err) {
  const message = String(err?.message || '');
  return (
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'ER_DUP_ENTRY' ||
    err?.errno === 1062 ||
    /UNIQUE constraint failed|Duplicate entry/i.test(message)
  );
}

/**
 * Put a reply in the queue, or return the existing one.
 *
 * @returns {Promise<{id: number, created: boolean, status: string}>}
 */
async function enqueue({
  userId,
  gmailAccountId,
  conversationId,
  propertyId = null,
  triggerMessageId = null,
  gmailMessageId = null,
  bodyText = null,
  mode = 'manual',
  toAddress = null,
  subject = null,
  inReplyTo = null,
  references = null,
  gmailThreadId = null,
  decision = null,
  delayMs = null,
}) {
  const db = getDatabase();
  const key = buildIdempotencyKey({ conversationId, triggerMessageId, gmailMessageId });

  // Automatic sends wait out the guest's burst; a manual send is a deliberate
  // click and goes as soon as a worker picks it up.
  const scheduledAt = nowIso(delayMs != null ? delayMs : (mode === 'auto' ? DEBOUNCE_MS : 0));

  try {
    const result = await db.query(
      `INSERT INTO outbound_replies
        (user_id, gmail_account_id, conversation_id, property_id, trigger_message_id,
         idempotency_key, status, mode, body_text, to_address, subject,
         in_reply_to, references_header, gmail_thread_id, scheduled_at, decision_json)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, gmailAccountId, conversationId, propertyId, triggerMessageId,
        key, mode, bodyText, toAddress, subject,
        inReplyTo, references, gmailThreadId, scheduledAt,
        decision ? JSON.stringify(decision) : null,
      ]
    );
    return { id: result.insertId, created: true, status: STATUS.PENDING };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Someone got there first — that is the whole point of the constraint.
    const existing = await db.query(
      'SELECT id, status FROM outbound_replies WHERE idempotency_key = ? AND user_id = ?',
      [key, userId]
    );
    if (existing.length === 0) throw err;
    logger.info(`Réponse déjà en file pour la conversation ${conversationId} (statut ${existing[0].status})`);
    return { id: existing[0].id, created: false, status: existing[0].status };
  }
}

/**
 * A new guest message arrived while a reply was still waiting: push the
 * deadline back so the answer covers the whole burst rather than the first
 * sentence. Only ever moves a PENDING row, and never past the hard ceiling.
 */
async function extendDebounce(conversationId, userId) {
  const db = getDatabase();
  const rows = await db.query(
    `SELECT id, created_at FROM outbound_replies
     WHERE conversation_id = ? AND user_id = ? AND status = 'pending' AND mode = 'auto'`,
    [conversationId, userId]
  );
  if (rows.length === 0) return 0;

  let moved = 0;
  for (const row of rows) {
    // Ceiling measured from when the burst started, so a guest typing
    // continuously cannot postpone the reply indefinitely.
    const createdMs = parseDbTimestamp(row.created_at);
    const ceiling = Number.isFinite(createdMs) ? createdMs + DEBOUNCE_MAX_MS : Date.now() + DEBOUNCE_MS;
    // Never move the deadline EARLIER: extending is only ever about waiting
    // longer for the rest of the guest's burst.
    const target = Math.max(Math.min(Date.now() + DEBOUNCE_MS, ceiling), Date.now());

    const res = await db.query(
      `UPDATE outbound_replies SET scheduled_at = ?, updated_at = NOW()
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
      [new Date(target).toISOString().slice(0, 19).replace('T', ' '), row.id, userId]
    );
    moved += res.affectedRows || 0;
  }
  return moved;
}

/**
 * Claim one due row for this worker.
 *
 * The conditional UPDATE is the lock: `WHERE id = ? AND status = 'pending'`
 * means only one caller can flip it, whatever else is running.
 *
 * @returns {Promise<object|null>} the claimed row, or null if nothing is due
 */
async function claimNext() {
  const db = getDatabase();

  await reclaimStaleLocks();

  const candidates = await db.query(
    `SELECT r.* FROM outbound_replies r
     WHERE r.status = 'pending'
       AND (r.scheduled_at IS NULL OR r.scheduled_at <= NOW())
       AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= NOW())
       AND NOT EXISTS (
         SELECT 1 FROM outbound_replies s
         WHERE s.conversation_id = r.conversation_id AND s.status = 'sending'
       )
     ORDER BY r.id ASC
     LIMIT 10`
  );

  for (const row of candidates) {
    const claim = await db.query(
      `UPDATE outbound_replies
       SET status = 'sending', locked_by = ?, locked_at = NOW(), attempts = attempts + 1, updated_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [WORKER_ID, row.id]
    );
    // affectedRows === 0 → another worker claimed it between the SELECT and
    // this UPDATE. Not an error; just try the next candidate.
    if (claim.affectedRows === 1) {
      const fresh = await db.query('SELECT * FROM outbound_replies WHERE id = ?', [row.id]);
      return fresh[0] || null;
    }
  }

  return null;
}

/** Return rows stuck in `sending` by a dead worker to the pending pool. */
async function reclaimStaleLocks() {
  const db = getDatabase();
  const cutoff = nowIso(-LOCK_TIMEOUT_MS);
  const res = await db.query(
    `UPDATE outbound_replies
     SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = NOW()
     WHERE status = 'sending' AND locked_at IS NOT NULL AND locked_at < ?`,
    [cutoff]
  );
  if (res.affectedRows > 0) {
    logger.warn(`File d'envoi : ${res.affectedRows} verrou(x) périmé(s) libéré(s)`);
  }
  return res.affectedRows || 0;
}

async function markSent(id, { gmailMessageId, gmailThreadId }) {
  const db = getDatabase();
  await db.query(
    `UPDATE outbound_replies
     SET status = 'sent', sent_gmail_message_id = ?, sent_gmail_thread_id = ?,
         sent_at = NOW(), locked_by = NULL, locked_at = NULL, last_error = NULL, updated_at = NOW()
     WHERE id = ?`,
    [gmailMessageId || null, gmailThreadId || null, id]
  );
}

/**
 * Record a failure. Temporary problems come back with backoff; permanent ones
 * (bad recipient, missing scope, revoked token) stop immediately — retrying
 * them just burns quota and delays the host noticing.
 */
async function markFailed(id, error, { permanent = false } = {}) {
  const db = getDatabase();
  const rows = await db.query('SELECT attempts FROM outbound_replies WHERE id = ?', [id]);
  const attempts = rows[0]?.attempts || 1;
  const message = String(error?.message || error || 'erreur inconnue').slice(0, 500);

  const giveUp = permanent || attempts >= MAX_ATTEMPTS;
  if (giveUp) {
    await db.query(
      `UPDATE outbound_replies
       SET status = 'failed', last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = NOW()
       WHERE id = ?`,
      [message, id]
    );
    return { retrying: false, attempts };
  }

  const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  await db.query(
    `UPDATE outbound_replies
     SET status = 'pending', last_error = ?, next_attempt_at = ?,
         locked_by = NULL, locked_at = NULL, updated_at = NOW()
     WHERE id = ?`,
    [message, nowIso(delay), id]
  );
  return { retrying: true, attempts, retryInMs: delay };
}

/**
 * Re-arm a failed row. Never creates a second row — the idempotency key is
 * unchanged, so "retry" can be pressed repeatedly without risk.
 */
async function retry(id, userId) {
  const db = getDatabase();
  const res = await db.query(
    `UPDATE outbound_replies
     SET status = 'pending', next_attempt_at = NULL, scheduled_at = NULL,
         attempts = 0, last_error = NULL, locked_by = NULL, locked_at = NULL, updated_at = NOW()
     WHERE id = ? AND user_id = ? AND status IN ('failed', 'cancelled')`,
    [id, userId]
  );
  return res.affectedRows > 0;
}

/** Cancel a reply that has not gone out yet. */
async function cancel(id, userId) {
  const db = getDatabase();
  const res = await db.query(
    `UPDATE outbound_replies SET status = 'cancelled', updated_at = NOW()
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [id, userId]
  );
  return res.affectedRows > 0;
}

/** Latest queue entry for a conversation, for the UI status pill. */
async function latestForConversation(conversationId, userId) {
  const db = getDatabase();
  const rows = await db.query(
    `SELECT id, status, mode, attempts, last_error, sent_at, scheduled_at, created_at, decision_json
     FROM outbound_replies
     WHERE conversation_id = ? AND user_id = ?
     ORDER BY id DESC LIMIT 1`,
    [conversationId, userId]
  );
  return rows[0] || null;
}

/** Does this conversation already have a reply queued or sent for that message? */
async function existsForTrigger({ conversationId, triggerMessageId, gmailMessageId, userId }) {
  const db = getDatabase();
  const key = buildIdempotencyKey({ conversationId, triggerMessageId, gmailMessageId });
  const rows = await db.query(
    'SELECT id, status FROM outbound_replies WHERE idempotency_key = ? AND user_id = ?',
    [key, userId]
  );
  return rows[0] || null;
}

module.exports = {
  STATUS,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  DEBOUNCE_MS,
  DEBOUNCE_MAX_MS,
  LOCK_TIMEOUT_MS,
  WORKER_ID,
  parseDbTimestamp,
  buildIdempotencyKey,
  enqueue,
  extendDebounce,
  claimNext,
  reclaimStaleLocks,
  markSent,
  markFailed,
  retry,
  cancel,
  latestForConversation,
  existsForTrigger,
};

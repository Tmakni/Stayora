/**
 * Sync Scheduler
 * 
 * Periodically polls Airbnb API for new messages and reservation updates.
 * Broadcasts new messages to connected SSE clients for real-time display.
 */
const { getDatabase } = require('../config/db');
const airbnbSync = require('./airbnbSyncService');
const gmailSync = require('./gmailSyncService');
const logger = require('../utils/logger');

// SSE clients: Map<userId, Set<response>>
const sseClients = new Map();

// Scheduler state
let syncInterval = null;
let icalSyncInterval = null;
let initialSyncTimeout = null;
let airbnbSyncRunning = false;
let gmailSyncRunning = false;
let icalSyncRunning = false;
const SYNC_INTERVAL_MS = 60 * 1000; // 60 seconds
const ICAL_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function getIcalService() {
  return require('./icalService');
}

// ================================================================
// SSE Client management
// ================================================================

/**
 * Register an SSE client for a user
 */
function addSSEClient(userId, res) {
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  const clients = sseClients.get(userId);
  clients.add(res);
  logger.info(`SSE client connected for user ${userId} (total: ${clients.size})`);

  // Auto-cleanup on disconnect or error
  const cleanup = () => removeSSEClient(userId, res);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Remove an SSE client
 */
function removeSSEClient(userId, res) {
  const clients = sseClients.get(userId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(userId);
  }
}

/**
 * Get the number of SSE connections for a user
 */
function getSSEClientCount(userId) {
  const clients = sseClients.get(userId);
  return clients ? clients.size : 0;
}

/**
 * Send an SSE event to all connected clients for a user
 */
function sendToUser(userId, event, data) {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (err) {
      // Client disconnected, clean up
      clients.delete(res);
    }
  }
}

/**
 * Broadcast a new message event
 */
function broadcastNewMessage(userId, conversationId, message) {
  sendToUser(userId, 'new_message', {
    conversation_id: conversationId,
    message
  });
}

/**
 * Broadcast conversation list update
 */
function broadcastConversationUpdate(userId) {
  sendToUser(userId, 'conversations_updated', { timestamp: new Date().toISOString() });
}

// ================================================================
// Auto-polling scheduler
// ================================================================

/**
 * Run a sync cycle for all active Airbnb accounts
 */
async function runSyncCycle() {
  if (airbnbSyncRunning) { logger.info('Airbnb sync still running, skipping cycle'); return; }
  airbnbSyncRunning = true;
  const db = getDatabase();

  try {
    // Get all active Airbnb accounts across all users
    const accounts = await db.query(
      'SELECT id, user_id FROM airbnb_accounts WHERE is_active = TRUE'
    );

    if (accounts.length === 0) return;

    await runAccountsConcurrently(accounts, async (account) => {
      try {
        const sinceMessageId = await getMaxMessageId(db);

        const result = await airbnbSync.fetchMessages(account.user_id, account.id);

        // Skip the follow-up query entirely when the sync appended nothing.
        if (!result || result.synced > 0 || result.synced === undefined) {
          await broadcastMessagesSince(db, account.user_id, sinceMessageId);
        }
      } catch (err) {
        // Don't stop the whole cycle if one account fails
        logger.error(`Sync cycle failed for account ${account.id}:`, err.message);
      }
    });
  } catch (err) {
    logger.error('Sync cycle error:', err.message);
  } finally {
    airbnbSyncRunning = false;
  }
}

/**
 * Run a sync cycle for all active Gmail accounts
 */
async function runGmailSyncCycle() {
  if (gmailSyncRunning) { logger.info('Gmail sync still running, skipping cycle'); return; }
  gmailSyncRunning = true;
  const db = getDatabase();

  try {
    const accounts = await db.query(
      'SELECT id, user_id FROM gmail_accounts WHERE is_active = TRUE'
    );

    if (accounts.length === 0) return;

    await runAccountsConcurrently(accounts, async (account) => {
      try {
        const sinceMessageId = await getMaxMessageId(db);

        const result = await gmailSync.fetchMessages(account.user_id, account.id);

        if (!result || result.synced > 0 || result.synced === undefined) {
          await broadcastMessagesSince(db, account.user_id, sinceMessageId);
        }
      } catch (err) {
        if (err.message === 'GMAIL_INSUFFICIENT_SCOPES') {
          logger.error(`Gmail account ${account.id}: SCOPES MANQUANTS — le token ne contient pas gmail.readonly. L'utilisateur doit supprimer et reconnecter le compte Gmail.`);
        } else if (err.message === 'GMAIL_TOKEN_EXPIRED') {
          logger.error(`Gmail account ${account.id}: TOKEN EXPIRÉ — l'utilisateur doit reconnecter son compte Gmail.`);
          // Account already marked as error in getGmailAccount/fetchMessages
        } else {
          logger.error(`Gmail sync cycle failed for account ${account.id}: ${err.message}`);
        }
      }
    });
  } catch (err) {
    logger.error('Gmail sync cycle error:', err.message);
  } finally {
    gmailSyncRunning = false;
  }
}

/**
 * Run `worker` over every account with bounded concurrency.
 *
 * The cycles used to await one account at a time. Each Gmail account costs a
 * threads.list plus one threads.get per thread — hundreds of milliseconds of
 * pure network wait each — so with 100 connected accounts a strictly sequential
 * cycle could not finish anywhere near its 60s period, and the `syncRunning`
 * guard then skipped cycle after cycle: the last accounts in the list were
 * effectively never synced.
 *
 * Concurrency stays deliberately modest. These are I/O-bound API calls, but
 * every one of them writes through a single shared DB pool (max 1 connection on
 * SQLite, 15 on MySQL), and Gmail applies per-user rate limits of its own.
 */
const ACCOUNT_SYNC_CONCURRENCY = 4;

async function runAccountsConcurrently(accounts, worker) {
  let cursor = 0;

  async function drain() {
    for (;;) {
      const index = cursor++;
      if (index >= accounts.length) return;
      await worker(accounts[index]);
    }
  }

  const lanes = Math.min(ACCOUNT_SYNC_CONCURRENCY, accounts.length);
  await Promise.all(Array.from({ length: lanes }, drain));
}

/**
 * Fetch the messages inserted by a sync run, for SSE broadcast.
 *
 * Replaces the previous before/after full-count diff, which ran
 *   SELECT conversation_id, COUNT(*) … JOIN conversations … GROUP BY …
 * over the user's ENTIRE message history TWICE per account per 60s cycle —
 * two full scans per user per minute regardless of whether anything changed,
 * and the dominant DB cost of the scheduler at 100+ users.
 *
 * A sync only ever appends rows, so the new messages are exactly those with an
 * id greater than the table's max id captured just before the run. That is one
 * indexed lookup before, one narrow range scan after, and nothing at all when
 * the sync reported zero new messages.
 */
async function getMaxMessageId(db) {
  const rows = await db.query('SELECT MAX(id) AS max_id FROM messages');
  return (rows[0] && rows[0].max_id) || 0;
}

async function broadcastMessagesSince(db, userId, sinceMessageId) {
  const rows = await db.query(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
     FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id > ? AND c.user_id = ?
     ORDER BY m.id ASC
     LIMIT 200`,
    [sinceMessageId, userId]
  );

  if (rows.length === 0) return;

  for (const msg of rows) {
    broadcastNewMessage(userId, msg.conversation_id, {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      created_at: msg.created_at,
    });
  }
  broadcastConversationUpdate(userId);
}

/**
 * Start the auto-polling scheduler
 */
function startScheduler() {
  if (syncInterval) return; // Already running

  logger.info(`Starting sync scheduler (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
  syncInterval = setInterval(async () => {
    await runSyncCycle();
    await runGmailSyncCycle();
  }, SYNC_INTERVAL_MS);

  // iCal sync every 30 minutes
  logger.info(`Starting iCal sync scheduler (interval: ${ICAL_SYNC_INTERVAL_MS / 60000}min)`);
  icalSyncInterval = setInterval(() => {
    runIcalSyncCycle();
  }, ICAL_SYNC_INTERVAL_MS);

  // Run first sync after a short delay to let server fully start
  initialSyncTimeout = setTimeout(() => {
    initialSyncTimeout = null;
    runSyncCycle();
    runGmailSyncCycle();
    runIcalSyncCycle();
  }, 5000);
}

/**
 * Run iCal calendar sync for all registered calendars
 */
async function runIcalSyncCycle() {
  if (icalSyncRunning) return;
  icalSyncRunning = true;
  try {
    const icalService = getIcalService();
    await icalService.syncAllCalendars();
  } catch (err) {
    logger.error('iCal sync cycle error:', err.message);
  } finally {
    icalSyncRunning = false;
  }
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (icalSyncInterval) {
    clearInterval(icalSyncInterval);
    icalSyncInterval = null;
  }
  if (initialSyncTimeout) {
    clearTimeout(initialSyncTimeout);
    initialSyncTimeout = null;
  }
  logger.info('Sync scheduler stopped');
}

module.exports = {
  addSSEClient,
  removeSSEClient,
  getSSEClientCount,
  sendToUser,
  broadcastNewMessage,
  broadcastConversationUpdate,
  startScheduler,
  stopScheduler
};

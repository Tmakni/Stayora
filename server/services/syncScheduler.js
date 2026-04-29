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

    for (const account of accounts) {
      try {
        // Track message count before sync
        const beforeCounts = await getConversationMessageCounts(db, account.user_id);

        // Sync messages from Airbnb
        await airbnbSync.fetchMessages(account.user_id, account.id);

        // Check for new messages
        const afterCounts = await getConversationMessageCounts(db, account.user_id);

        let hasNewMessages = false;
        for (const [convId, count] of afterCounts) {
          const prevCount = beforeCounts.get(convId) || 0;
          if (count > prevCount) {
            hasNewMessages = true;
            // Get the new messages
            const newMsgs = await db.query(
              'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
              [convId, count - prevCount]
            );
            for (const msg of newMsgs) {
              broadcastNewMessage(account.user_id, convId, msg);
            }
          }
        }

        if (hasNewMessages) {
          broadcastConversationUpdate(account.user_id);
        }
      } catch (err) {
        // Don't stop the whole cycle if one account fails
        logger.error(`Sync cycle failed for account ${account.id}:`, err.message);
      }
    }
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

    for (const account of accounts) {
      try {
        const beforeCounts = await getConversationMessageCounts(db, account.user_id);

        await gmailSync.fetchMessages(account.user_id, account.id);

        const afterCounts = await getConversationMessageCounts(db, account.user_id);

        let hasNewMessages = false;
        for (const [convId, count] of afterCounts) {
          const prevCount = beforeCounts.get(convId) || 0;
          if (count > prevCount) {
            hasNewMessages = true;
            const newMsgs = await db.query(
              'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
              [convId, count - prevCount]
            );
            for (const msg of newMsgs) {
              broadcastNewMessage(account.user_id, convId, msg);
            }
          }
        }

        if (hasNewMessages) {
          broadcastConversationUpdate(account.user_id);
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
    }
  } catch (err) {
    logger.error('Gmail sync cycle error:', err.message);
  } finally {
    gmailSyncRunning = false;
  }
}

/**
 * Get message counts per conversation for a user (single query)
 */
async function getConversationMessageCounts(db, userId) {
  const rows = await db.query(
    `SELECT m.conversation_id, COUNT(*) as cnt
     FROM messages m
     INNER JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = ?
     GROUP BY m.conversation_id`,
    [userId]
  );

  const counts = new Map();
  for (const row of rows) {
    counts.set(row.conversation_id, row.cnt);
  }
  return counts;
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
  setTimeout(() => {
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

/**
 * Airbnb Sync Service
 * 
 * Handles communication with Airbnb's API to fetch:
 * - Inbox messages (guest conversations)
 * - Reservations and their statuses
 * - Listing details
 *
 * Uses the Airbnb private API endpoints (same as the mobile app).
 * Tokens are stored encrypted in the DB.
 */
const { getDatabase } = require('../config/db');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

const AIRBNB_API_BASE = 'https://api.airbnb.com/v2';
const AIRBNB_API_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20';  // Public Airbnb API key (same for all clients)

// ================================================================
// Token management
// ================================================================

/**
 * Store Airbnb credentials (encrypted) for a user
 */
async function saveAirbnbAccount(userId, { airbnbEmail, accessToken, refreshToken, airbnbUserId, displayName, expiresAt }) {
  const db = getDatabase();

  const accessTokenEnc = encrypt(accessToken);
  const refreshTokenEnc = refreshToken ? encrypt(refreshToken) : null;

  // Upsert: update if same email exists, otherwise insert
  const existing = await db.query(
    'SELECT id FROM airbnb_accounts WHERE user_id = ? AND airbnb_email = ?',
    [userId, airbnbEmail]
  );

  if (existing.length > 0) {
    await db.query(
      `UPDATE airbnb_accounts SET 
        access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?,
        airbnb_user_id = ?, display_name = ?, is_active = TRUE, updated_at = NOW()
       WHERE id = ?`,
      [accessTokenEnc, refreshTokenEnc, expiresAt || null, airbnbUserId || null, displayName || null, existing[0].id]
    );
    return existing[0].id;
  }

  const result = await db.query(
    `INSERT INTO airbnb_accounts (user_id, airbnb_email, access_token_enc, refresh_token_enc, token_expires_at, airbnb_user_id, display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, airbnbEmail, accessTokenEnc, refreshTokenEnc, expiresAt || null, airbnbUserId || null, displayName || null]
  );
  return result.insertId;
}

/**
 * Get decrypted Airbnb account for API calls
 */
async function getAirbnbAccount(userId, accountId) {
  const db = getDatabase();
  const rows = await db.query(
    'SELECT * FROM airbnb_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE',
    [accountId, userId]
  );
  if (rows.length === 0) return null;

  const account = rows[0];
  return {
    ...account,
    access_token: decrypt(account.access_token_enc),
    refresh_token: account.refresh_token_enc ? decrypt(account.refresh_token_enc) : null
  };
}

/**
 * Get all Airbnb accounts for a user
 */
async function getUserAirbnbAccounts(userId) {
  const db = getDatabase();
  const accounts = await db.query(
    'SELECT id, airbnb_email, airbnb_user_id, display_name, is_active, last_sync_at, sync_status, sync_error, created_at FROM airbnb_accounts WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return accounts;
}

// ================================================================
// Airbnb API calls
// ================================================================

/**
 * Make authenticated request to Airbnb API
 */
async function airbnbApiRequest(accessToken, endpoint, params = {}) {
  const url = new URL(`${AIRBNB_API_BASE}${endpoint}`);
  url.searchParams.set('key', AIRBNB_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: {
      'X-Airbnb-OAuth-Token': accessToken,
      'X-Airbnb-API-Key': AIRBNB_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Airbnb/23.49 iPhone/17.1 Type/Phone',
      'Accept': 'application/json'
    }
  });

  if (response.status === 401) {
    throw new Error('AIRBNB_TOKEN_EXPIRED');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Airbnb API error ${response.status}: ${text.substring(0, 500)}`);
  }

  return response.json();
}

/**
 * Make authenticated POST request to Airbnb API
 */
async function airbnbApiPost(accessToken, endpoint, body = {}) {
  const url = new URL(`${AIRBNB_API_BASE}${endpoint}`);
  url.searchParams.set('key', AIRBNB_API_KEY);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'X-Airbnb-OAuth-Token': accessToken,
      'X-Airbnb-API-Key': AIRBNB_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'Airbnb/23.49 iPhone/17.1 Type/Phone',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (response.status === 401) {
    throw new Error('AIRBNB_TOKEN_EXPIRED');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Airbnb API error ${response.status}: ${text.substring(0, 500)}`);
  }

  return response.json();
}

// ================================================================
// Send message to Airbnb thread
// ================================================================

/**
 * Send a message to an Airbnb thread
 * @param {number} userId - Internal user ID
 * @param {number} accountId - Airbnb account ID
 * @param {string} threadId - Airbnb thread ID
 * @param {string} message - Message content to send
 * @returns {object} Airbnb API response
 */
async function sendMessageToThread(userId, accountId, threadId, message) {
  const account = await getAirbnbAccount(userId, accountId);
  if (!account) throw new Error('Airbnb account not found');

  if (!threadId || !message || !message.trim()) {
    throw new Error('Thread ID and message content are required');
  }

  logger.info(`Sending message to Airbnb thread ${threadId} for account ${accountId}`);

  const result = await airbnbApiPost(account.access_token, `/threads/${threadId}/reply`, {
    message: message.trim()
  });

  logger.info(`Message sent to Airbnb thread ${threadId} successfully`);
  return result;
}

// ================================================================
// Fetch reservations from Airbnb
// ================================================================

/**
 * Fetch all reservations for an Airbnb account
 */
async function fetchReservations(userId, accountId) {
  const account = await getAirbnbAccount(userId, accountId);
  if (!account) throw new Error('Airbnb account not found');

  const db = getDatabase();

  // Log sync start
  const logResult = await db.query(
    'INSERT INTO sync_logs (user_id, airbnb_account_id, sync_type, status) VALUES (?, ?, ?, ?)',
    [userId, accountId, 'reservations', 'started']
  );
  const syncLogId = logResult.insertId;

  try {
    // Fetch ALL reservations with pagination
    let allReservations = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const data = await airbnbApiRequest(account.access_token, '/reservations', {
        _format: 'for_mobile_host',
        _limit: limit,
        _offset: offset,
        host_id: account.airbnb_user_id
      });

      const reservations = data.reservations || [];
      allReservations = allReservations.concat(reservations);

      if (reservations.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    logger.info(`Fetched ${allReservations.length} total reservations for account ${accountId}`);
    let synced = 0;

    for (const resa of allReservations) {
      await upsertReservation(userId, accountId, resa);
      synced++;
    }

    // Update sync log
    await db.query(
      'UPDATE sync_logs SET status = ?, items_synced = ?, completed_at = NOW() WHERE id = ?',
      ['completed', synced, syncLogId]
    );

    // Update account last sync
    await db.query(
      'UPDATE airbnb_accounts SET last_sync_at = NOW(), sync_status = ?, sync_error = NULL WHERE id = ?',
      ['idle', accountId]
    );

    logger.info(`Synced ${synced} reservations for account ${accountId}`);
    return { synced, reservations: allReservations.length };
  } catch (error) {
    await db.query(
      'UPDATE sync_logs SET status = ?, error_message = ?, completed_at = NOW() WHERE id = ?',
      ['failed', error.message, syncLogId]
    );
    await db.query(
      'UPDATE airbnb_accounts SET sync_status = ?, sync_error = ? WHERE id = ?',
      ['error', error.message, accountId]
    );
    throw error;
  }
}

/**
 * Upsert a single reservation from Airbnb API data
 */
async function upsertReservation(userId, accountId, resa) {
  const db = getDatabase();
  const airbnbResaId = String(resa.id || resa.confirmation_code);

  // Map Airbnb status to our enum
  const statusMap = {
    'pending': 'pending',
    'accept': 'accepted',
    'accepted': 'accepted',
    'confirmed': 'confirmed',
    'checkpoint': 'checkedin',
    'checked_in': 'checkedin',
    'checkout': 'checkedout',
    'checked_out': 'checkedout',
    'cancelled': 'cancelled',
    'canceled': 'cancelled',
    'denied': 'denied',
    'declined': 'denied',
    'expired': 'expired',
    'timedout': 'expired'
  };

  const status = statusMap[String(resa.status || resa.user_facing_status || '').toLowerCase()] || 'pending';

  // Find matching property in our DB
  let propertyId = null;
  const listingId = String(resa.listing_id || resa.listing?.id || '');
  if (listingId) {
    // Try to match by airbnb_listing_id in context_json or superhot_listing_id
    const props = await db.query(
      "SELECT id FROM property_profiles WHERE user_id = ? AND (superhot_listing_id = ? OR context_json LIKE ?)",
      [userId, listingId, `%"airbnb_listing_id":"${listingId}"%`]
    );
    if (props.length > 0) propertyId = props[0].id;
  }

  // Check if reservation already exists
  const existing = await db.query(
    'SELECT id, status FROM reservations WHERE airbnb_reservation_id = ?',
    [airbnbResaId]
  );

  const guestName = resa.guest?.first_name
    ? `${resa.guest.first_name} ${resa.guest.last_name || ''}`.trim()
    : resa.guest_details?.localized_name || 'Voyageur';

  if (existing.length > 0) {
    const prev = existing[0];
    const statusChanged = prev.status !== status;

    await db.query(
      `UPDATE reservations SET 
        status = ?, previous_status = ?, status_changed_at = ?,
        guest_name = ?, number_of_guests = ?,
        total_price = ?, host_payout = ?,
        airbnb_raw_json = ?, last_synced_at = NOW(), property_id = COALESCE(?, property_id)
       WHERE id = ?`,
      [
        status,
        statusChanged ? prev.status : prev.previous_status,
        statusChanged ? new Date() : prev.status_changed_at,
        guestName,
        resa.number_of_guests || resa.guest_details?.number_of_guests || 1,
        resa.expected_payout_amount_before_taxes || resa.total_paid_amount_accurate || null,
        resa.host_payout_amount || resa.expected_payout_amount_accurate || null,
        JSON.stringify(resa),
        propertyId,
        prev.id
      ]
    );

    // Update linked conversation status if status changed
    if (statusChanged) {
      await syncConversationStatus(prev.id, status);
    }

    return prev.id;
  }

  // Insert new reservation
  const result = await db.query(
    `INSERT INTO reservations (
      user_id, property_id, airbnb_account_id, airbnb_reservation_id, airbnb_listing_id,
      confirmation_code, guest_name, guest_email, guest_phone, number_of_guests,
      check_in_date, check_out_date, booked_at,
      total_price, currency, host_payout, status,
      airbnb_raw_json, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      userId,
      propertyId,
      accountId,
      airbnbResaId,
      listingId || null,
      resa.confirmation_code || null,
      guestName,
      resa.guest?.email || null,
      resa.guest?.phone || null,
      resa.number_of_guests || 1,
      resa.start_date || resa.checkin || new Date(),
      resa.end_date || resa.checkout || new Date(),
      resa.booked_at || resa.created_at || null,
      resa.expected_payout_amount_before_taxes || null,
      resa.listing_base_price_currency || 'EUR',
      resa.host_payout_amount || null,
      status,
      JSON.stringify(resa)
    ]
  );

  return result.insertId;
}

/**
 * Sync conversation booking_status when reservation status changes on Airbnb
 */
async function syncConversationStatus(reservationId, newStatus) {
  const db = getDatabase();

  // Map reservation status to conversation booking_status
  const convStatusMap = {
    'pending': 'inquiry',
    'accepted': 'request',
    'confirmed': 'confirmed',
    'checkedin': 'checkedin',
    'checkedout': 'checkedout',
    'cancelled': 'checkedout',
    'denied': 'checkedout',
    'expired': 'checkedout'
  };

  const convStatus = convStatusMap[newStatus] || 'inquiry';

  await db.query(
    'UPDATE conversations SET booking_status = ? WHERE reservation_id = ?',
    [convStatus, reservationId]
  );
}

// ================================================================
// Fetch messages from Airbnb inbox
// ================================================================

/**
 * Fetch inbox threads from Airbnb
 */
async function fetchMessages(userId, accountId) {
  const account = await getAirbnbAccount(userId, accountId);
  if (!account) throw new Error('Airbnb account not found');

  const db = getDatabase();

  const logResult = await db.query(
    'INSERT INTO sync_logs (user_id, airbnb_account_id, sync_type, status) VALUES (?, ?, ?, ?)',
    [userId, accountId, 'messages', 'started']
  );
  const syncLogId = logResult.insertId;

  try {
    // Fetch ALL threads with pagination
    let allThreads = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const data = await airbnbApiRequest(account.access_token, '/threads', {
        _format: 'for_messaging_sync_with_posts',
        _limit: limit,
        _offset: offset,
        role: 'host'
      });

      const threads = data.threads || [];
      allThreads = allThreads.concat(threads);

      if (threads.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    logger.info(`Fetched ${allThreads.length} total threads for account ${accountId}`);
    let synced = 0;

    for (const thread of allThreads) {
      await syncThread(userId, accountId, account.access_token, thread);
      synced++;
    }

    await db.query(
      'UPDATE sync_logs SET status = ?, items_synced = ?, completed_at = NOW() WHERE id = ?',
      ['completed', synced, syncLogId]
    );

    await db.query(
      'UPDATE airbnb_accounts SET last_sync_at = NOW(), sync_status = ?, sync_error = NULL WHERE id = ?',
      ['idle', accountId]
    );

    logger.info(`Synced ${synced} message threads for account ${accountId}`);
    return { synced, threads: allThreads.length };
  } catch (error) {
    await db.query(
      'UPDATE sync_logs SET status = ?, error_message = ?, completed_at = NOW() WHERE id = ?',
      ['failed', error.message, syncLogId]
    );
    await db.query(
      'UPDATE airbnb_accounts SET sync_status = ?, sync_error = ? WHERE id = ?',
      ['error', error.message, accountId]
    );
    throw error;
  }
}

/**
 * Sync a single Airbnb thread into our DB
 */
async function syncThread(userId, accountId, accessToken, thread) {
  const db = getDatabase();
  const threadId = String(thread.id);

  // Get or create airbnb_threads record
  const existingThread = await db.query(
    'SELECT id, conversation_id FROM airbnb_threads WHERE airbnb_account_id = ? AND airbnb_thread_id = ?',
    [accountId, threadId]
  );

  const guestName = thread.other_user?.first_name
    ? `${thread.other_user.first_name} ${thread.other_user.last_name || ''}`.trim()
    : 'Voyageur';
  const guestAirbnbId = thread.other_user?.id ? String(thread.other_user.id) : null;
  const listingName = thread.listing?.name || '';
  const listingId = thread.listing?.id ? String(thread.listing.id) : null;

  let dbThreadId, conversationId;

  if (existingThread.length > 0) {
    dbThreadId = existingThread[0].id;
    conversationId = existingThread[0].conversation_id;

    await db.query(
      'UPDATE airbnb_threads SET guest_name = ?, last_message_at = ?, unread_count = ?, last_synced_at = NOW() WHERE id = ?',
      [guestName, thread.last_message_sent_at || new Date(), thread.unread_count || 0, dbThreadId]
    );
  } else {
    // Find matching reservation
    let reservationId = null;
    if (thread.reservation?.id) {
      const resas = await db.query(
        'SELECT id FROM reservations WHERE airbnb_reservation_id = ?',
        [String(thread.reservation.id)]
      );
      if (resas.length > 0) reservationId = resas[0].id;
    }

    // Find matching property
    let propertyId = null;
    if (listingId) {
      const props = await db.query(
        "SELECT id FROM property_profiles WHERE user_id = ? AND (superhot_listing_id = ? OR context_json LIKE ?)",
        [userId, listingId, `%"airbnb_listing_id":"${listingId}"%`]
      );
      if (props.length > 0) propertyId = props[0].id;
    }

    // Create conversation for this thread
    const convResult = await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, property_id, reservation_id, airbnb_thread_id, external_id, external_provider, guest_name, guest_language)
       VALUES (?, ?, 'inquiry', ?, ?, ?, ?, 'airbnb', ?, 'fr')`,
      [userId, `${guestName} – ${listingName || 'Airbnb'}`, propertyId, reservationId, threadId, threadId, guestName]
    );
    conversationId = convResult.insertId;

    // Create airbnb_threads record
    const threadResult = await db.query(
      `INSERT INTO airbnb_threads (user_id, airbnb_account_id, airbnb_thread_id, reservation_id, conversation_id, guest_name, guest_airbnb_id, listing_name, airbnb_listing_id, last_message_at, unread_count, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, accountId, threadId, reservationId, conversationId, guestName, guestAirbnbId, listingName, listingId, thread.last_message_sent_at || new Date(), thread.unread_count || 0]
    );
    dbThreadId = threadResult.insertId;
  }

  // Fetch and sync individual messages for this thread
  if (conversationId) {
    await syncThreadMessages(userId, accessToken, threadId, conversationId);
  }

  return dbThreadId;
}

/**
 * Fetch and sync messages within a specific thread
 */
async function syncThreadMessages(userId, accessToken, airbnbThreadId, conversationId) {
  const db = getDatabase();

  try {
    // Fetch ALL messages in thread with pagination
    let allPosts = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;
    let threadData = null;

    while (hasMore) {
      const data = await airbnbApiRequest(accessToken, `/threads/${airbnbThreadId}`, {
        _format: 'for_messaging_sync_with_posts',
        _limit: limit,
        _offset: offset
      });

      if (!threadData) threadData = data;

      const posts = data.thread?.posts || data.posts || [];
      allPosts = allPosts.concat(posts);

      if (posts.length < limit) {
        hasMore = false;
      } else {
        offset += limit;
      }
    }

    const posts = allPosts;
    let newMessages = 0;

    // Get existing message IDs to avoid duplicates
    const existingMsgs = await db.query(
      "SELECT metadata_json FROM messages WHERE conversation_id = ? AND metadata_json IS NOT NULL",
      [conversationId]
    );
    const existingAirbnbIds = new Set();
    for (const msg of existingMsgs) {
      try {
        const meta = JSON.parse(msg.metadata_json);
        if (meta.airbnb_message_id) existingAirbnbIds.add(meta.airbnb_message_id);
      } catch (_) {}
    }

    for (const post of posts) {
      const msgId = String(post.id);
      if (existingAirbnbIds.has(msgId)) continue;

      const hostId = threadData?.thread?.host_id
        || threadData?.thread?.other_user_id_for_host
        || '0';
      const isHost = post.user_id === parseInt(hostId);
      const role = isHost ? 'outgoing' : 'incoming';

      // Extract content from all possible Airbnb message fields
      const content = post.message
        || post.body
        || post.localized_message
        || post.text
        || (post.structured_message && post.structured_message.text)
        || (post.structured_message && post.structured_message.body)
        || post.preview
        || '';

      // For system/automated messages, try additional fields
      const messageType = post.message_type || post.type || 'text';
      const isSystemMsg = ['system', 'booking_confirmation', 'alteration',
        'cancellation', 'review', 'special_offer', 'pre_approval',
        'pending_pre_approval', 'resolution_center'].includes(messageType);

      if (!content.trim()) {
        // Skip truly empty messages, but log for debugging
        if (post.message_type) {
          logger.debug(`Skipping empty ${post.message_type} message ${msgId} in thread ${airbnbThreadId}`);
        }
        continue;
      }

      // System messages from Airbnb become 'system' role
      const finalRole = isSystemMsg ? 'system' : role;

      await db.query(
        'INSERT INTO messages (conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
        [
          conversationId,
          finalRole,
          content,
          JSON.stringify({
            source: 'airbnb_sync',
            airbnb_message_id: msgId,
            airbnb_thread_id: airbnbThreadId,
            user_id: post.user_id,
            message_type: messageType,
            created_at: post.created_at
          }),
          post.created_at ? new Date(post.created_at) : new Date()
        ]
      );
      newMessages++;
    }

    if (newMessages > 0) {
      logger.info(`Synced ${newMessages} new messages for thread ${airbnbThreadId}`);
    }

    return newMessages;
  } catch (error) {
    logger.error(`Error syncing messages for thread ${airbnbThreadId}:`, error.message);
    return 0;
  }
}

// ================================================================
// Full sync (reservations + messages)
// ================================================================

/**
 * Full sync: reservations then messages for an account
 */
async function fullSync(userId, accountId) {
  const db = getDatabase();

  await db.query(
    'UPDATE airbnb_accounts SET sync_status = ? WHERE id = ?',
    ['syncing', accountId]
  );

  const results = { reservations: null, messages: null };

  try {
    results.reservations = await fetchReservations(userId, accountId);
  } catch (err) {
    logger.error('Reservation sync failed:', err.message);
    results.reservations = { error: err.message };
  }

  try {
    results.messages = await fetchMessages(userId, accountId);
  } catch (err) {
    logger.error('Message sync failed:', err.message);
    results.messages = { error: err.message };
  }

  return results;
}

/**
 * Remove an Airbnb account (soft delete — deactivate)
 */
async function deactivateAccount(userId, accountId) {
  const db = getDatabase();
  await db.query(
    'UPDATE airbnb_accounts SET is_active = FALSE, access_token_enc = NULL, refresh_token_enc = NULL WHERE id = ? AND user_id = ?',
    [accountId, userId]
  );
}

module.exports = {
  saveAirbnbAccount,
  getAirbnbAccount,
  getUserAirbnbAccounts,
  fetchReservations,
  fetchMessages,
  fullSync,
  deactivateAccount,
  syncConversationStatus,
  sendMessageToThread
};

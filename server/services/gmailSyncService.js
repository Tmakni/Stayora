/**
 * Gmail Sync Service
 *
 * Fetches emails from Gmail via the Google API and inserts them as
 * incoming messages in the conversation system — exactly the same
 * flow as the Airbnb sync but via IMAP-style REST (Gmail API v1).
 *
 * OAuth2 tokens are stored AES-256-GCM encrypted, identical to airbnb_accounts.
 */
const { gmail } = require('@googleapis/gmail');
const { OAuth2Client } = require('google-auth-library');
const { getDatabase } = require('../config/db');
const { encrypt, decrypt } = require('../utils/encryption');
const { sanitizeEmail, sanitizeString } = require('../utils/sanitize');
const logger = require('../utils/logger');
const {
  FALLBACK_GUEST_NAME,
  extractGuestNameFromThread,
  extractRoleBlocks,
  shouldReplaceStoredName,
  nameKey,
} = require('./guestNameExtractor');

// ================================================================
// OAuth2 helper
// ================================================================

function makeOAuth2Client() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Build an authenticated Gmail client from stored tokens
 */
function getGmailClient(accessToken, refreshToken) {
  const oauth2 = makeOAuth2Client();
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  return gmail({ version: 'v1', auth: oauth2 });
}

// ================================================================
// Token / account management
// ================================================================

/**
 * Exchange the one-time auth code for tokens & store in DB
 */
async function saveGmailAccount(userId, { email, accessToken, refreshToken, expiresAt, grantedScopes, canSend }) {
  const db = getDatabase();

  const accessTokenEnc = encrypt(accessToken);
  const refreshTokenEnc = refreshToken ? encrypt(refreshToken) : null;

  const existing = await db.query(
    'SELECT id, refresh_token_enc FROM gmail_accounts WHERE user_id = ? AND email = ?',
    [userId, email]
  );

  if (existing.length > 0) {
    // Keep the previous refresh token if Google did not return a new one.
    const refreshTokenToStore = refreshTokenEnc || existing[0].refresh_token_enc || null;
    await db.query(
      `UPDATE gmail_accounts SET
        access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?,
        granted_scopes = ?, can_send = ?,
        is_active = TRUE, sync_status = 'idle', sync_error = NULL, updated_at = NOW()
       WHERE id = ?`,
      [
        accessTokenEnc, refreshTokenToStore, expiresAt || null,
        grantedScopes || null, canSend ? 1 : 0,
        existing[0].id,
      ]
    );
    return existing[0].id;
  }

  const result = await db.query(
    `INSERT INTO gmail_accounts (user_id, email, access_token_enc, refresh_token_enc, token_expires_at, granted_scopes, can_send)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, email, accessTokenEnc, refreshTokenEnc, expiresAt || null, grantedScopes || null, canSend ? 1 : 0]
  );
  return result.insertId;
}

/**
 * Get decrypted Gmail account for API calls.
 * Automatically refreshes the access_token if a refresh_token is available.
 * Validates that token has the required gmail.readonly scope.
 */
async function getGmailAccount(userId, accountId) {
  const db = getDatabase();
  const rows = await db.query(
    'SELECT * FROM gmail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE',
    [accountId, userId]
  );
  if (rows.length === 0) return null;

  const account = rows[0];
  let accessToken = decrypt(account.access_token_enc);
  let refreshToken = account.refresh_token_enc ? decrypt(account.refresh_token_enc) : null;

  const expiresAtMs = account.token_expires_at ? new Date(account.token_expires_at).getTime() : null;
  const shouldRefresh = !!refreshToken && (!expiresAtMs || (expiresAtMs - Date.now()) <= 120000);

  // Auto-refresh only when token is close to expiry.
  if (shouldRefresh) {
    try {
      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
      const { tokens: credentials } = await oauth2.refreshToken(refreshToken);
      logger.info(`Gmail token refresh for account ${accountId}: scopes="${credentials.scope || 'N/A'}", hasNewToken=${!!(credentials.access_token && credentials.access_token !== accessToken)}`);

      // Check if the refreshed token has the gmail.readonly scope
      const grantedScopes = (credentials.scope || '').split(' ');
      const hasGmailScope = grantedScopes.some(s => s.includes('gmail.readonly') || s.includes('gmail.modify') || s.includes('mail.google.com'));
      if (credentials.scope && !hasGmailScope) {
        logger.error(`Gmail account ${accountId} (${account.email}): token missing gmail.readonly scope. Granted scopes: ${credentials.scope}. Account needs re-authorization.`);
        await db.query(
          'UPDATE gmail_accounts SET sync_status = ?, sync_error = ? WHERE id = ?',
          ['error', 'Token missing gmail.readonly scope — cliquez Réautoriser', account.id]
        );
        throw new Error('GMAIL_INSUFFICIENT_SCOPES');
      }

      let hasTokenUpdate = false;
      if (credentials.access_token && credentials.access_token !== accessToken) {
        accessToken = credentials.access_token;
        hasTokenUpdate = true;
      }
      if (credentials.refresh_token && credentials.refresh_token !== refreshToken) {
        refreshToken = credentials.refresh_token;
        hasTokenUpdate = true;
      }

      if (hasTokenUpdate || credentials.expiry_date) {
        await db.query(
          'UPDATE gmail_accounts SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = NOW() WHERE id = ?',
          [
            encrypt(accessToken),
            refreshToken ? encrypt(refreshToken) : null,
            credentials.expiry_date ? new Date(credentials.expiry_date) : null,
            account.id
          ]
        );
        logger.info(`Gmail token refreshed and saved for account ${accountId}`);
      }

      // Google returns the effective scope set on every refresh. Recording it
      // here is what lets an account that already carries gmail.send start
      // sending without a manual reconnect — and, symmetrically, what revokes
      // sending the moment the grant is narrowed. Before this, granted_scopes
      // was written only in the OAuth callback, so every account connected
      // before the send scope existed stayed can_send = 0 forever.
      if (credentials.scope) {
        const canSend = hasSendScope(credentials.scope);
        if (credentials.scope !== account.granted_scopes || !!canSend !== !!account.can_send) {
          await db.query(
            'UPDATE gmail_accounts SET granted_scopes = ?, can_send = ? WHERE id = ?',
            [credentials.scope, canSend ? 1 : 0, account.id]
          );
          account.granted_scopes = credentials.scope;
          account.can_send = canSend ? 1 : 0;
          logger.info(`Gmail account ${accountId}: scopes recorded, can_send=${canSend}`);
        }
      }
    } catch (err) {
      if (err.message === 'GMAIL_INSUFFICIENT_SCOPES') throw err;

      const refreshErrorCode = err.response?.data?.error || '';
      const refreshErrorDesc = err.response?.data?.error_description || '';
      const errorText = [err.message || '', refreshErrorCode, refreshErrorDesc].join(' ');
      const isInvalidGrant = /invalid_grant|expired or revoked|token has been revoked/i.test(errorText);

      if (isInvalidGrant) {
        logger.error(`Gmail account ${accountId} (${account.email}): refresh token revoked/expired. User must re-authorize.`);
        await db.query(
          'UPDATE gmail_accounts SET sync_status = ?, sync_error = ? WHERE id = ?',
          ['error', 'Token Gmail expiré ou révoqué. Si cela arrive après 7 jours, passez votre app OAuth Google en mode Production.', account.id]
        );
        throw new Error('GMAIL_TOKEN_EXPIRED');
      }

      logger.warn(`Gmail token refresh failed for account ${accountId}: ${err.message}`);
      // Continue with existing token — it may still be valid
    }
  } else if (!refreshToken) {
    logger.warn(`Gmail account ${accountId} (${account.email}): no refresh token stored — cannot refresh access token`);
  }

  return { ...account, access_token: accessToken, refresh_token: refreshToken };
}

/**
 * List Gmail accounts for a user (public info only)
 */
async function getUserGmailAccounts(userId) {
  const db = getDatabase();
  // can_send drives the "Réautoriser" prompt: accounts connected before the
  // gmail.send scope was added hold a token that cannot send.
  return db.query(
    `SELECT id, email, is_active, last_sync_at, sync_status, sync_error, can_send, created_at
     FROM gmail_accounts WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
}

/**
 * Deactivate (soft-delete) a Gmail account
 */
async function deactivateAccount(userId, accountId) {
  const db = getDatabase();
  await db.query(
    'UPDATE gmail_accounts SET is_active = FALSE, access_token_enc = NULL, refresh_token_enc = NULL WHERE id = ? AND user_id = ?',
    [accountId, userId]
  );
}

// ================================================================
// Gmail message fetching
// ================================================================

/**
 * Fetch emails from Gmail and insert them as conversations.
 *
 * Strategy:
 *   1. Search Gmail for inbox emails
 *   2. For each email thread: extract sender name, subject, message body
 *   3. For Airbnb emails: also extract guest name & match to property
 *   4. Create or update a conversation with sender name and message content
 *
 * @param {number} userId
 * @param {number} accountId
 * @param {boolean} [forceFullSync=false] — ignore last_sync_at, fetch everything
 */
async function fetchMessages(userId, accountId, forceFullSync = false) {
  const account = await getGmailAccount(userId, accountId);
  if (!account) throw new Error('Gmail account not found');

  const db = getDatabase();

  // Log sync start
  const logResult = await db.query(
    'INSERT INTO sync_logs (user_id, airbnb_account_id, sync_type, status) VALUES (?, ?, ?, ?)',
    [userId, null, 'messages', 'started']
  );
  const syncLogId = logResult.insertId;

  try {
    const gmail = getGmailClient(account.access_token, account.refresh_token);

    // Fetch ALL Airbnb notification emails (no in:inbox — catches archived/filtered)
    let q = 'from:airbnb';
    if (!forceFullSync && account.last_sync_at) {
      // 5-minute safety buffer to avoid missing messages during sync gaps
      const safetyBufferSeconds = 300;
      const afterEpoch = Math.floor(new Date(account.last_sync_at).getTime() / 1000) - safetyBufferSeconds;
      q += ` after:${afterEpoch}`;
    }
    if (forceFullSync) {
      logger.info(`Gmail sync: FORCE FULL SYNC for account ${accountId} (ignoring last_sync_at)`);
    }
    logger.info(`Gmail sync: query = "${q}"`);

    // Use threads.list with pagination to fetch ALL matching threads
    let threads = [];
    let pageToken = null;
    let pageCount = 0;
    do {
      const listResp = await gmail.users.threads.list({
        userId: 'me',
        q,
        maxResults: 200,
        ...(pageToken && { pageToken })
      });
      const pageThreads = listResp.data.threads || [];
      threads.push(...pageThreads);
      pageToken = listResp.data.nextPageToken;
      pageCount++;
      logger.info(`Gmail sync: page ${pageCount} → ${pageThreads.length} threads (nextPageToken: ${pageToken ? 'yes' : 'no'})`);
    } while (pageToken);

    logger.info(`Gmail sync: found ${threads.length} total threads for account ${accountId} (query: "${q}")`);

    if (threads.length === 0) {
      await finishSyncLog(db, syncLogId, 0, accountId);
      return { synced: 0, threads: 0 };
    }

    // Load user's properties once for matching
    const properties = await db.query(
      'SELECT id, name, superhot_listing_id, context_json FROM property_profiles WHERE user_id = ?',
      [userId]
    );

    // Fetch full thread data in parallel batches (each threads.get returns ALL messages)
    const BATCH_SIZE = 5;
    const threadMap = new Map(); // threadId → [gmailMsg, …]
    for (let i = 0; i < threads.length; i += BATCH_SIZE) {
      const batch = threads.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(t =>
        gmail.users.threads.get({
          userId: 'me',
          id: t.id,
          format: 'full'
        }).catch(err => {
          logger.warn(`Gmail thread fetch failed for ${t.id}: ${err.message}`);
          return null;
        })
      ));
      for (const res of results) {
        if (!res || !res.data || !res.data.messages) continue;
        const threadId = res.data.id;
        const msgCount = res.data.messages.length;
        logger.info(`Gmail sync: thread ${threadId} has ${msgCount} message(s)`);
        threadMap.set(threadId, res.data.messages);
      }
    }

    logger.info(`Gmail sync: loaded ${threadMap.size} threads with full message data`);

    // Names Airbnb has labelled "Hôte"/"Co-hôte" for this account, accumulated
    // across every past sync. Shared by all threads of this run so a guest
    // writing "Bonjour Delphine," can never make the HOST's name the guest name.
    const hostNames = loadHostNames(account);
    const hostNamesBefore = hostNames.size;

    let synced = 0;
    let skipped = 0;
    for (const [threadId, msgs] of threadMap) {
      try {
        const count = await syncGmailThread(userId, accountId, account, gmail, threadId, msgs, properties, hostNames);
        synced += count;
        if (count === 0) skipped++;
      } catch (threadErr) {
        logger.warn(`Gmail sync thread ${threadId} failed: ${threadErr.message}`);
      }
    }

    if (hostNames.size > hostNamesBefore) {
      await persistHostNames(db, accountId, hostNames);
    }

    logger.info(`Gmail sync: DONE — ${synced} new messages saved, ${skipped} threads skipped (no new messages)`);
    await finishSyncLog(db, syncLogId, synced, accountId);
    return { synced, threads: threadMap.size };
  } catch (error) {
    await db.query(
      'UPDATE sync_logs SET status = ?, error_message = ?, completed_at = NOW() WHERE id = ?',
      ['failed', error.message, syncLogId]
    );

    // Provide clear error message for scope issues
    let userMessage = error.message;
    let isTokenExpired = false;

    if (error.message === 'GMAIL_TOKEN_EXPIRED') {
      userMessage = 'Token expiré ou révoqué — veuillez reconnecter votre compte Gmail';
      isTokenExpired = true;
    } else if (error.message === 'GMAIL_INSUFFICIENT_SCOPES') {
      userMessage = 'Le token Gmail ne contient pas le scope gmail.readonly. Cliquez Réautoriser.';
      logger.error(`Gmail account ${accountId}: insufficient scopes — user must re-authorize`);
    } else if (error.message && (error.message.includes('insufficient') || error.message.includes('Insufficient Permission'))) {
      userMessage = 'Scopes insuffisants. Activez l\'API Gmail dans Google Cloud Console puis cliquez Réautoriser.';
      logger.error(`Gmail account ${accountId}: API returned insufficient scopes error.`);
    } else if (error.code === 401 || (error.message && error.message.includes('invalid_grant'))) {
      userMessage = 'Token expiré ou révoqué — veuillez reconnecter votre compte Gmail';
      isTokenExpired = true;
    }

    await db.query(
      'UPDATE gmail_accounts SET sync_status = ?, sync_error = ? WHERE id = ?',
      ['error', userMessage, accountId]
    );

    if (isTokenExpired) {
      throw new Error('GMAIL_TOKEN_EXPIRED');
    }
    throw error;
  }
}

// ================================================================
// Internal helpers
// ================================================================

/**
 * Sync a single Gmail thread into the conversation system.
 * Handles both Airbnb notification emails and general emails.
 */
async function syncGmailThread(userId, accountId, account, gmail, threadId, fullMsgs, properties, hostNames) {
  const db = getDatabase();
  const knownHostNames = hostNames || new Set();

  // Check if we already track this thread
  const existing = await db.query(
    'SELECT id, conversation_id FROM gmail_threads WHERE gmail_account_id = ? AND gmail_thread_id = ?',
    [accountId, threadId]
  );

  // Extract subject & sender from the first message (already full format)
  const firstMsg = fullMsgs[0];
  const headers = parseHeaders(firstMsg);
  const subject = headers.subject || '(sans objet)';
  const senderEmail = extractEmail(headers.from || '');
  const senderDisplayName = extractName(headers.from || '') || senderEmail;

  // Detect if ANY message in the thread is from Airbnb (not just the first)
  // This prevents missing threads where the host sent the first message
  const isAirbnb = fullMsgs.some(msg => {
    const from = extractEmail((parseHeaders(msg).from || ''));
    return from.includes('airbnb');
  });
  logger.info(`Gmail sync thread ${threadId}: from="${senderDisplayName}" <${senderEmail}>, subject="${subject}", isAirbnb=${isAirbnb}`);

  // Skip non-Airbnb emails — we only want Airbnb conversations
  if (!isAirbnb) {
    logger.info(`Gmail sync: skipping thread ${threadId} — not from Airbnb`);
    return 0;
  }

  // Decode every body ONCE up front. extractBody() walks the MIME tree and
  // base64-decodes it, and the old flow ran it twice per message (once here for
  // the first message, once again in the insert loop) — on a 200-thread mailbox
  // that is thousands of redundant decodes per sync.
  const decodedBodies = fullMsgs.map(msg => {
    try {
      return extractBody(msg);
    } catch (_) {
      return '';
    }
  });

  let firstBody = '';
  let airbnbThreadId = null;
  let airbnbReplyUrl = null;
  try {
    firstBody = decodedBodies[0] || '';
    // Try ALL messages to find the Airbnb thread ID.
    // Airbnb sends each notification (guest msg, host reply, booking update) as
    // a SEPARATE Gmail thread. Any message in any thread may contain the link.
    if (isAirbnb) {
      for (const msg of fullMsgs) {
        const result = extractAirbnbThreadIdFromMessage(msg);
        if (result && result.threadId) {
          airbnbThreadId = result.threadId;
          airbnbReplyUrl = result.replyUrl;
          break;
        }
      }
    }
    if (airbnbThreadId) {
      logger.info(`Gmail sync thread ${threadId}: Airbnb thread ID extracted = ${airbnbThreadId}, replyUrl = ${airbnbReplyUrl}`);
    } else if (isAirbnb) {
      logger.warn(`Gmail sync thread ${threadId}: could NOT extract Airbnb thread ID — will use fallback matching`);
    }
  } catch (_) {}

  // ── Guest name resolution ──────────────────────────────────────────────
  // Every Airbnb notification comes from "Airbnb <express@airbnb.com>", so the
  // From display name is ALWAYS the literal string "Airbnb" — using it as a
  // fallback is what made every row in the conversation list read "Airbnb".
  // The traveller's name is instead recovered from the message content by
  // guestNameExtractor, which scores each candidate so a later sync can only
  // ever upgrade a weaker name, never swap two travellers around.
  let displayName, propertyName, matchedProperty;
  let nameResult = { name: FALLBACK_GUEST_NAME, source: 'fallback', confidence: 0 };

  if (isAirbnb) {
    const threadEmails = fullMsgs.map((msg, i) => {
      const msgHeaders = parseHeaders(msg);
      const from = extractEmail(msgHeaders.from || '');
      return {
        subject: msgHeaders.subject || subject,
        body: decodedBodies[i] || '',
        // The host's own greeting ("Bonjour Florine,") only names the guest
        // when the host is the one writing, so the role must be known here.
        role: detectAirbnbMessageRole(msgHeaders.subject || '', decodedBodies[i] || '', account.email) === 'outgoing'
          || from === String(account.email || '').toLowerCase()
          ? 'outgoing'
          : 'incoming',
      };
    });

    // Record any name Airbnb tagged as host/co-host in this thread, so later
    // threads of the same account inherit the exclusion.
    for (const msgBody of decodedBodies) {
      const { hostNames: found } = extractRoleBlocks(msgBody || '');
      for (const name of found) knownHostNames.add(name);
    }

    nameResult = extractGuestNameFromThread(threadEmails, {
      // Never let the host's own identity become the guest name.
      knownHostNames: [
        ...knownHostNames,
        account.display_name,
        extractName(account.email || ''),
      ].filter(Boolean),
    });
    displayName = nameResult.name;
    propertyName = extractPropertyName(subject, firstBody);
    matchedProperty = matchProperty(propertyName, properties);
  } else {
    displayName = senderDisplayName;
    propertyName = null;
    matchedProperty = null;
  }

  let dbThreadId, conversationId;

  if (existing.length > 0) {
    dbThreadId = existing[0].id;
    conversationId = existing[0].conversation_id;

    // Backfill airbnb_thread_id and airbnb_reply_url if we now have them but they weren't stored before
    if (airbnbThreadId) {
      await db.query(
        'UPDATE conversations SET airbnb_thread_id = ?, airbnb_reply_url = COALESCE(airbnb_reply_url, ?) WHERE id = ? AND (airbnb_thread_id IS NULL OR airbnb_thread_id = "")',
        [airbnbThreadId, airbnbReplyUrl, conversationId]
      );
    } else if (airbnbReplyUrl) {
      // Store the reply URL even if we couldn't parse a clean thread ID
      await db.query(
        'UPDATE conversations SET airbnb_reply_url = ? WHERE id = ? AND (airbnb_reply_url IS NULL OR airbnb_reply_url = "")',
        [airbnbReplyUrl, conversationId]
      );
    }

    // Upgrade the stored guest name when this sync found a better source.
    // Guarded by shouldReplaceStoredName so a repeat sync can never flip an
    // established conversation onto a different traveller.
    if (isAirbnb) {
      await maybeUpgradeGuestName(db, userId, conversationId, nameResult);
    }

    await db.query(
      'UPDATE gmail_threads SET last_message_at = NOW(), last_synced_at = NOW() WHERE id = ?',
      [dbThreadId]
    );
  } else {
    // ── New Gmail thread: check if it belongs to an existing Airbnb conversation ──
    // Airbnb sends each notification (guest msg, host reply, booking update) as a
    // separate Gmail thread. We must group them by airbnb_thread_id, not Gmail thread ID.
    let existingConvId = null;
    if (airbnbThreadId) {
      const byAirbnbThread = await db.query(
        'SELECT id FROM conversations WHERE user_id = ? AND airbnb_thread_id = ? LIMIT 1',
        [userId, airbnbThreadId]
      );
      if (byAirbnbThread.length > 0) {
        existingConvId = byAirbnbThread[0].id;
        logger.info(`Gmail sync thread ${threadId}: merging into existing conversation ${existingConvId} (Airbnb thread ${airbnbThreadId})`);
        // Backfill property match if we now know it and the conversation doesn't yet
        if (matchedProperty) {
          await db.query(
            'UPDATE conversations SET property_id = ? WHERE id = ? AND property_id IS NULL',
            [matchedProperty.id, existingConvId]
          );
        }
      }
    }

    if (existingConvId) {
      conversationId = existingConvId;
      if (isAirbnb) {
        await maybeUpgradeGuestName(db, userId, conversationId, nameResult);
      }
    } else {
      // ── Fallback: no airbnb_thread_id — try matching by guest name + property ──
      // This handles cases where the Airbnb URL extraction failed (changed URL format, etc.)
      // Only a confidently-extracted, non-placeholder name may drive a merge:
      // merging on "Voyageur" would collapse every unidentified thread of a
      // property into a single conversation.
      const canMergeByName =
        isAirbnb &&
        displayName &&
        displayName !== senderEmail &&
        displayName !== FALLBACK_GUEST_NAME &&
        nameResult.confidence > 0;

      if (canMergeByName) {
        const fallbackConvId = await findExistingConversationFallback(db, userId, displayName, matchedProperty);
        if (fallbackConvId) {
          conversationId = fallbackConvId;
          logger.info(`Gmail sync thread ${threadId}: merged into conversation ${fallbackConvId} via name fallback ("${displayName}")`);
          // Register this Gmail thread so future syncs find it without fallback
          const tRes = await db.query(
            `INSERT INTO gmail_threads (user_id, gmail_account_id, gmail_thread_id, conversation_id, sender_email, sender_name, subject, last_message_at, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [userId, accountId, threadId, conversationId, senderEmail, displayName, subject]
          );
          dbThreadId = tRes.insertId;
        }
      }

      if (!conversationId) {
        // Truly new Airbnb conversation — create it
        let convTitle;
        if (isAirbnb && matchedProperty) {
          convTitle = `${displayName} – ${matchedProperty.name}`;
        } else if (isAirbnb && propertyName) {
          convTitle = `${displayName} – ${propertyName}`;
        } else {
          convTitle = displayName;
        }

        const convResult = await db.query(
          `INSERT INTO conversations (user_id, title, booking_status, property_id, external_id, external_provider, guest_name, guest_name_source, guest_name_confidence, guest_language, airbnb_thread_id, airbnb_reply_url)
           VALUES (?, ?, 'inquiry', ?, ?, 'gmail', ?, ?, ?, 'fr', ?, ?)`,
          [
            userId, convTitle, matchedProperty ? matchedProperty.id : null, threadId,
            displayName, nameResult.source, nameResult.confidence,
            airbnbThreadId, airbnbReplyUrl
          ]
        );
        conversationId = convResult.insertId;
        logger.info(`Gmail sync thread ${threadId}: created new conversation ${conversationId} for "${displayName}"`);

        // Register this Gmail thread so future syncs find it instantly
        const tRes = await db.query(
          `INSERT INTO gmail_threads (user_id, gmail_account_id, gmail_thread_id, conversation_id, sender_email, sender_name, subject, last_message_at, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [userId, accountId, threadId, conversationId, senderEmail, displayName, subject]
        );
        dbThreadId = tRes.insertId;
      }
    }
  }

  // Messages already fetched in full format — no extra API calls needed
  const { ids: existingMsgIds, needsHeaders } = await getExistingGmailMessageIds(db, conversationId);
  let newMessages = 0;
  let duplicates = 0;
  // Counted separately from newMessages: only a GUEST message should trigger an
  // automatic reply. Notifications echoing the host's own reply are stored as
  // 'outgoing' and must not make Michel answer itself — that is the loop.
  let newGuestMessages = 0;
  logger.info(`Gmail sync thread ${threadId}: ${fullMsgs.length} message(s) in thread, ${existingMsgIds.size} already in DB`);

  // Latest message timestamp of the batch — the conversation's updated_at is
  // written ONCE after the loop instead of once per inserted message.
  let latestMsgDate = null;

  for (let mi = 0; mi < fullMsgs.length; mi++) {
    const fullMsg = fullMsgs[mi];
    if (existingMsgIds.has(fullMsg.id)) {
      duplicates++;
      // Known message — but if it predates the reply-header capture, fill the
      // headers in from the payload already in hand. COALESCE + the IS NULL
      // guard make this idempotent, so it is a no-op on every later sync.
      if (needsHeaders.has(fullMsg.id)) {
        const h = parseHeaders(fullMsg);
        if (h['reply-to'] || h['message-id']) {
          await db.query(
            `UPDATE messages
                SET email_reply_to = COALESCE(email_reply_to, ?),
                    email_message_id = COALESCE(email_message_id, ?),
                    email_references = COALESCE(email_references, ?),
                    email_subject = COALESCE(email_subject, ?)
              WHERE gmail_message_id = ? AND conversation_id = ? AND email_reply_to IS NULL`,
            [h['reply-to'] || null, h['message-id'] || null, h['references'] || null, h.subject || null, fullMsg.id, conversationId]
          );
          needsHeaders.delete(fullMsg.id);
        }
      }
      logger.info(`Gmail sync: skipping duplicate message ${fullMsg.id}`);
      continue;
    }

    const body = decodedBodies[mi] || '';
    if (!body.trim()) {
      logger.info(`Gmail sync: skipping message ${fullMsg.id} — empty body`);
      continue;
    }

    // For Airbnb emails, extract the guest message; for others, use full body
    let cleanedMessage = isAirbnb
      ? extractAirbnbMessage(body)
      : body.replace(/\n{3,}/g, '\n\n').trim();
    // Fallback: if Airbnb parser returned empty but raw body has content, use raw body
    if (!cleanedMessage.trim() && body.trim()) {
      logger.warn(`Gmail sync: Airbnb parser returned empty for ${fullMsg.id}, using raw body`);
      cleanedMessage = body.replace(/\n{3,}/g, '\n\n').trim();
    }
    if (!cleanedMessage.trim()) {
      logger.info(`Gmail sync: skipping message ${fullMsg.id} — no extractable content`);
      continue;
    }

    const msgHeaders = parseHeaders(fullMsg);
    const msgSenderEmail = extractEmail(msgHeaders.from || '');
    const msgSubject = msgHeaders.subject || '';

    // Determine role:
    // - If sent by the user's own email → outgoing
    // - If from Airbnb: detect whether it's a notification of the HOST's own reply
    //   vs a GUEST message. Airbnb sends both as automated@airbnb.com.
    let role;
    if (msgSenderEmail === account.email.toLowerCase()) {
      role = 'outgoing';
    } else if (isAirbnb) {
      role = detectAirbnbMessageRole(msgSubject, body, account.email);
    } else {
      role = 'incoming';
    }

    const msgDate = fullMsg.internalDate
      ? new Date(parseInt(fullMsg.internalDate))
      : new Date();

    // gmail_message_id is written to its own indexed column as well as into
    // metadata_json: the de-duplication lookup used to read EVERY message row of
    // the conversation and JSON.parse each one just to find these ids.
    // Reply headers, captured at sync time and never afterwards.
    //
    // This is the ONLY place the reply address can legitimately come from: it
    // is read off a message Gmail actually delivered to this account, for this
    // conversation. emailReplyService refuses to send anywhere else, so a
    // client can never nominate a recipient (see 017's header columns).
    // Airbnb puts a per-thread routing token in Reply-To; From is always the
    // unusable express@airbnb.com.
    const emailReplyTo = msgHeaders['reply-to'] || null;
    const emailMessageId = msgHeaders['message-id'] || null;
    const emailReferences = msgHeaders['references'] || null;

    await db.query(
      `INSERT INTO messages
        (conversation_id, role, content, gmail_message_id,
         email_reply_to, email_message_id, email_references, email_subject,
         metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversationId,
        role,
        cleanedMessage,
        fullMsg.id,
        emailReplyTo,
        emailMessageId,
        emailReferences,
        msgSubject || null,
        JSON.stringify({
          source: 'gmail_sync',
          gmail_message_id: fullMsg.id,
          gmail_thread_id: threadId,
          from: msgHeaders.from,
          subject: msgHeaders.subject,
          date: msgHeaders.date,
          sender_name: displayName,
          property_name: matchedProperty ? matchedProperty.name : propertyName
        }),
        msgDate
      ]
    );
    if (!latestMsgDate || msgDate > latestMsgDate) latestMsgDate = msgDate;
    // Guard against re-inserting the same id twice within this same thread pass
    // (Gmail can list a message under more than one thread during a merge).
    existingMsgIds.add(fullMsg.id);
    logger.info(`Gmail sync: saved message ${fullMsg.id} (role=${role}) to conversation ${conversationId}`);
    newMessages++;
    if (role === 'incoming') newGuestMessages++;
  }

  // Touch updated_at once so the conversation floats to the top of the inbox
  // list — previously this ran once per message inserted.
  if (latestMsgDate) {
    await db.query(
      'UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?',
      [latestMsgDate, conversationId, userId]
    );
  }

  logger.info(`Gmail sync thread ${threadId}: saved ${newMessages} new message(s), skipped ${duplicates} duplicate(s)`);

  // Extract Q&A pairs so the AI can reuse them for future guests of the same
  // property. Deliberately NOT awaited: it is a best-effort enrichment, and
  // blocking on it made every thread's sync wait on extra DB work.
  if (newMessages > 0) {
    setImmediate(() => {
      try {
        const { extractConversationQA } = require('./propertyQAService');
        Promise.resolve(extractConversationQA(conversationId)).catch(qaErr => {
          logger.warn(`Q&A extraction failed for conversation ${conversationId}: ${qaErr.message}`);
        });
      } catch (qaErr) {
        logger.warn(`Q&A extraction failed for conversation ${conversationId}: ${qaErr.message}`);
      }
    });
  }

  // Automatic reply: book a slot for this conversation once a genuinely new
  // GUEST message landed. Also off the critical path — scheduling only writes a
  // queue row (the model runs later, in the worker), and a failure here must
  // never take the sync down with it.
  if (newGuestMessages > 0) {
    setImmediate(() => {
      try {
        const autoReply = require('./autoReplyService');
        Promise.resolve(
          autoReply.scheduleForConversation({
            userId,
            conversationId,
            propertyId: matchedProperty ? matchedProperty.id : null,
          })
        ).catch(err => {
          logger.warn(`Auto-reply scheduling failed for conversation ${conversationId}: ${err.message}`);
        });
      } catch (err) {
        logger.warn(`Auto-reply scheduling failed for conversation ${conversationId}: ${err.message}`);
      }
    });
  }

  return newMessages;
}

/**
 * Get already-synced Gmail message IDs for a conversation.
 *
 * Reads the dedicated indexed gmail_message_id column instead of pulling every
 * metadata_json blob of the conversation and JSON.parse-ing it — that old path
 * was O(messages × bytes) on every thread of every sync cycle.
 *
 * Rows written before migration 013 have the id only inside metadata_json, so
 * those are still parsed, but only for the rows the migration could not backfill.
 */
async function getExistingGmailMessageIds(db, conversationId) {
  const ids = new Set();
  // Messages stored before migration 017 carry no reply headers, and the
  // capture below only runs on INSERT — so they would stay unanswerable
  // forever. Whenever a sync re-reads a thread we already know, we top the
  // missing headers up from the payload we just fetched (no extra API call).
  const needsHeaders = new Set();

  const rows = await db.query(
    'SELECT gmail_message_id, email_reply_to FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL',
    [conversationId]
  );
  for (const row of rows) {
    if (row.gmail_message_id) {
      ids.add(row.gmail_message_id);
      if (row.email_reply_to === null || row.email_reply_to === undefined) {
        needsHeaders.add(row.gmail_message_id);
      }
    }
  }

  const legacyRows = await db.query(
    "SELECT metadata_json FROM messages WHERE conversation_id = ? AND gmail_message_id IS NULL AND metadata_json IS NOT NULL",
    [conversationId]
  );
  for (const row of legacyRows) {
    try {
      const meta = JSON.parse(row.metadata_json);
      if (meta.gmail_message_id) ids.add(meta.gmail_message_id);
    } catch (_) {}
  }

  return { ids, needsHeaders };
}

// Cap the stored host-name list: it should hold an owner plus a few co-hosts,
// never grow without bound from a mis-parsed body.
const MAX_HOST_NAMES = 25;

/** Read the host names accumulated on a Gmail account row. */
function loadHostNames(account) {
  const set = new Set();
  if (!account || !account.host_names_json) return set;
  try {
    const parsed = JSON.parse(account.host_names_json);
    if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (typeof name === 'string' && name.trim()) set.add(name.trim());
      }
    }
  } catch (_) {
    // Colonne corrompue — on repart d'un ensemble vide, elle sera réécrite.
  }
  return set;
}

/** Persist newly discovered host names back onto the Gmail account row. */
async function persistHostNames(db, accountId, hostNames) {
  try {
    const list = [...hostNames].slice(0, MAX_HOST_NAMES);
    await db.query(
      'UPDATE gmail_accounts SET host_names_json = ? WHERE id = ?',
      [JSON.stringify(list), accountId]
    );
    logger.info(`Gmail sync: host names for account ${accountId} → ${list.join(', ')}`);
  } catch (err) {
    logger.warn(`Could not persist host names for account ${accountId}: ${err.message}`);
  }
}

/**
 * Persist a better guest name on an existing conversation.
 *
 * Rewrites the title too when it still carries the old name, so the inbox stops
 * showing "Airbnb – La Villa Cosy" for a conversation we can now attribute.
 * The user_id predicate is not redundant: it keeps a malformed conversation_id
 * from ever letting one account's sync write into another account's row.
 */
async function maybeUpgradeGuestName(db, userId, conversationId, nameResult) {
  if (!conversationId || !nameResult || !nameResult.name) return;

  const rows = await db.query(
    'SELECT guest_name, guest_name_confidence, title FROM conversations WHERE id = ? AND user_id = ?',
    [conversationId, userId]
  );
  if (rows.length === 0) return;

  const current = rows[0];
  if (!shouldReplaceStoredName(current.guest_name, current.guest_name_confidence, nameResult)) return;

  const oldName = current.guest_name;
  let newTitle = current.title;
  if (oldName && newTitle && newTitle.includes(oldName)) {
    newTitle = newTitle.split(oldName).join(nameResult.name);
  }

  await db.query(
    `UPDATE conversations
     SET guest_name = ?, guest_name_source = ?, guest_name_confidence = ?, title = ?
     WHERE id = ? AND user_id = ?`,
    [nameResult.name, nameResult.source, nameResult.confidence, newTitle, conversationId, userId]
  );

  logger.info(
    `Gmail sync: guest name upgraded for conversation ${conversationId}: ` +
    `"${oldName || '(vide)'}" → "${nameResult.name}" (${nameResult.source}/${nameResult.confidence})`
  );
}

/**
 * Fallback conversation matching when airbnb_thread_id extraction fails.
 * Tries to find an existing conversation for the same guest name (+ property if known).
 * Only matches conversations created within the last 90 days to avoid false positives.
 *
 * Two bugs fixed here:
 *  1. The 90-day window used MySQL's DATE_SUB(NOW(), INTERVAL 90 DAY). The
 *     SQLite adapter only rewrites NOW(), so the query became
 *     `DATE_SUB(datetime('now'), INTERVAL 90 DAY)` — a hard syntax error that
 *     made this function THROW on every call. The caller's try/catch swallowed
 *     it as "thread failed", so the de-duplication path never actually ran and
 *     each notification mail kept creating a brand-new conversation. The cutoff
 *     is now computed in JS and passed as a bound parameter, which is portable.
 *  2. It merged on first name alone, so two different travellers called "Marie"
 *     on the same property collapsed into one thread. Matching is now exact on
 *     the full normalised name.
 */
async function findExistingConversationFallback(db, userId, guestName, matchedProperty) {
  if (!guestName) return null;

  const normalizedName = nameKey(guestName);
  if (!normalizedName) return null;

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // If we know the property, constrain to it for higher confidence
  let rows;
  if (matchedProperty) {
    rows = await db.query(
      `SELECT id, guest_name FROM conversations
       WHERE user_id = ? AND property_id = ?
         AND external_provider = 'gmail'
         AND created_at >= ?
       ORDER BY updated_at DESC LIMIT 20`,
      [userId, matchedProperty.id, cutoff]
    );
  } else {
    rows = await db.query(
      `SELECT id, guest_name FROM conversations
       WHERE user_id = ?
         AND external_provider = 'gmail'
         AND created_at >= ?
       ORDER BY updated_at DESC LIMIT 40`,
      [userId, cutoff]
    );
  }

  for (const row of rows) {
    if (!row.guest_name) continue;
    // Exact match only — merging on the first name alone mixed up distinct
    // travellers who happen to share one.
    if (nameKey(row.guest_name) === normalizedName) return row.id;
  }

  return null;
}

/**
 * Extract the Airbnb conversation thread ID from a Gmail message.
 * Also returns the best direct Airbnb reply URL found.
 *
 * Returns: { threadId: string|null, replyUrl: string|null }
 *
 * Sources tried in order:
 *  1. Email headers (X-Airbnb-Thread-ID, References, Message-ID)
 *  2. Decoded tracking redirect URLs (url=, redirect=, upn= params)
 *  3. Direct HTML body — /hosting/inbox/thread/<id>
 *  4. Percent-encoded variants of the above
 *  5. HTML body — /z/q/<id>, /messaging/thread/<id>, abnb.me links, etc.
 *  6. Subject line — long numeric ID pattern
 */
function extractAirbnbThreadIdFromMessage(gmailMessageData) {
  const payload = gmailMessageData.payload;
  if (!payload) return { threadId: null, replyUrl: null };

  // ── Strategy 1: check email headers ──
  const hdrs = parseHeaders(gmailMessageData);
  const refsHeader = hdrs['references'] || hdrs['in-reply-to'] || '';
  const threadHeaderMatch = refsHeader.match(/thread[_\-/](\d{8,})/i);
  if (threadHeaderMatch) {
    const tid = threadHeaderMatch[1];
    return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
  }

  // ── Collect all raw text (HTML + plain) ──
  let htmlContent = null;
  let plainContent = null;

  function findParts(parts) {
    for (const part of (parts || [])) {
      if (part.mimeType === 'text/html' && part.body && part.body.data && !htmlContent) {
        htmlContent = Buffer.from(
          part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
        ).toString('utf8');
      }
      if (part.mimeType === 'text/plain' && part.body && part.body.data && !plainContent) {
        plainContent = Buffer.from(
          part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
        ).toString('utf8');
      }
      if (part.parts) findParts(part.parts);
    }
  }

  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    htmlContent = Buffer.from(
      payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
    ).toString('utf8');
  } else if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    plainContent = Buffer.from(
      payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
    ).toString('utf8');
  } else {
    findParts(payload.parts);
  }

  // ── Helper: search a text blob for Airbnb thread ID + URL ──
  function searchContent(text) {
    if (!text) return null;

    // Step A: decode any tracking redirect params (url=, redirect=, to=, dest=)
    // Airbnb emails wrap links: href="https://email.airbnb.com/ls/click?upn=...&url=https%3A%2F%2F..."
    const redirectParamRe = /[?&](?:url|redirect|to|dest|link)=([^&"'\s]{20,})/gi;
    let rdMatch;
    while ((rdMatch = redirectParamRe.exec(text)) !== null) {
      try {
        const decoded = decodeURIComponent(rdMatch[1]);
        const found = searchRawUrl(decoded);
        if (found) return found;
      } catch (_) {}
    }

    // Step B: look for percent-encoded Airbnb paths directly in text
    // e.g. %2Fhosting%2Finbox%2Fthread%2F12345
    const pctInbox = text.match(/%2Fhosting%2Finbox%2Fthread%2F(\d+)/i);
    if (pctInbox) {
      const tid = pctInbox[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }
    const pctMsg = text.match(/%2Fmessaging%2Fthread%2F(\d+)/i);
    if (pctMsg) {
      const tid = pctMsg[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/messaging/thread/${tid}` };
    }

    // Step C: plain URL patterns
    return searchRawUrl(text);
  }

  function searchRawUrl(text) {
    if (!text) return null;

    // /hosting/inbox/thread/<id>  (desktop, app, fr + com)
    let m = text.match(/\/hosting\/inbox(?:\/thread)?\/(\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // /messaging/thread/<id>  or  /messaging/ajax_messaging_thread?thread_id=<id>
    m = text.match(/\/messaging\/(?:thread|ajax_messaging_thread)[\/?](\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // ?thread_id=<id>
    m = text.match(/[?&]thread_id=(\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // /z/q/<id>  (mobile short link)
    m = text.match(/airbnb\.[a-z]{2,6}\/z\/q\/(\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // abnb.me/<path>/<id>
    m = text.match(/abnb\.me\/[^"'\s]*?\/(\d{8,})/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // /inquiries/<id>  (older format)
    m = text.match(/\/inquiries\/(\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    // Any numeric ID (8+ digits) embedded in an airbnb URL
    m = text.match(/airbnb\.[a-z]{2,6}\/[^"'\s]*?\/(\d{8,})/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
    }

    return null;
  }

  // ── Strategy 2 & 3: Search HTML, then plain text ──
  const htmlResult = searchContent(htmlContent);
  if (htmlResult) return htmlResult;

  const plainResult = searchContent(plainContent);
  if (plainResult) return plainResult;

  // ── Strategy 4: check subject for long numeric ID ──
  const subject = hdrs.subject || '';
  const subjMatch = subject.match(/\b(\d{10,})\b/);
  if (subjMatch) {
    const tid = subjMatch[1];
    return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/inbox/thread/${tid}` };
  }

  return { threadId: null, replyUrl: null };
}

/**
 * Parse Gmail message headers into a flat object
 */
function parseHeaders(gmailMsg) {
  const hdrs = {};
  const payload = gmailMsg.payload || gmailMsg;
  const headers = payload.headers || [];
  for (const h of headers) {
    hdrs[h.name.toLowerCase()] = h.value;
  }
  return hdrs;
}

/**
 * Extract email address from a "Name <email>" string
 */
function extractEmail(fromStr) {
  const match = fromStr.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : fromStr.toLowerCase().trim();
}

/**
 * Extract display name from a "Name <email>" string
 */
function extractName(fromStr) {
  const match = fromStr.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : '';
}

// ================================================================
// Airbnb notification parsing
// ================================================================

/**
 * NOTE: the former extractGuestName() lived here. It matched loose,
 * unvalidated patterns ("de X", "from X", "X arrive") anywhere in the body and
 * had no stopword filtering, which is where guest names like "dernière m",
 * "lit p", "votre s" and "to" in the conversations table came from — and when
 * it found nothing the caller fell back to the From display name, i.e. the
 * literal "Airbnb". It is replaced by services/guestNameExtractor.js, which
 * validates every candidate and scores it by source.
 */

/**
 * Extract the property/listing name from an Airbnb notification email.
 * Airbnb subjects often contain: "... pour Joli Studio Centre Ville"
 * Body often contains the listing name near "votre logement" or similar.
 */
function extractPropertyName(subject, body) {
  const subjectPatterns = [
    // FR: "... pour Joli Studio Centre Ville"
    /pour\s+(.+?)(?:\s*[-–—]|\s*$)/i,
    // FR: "... à propos de Joli Studio"
    /à\s+propos\s+de\s+(.+?)(?:\s*[-–—]|\s*$)/i,
    // EN: "... about Your Lovely Apartment"
    /about\s+(.+?)(?:\s*[-–—]|\s*$)/i,
    // EN: "... for Your Lovely Apartment"
    /for\s+(.+?)(?:\s*[-–—]|\s*$)/i,
  ];

  for (const regex of subjectPatterns) {
    const match = subject.match(regex);
    if (match && match[1].length > 3 && match[1].length < 100) {
      return match[1].trim();
    }
  }

  // Try body
  const bodyPatterns = [
    /(?:votre\s+logement|votre\s+annonce|your\s+listing|your\s+property)\s*[:\s]+["«]?([^"»\n]+)/i,
    /(?:réservation|reservation|séjour|stay)\s+(?:à|at|pour|for)\s+["«]?([^"»\n,]+)/i,
  ];

  for (const regex of bodyPatterns) {
    const match = body.match(regex);
    if (match && match[1].length > 3 && match[1].length < 100) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Match a property name extracted from email to the user's property_profiles.
 * Uses fuzzy substring matching — returns the best match or null.
 */
function matchProperty(emailPropertyName, properties) {
  if (!emailPropertyName || properties.length === 0) return null;

  const needle = emailPropertyName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let bestMatch = null;
  let bestScore = 0;

  for (const prop of properties) {
    const propName = prop.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Exact match
    if (propName === needle) return prop;

    // Substring match (either direction)
    if (needle.includes(propName) || propName.includes(needle)) {
      const score = Math.min(needle.length, propName.length) / Math.max(needle.length, propName.length);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = prop;
      }
    }

    // Word overlap matching
    const needleWords = needle.split(/\s+/).filter(w => w.length > 2);
    const propWords = propName.split(/\s+/).filter(w => w.length > 2);
    if (needleWords.length > 0 && propWords.length > 0) {
      const matchingWords = needleWords.filter(w => propWords.some(pw => pw.includes(w) || w.includes(pw)));
      const overlapScore = matchingWords.length / Math.max(needleWords.length, propWords.length);
      if (overlapScore > bestScore && overlapScore >= 0.4) {
        bestScore = overlapScore;
        bestMatch = prop;
      }
    }
  }

  // Only accept matches with reasonable confidence
  return bestScore >= 0.3 ? bestMatch : null;
}

/**
 * Detect whether an Airbnb notification email contains the HOST's own reply
 * or a GUEST's message. Both arrive from @airbnb.com.
 *
 * Airbnb HTML-converted emails have this structure:
 *   [Title]
 *   Pour votre protection…
 *   [Sender Name]
 *   [Role: "Hôte" / "Host" / "Responsable de la réservation" / "Voyageur"]
 *   [Message]
 *   Consulter / Répondre
 *
 * If the role line says "Hôte" or "Host", it's the property owner's message.
 */
function detectAirbnbMessageRole(subject, body, hostEmail) {
  // Primary detection: look for the sender role pattern in the body.
  // Airbnb emails show the sender's role right after their name.
  // "Hôte" / "Host" / "Co-hôte" / "Co-host" = outgoing (property owner)
  const hostRolePattern = /\n\s*(H[ôo]te|Host|Co-?h[ôo]te|Co-?host)\s*\n/i;
  if (hostRolePattern.test(body)) {
    return 'outgoing';
  }

  // Fallback: check subject/body for host-reply confirmation patterns
  const combined = (subject + ' ' + body).toLowerCase();
  const hostPatterns = [
    /votre\s+r[ée]ponse/,
    /vous\s+avez\s+(?:envoy[ée]|r[ée]pondu|[ée]crit)/,
    /message\s+envoy[ée]/,
    /r[ée]ponse\s+envoy[ée]e/,
    /your\s+(?:reply|response|message)\s+(?:was|has\s+been)\s+sent/,
    /you\s+(?:sent|replied|responded)/,
  ];

  for (const pattern of hostPatterns) {
    if (pattern.test(combined)) {
      return 'outgoing';
    }
  }

  // Default: it's a guest message (incoming)
  return 'incoming';
}

/**
 * Extract the actual message from an Airbnb notification email body.
 *
 * Airbnb HTML emails, when converted to text via stripHtml(), produce:
 *
 *   [Title: "Demande d'information pour ..." or "Réservation pour ..."]
 *   Pour votre protection et votre sécurité, communiquez toujours via Airbnb.
 *   [Sender Name]
 *   [Role: "Hôte" / "Responsable de la réservation" / "Voyageur"]
 *   [ACTUAL MESSAGE]
 *   Consulter la demande d'information
 *   Répondre
 *   Vous pouvez également répondre directement à cet e-mail.
 *   [Property details, dates, footer...]
 */
function extractAirbnbMessage(body) {
  // ── Strategy 1: Structured extraction ──
  // Find the message between the sender-role line and the CTA buttons.

  // Known sender roles in Airbnb emails (the line right before the message)
  const rolePatterns = [
    /\n\s*(?:H[ôo]te|Host|Co-?h[ôo]te|Co-?host)\s*\n/i,
    /\n\s*(?:Responsable de la r[ée]servation)\s*\n/i,
    /\n\s*(?:Voyageur|Guest|Traveler)\s*\n/i,
    /\n\s*(?:Superhost|Super-?h[ôo]te)\s*\n/i,
  ];

  // CTA / end-of-message markers
  const endPatterns = [
    /\n\s*Consulter\s+/i,
    /\n\s*R[ée]pondre\b/i,
    /\n\s*R[ée]server\s+maintenant/i,
    /\n\s*Vous\s+pouvez\s+[ée]galement/i,
    /\n\s*Afficher\s+/i,
    /\n\s*(?:View|Reply|Respond|See)\s+/i,
    /\n\s*(?:Go to|Aller sur)\s+/i,
    /\n\s*(?:Book now|Reserve now)/i,
    /\n\s*T[ée]l[ée]chargez\s+/i,
    /\n\s*Download\s+/i,
    /\n\s*Airbnb\s+Ireland/i,
    /\n\s*Modifiez\s+vos\s+pr[ée]f[ée]rences/i,
    /\n\s*Image\s+envoy[ée]e/i,
    // When a thread has multiple messages, there's often a sender name in ALL CAPS
    // followed by the role, belonging to a PREVIOUS message in the thread.
    // Stop before such patterns to avoid mixing messages.
    /\n\s*[A-Z\u00C0-\u00DC]{3,}\s*\n\s*(?:H[ôo]te|Host|Responsable|Voyageur|Guest)/i,
  ];

  let messageStart = -1;

  // Try to find the end of the role line (= start of the actual message)
  for (const rolePattern of rolePatterns) {
    const match = body.match(rolePattern);
    if (match) {
      messageStart = match.index + match[0].length;
      break;
    }
  }

  if (messageStart >= 0) {
    let text = body.substring(messageStart);

    // Find the earliest end marker
    let messageEnd = text.length;
    for (const endPattern of endPatterns) {
      const match = text.match(endPattern);
      if (match && match.index < messageEnd) {
        messageEnd = match.index;
      }
    }
    text = text.substring(0, messageEnd);

    // Clean up
    text = text.replace(/%[a-z_]+%/gi, '');
    text = text.replace(/https?:\/\/[^\s\])\}>]+/g, '');
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    text = text.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
    text = text.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    if (text.length >= 1) {
      return text;
    }
  }

  // ── Strategy 2: Plain-text extraction (fallback) ──
  const startMarkers = [
    /(?:message\s*(?:de\s+\w+)?\s*:\s*\n)/i,
    /(?:\w+\s+)?a\s+[ée]crit\s*:\s*\n/i,
    /wrote\s*:\s*\n/i,
    /vous\s+a\s+envoy[ée]\s+un\s+message\s*[:\s]*\n/i,
    /sent\s+you\s+a\s+message\s*[:\s]*\n/i,
    /(?:Nouveau message|New message|Message re[çc]u)[^\n]*\n\s*\n/i,
  ];

  const fallbackEndMarkers = [
    /\n\s*https?:\/\/[^\s]*airbnb/i,
    /\n\s*https?:\/\/[^\s]*abnb/i,
    /\n\s*https?:\/\/[^\s]{30,}/i,
    /\n\s*(?:R[ée]pondre|Reply|Respond)\s/i,
    /\n\s*(?:Consulter|Afficher|View|See)\s/i,
    /\n\s*[-_=]{3,}/,
    /\n\s*Airbnb,?\s+I/i,
    /\n\s*(?:http|www\.)/i,
    /\n\s*Pour\s+votre\s+(protection|s[ée]curit[ée])/i,
  ];

  let text = body;

  for (const marker of startMarkers) {
    const match = text.match(marker);
    if (match) {
      text = text.substring(match.index + match[0].length);
      break;
    }
  }

  for (const marker of fallbackEndMarkers) {
    const match = text.match(marker);
    if (match) {
      text = text.substring(0, match.index);
    }
  }

  text = text.replace(/%[a-z_]+%/gi, '');
  text = text.replace(/https?:\/\/[^\s\])\}>]+/g, '');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  text = text.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (text.length < 5) {
    return body.replace(/\n{3,}/g, '\n\n').trim();
  }

  return text;
}

/**
 * Extract the plain-text body from a Gmail message payload.
 * Falls back to stripping HTML tags if only text/html is available.
 */
function extractBody(message) {
  const payload = message.payload;
  if (!payload) return '';

  // Simple single-part message
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — look for text/plain first, then text/html
  const parts = payload.parts || [];
  let plainPart = null;
  let htmlPart = null;

  function walk(partList) {
    for (const part of partList) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        plainPart = part;
      } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlPart = part;
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(parts);

  if (plainPart) {
    const plainText = decodeBase64Url(plainPart.body.data);
    // If plain text is very short or contains only tracking tags, prefer HTML
    const stripped = plainText.replace(/%[a-z_]+%/gi, '').trim();
    if (stripped.length > 20) {
      return plainText;
    }
    // Fall through to HTML if available
    if (htmlPart) {
      const html = decodeBase64Url(htmlPart.body.data);
      return stripHtml(html);
    }
    return plainText;
  }
  if (htmlPart) {
    const html = decodeBase64Url(htmlPart.body.data);
    return stripHtml(html);
  }

  return '';
}

/**
 * Decode Gmail's URL-safe base64
 */
function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * HTML → text conversion
 */
function stripHtml(html) {
  return html
    // Remove style, script, and head blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    // Line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&[a-z]+;/gi, ' ')
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Mark sync as complete and update account
 */
async function finishSyncLog(db, syncLogId, synced, accountId) {
  await db.query(
    'UPDATE sync_logs SET status = ?, items_synced = ?, completed_at = NOW() WHERE id = ?',
    ['completed', synced, syncLogId]
  );
  await db.query(
    'UPDATE gmail_accounts SET last_sync_at = NOW(), sync_status = ?, sync_error = NULL WHERE id = ?',
    ['idle', accountId]
  );
}

// ================================================================
// OAuth2 flow helpers (used by controller)
// ================================================================

/**
 * Generate the Google OAuth2 consent URL
 */
/**
 * Scopes requested at consent.
 *
 * gmail.send was added for the reply feature: Michel answers the guest by
 * replying to Airbnb's notification mail from the host's own mailbox. It grants
 * sending ONLY — it cannot read, modify or delete anything, which readonly
 * already covers separately.
 *
 * Accounts connected before this change hold a token without gmail.send and
 * must go through "Réautoriser" (see hasSendScope / gmailController.reauthorize);
 * sending fails with GMAIL_SEND_SCOPE_MISSING until they do.
 */
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

function getAuthUrl(state, loginHint) {
  const oauth2 = makeOAuth2Client();
  const opts = {
    access_type: 'offline',
    prompt: 'consent',
    // include_granted_scopes keeps previously granted scopes when a connected
    // account re-consents, so re-authorising never silently drops read access.
    include_granted_scopes: true,
    scope: GMAIL_SCOPES,
  };
  if (state) opts.state = state;
  if (loginHint) opts.login_hint = loginHint;
  return oauth2.generateAuthUrl(opts);
}

/**
 * Exchange authorization code for tokens.
 * Verifies that the gmail.readonly scope was actually granted.
 */
async function exchangeCode(code) {
  const oauth2 = makeOAuth2Client();
  const { tokens } = await oauth2.getToken(code);

  oauth2.setCredentials(tokens);

  // Actually test Gmail API access — the token's scope field can be unreliable
  try {
    const testGmail = gmail({ version: 'v1', auth: oauth2 });
    await testGmail.users.labels.list({ userId: 'me' });
    logger.info('Gmail API access verified successfully');
  } catch (testErr) {
    logger.error('Gmail API test failed after token exchange:', testErr.message);
    throw new Error(
      'GMAIL_SCOPE_MISSING: L\'API Gmail n\'est pas accessible. ' +
      'Vérifiez que : 1) L\'API Gmail est ACTIVÉE dans Google Cloud Console ' +
      '(APIs & Services → Library → Gmail API → Activer), ' +
      '2) Le scope gmail.readonly est ajouté dans l\'écran de consentement OAuth ' +
      '(OAuth consent screen → Scopes → Add gmail.readonly). ' +
      'Puis réessayez la connexion.'
    );
  }

  // Get user email via Gmail profile (avoids needing the full oauth2 API)
  const gmailClient = gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmailClient.users.getProfile({ userId: 'me' });

  return {
    email: profile.data.emailAddress,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    // Recorded so the UI can say "réautorisation nécessaire" up front instead of
    // letting the first send fail. Google returns the scopes actually granted,
    // which is not always what was asked for.
    grantedScopes: tokens.scope || '',
    canSend: hasSendScope(tokens.scope),
  };
}

/** Does this scope string allow users.messages.send? */
function hasSendScope(scopeString) {
  const scopes = String(scopeString || '').split(/[\s,]+/).filter(Boolean);
  return scopes.some((s) => /gmail\.send|gmail\.modify|mail\.google\.com/.test(s));
}

/**
 * Purge non-Airbnb conversations that were synced via Gmail.
 * Deletes conversations (and their messages) where the sender is not from Airbnb.
 * Returns the number of conversations deleted.
 */
async function purgeNonAirbnbConversations(userId) {
  const db = getDatabase();

  // Find gmail_threads that are NOT from Airbnb.
  // The INNER JOIN on conversations is a safety boundary, not decoration: the
  // old version trusted gmail_threads.conversation_id on its own and issued
  // `DELETE FROM messages WHERE conversation_id = ?` before any ownership check,
  // so a row pointing at another account's conversation (which the insertId race
  // in db/database.js could produce) wiped that account's messages. Joining
  // through conversations.user_id makes a foreign conversation simply not match.
  const nonAirbnbThreads = await db.query(
    `SELECT gt.id, gt.conversation_id, gt.sender_email
     FROM gmail_threads gt
     INNER JOIN conversations c ON c.id = gt.conversation_id AND c.user_id = ?
     WHERE gt.user_id = ?
       AND gt.sender_email NOT LIKE '%airbnb.com'
       AND gt.sender_email NOT LIKE '%airbnb.fr'`,
    [userId, userId]
  );

  if (nonAirbnbThreads.length === 0) {
    logger.info(`Purge: no non-Airbnb conversations found for user ${userId}`);
    return 0;
  }

  let deleted = 0;
  for (const thread of nonAirbnbThreads) {
    try {
      // Delete messages first (FK constraint) — scoped to the owning user so a
      // stale conversation_id can never reach across accounts.
      await db.query(
        `DELETE FROM messages WHERE conversation_id IN (
           SELECT id FROM conversations WHERE id = ? AND user_id = ?
         )`,
        [thread.conversation_id, userId]
      );
      // Delete the gmail_thread record
      await db.query('DELETE FROM gmail_threads WHERE id = ? AND user_id = ?', [thread.id, userId]);
      // Delete the conversation
      await db.query('DELETE FROM conversations WHERE id = ? AND user_id = ?', [thread.conversation_id, userId]);
      deleted++;
    } catch (err) {
      logger.warn(`Purge: failed to delete conversation ${thread.conversation_id}: ${err.message}`);
    }
  }

  logger.info(`Purge: deleted ${deleted} non-Airbnb conversations for user ${userId}`);
  return deleted;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  saveGmailAccount,
  getGmailAccount,
  getUserGmailAccounts,
  deactivateAccount,
  fetchMessages,
  purgeNonAirbnbConversations,
  // Exposés pour les scripts d'audit lecture seule (scripts/audit-missing-messages.js) :
  // reproduire exactement le filtrage du sync est le seul moyen de classer un
  // message manquant par cause réelle plutôt que par supposition.
  __extractBody: extractBody,
  __extractAirbnbMessage: extractAirbnbMessage,
  __detectAirbnbMessageRole: detectAirbnbMessageRole
};

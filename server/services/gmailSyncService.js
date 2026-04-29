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
async function saveGmailAccount(userId, { email, accessToken, refreshToken, expiresAt }) {
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
        is_active = TRUE, sync_status = 'idle', sync_error = NULL, updated_at = NOW()
       WHERE id = ?`,
      [accessTokenEnc, refreshTokenToStore, expiresAt || null, existing[0].id]
    );
    return existing[0].id;
  }

  const result = await db.query(
    `INSERT INTO gmail_accounts (user_id, email, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, email, accessTokenEnc, refreshTokenEnc, expiresAt || null]
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
  return db.query(
    `SELECT id, email, is_active, last_sync_at, sync_status, sync_error, created_at
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
 */
async function fetchMessages(userId, accountId) {
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
    if (account.last_sync_at) {
      // 5-minute safety buffer to avoid missing messages during sync gaps
      const safetyBufferSeconds = 300;
      const afterEpoch = Math.floor(new Date(account.last_sync_at).getTime() / 1000) - safetyBufferSeconds;
      q += ` after:${afterEpoch}`;
    }

    // Use threads.list with pagination to fetch ALL matching threads
    let threads = [];
    let pageToken = null;
    do {
      const listResp = await gmail.users.threads.list({
        userId: 'me',
        q,
        maxResults: 100,
        ...(pageToken && { pageToken })
      });
      threads.push(...(listResp.data.threads || []));
      pageToken = listResp.data.nextPageToken;
    } while (pageToken);
    logger.info(`Gmail sync: found ${threads.length} threads in inbox for account ${accountId} (query: ${q})`);
    if (threads.length === 0) {
      await finishSyncLog(db, syncLogId, 0, accountId);
      return { synced: 0 };
    }

    // Load user's properties once for matching
    const properties = await db.query(
      'SELECT id, name, superhot_listing_id, context_json FROM property_profiles WHERE user_id = ?',
      [userId]
    );

    // Fetch full thread data in parallel batches (each threads.get returns ALL messages)
    // This replaces N+1 individual message fetches with ~5 batched thread fetches
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
        threadMap.set(threadId, res.data.messages);
      }
    }

    let synced = 0;
    for (const [threadId, msgs] of threadMap) {
      try {
        const count = await syncGmailThread(userId, accountId, account, gmail, threadId, msgs, properties);
        synced += count;
      } catch (threadErr) {
        logger.warn(`Gmail sync thread ${threadId} failed: ${threadErr.message}`);
      }
    }

    await finishSyncLog(db, syncLogId, synced, accountId);
    logger.info(`Gmail sync: ${synced} new messages for account ${accountId}`);
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
async function syncGmailThread(userId, accountId, account, gmail, threadId, fullMsgs, properties) {
  const db = getDatabase();

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

  // Body already fetched (full format from threads.get) — no extra API call needed
  let firstBody = '';
  let airbnbThreadId = null;
  try {
    firstBody = extractBody(firstMsg);
    // Try ALL messages to find the Airbnb thread ID.
    // Airbnb sends each notification (guest msg, host reply, booking update) as
    // a SEPARATE Gmail thread. Any message in any thread may contain the link.
    if (isAirbnb) {
      for (const msg of fullMsgs) {
        const tid = extractAirbnbThreadIdFromMessage(msg);
        if (tid) { airbnbThreadId = tid; break; }
      }
    }
    if (airbnbThreadId) logger.info(`Gmail sync thread ${threadId}: extracted Airbnb thread ID = ${airbnbThreadId}`);
  } catch (_) {}

  // Extract names
  let displayName, propertyName, matchedProperty;

  if (isAirbnb) {
    displayName = extractGuestName(subject, firstBody) || senderDisplayName;
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

    // Backfill airbnb_thread_id if we now have it but it wasn't stored before
    if (airbnbThreadId) {
      await db.query(
        'UPDATE conversations SET airbnb_thread_id = ? WHERE id = ? AND (airbnb_thread_id IS NULL OR airbnb_thread_id = "")',
        [airbnbThreadId, conversationId]
      );
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
    } else {
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
        `INSERT INTO conversations (user_id, title, booking_status, property_id, external_id, external_provider, guest_name, guest_language, airbnb_thread_id)
         VALUES (?, ?, 'inquiry', ?, ?, 'gmail', ?, 'fr', ?)`,
        [userId, convTitle, matchedProperty ? matchedProperty.id : null, threadId, displayName, airbnbThreadId]
      );
      conversationId = convResult.insertId;
    }

    // Always register this Gmail thread so future syncs find it instantly
    const threadResult = await db.query(
      `INSERT INTO gmail_threads (user_id, gmail_account_id, gmail_thread_id, conversation_id, sender_email, sender_name, subject, last_message_at, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, accountId, threadId, conversationId, senderEmail, displayName, subject]
    );
    dbThreadId = threadResult.insertId;
  }

  // Messages already fetched in full format — no extra API calls needed
  const existingMsgIds = await getExistingGmailMessageIds(db, conversationId);
  let newMessages = 0;

  for (const fullMsg of fullMsgs) {
    if (existingMsgIds.has(fullMsg.id)) continue;

    const body = extractBody(fullMsg);
    if (!body.trim()) continue;

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

    await db.query(
      'INSERT INTO messages (conversation_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [
        conversationId,
        role,
        cleanedMessage,
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
    // Touch updated_at so the conversation floats to the top of the inbox list
    await db.query(
      'UPDATE conversations SET updated_at = ? WHERE id = ?',
      [msgDate, conversationId]
    );
    newMessages++;
  }

  // After inserting new messages, extract Q&A pairs from this conversation
  // so the AI can use them for future guests of the same property
  if (newMessages > 0) {
    try {
      const { extractConversationQA } = require('./propertyQAService');
      await extractConversationQA(conversationId);
    } catch (qaErr) {
      logger.warn(`Q&A extraction failed for conversation ${conversationId}: ${qaErr.message}`);
    }
  }

  return newMessages;
}

/**
 * Get already-synced Gmail message IDs for a conversation
 */
async function getExistingGmailMessageIds(db, conversationId) {
  const rows = await db.query(
    "SELECT metadata_json FROM messages WHERE conversation_id = ? AND metadata_json IS NOT NULL",
    [conversationId]
  );
  const ids = new Set();
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.metadata_json);
      if (meta.gmail_message_id) ids.add(meta.gmail_message_id);
    } catch (_) {}
  }
  return ids;
}

/**
 * Extract the Airbnb conversation thread ID from a Gmail message's raw HTML.
 * Airbnb notification emails contain a direct link such as:
 *   https://www.airbnb.com/hosting/inbox/thread/1234567890
 * We extract the numeric thread ID from that URL.
 */
function extractAirbnbThreadIdFromMessage(gmailMessageData) {
  const payload = gmailMessageData.payload;
  if (!payload) return null;

  let htmlContent = null;

  function findHtml(parts) {
    for (const part of (parts || [])) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlContent = Buffer.from(
          part.body.data.replace(/-/g, '+').replace(/_/g, '/'),
          'base64'
        ).toString('utf8');
        return;
      }
      if (part.parts) findHtml(part.parts);
    }
  }

  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    htmlContent = Buffer.from(
      payload.body.data.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
  } else {
    findHtml(payload.parts);
  }

  if (!htmlContent) return null;

  // Match airbnb.com or airbnb.fr thread URL
  const match = htmlContent.match(/https?:\/\/(?:www\.)?airbnb\.[a-z.]{2,6}\/hosting\/inbox\/thread\/(\d+)/i);
  return match ? match[1] : null;
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
 * Extract guest name from Airbnb notification email.
 * Airbnb subjects look like:
 *   "Nouveau message de Jean" / "New message from Jean"
 *   "Jean vous a envoyé un message"
 *   "Demande de réservation de Jean pour ..."
 *   "Nouvelle demande de renseignement de Jean"
 */
function extractGuestName(subject, body) {
  // Try subject patterns first (most reliable)
  const subjectPatterns = [
    // FR: "Objet : Réservation pour ..." — contains property name but body has guest info
    // FR: "Nouveau message de Jean"
    /(?:nouveau|nouvelle)\s+(?:message|demande)[^]*?de\s+([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+)?)/i,
    // FR: "Jean vous a envoyé un message"
    /^([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+)?)\s+vous\s+a\s+envoy/i,
    // EN: "New message from Jean"
    /new\s+message\s+from\s+([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+)?)/i,
    // EN: "Reservation request from Jean"
    /(?:reservation|booking)\s+(?:request|inquiry)\s+from\s+([A-ZÀ-Ü][a-zà-ü]+)/i,
    // FR: "Jean a fait une demande"
    /^([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü]\.?)?)\s+(?:a\s+fait|souhaite|demande)/i,
  ];

  for (const regex of subjectPatterns) {
    const match = subject.match(regex);
    if (match) return match[1].trim();
  }

  // Try body patterns
  const bodyPatterns = [
    /message\s+de\s+([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+)?)/i,
    /de\s+la\s+part\s+de\s+([A-ZÀ-Ü][a-zà-ü]+)/i,
    /from\s+([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+)?)/i,
    // FR: "Réservation de Jean" or "Demande de Jean"
    /(?:réservation|demande)\s+de\s+([A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü]\.?)?)/i,
    // FR: "Jean arrive le..." / "Jean part le..."
    /([A-ZÀ-Ü][a-zà-ü]+)\s+(?:arrive|part|séjourne|checke?)\s/i,
  ];

  for (const regex of bodyPatterns) {
    const match = body.match(regex);
    if (match) return match[1].trim();
  }

  return null;
}

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
function getAuthUrl(state, loginHint) {
  const oauth2 = makeOAuth2Client();
  const opts = {
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
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
    expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
  };
}

/**
 * Purge non-Airbnb conversations that were synced via Gmail.
 * Deletes conversations (and their messages) where the sender is not from Airbnb.
 * Returns the number of conversations deleted.
 */
async function purgeNonAirbnbConversations(userId) {
  const db = getDatabase();

  // Find gmail_threads that are NOT from Airbnb
  const nonAirbnbThreads = await db.query(
    `SELECT gt.id, gt.conversation_id, gt.sender_email
     FROM gmail_threads gt
     WHERE gt.user_id = ?
       AND gt.sender_email NOT LIKE '%airbnb.com'
       AND gt.sender_email NOT LIKE '%airbnb.fr'`,
    [userId]
  );

  if (nonAirbnbThreads.length === 0) {
    logger.info(`Purge: no non-Airbnb conversations found for user ${userId}`);
    return 0;
  }

  let deleted = 0;
  for (const thread of nonAirbnbThreads) {
    try {
      // Delete messages first (FK constraint)
      await db.query('DELETE FROM messages WHERE conversation_id = ?', [thread.conversation_id]);
      // Delete the gmail_thread record
      await db.query('DELETE FROM gmail_threads WHERE id = ?', [thread.id]);
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
  purgeNonAirbnbConversations
};

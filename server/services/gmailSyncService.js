/**
 * Gmail Sync Service
 *
 * Fetches emails from Gmail via the Google API and inserts them as
 * incoming messages in the conversation system — exactly the same
 * flow as the Airbnb sync but via IMAP-style REST (Gmail API v1).
 *
 * OAuth2 tokens are stored AES-256-GCM encrypted, identical to airbnb_accounts.
 */
// The Google SDKs are the heaviest dependency in the process and nothing calls
// Gmail during startup, so they are resolved on first use instead of at
// require() time. server.js loads every route → controller → service before
// app.listen(), so an eager require here is time the whole API spends
// answering 503 "Server is starting".
let _gmailApi = null;
function gmailApi() {
  if (!_gmailApi) _gmailApi = require('@googleapis/gmail').gmail;
  return _gmailApi;
}
let _OAuth2Client = null;
function oauthClientClass() {
  if (!_OAuth2Client) _OAuth2Client = require('google-auth-library').OAuth2Client;
  return _OAuth2Client;
}

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
const { extractAirbnbMessageBlocks, fingerprint } = require('./airbnbMessageBlocks');

/**
 * Rend une date au format que la base attend : 'YYYY-MM-DD HH:MM:SS', en UTC.
 *
 * Ne JAMAIS lier un objet Date directement : sur le dialecte better-sqlite3,
 * knex le convertit en `valueOf()`, donc en millisecondes entières, tandis que
 * NOW() (traduit en datetime('now') par la couche db) écrit du texte. Mélanger
 * les deux dans une même colonne casse tout tri, SQLite classant les entiers
 * avant le texte quelle que soit la date réelle.
 *
 * Même convention que nowIso() dans outboundQueue.js.
 */
function toSqlDateTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

// ================================================================
// OAuth2 helper
// ================================================================

function makeOAuth2Client() {
  const OAuth2Client = oauthClientClass();
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
  return gmailApi()({ version: 'v1', auth: oauth2 });
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
  //
  // Only ACTIVE accounts are returned. A disconnected account keeps its row
  // (audit trail, and the reconnect path reuses it) but has no tokens left, so
  // there is nothing left to do with it — while it was still listed, the page
  // showed a dead "Inactif" card whose only button was "Déconnecter" again, and
  // the "Connecter Gmail" card stayed hidden because the account list was not
  // empty. Disconnecting therefore left the user with no way back in.
  return db.query(
    `SELECT id, email, is_active, last_sync_at, sync_status, sync_error, can_send, created_at
     FROM gmail_accounts WHERE user_id = ? AND is_active = TRUE ORDER BY created_at DESC`,
    [userId]
  );
}

/**
 * Deactivate (soft-delete) a Gmail account
 */
async function deactivateAccount(userId, accountId) {
  const db = getDatabase();
  // Clearing sync_status/sync_error too: a disconnected account that kept
  // sync_status = 'error' came back as a red "Erreur" card the moment it was
  // reconnected, reporting a failure that belonged to the previous token.
  // Returns whether a row actually changed, so the caller can answer 404
  // instead of reporting success for an account that was never touched.
  const result = await db.query(
    `UPDATE gmail_accounts
        SET is_active = FALSE, access_token_enc = NULL, refresh_token_enc = NULL,
            sync_status = 'idle', sync_error = NULL
      WHERE id = ? AND user_id = ? AND is_active = TRUE`,
    [accountId, userId]
  );
  return (result.affectedRows || 0) > 0;
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

    // The watermark is stamped from the moment the run STARTED, never from the
    // moment it finished.
    //
    // finishSyncLog used to write `last_sync_at = NOW()` after the thread loop,
    // so the next incremental window opened where this run ENDED. Everything
    // that arrived while the run was working — and a first sync over a few
    // thousand mails takes minutes, one threads.get per thread in batches of 5 —
    // fell between the two windows and was never listed again. The 5-minute
    // buffer hid it only for syncs that finished within 5 minutes.
    const syncStartedAt = new Date();

    // Fetch ALL Airbnb notification emails.
    //
    //   in:anywhere  Gmail's list endpoints exclude SPAM and TRASH by default,
    //                and Airbnb notifications do land in spam, silently — a
    //                host cannot answer a message the sync refuses to look at.
    //   -in:trash    but the trash is a DELIBERATE act. Re-importing what the
    //                host threw away (and resurrecting the conversation it
    //                belonged to on every sync) is not completeness, it is
    //                refusing to take no for an answer.
    let q = 'from:airbnb in:anywhere -in:trash';
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

    // Any thread this run could not finish. A single one of these means the
    // watermark must NOT move: the incremental window would jump over the
    // thread we just failed on, and nothing would ever list it again.
    let incompleteThreads = 0;

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
        if (!res || !res.data || !res.data.messages) {
          incompleteThreads++;
          continue;
        }
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
        incompleteThreads++;
        logger.warn(`Gmail sync thread ${threadId} failed: ${threadErr.message}`);
      }
    }

    if (hostNames.size > hostNamesBefore) {
      await persistHostNames(db, accountId, hostNames);
    }

    logger.info(`Gmail sync: DONE — ${synced} new messages saved, ${skipped} threads skipped (no new messages)`);
    await finishSyncLog(db, syncLogId, synced, accountId, {
      watermark: syncStartedAt,
      complete: incompleteThreads === 0,
      incompleteThreads,
    });
    return { synced, threads: threadMap.size, incompleteThreads };
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

/**
 * Reconciliation pass — re-read threads we already know and import whatever is
 * missing, ignoring the incremental window entirely.
 *
 * The incremental sync is a *recall* mechanism: it finds threads whose newest
 * message is inside the `after:` window. Everything about completeness rests on
 * that window never being wrong — and it can be wrong for reasons no amount of
 * care inside one run removes: a Gmail 5xx on a single threads.get, a deploy
 * restarting the process mid-run, a token refreshed halfway, clock skew between
 * the app and Gmail, a message Gmail back-dates into a window that has closed.
 * When it is wrong, the messages are not late — they are gone, because nothing
 * ever lists that thread again.
 *
 * This pass removes that class of failure instead of narrowing it. It walks
 * gmail_threads (the threads we have already attached to a conversation),
 * re-fetches each one in full, and hands it to the same importer. Since
 * syncGmailThread de-duplicates on gmail_message_id, re-reading a complete
 * thread writes nothing; a thread with a hole fills in.
 *
 * Cost is bounded by design: oldest-reconciled-first, `limit` threads per run,
 * so a large mailbox is covered over several passes rather than in one burst.
 *
 * @returns {Promise<{threads: number, recovered: number, failed: number}>}
 */
async function reconcileThreads(userId, accountId, { limit = 40 } = {}) {
  const account = await getGmailAccount(userId, accountId);
  if (!account) throw new Error('Gmail account not found');

  const db = getDatabase();
  const gmail = getGmailClient(account.access_token, account.refresh_token);

  // Least-recently-reconciled first, so every thread comes round eventually
  // instead of the same busy ones being re-read forever.
  const rows = await db.query(
    `SELECT gt.gmail_thread_id
       FROM gmail_threads gt
      WHERE gt.gmail_account_id = ? AND gt.user_id = ?
      ORDER BY COALESCE(gt.reconciled_at, '1970-01-01') ASC, gt.id ASC
      LIMIT ?`,
    [accountId, userId, limit]
  );
  if (rows.length === 0) return { threads: 0, recovered: 0, failed: 0 };

  const properties = await db.query(
    'SELECT id, name, superhot_listing_id, context_json FROM property_profiles WHERE user_id = ?',
    [userId]
  );
  const hostNames = loadHostNames(account);

  let recovered = 0;
  let failed = 0;

  for (const row of rows) {
    const threadId = row.gmail_thread_id;
    try {
      const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
      const msgs = res?.data?.messages || [];
      if (msgs.length === 0) {
        // The thread is gone from Gmail (deleted, or purged from trash). Stamp
        // it so it stops being re-read on every pass.
        await touchReconciled(db, accountId, threadId);
        continue;
      }

      const added = await syncGmailThread(
        userId, accountId, account, gmail, threadId, msgs, properties, hostNames
      );
      if (added > 0) {
        recovered += added;
        logger.info(`Réconciliation : ${added} message(s) récupéré(s) sur le fil ${threadId}`);
      }
      await touchReconciled(db, accountId, threadId);
    } catch (err) {
      failed++;
      // 404 means the thread no longer exists — not worth retrying forever.
      if (err?.code === 404 || err?.status === 404) {
        await touchReconciled(db, accountId, threadId).catch(() => {});
      }
      logger.warn(`Réconciliation du fil ${threadId} impossible : ${err.message}`);
    }
  }

  if (hostNames.size > 0) {
    await persistHostNames(db, accountId, hostNames).catch(() => {});
  }

  if (recovered > 0 || failed > 0) {
    logger.info(
      `Réconciliation Gmail (compte ${accountId}) : ${rows.length} fil(s) relus, ` +
      `${recovered} message(s) récupéré(s), ${failed} échec(s)`
    );
  }
  return { threads: rows.length, recovered, failed };
}

async function touchReconciled(db, accountId, gmailThreadId) {
  await db.query(
    'UPDATE gmail_threads SET reconciled_at = NOW() WHERE gmail_account_id = ? AND gmail_thread_id = ?',
    [accountId, gmailThreadId]
  );
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

    // ── Reunite a conversation that was split before its Airbnb id was known ──
    //
    // Airbnb notification mails carry NO References/In-Reply-To header (2 of
    // 3290 in a real mailbox), so Gmail can only thread them by SUBJECT — and
    // Airbnb rewrites the subject as a booking advances ("Demande
    // d'information pour X" → "Préapprobation pour X" → "Réservation pour X").
    // Every rewrite therefore starts a NEW Gmail thread for the SAME Airbnb
    // conversation, and each new Gmail thread became its own conversation here.
    //
    // The airbnb_thread_id is what puts them back together, but it was only
    // ever consulted while REGISTERING a Gmail thread (the else-branch below).
    // Once a thread was registered, this branch merely backfilled the id and
    // never looked to see whether a sibling conversation already carried it —
    // so a split that happened before the id could be extracted stayed split
    // forever, and the host saw a two-message conversation where Airbnb showed
    // a dozen.
    if (airbnbThreadId) {
      const survivorId = await reconcileAirbnbThread(db, userId, airbnbThreadId, conversationId);
      if (survivorId !== conversationId) {
        conversationId = survivorId;
        await db.query(
          'UPDATE gmail_threads SET conversation_id = ? WHERE id = ? AND user_id = ?',
          [conversationId, dbThreadId, userId]
        );
      }
    }

    // Backfill airbnb_thread_id and airbnb_reply_url if we now have them but they weren't stored before
    if (airbnbThreadId) {
      await db.query(
        `UPDATE conversations SET airbnb_thread_id = ?, airbnb_reply_url = COALESCE(airbnb_reply_url, ?)
          WHERE id = ? AND user_id = ? AND (airbnb_thread_id IS NULL OR airbnb_thread_id = '')`,
        [airbnbThreadId, airbnbReplyUrl, conversationId, userId]
      );
    } else if (airbnbReplyUrl) {
      // Store the reply URL even if we couldn't parse a clean thread ID
      await db.query(
        `UPDATE conversations SET airbnb_reply_url = ?
          WHERE id = ? AND user_id = ? AND (airbnb_reply_url IS NULL OR airbnb_reply_url = '')`,
        [airbnbReplyUrl, conversationId, userId]
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
      // Oldest wins, deterministically: an unordered LIMIT 1 let two syncs of
      // the same Airbnb thread pick different "existing" conversations and keep
      // splitting messages between them.
      const byAirbnbThread = await db.query(
        'SELECT id FROM conversations WHERE user_id = ? AND airbnb_thread_id = ? ORDER BY id ASC LIMIT 1',
        [userId, airbnbThreadId]
      );
      if (byAirbnbThread.length > 0) {
        existingConvId = byAirbnbThread[0].id;
        logger.info(`Gmail sync thread ${threadId}: merging into existing conversation ${existingConvId} (Airbnb thread ${airbnbThreadId})`);
        // Backfill property match if we now know it and the conversation doesn't yet
        if (matchedProperty) {
          await db.query(
            'UPDATE conversations SET property_id = ? WHERE id = ? AND user_id = ? AND property_id IS NULL',
            [matchedProperty.id, existingConvId, userId]
          );
        }
      }
    }

    if (existingConvId) {
      conversationId = existingConvId;
      if (isAirbnb) {
        await maybeUpgradeGuestName(db, userId, conversationId, nameResult);
      }
      // Register the Gmail thread — the name-fallback and create paths below
      // both do it, but this one did not, so a thread grouped by
      // airbnb_thread_id was never recorded. It still found its conversation on
      // every later sync (the same lookup ran again), but it stayed invisible in
      // gmail_threads: nothing linked the mail thread to the conversation, the
      // last_message_at/last_synced_at bookkeeping never ran for it, and the
      // repair paths that walk gmail_threads could not see it.
      const tRes = await db.query(
        `INSERT INTO gmail_threads (user_id, gmail_account_id, gmail_thread_id, conversation_id, sender_email, sender_name, subject, last_message_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [userId, accountId, threadId, conversationId, senderEmail, displayName, subject]
      );
      dbThreadId = tRes.insertId;
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
  // Empreintes du contenu déjà stocké. Sert UNIQUEMENT à reconnaître qu'un bloc
  // rappelé dans un e-mail plus récent est un message que nous avons déjà : la
  // déduplication du sync, elle, reste la clé (conversation_id,
  // gmail_message_id) imposée par la base (migration 020).
  const storedFingerprints = await loadConversationFingerprints(db, conversationId);
  let newMessages = 0;
  let duplicates = 0;
  // Messages retrouvés dans l'historique cité d'un e-mail plus récent : ils
  // n'ont jamais été livrés isolément (ou leur e-mail n'a pas été importé), et
  // ce sont eux qui rebouchent les trous des conversations existantes.
  let recoveredFromQuotes = 0;
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
    const body = decodedBodies[mi] || '';
    const msgHeaders = parseHeaders(fullMsg);
    const msgSenderEmail = extractEmail(msgHeaders.from || '');
    const msgSubject = msgHeaders.subject || '';

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

    // Known message — but if it predates the reply-header capture, fill the
    // headers in from the payload already in hand. COALESCE + the IS NULL
    // guard make this idempotent, so it is a no-op on every later sync.
    if (existingMsgIds.has(fullMsg.id) && needsHeaders.has(fullMsg.id)) {
      if (emailReplyTo || emailMessageId) {
        await db.query(
          `UPDATE messages
              SET email_reply_to = COALESCE(email_reply_to, ?),
                  email_message_id = COALESCE(email_message_id, ?),
                  email_references = COALESCE(email_references, ?),
                  email_subject = COALESCE(email_subject, ?)
            WHERE gmail_message_id = ? AND conversation_id = ? AND email_reply_to IS NULL`,
          [emailReplyTo, emailMessageId, emailReferences, msgHeaders.subject || null, fullMsg.id, conversationId]
        );
        needsHeaders.delete(fullMsg.id);
      }
    }

    // Determine the role of the mail as a whole:
    // - If sent by the user's own email → outgoing
    // - If from Airbnb: detect whether it's a notification of the HOST's own reply
    //   vs a GUEST message. Airbnb sends both as automated@airbnb.com.
    // Only used for the parts no role block covers; a block carries its own role.
    let fallbackRole;
    if (msgSenderEmail === account.email.toLowerCase()) {
      fallbackRole = 'outgoing';
    } else if (isAirbnb) {
      fallbackRole = detectAirbnbMessageRole(msgSubject, body, account.email);
    } else {
      fallbackRole = 'incoming';
    }

    // Écrit sous forme de chaîne 'YYYY-MM-DD HH:MM:SS', jamais comme objet Date.
    //
    // knex, sur le dialecte better-sqlite3, transforme tout binding Date en
    // `valueOf()` — donc en millisecondes ENTIÈRES. Les autres écritures de ces
    // mêmes colonnes passent par NOW(), que la couche db traduit en
    // datetime('now'), c'est-à-dire du TEXTE. La colonne se retrouvait avec les
    // deux types, et SQLite ordonne le texte APRÈS les entiers : dans
    // `ORDER BY updated_at DESC`, toute conversation datée en texte passait
    // devant toute conversation datée en entier, quelle que soit la date réelle.
    // Les conversations les plus récentes se retrouvaient donc en bas de la
    // liste. Même effet sur l'ordre des messages d'un fil.
    //
    // UTC des deux côtés : datetime('now') est en UTC, toISOString() aussi.
    const baseDateMs = fullMsg.internalDate ? parseInt(fullMsg.internalDate, 10) : Date.now();

    // UN e-mail Airbnb peut porter PLUSIEURS messages (voir
    // services/airbnbMessageBlocks.js). buildStorableParts rend donc une liste :
    // le message que l'e-mail annonce, puis l'historique rappelé sous lui.
    const parts = buildStorableParts({
      gmailMessageId: fullMsg.id,
      body,
      isAirbnb,
      subject: msgHeaders.subject || '',
      fallbackRole,
      baseDateMs,
    });

    for (const part of parts) {
      if (existingMsgIds.has(part.key)) {
        duplicates++;
        continue;
      }

      // Un bloc rappelé n'est ajouté QUE s'il manque réellement. Comparé au
      // contenu parce qu'il n'a pas d'identité Gmail propre — c'est le même
      // message, rendu une seconde fois dans un autre e-mail. La comparaison
      // est volontairement restreinte aux messages de CETTE conversation et au
      // même rôle : deux messages identiques venant de deux e-mails distincts
      // gardent chacun leur ligne, puisqu'ils passent par le chemin primaire.
      if (part.quoted && quoteAlreadyStored(storedFingerprints, part.role, part.content)) {
        continue;
      }

      if (part.unreadable) {
        logger.warn(`Gmail sync: message ${fullMsg.id} illisible (${part.unreadable}) — enregistré en l'état`);
      }

      const msgDate = toSqlDateTime(new Date(part.dateMs));

      // The read-then-write above (existingMsgIds) is a decision made on a
      // snapshot: another importer may insert this same message between that read
      // and this write. Migration 020 makes the database refuse the second one —
      // this catch is the other half, turning that refusal into the same "already
      // known" outcome the in-memory check produces, instead of an exception that
      // would abort the rest of the thread.
      //
      // Concretely: the sync cycle and the reconciliation pass read the same
      // threads, and a Render deploy briefly runs two processes over one file.
      try {
        await db.query(
          `INSERT INTO messages
            (conversation_id, role, content, gmail_message_id,
             email_reply_to, email_message_id, email_references, email_subject,
             metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            conversationId,
            part.role,
            part.content,
            part.key,
            // Un bloc rappelé n'a pas d'enveloppe à lui : lui prêter le Reply-To
            // de l'e-mail qui le cite ferait de lui un déclencheur de réponse
            // automatique valide (replyContextService filtre sur
            // email_reply_to IS NOT NULL). Il reste donc sans en-têtes.
            part.quoted ? null : emailReplyTo,
            part.quoted ? null : emailMessageId,
            part.quoted ? null : emailReferences,
            msgSubject || null,
            JSON.stringify({
              source: 'gmail_sync',
              gmail_message_id: fullMsg.id,
              gmail_thread_id: threadId,
              from: msgHeaders.from,
              subject: msgHeaders.subject,
              date: msgHeaders.date,
              sender_name: displayName,
              property_name: matchedProperty ? matchedProperty.name : propertyName,
              ...(part.blockIndex !== null ? { block_index: part.blockIndex } : {}),
              ...(part.sender ? { block_sender: part.sender } : {}),
              ...(part.quoted ? { recovered_from_quote: true } : {}),
              ...(part.unreadable ? { unreadable: part.unreadable } : {}),
            }),
            msgDate,
          ]
        );
      } catch (err) {
        if (isDuplicateMessageError(err)) {
          // Another importer won the race. Same outcome as finding it in the
          // snapshot: count it as a duplicate and move on.
          duplicates++;
          existingMsgIds.add(part.key);
          logger.info(`Gmail sync: message ${part.key} déjà inséré par un autre passage — ignoré`);
          continue;
        }
        throw err;
      }

      // Guard against re-inserting the same id twice within this same thread pass
      // (Gmail can list a message under more than one thread during a merge), and
      // against two e-mails rappelant le même message historique.
      existingMsgIds.add(part.key);
      const fp = fingerprint(part.content);
      if (fp) storedFingerprints.push({ role: part.role, fp });

      // Seul le message annoncé par l'e-mail fait remonter la conversation :
      // un bloc rappelé est antérieur, il ne doit pas dater le fil.
      if (!part.quoted && (!latestMsgDate || msgDate > latestMsgDate)) latestMsgDate = msgDate;

      newMessages++;
      if (part.quoted) recoveredFromQuotes++;
      logger.info(`Gmail sync: saved message ${part.key} (role=${part.role}${part.quoted ? ', rappelé' : ''}) to conversation ${conversationId}`);

      // A placeholder is a record that something arrived, not a question. Letting
      // it trigger the automatic reply would have Michel answer a body it could
      // not read — the host looks at this one. Un message rappelé n'en déclenche
      // pas non plus : il est ancien par construction, et l'hôte y a déjà
      // répondu ailleurs dans le fil.
      if (part.role === 'incoming' && !part.unreadable && !part.quoted) newGuestMessages++;
    }
  }

  // Touch updated_at once so the conversation floats to the top of the inbox
  // list — previously this ran once per message inserted.
  if (latestMsgDate) {
    await db.query(
      'UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?',
      [latestMsgDate, conversationId, userId]
    );
  }

  if (recoveredFromQuotes > 0) {
    logger.info(
      `Gmail sync thread ${threadId}: ${recoveredFromQuotes} message(s) récupéré(s) dans l'historique cité`
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

  // Advance booking_status from the messages that just landed.
  //
  // autoUpdateStatus only ever ran from the manual "add message" endpoint, so a
  // conversation fed entirely by Gmail — which is all of them — stayed on
  // 'inquiry' for its whole life. That fed the model a wrong booking state on
  // every generation, and left the closure rule's 'checked_out' signal dead: a
  // stay could not be recognised as finished because nothing ever recorded that
  // it had started. Status only moves forward, so this is safe to re-run.
  if (newMessages > 0) {
    setImmediate(() => {
      try {
        const { autoUpdateStatus } = require('./statusDetector');
        Promise.resolve(autoUpdateStatus(conversationId)).catch(statusErr => {
          logger.warn(`Status detection failed for conversation ${conversationId}: ${statusErr.message}`);
        });
      } catch (statusErr) {
        logger.warn(`Status detection failed for conversation ${conversationId}: ${statusErr.message}`);
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
 * Does this error mean "that message is already stored"?
 *
 * Recognises the unique-violation shapes of both engines the app runs on
 * (better-sqlite3 in dev/test/production-on-Render, mysql2 when DB_HOST is
 * configured). Matching on the message text as well as the code keeps it
 * working when knex wraps the driver error.
 */
function isDuplicateMessageError(err) {
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

/**
 * Liste des lignes à écrire pour UN e-mail Gmail.
 *
 * Un e-mail Airbnb ne vaut PAS un message. Le gabarit rend chaque message comme
 * un bloc « nom / rôle / texte », et une notification en porte régulièrement
 * deux ou trois : celui qu'elle annonce, puis le rappel de ceux qui précèdent.
 * L'ancien extracteur n'en rendait qu'un — c'est la cause des messages manquants.
 *
 * Convention de clé, choisie pour rester compatible avec l'existant :
 *   - bloc 0        → l'identifiant Gmail nu. Les lignes déjà en base gardent
 *                     donc exactement leur clé, aucune reprise de données ;
 *   - blocs suivants → `<idGmail>#<n>`, déterministe, donc rejouable sans
 *                     doublon sous l'index UNIQUE (conversation_id,
 *                     gmail_message_id) de la migration 020.
 *
 * @returns {Array<{key,role,content,quoted,sender,unreadable,dateMs,blockIndex}>}
 */
function buildStorableParts({ gmailMessageId, body, isAirbnb, subject, fallbackRole, baseDateMs }) {
  const blocks = isAirbnb ? extractAirbnbMessageBlocks(body) : [];

  if (blocks.length > 0) {
    return blocks.map((block, i) => ({
      key: i === 0 ? gmailMessageId : `${gmailMessageId}#${i}`,
      role: block.role,
      content: block.text,
      // Le bloc 0 est le message que cet e-mail annonce ; les suivants sont
      // l'historique rappelé sous lui.
      quoted: i > 0,
      sender: block.sender,
      unreadable: null,
      // Un bloc rappelé est antérieur au message annoncé : daté juste avant,
      // il s'insère au bon endroit du fil sans jamais passer devant lui.
      dateMs: baseDateMs - i * 1000,
      blockIndex: i,
    }));
  }

  // Aucun bloc identifiable (mail non-Airbnb, gabarit inconnu, corps illisible) :
  // ancien chemin, un e-mail = un message.
  let content = isAirbnb
    ? extractAirbnbMessage(body)
    : body.replace(/\n{3,}/g, '\n\n').trim();

  // Fallback: if the Airbnb parser returned empty but the raw body has content,
  // use the raw body rather than losing the message.
  if (!content.trim() && body.trim()) {
    logger.warn(`Gmail sync: Airbnb parser returned empty for ${gmailMessageId}, using raw body`);
    content = body.replace(/\n{3,}/g, '\n\n').trim();
  }

  // A message we cannot read is still a message that EXISTS.
  //
  // Both "empty MIME body" and "parser returned nothing" used to `continue`,
  // which dropped the row silently: nothing was stored, so nothing recorded
  // that Gmail had ever delivered it. That is the bulk of what
  // scripts/audit-missing-messages.js reports as `corps-vide` / `parser-vide`.
  //
  // Storing a placeholder instead keeps the thread whole: the host sees that
  // something arrived and can open it in Gmail, the id is recorded so the
  // message is not reconsidered on every later sync, and the reply headers
  // (which live in the headers, not the body) are captured as usual.
  let unreadable = null;
  if (!content.trim()) {
    unreadable = body.trim() ? 'parser_empty' : 'empty_body';
    const hint = String(subject || '').trim();
    content = hint
      ? `[Message Airbnb non lisible automatiquement — objet : ${hint}]`
      : '[Message Airbnb non lisible automatiquement — à consulter dans Gmail]';
  }

  return [{
    key: gmailMessageId,
    role: fallbackRole,
    content,
    quoted: false,
    sender: null,
    unreadable,
    dateMs: baseDateMs,
    blockIndex: null,
  }];
}

/**
 * Empreintes du contenu déjà stocké dans une conversation.
 *
 * Lues une fois par fil : la comparaison ne sert qu'aux blocs rappelés, qui
 * sont rares, mais la relecture par bloc coûterait une requête par bloc.
 */
async function loadConversationFingerprints(db, conversationId) {
  const rows = await db.query(
    'SELECT role, content FROM messages WHERE conversation_id = ?',
    [conversationId]
  );
  const out = [];
  for (const row of rows) {
    const fp = fingerprint(row.content);
    if (fp) out.push({ role: row.role, fp });
  }
  return out;
}

// Longueur minimale d'un préfixe commun pour conclure « c'est le même message ».
// En dessous, seule l'égalité exacte compte : « Merci ! » et « Merci beaucoup »
// ne doivent pas se confondre.
const QUOTE_PREFIX_MIN = 40;

/**
 * Ce bloc rappelé correspond-il à un message déjà présent dans la conversation ?
 *
 * La comparaison porte sur le CONTENU parce qu'un bloc rappelé n'a pas
 * d'identité Gmail propre : c'est le même message, rendu une seconde fois dans
 * un autre e-mail. Elle est bornée à la conversation courante et au même rôle.
 *
 * Le rapprochement par préfixe existe parce que l'ancien extracteur tronquait
 * les messages sur ses marqueurs de fin : la copie en base est souvent un début
 * de la version rappelée (ou l'inverse quand c'est la citation qui est coupée).
 *
 * Ceci ne remplace PAS la déduplication du sync : deux messages identiques
 * légitimes venant de deux e-mails différents passent tous deux par le chemin
 * primaire, gardent chacun leur identifiant Gmail, et donc chacun leur ligne.
 */
function quoteAlreadyStored(storedFingerprints, role, content) {
  const fp = fingerprint(content);
  if (!fp) return true; // rien d'exploitable à ajouter

  for (const stored of storedFingerprints) {
    if (stored.role !== role) continue;
    if (stored.fp === fp) return true;

    const shorter = stored.fp.length <= fp.length ? stored.fp : fp;
    const longer = stored.fp.length <= fp.length ? fp : stored.fp;
    if (shorter.length >= QUOTE_PREFIX_MIN && longer.startsWith(shorter)) return true;
  }
  return false;
}

// Cap the stored host-name list: it should hold an owner plus a few co-hosts,
// never grow without bound from a mis-parsed body.
const MAX_HOST_NAMES = 25;

/**
 * How long the incremental watermark may stay pinned by unreadable threads
 * before it is allowed to move on anyway. See finishSyncLog.
 */
const MAX_WATERMARK_STALL_MS = parseInt(process.env.GMAIL_MAX_WATERMARK_STALL_MS, 10) || 24 * 60 * 60 * 1000;

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

// Tables that point at a conversation and must follow it through a merge.
// `messages` is the one exception, handled separately below because it needs
// de-duplication rather than a blind repoint. gmail_threads IS in this list —
// every thread of the losing conversation moves — and the caller additionally
// repoints the specific row it is holding, which is harmless repetition.
const CONVERSATION_REFERENCES = [
  'gmail_threads',
  'airbnb_threads',
  'outbound_replies',
  'property_qa',
  'reservations',
  'webhook_logs',
];

/**
 * Collapse every conversation that carries the same Airbnb thread id for this
 * user into one, and return the id of the survivor.
 *
 * Two conversations sharing an airbnb_thread_id ARE the same Airbnb
 * conversation — that id is Airbnb's own key for the message thread — so the
 * split is always an artefact of Gmail having filed the notifications under
 * several mail threads. The oldest conversation wins, which makes the outcome
 * independent of the order in which the Gmail threads happen to sync.
 *
 * `currentConvId` is folded in even when it does not carry the id yet: it is
 * about to be given it by the caller's backfill, and merging in the same pass
 * is what lets a conversation that was split BEFORE the id could be extracted
 * be repaired the first time either half is re-synced.
 */
async function reconcileAirbnbThread(db, userId, airbnbThreadId, currentConvId) {
  if (!airbnbThreadId || !currentConvId) return currentConvId;

  const rows = await db.query(
    'SELECT id FROM conversations WHERE user_id = ? AND airbnb_thread_id = ?',
    [userId, airbnbThreadId]
  );

  const ids = new Set(rows.map((r) => r.id));
  ids.add(currentConvId);
  if (ids.size < 2) return currentConvId;

  const [target, ...duplicates] = [...ids].sort((a, b) => a - b);
  for (const duplicateId of duplicates) {
    const moved = await mergeConversationInto(db, userId, duplicateId, target);
    logger.info(
      `Gmail sync: conversation ${duplicateId} merged into ${target} ` +
      `(Airbnb thread ${airbnbThreadId}, ${moved} message(s) moved)`
    );
  }
  return target;
}

/**
 * Fold `sourceConvId` into `targetConvId` and delete the emptied source.
 *
 * Every statement is predicated on user_id: a merge moves messages between
 * conversations, which is exactly the operation that must never be able to
 * cross an account boundary, however malformed the ids reaching it are.
 *
 * Returns the number of messages moved.
 */
async function mergeConversationInto(db, userId, sourceConvId, targetConvId) {
  if (!sourceConvId || !targetConvId || sourceConvId === targetConvId) return 0;

  // Both endpoints must belong to the caller. Reading them back (rather than
  // trusting the ids) is what makes the unscoped UPDATEs below safe.
  const owned = await db.query(
    'SELECT id FROM conversations WHERE id IN (?, ?) AND user_id = ?',
    [sourceConvId, targetConvId, userId]
  );
  if (owned.length !== 2) {
    logger.warn(
      `Gmail sync: refusing to merge conversation ${sourceConvId} into ${targetConvId} — not both owned by user ${userId}`
    );
    return 0;
  }

  // Drop the source rows the target already holds, so a Gmail message that was
  // synced into both halves does not survive the merge twice.
  //
  // The overlap is resolved in JS rather than with
  // `DELETE ... WHERE gmail_message_id IN (SELECT ... FROM messages ...)`:
  // MySQL refuses a subquery that reads the very table being deleted from
  // (error 1093), so that form would work on SQLite in dev and fail in
  // production.
  const [sourceRows, targetRows] = await Promise.all([
    db.query('SELECT id, gmail_message_id FROM messages WHERE conversation_id = ?', [sourceConvId]),
    db.query('SELECT gmail_message_id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL', [targetConvId]),
  ]);

  const targetGmailIds = new Set(targetRows.map((r) => r.gmail_message_id));
  const redundantIds = sourceRows
    .filter((r) => r.gmail_message_id && targetGmailIds.has(r.gmail_message_id))
    .map((r) => r.id);

  if (redundantIds.length > 0) {
    const placeholders = redundantIds.map(() => '?').join(',');
    await db.query(`DELETE FROM messages WHERE id IN (${placeholders})`, redundantIds);
  }

  const moved = sourceRows.length - redundantIds.length;

  await db.query('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?', [targetConvId, sourceConvId]);

  for (const table of CONVERSATION_REFERENCES) {
    try {
      await db.query(`UPDATE ${table} SET conversation_id = ? WHERE conversation_id = ?`, [targetConvId, sourceConvId]);
    } catch (err) {
      // An optional table may not exist on an older deployment; the merge of
      // the messages themselves is what matters and has already happened.
      logger.warn(`Gmail sync: could not repoint ${table} during merge: ${err.message}`);
    }
  }

  // Keep whatever the source knew that the target does not. Read first, then
  // write literal values: MySQL rejects a subquery on the table being updated
  // (error 1093), so the COALESCE-from-subquery form would only work on SQLite.
  const [sourceConv] = await db.query(
    'SELECT property_id, airbnb_reply_url FROM conversations WHERE id = ? AND user_id = ?',
    [sourceConvId, userId]
  );
  if (sourceConv && (sourceConv.property_id || sourceConv.airbnb_reply_url)) {
    const [targetConv] = await db.query(
      'SELECT property_id, airbnb_reply_url FROM conversations WHERE id = ? AND user_id = ?',
      [targetConvId, userId]
    );
    const propertyId = targetConv?.property_id || sourceConv.property_id || null;
    const replyUrl = targetConv?.airbnb_reply_url || sourceConv.airbnb_reply_url || null;
    if (propertyId !== targetConv?.property_id || replyUrl !== targetConv?.airbnb_reply_url) {
      await db.query(
        'UPDATE conversations SET property_id = ?, airbnb_reply_url = ? WHERE id = ? AND user_id = ?',
        [propertyId, replyUrl, targetConvId, userId]
      );
    }
  }

  await db.query('DELETE FROM conversations WHERE id = ? AND user_id = ?', [sourceConvId, userId]);

  return moved;
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

  // The name is matched in SQL, not in JS after the fact.
  //
  // This used to fetch the 20 (or 40) most recently updated conversations and
  // then look for the name among them — so on a busy account the conversation
  // being looked for was routinely outside the window, the fallback reported
  // "no match", and the notification opened yet another conversation holding a
  // single message. It is why one traveller ends up with five or six separate
  // threads for the same stay ("Thibaud / La Planquette" occupies six) while
  // Airbnb shows one continuous conversation.
  //
  // guest_name is matched case-insensitively here and re-checked with nameKey()
  // below, which also strips accents — LOWER() is ASCII-only in SQLite, so the
  // SQL predicate is the fast index-backed filter and nameKey() is the decision.
  const params = [userId, cutoff, guestName.toLowerCase()];
  let propertyPredicate = '';
  if (matchedProperty) {
    propertyPredicate = 'AND property_id = ?';
    params.push(matchedProperty.id);
  }

  const rows = await db.query(
    `SELECT id, guest_name FROM conversations
      WHERE user_id = ?
        AND external_provider = 'gmail'
        AND created_at >= ?
        AND guest_name IS NOT NULL
        AND LOWER(guest_name) = ?
        ${propertyPredicate}
      ORDER BY id ASC`,
    params
  );

  for (const row of rows) {
    // Exact match only — merging on the first name alone mixed up distinct
    // travellers who happen to share one. Oldest wins (ORDER BY id) so every
    // notification of one stay converges on the same conversation.
    if (nameKey(row.guest_name) === normalizedName) return row.id;
  }

  // Accented spellings that LOWER() cannot equate ("Gaëlle" vs "GAELLE") are
  // rare but real; they get a bounded scan rather than an unbounded one.
  const accentFallback = await db.query(
    `SELECT id, guest_name FROM conversations
      WHERE user_id = ?
        AND external_provider = 'gmail'
        AND created_at >= ?
        AND guest_name IS NOT NULL
        ${propertyPredicate}
      ORDER BY id ASC
      LIMIT 500`,
    matchedProperty ? [userId, cutoff, matchedProperty.id] : [userId, cutoff]
  );
  for (const row of accentFallback) {
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

    // Step A: decode any tracking redirect params (url=, redirect=, to=, dest=, upn=)
    // Airbnb emails wrap links: href="https://email.airbnb.com/ls/click?upn=...&url=https%3A%2F%2F..."
    //
    // upn= is SendGrid's own wrapper (these mails are sent through SendGrid —
    // their Message-IDs end in @geopod-ismtpd-NN) and it does NOT use percent
    // escapes: the destination is encoded with "-" instead of "%", so a link
    // reads ...upn=https-3A-2F-2Fwww.airbnb.fr-2Fhosting-2Fthread-2F248… . It was
    // named in this function's doc comment from the start but never actually
    // decoded, so on any mail whose thread link exists only inside a tracking
    // wrapper the id was unrecoverable.
    const redirectParamRe = /[?&](?:url|redirect|to|dest|link|upn)=([^&"'\s]{20,})/gi;
    let rdMatch;
    while ((rdMatch = redirectParamRe.exec(text)) !== null) {
      for (const decoded of decodeRedirectTarget(rdMatch[1])) {
        const found = searchRawUrl(decoded);
        if (found) return found;
      }
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

    // /hosting/thread/<id> — the format Airbnb actually sends today. Every
    // thread link in a current notification mail looks like
    //   https://www.airbnb.fr/hosting/thread/2482565367?open_scheduled_messages=…
    // It matches none of the historical patterns below, so before this line the
    // id could only ever be recovered by the loose catch-all at the bottom —
    // which takes the FIRST 8-digit number under any airbnb.<tld>/ URL and
    // therefore just as happily returns a listing or user id.
    let m = text.match(/\/hosting\/thread\/(\d+)/i);
    if (m) {
      const tid = m[1];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/thread/${tid}` };
    }

    // /hosting/inbox/thread/<id>  (desktop, app, fr + com)
    m = text.match(/\/hosting\/inbox(?:\/thread)?\/(\d+)/i);
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

    // Last resort: any 8+ digit id embedded in an airbnb URL.
    //
    // Airbnb mails carry plenty of other long numeric ids — the listing
    // (/rooms/, /hosting/listings/), the traveller (/users/show/), the booking
    // (/reservations/) — and taking the first one as the conversation id is
    // worse than finding nothing: every conversation about one listing would
    // collapse onto the same /rooms/ id and be merged into a single thread.
    // Those paths are therefore skipped rather than blindly accepted.
    const NON_THREAD_PATH = /\/(?:rooms|listings|users|reservations|account-settings|payments|payouts|experiences|wishlists|help|reviews)\//i;
    const genericRe = /airbnb\.[a-z]{2,6}\/([^"'\s]*?)\/(\d{8,})/gi;
    let gm;
    while ((gm = genericRe.exec(text)) !== null) {
      if (NON_THREAD_PATH.test(`/${gm[1]}/`)) continue;
      const tid = gm[2];
      return { threadId: tid, replyUrl: `https://www.airbnb.com/hosting/thread/${tid}` };
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
 * Candidate plaintexts for a tracking-redirect parameter value.
 *
 * Returns every decoding worth searching rather than guessing which one
 * applies: the same `?upn=`/`?url=` slot carries percent-escaped URLs,
 * SendGrid's "-2F" dash-escaped URLs, and base64 payloads depending on the
 * template. The raw value is included last so a plain, unencoded URL still
 * gets searched.
 */
function decodeRedirectTarget(rawValue) {
  const out = [];
  const push = (value) => {
    if (value && typeof value === 'string' && !out.includes(value)) out.push(value);
  };

  try {
    push(decodeURIComponent(rawValue));
  } catch (_) {
    // Percent sequence was malformed — the other decodings may still work.
  }

  // SendGrid: "-2F" → "/", "-3A" → ":", i.e. percent-escapes written with "-".
  if (/-[0-9A-F]{2}/i.test(rawValue)) {
    push(rawValue.replace(/-([0-9A-F]{2})/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      // Leave "-XY" alone when it is not a printable ASCII escape, otherwise a
      // literal hyphen in the payload turns into a control character.
      return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : `-${hex}`;
    }));
  }

  // Some templates base64 the destination instead of escaping it.
  if (/^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(rawValue)) {
    try {
      const decoded = Buffer.from(
        rawValue.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
      ).toString('utf8');
      if (/airbnb/i.test(decoded)) push(decoded);
    } catch (_) {}
  }

  push(rawValue);
  return out;
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
 * Mark sync as complete and update the account's incremental watermark.
 *
 * `last_sync_at` is not bookkeeping — it is the left edge of the next
 * `after:` window, so writing it is a promise that everything before it has
 * been imported. Two rules follow:
 *
 *   - the watermark is the moment the run STARTED, not NOW(). A run that took
 *     four minutes must not claim the four minutes it spent working.
 *   - a run that could not read every thread does not move it at all. Losing a
 *     little ground (the next run re-reads threads it already has, which is
 *     cheap and de-duplicated by gmail_message_id) is always better than
 *     stepping over a thread that failed: the incremental window never comes
 *     back, so those messages would be gone for good.
 */
async function finishSyncLog(db, syncLogId, synced, accountId, options = {}) {
  const { watermark = null, complete = true, incompleteThreads = 0 } = options;

  await db.query(
    'UPDATE sync_logs SET status = ?, items_synced = ?, completed_at = NOW() WHERE id = ?',
    ['completed', synced, syncLogId]
  );

  if (!complete) {
    // Holding the watermark is the right move for a transient failure, but it
    // must not become permanent: one thread Gmail reliably errors on would pin
    // the window open forever, and every 60s cycle would then re-list and
    // re-fetch the entire mailbox. Past MAX_WATERMARK_STALL_MS the trade
    // reverses — the thread is not coming back on its own, and by now it is
    // either registered in gmail_threads (so the reconciliation pass owns its
    // recovery) or genuinely unreadable.
    const [current] = await db.query('SELECT last_sync_at FROM gmail_accounts WHERE id = ?', [accountId]);
    const previous = current?.last_sync_at ? new Date(`${String(current.last_sync_at).replace(' ', 'T')}Z`) : null;
    const stalledMs = previous ? Date.now() - previous.getTime() : Infinity;

    if (stalledMs <= MAX_WATERMARK_STALL_MS) {
      logger.warn(
        `Gmail sync: ${incompleteThreads} fil(s) non lus pour le compte ${accountId} — ` +
        'le repère de synchronisation reste en arrière pour qu\'ils soient repris au prochain passage'
      );
      await db.query(
        'UPDATE gmail_accounts SET sync_status = ?, sync_error = NULL WHERE id = ?',
        ['idle', accountId]
      );
      return;
    }

    logger.warn(
      `Gmail sync: compte ${accountId} bloqué depuis ${Math.round(stalledMs / 3_600_000)} h sur ` +
      `${incompleteThreads} fil(s) illisibles — le repère avance malgré tout ; ` +
      'la passe de réconciliation prend le relais pour ces fils'
    );
  }

  await db.query(
    'UPDATE gmail_accounts SET last_sync_at = ?, sync_status = ?, sync_error = NULL WHERE id = ?',
    [toSqlDateTime(watermark || new Date()), 'idle', accountId]
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
    const testGmail = gmailApi()({ version: 'v1', auth: oauth2 });
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
  const gmailClient = gmailApi()({ version: 'v1', auth: oauth2 });
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
      // Queued/failed replies for this conversation. outbound_replies carries no
      // foreign key (see migration 017), so nothing removes these on its own:
      // without this the purge left rows pointing at a conversation id that no
      // longer exists — and, worse, an id the database is free to reissue to a
      // future conversation.
      await db.query(
        'DELETE FROM outbound_replies WHERE conversation_id = ? AND user_id = ?',
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
  reconcileThreads,
  purgeNonAirbnbConversations,
  // Exposés pour les scripts d'audit lecture seule (scripts/audit-missing-messages.js) :
  // reproduire exactement le filtrage du sync est le seul moyen de classer un
  // message manquant par cause réelle plutôt que par supposition.
  __extractBody: extractBody,
  __extractAirbnbMessage: extractAirbnbMessage,
  // Découpage multi-blocs : l'audit doit compter les MESSAGES d'un e-mail,
  // pas les e-mails, sans quoi un fil amputé se déclare complet.
  __buildStorableParts: buildStorableParts,
  __quoteAlreadyStored: quoteAlreadyStored,
  __detectAirbnbMessageRole: detectAirbnbMessageRole,
  // Exposés pour les tests (server/tests/gmailThreadMerge.test.js) et le script
  // de réparation (scripts/repair-split-conversations.js). syncGmailThread
  // n'appelle plus l'API Gmail — les messages lui sont passés déjà chargés —
  // donc il est testable directement, sans réseau.
  __syncGmailThread: syncGmailThread,
  __finishSyncLog: finishSyncLog,
  __mergeConversationInto: mergeConversationInto,
  __reconcileAirbnbThread: reconcileAirbnbThread,
  __extractAirbnbThreadIdFromMessage: extractAirbnbThreadIdFromMessage
};

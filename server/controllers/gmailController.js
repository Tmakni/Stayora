/**
 * Gmail Controller — OAuth flow, account management & message sync triggers
 */
const { sanitizeEmail } = require('../utils/sanitize');
const logger = require('../utils/logger');
const gmailSync = require('../services/gmailSyncService');
const { getDatabase } = require('../config/db');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config/env');

// Temporary store for OAuth state → userId mapping (survives during server uptime)
const pendingOAuthStates = new Map();

// ================================================================
// OAuth
// ================================================================

/**
 * GET /api/gmail/auth-url
 * Returns the Google OAuth2 consent URL the front-end should redirect to.
 * Embeds the userId in a signed state parameter so the callback can identify the user.
 */
async function getAuthUrl(req, res) {
  try {
    // Create a unique state token that maps to this user
    const stateToken = crypto.randomBytes(20).toString('hex');
    pendingOAuthStates.set(stateToken, {
      userId: req.userId,
      createdAt: Date.now()
    });

    // Clean up old states (>10 min)
    for (const [key, val] of pendingOAuthStates) {
      if (Date.now() - val.createdAt > 600000) pendingOAuthStates.delete(key);
    }

    const url = gmailSync.getAuthUrl(stateToken);
    return res.json({ url });
  } catch (error) {
    logger.error('Gmail auth URL error:', error);
    return res.status(500).json({ error: 'Impossible de générer l\'URL d\'authentification Gmail' });
  }
}

/**
 * GET /api/gmail/oauth-callback?code=...&state=...
 * Google redirects here after user consents.
 * Handles EVERYTHING server-side: exchanges the code, saves the account,
 * and shows a success/error page. No localStorage JWT needed.
 */
async function oauthCallback(req, res) {
  const code = req.query.code;
  const error = req.query.error;
  const state = req.query.state;

  // Helper to render result page
  function renderPage(title, message, isError) {
    const color = isError ? '#d93025' : '#188038';
    const icon = isError ? '✕' : '✓';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa;}
  .box{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:450px;}
  .icon{font-size:48px;color:${color};margin-bottom:12px;}
  .msg{color:${color};margin-top:8px;}
  a{color:#4285f4;text-decoration:none;}
</style></head><body>
<div class="box">
  <div class="icon">${icon}</div>
  <h2>${title}</h2>
  <p class="msg">${message}</p>
  ${isError ? '' : '<p>Redirection dans 2 secondes...</p><script>setTimeout(()=>window.location.href="/index.html#integrations",2000)</script>'}
</div></body></html>`);
  }

  if (error) {
    logger.warn('Gmail OAuth error from Google:', error);
    return renderPage('Erreur OAuth', `Google a retourné une erreur : ${error}`, true);
  }

  if (!code) {
    return renderPage('Erreur', 'Aucun code d\'autorisation reçu de Google.', true);
  }

  // Find the userId from the state parameter — MUST be valid, no fallback
  let userId = null;

  if (state && pendingOAuthStates.has(state)) {
    userId = pendingOAuthStates.get(state).userId;
    pendingOAuthStates.delete(state);
  }

  if (!userId) {
    return renderPage('Erreur de sécurité',
      'La session OAuth a expiré ou est invalide. <a href="/index.html#integrations">Réessayez la connexion</a>.', true);
  }

  try {
    const { email, accessToken, refreshToken, expiresAt } = await gmailSync.exchangeCode(code);

    const accountId = await gmailSync.saveGmailAccount(userId, {
      email: sanitizeEmail(email),
      accessToken,
      refreshToken,
      expiresAt
    });

    logger.info(`Gmail account added: ${email} for user ${userId}`);

    // Trigger immediate sync
    try {
      const syncResult = await gmailSync.fetchMessages(userId, accountId);
      logger.info(`Gmail initial sync: ${syncResult.synced} messages for ${email}`);
      return renderPage('Gmail connecté !',
        `${email} ajouté avec succès. ${syncResult.synced} message(s) synchronisé(s).`, false);
    } catch (syncErr) {
      logger.warn('Initial Gmail sync failed (account still saved):', syncErr.message);
      return renderPage('Gmail connecté !',
        `${email} ajouté avec succès. La synchronisation démarrera sous 60 secondes.`, false);
    }
  } catch (err) {
    logger.error('Gmail callback exchange error:', err);

    if (err.message && err.message.includes('GMAIL_SCOPE_MISSING')) {
      return renderPage('API Gmail non accessible',
        'L\'API Gmail n\'est pas accessible avec ce compte. Vérifiez que :<br><br>' +
        '1. L\'<a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank">API Gmail est activée</a> dans Google Cloud Console<br>' +
        '2. Le scope <code>gmail.readonly</code> est ajouté dans l\'<a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank">écran de consentement OAuth</a><br><br>' +
        'Puis réessayez la connexion.', true);
    }

    return renderPage('Erreur de connexion',
      `Impossible de connecter Gmail : ${err.message}`, true);
  }
}

/**
 * POST /api/gmail/callback
 * Body: { code: "<authorization_code>" }
 * Legacy endpoint for the old client-side POST approach.
 */
async function handleCallback(req, res) {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Authorization code requis' });
    }

    const { email, accessToken, refreshToken, expiresAt } = await gmailSync.exchangeCode(code);

    const accountId = await gmailSync.saveGmailAccount(req.userId, {
      email: sanitizeEmail(email),
      accessToken,
      refreshToken,
      expiresAt
    });

    await logAudit(req, 'gmail_account_added', 'gmail_account', accountId);
    logger.info(`Gmail account added: ${email} for user ${req.userId}`);

    return res.status(201).json({
      success: true,
      account_id: accountId,
      email,
      message: 'Compte Gmail connecté avec succès'
    });
  } catch (error) {
    logger.error('Gmail callback error:', error);
    return res.status(500).json({ error: 'Erreur lors de la connexion du compte Gmail' });
  }
}

/**
 * GET /api/gmail/reauthorize/:accountId
 * Forces a new OAuth consent for an existing account (to fix missing scopes).
 */
async function reauthorize(req, res) {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    const db = getDatabase();
    const rows = await db.query(
      'SELECT id, email FROM gmail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE',
      [accountId, req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Compte Gmail introuvable' });
    }

    // Create state token that includes the accountId for re-auth
    const stateToken = crypto.randomBytes(20).toString('hex');
    pendingOAuthStates.set(stateToken, {
      userId: req.userId,
      reauthorizeAccountId: accountId,
      createdAt: Date.now()
    });

    const url = gmailSync.getAuthUrl(stateToken, rows[0].email);
    logger.info(`Gmail re-authorize requested for account ${accountId} (${rows[0].email})`);
    return res.json({ url });
  } catch (error) {
    logger.error('Gmail reauthorize error:', error);
    return res.status(500).json({ error: 'Impossible de générer l\'URL de réautorisation' });
  }
}

// ================================================================
// Account management
// ================================================================

/**
 * GET /api/gmail/accounts
 */
async function getAccounts(req, res) {
  try {
    const accounts = await gmailSync.getUserGmailAccounts(req.userId);
    return res.json({ accounts });
  } catch (error) {
    logger.error('Get Gmail accounts error:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération des comptes Gmail' });
  }
}

/**
 * DELETE /api/gmail/accounts/:id
 */
async function removeAccount(req, res) {
  try {
    const accountId = parseInt(req.params.id);
    await gmailSync.deactivateAccount(req.userId, accountId);
    await logAudit(req, 'gmail_account_removed', 'gmail_account', accountId);

    return res.json({ success: true, message: 'Compte Gmail supprimé' });
  } catch (error) {
    logger.error('Remove Gmail account error:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression du compte Gmail' });
  }
}

// ================================================================
// Sync triggers
// ================================================================

/**
 * POST /api/gmail/sync/:accountId
 * Manually trigger a Gmail message sync
 */
async function syncMessages(req, res) {
  try {
    const accountId = parseInt(req.params.accountId);
    // ?force=true → ignore last_sync_at, re-fetch everything (useful to recover missed messages)
    const forceFullSync = req.query.force === 'true' || req.body?.force === true;
    if (forceFullSync) {
      logger.info(`Gmail force full sync requested for account ${accountId} by user ${req.userId}`);
    }
    const result = await gmailSync.fetchMessages(req.userId, accountId, forceFullSync);
    await logAudit(req, 'gmail_sync_messages', 'gmail_account', accountId);

    return res.json({
      success: true,
      message: `${result.synced} messages Gmail synchronisés`,
      ...result
    });
  } catch (error) {
    logger.error('Gmail sync error:', error);

    if (error.message === 'GMAIL_TOKEN_EXPIRED') {
      return res.status(401).json({ error: 'Token Gmail expiré. Veuillez reconnecter le compte.' });
    }

    return res.status(500).json({ error: 'Erreur lors de la synchronisation Gmail' });
  }
}

// ================================================================
// Helpers
// ================================================================

async function logAudit(req, action, entityType, entityId) {
  try {
    const db = getDatabase();
    await db.query(
      'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [
        req.userId,
        action,
        entityType || null,
        entityId || null,
        req.ip || req.connection?.remoteAddress || null,
        req.headers?.['user-agent']?.substring(0, 500) || null
      ]
    );
  } catch (err) {
    logger.warn('Audit log failed:', err.message);
  }
}

/**
 * DELETE /api/gmail/purge-non-airbnb
 * Deletes all conversations that were synced from non-Airbnb senders.
 */
async function purgeNonAirbnb(req, res) {
  try {
    const deleted = await gmailSync.purgeNonAirbnbConversations(req.userId);
    await auditLog(req, 'gmail_purge_non_airbnb', 'gmail_account', null);
    return res.json({ success: true, deleted });
  } catch (error) {
    logger.error('Purge non-Airbnb error:', error);
    return res.status(500).json({ error: 'Échec de la purge' });
  }
}

module.exports = {
  oauthCallback,
  getAuthUrl,
  handleCallback,
  getAccounts,
  reauthorize,
  removeAccount,
  syncMessages,
  purgeNonAirbnb
};

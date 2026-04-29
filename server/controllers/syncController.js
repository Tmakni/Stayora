/**
 * Sync Controller — Airbnb account management + message/reservation sync
 */
const { sanitizeEmail, sanitizeString } = require('../utils/sanitize');
const logger = require('../utils/logger');
const airbnbSync = require('../services/airbnbSyncService');
const { getDatabase } = require('../config/db');

/**
 * POST /api/sync/accounts
 * Register an Airbnb account with access token
 */
async function addAirbnbAccount(req, res) {
  try {
    const { airbnb_email, access_token, refresh_token, airbnb_user_id, display_name } = req.body;

    if (!airbnb_email || !access_token) {
      return res.status(400).json({ error: 'airbnb_email and access_token required' });
    }

    const cleanEmail = sanitizeEmail(airbnb_email);

    const accountId = await airbnbSync.saveAirbnbAccount(req.userId, {
      airbnbEmail: cleanEmail,
      accessToken: access_token,
      refreshToken: refresh_token || null,
      airbnbUserId: airbnb_user_id || null,
      displayName: display_name ? sanitizeString(display_name) : null
    });

    // Log audit
    await logAudit(req, 'airbnb_account_added', 'airbnb_account', accountId);

    logger.info(`Airbnb account added: ${cleanEmail} for user ${req.userId}`);

    return res.status(201).json({
      success: true,
      account_id: accountId,
      message: 'Compte Airbnb ajouté avec succès'
    });
  } catch (error) {
    logger.error('Add Airbnb account error:', error);
    return res.status(500).json({ error: 'Erreur lors de l\'ajout du compte Airbnb' });
  }
}

/**
 * GET /api/sync/accounts
 * List all Airbnb accounts for the user
 */
async function getAirbnbAccounts(req, res) {
  try {
    const accounts = await airbnbSync.getUserAirbnbAccounts(req.userId);
    return res.json({ accounts });
  } catch (error) {
    logger.error('Get Airbnb accounts error:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération des comptes' });
  }
}

/**
 * DELETE /api/sync/accounts/:id
 * Deactivate an Airbnb account
 */
async function removeAirbnbAccount(req, res) {
  try {
    const accountId = parseInt(req.params.id);
    await airbnbSync.deactivateAccount(req.userId, accountId);
    await logAudit(req, 'airbnb_account_removed', 'airbnb_account', accountId);

    return res.json({ success: true, message: 'Compte Airbnb supprimé' });
  } catch (error) {
    logger.error('Remove Airbnb account error:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression du compte' });
  }
}

/**
 * POST /api/sync/messages/:accountId
 * Trigger message sync for a specific Airbnb account
 */
async function syncMessages(req, res) {
  try {
    const accountId = parseInt(req.params.accountId);
    const result = await airbnbSync.fetchMessages(req.userId, accountId);
    await logAudit(req, 'sync_messages', 'airbnb_account', accountId);

    return res.json({
      success: true,
      message: `${result.synced} conversations synchronisées`,
      ...result
    });
  } catch (error) {
    logger.error('Sync messages error:', error);

    if (error.message === 'AIRBNB_TOKEN_EXPIRED') {
      return res.status(401).json({ error: 'Token Airbnb expiré. Veuillez reconnecter le compte.' });
    }

    return res.status(500).json({ error: 'Erreur lors de la synchronisation des messages' });
  }
}

/**
 * POST /api/sync/reservations/:accountId
 * Trigger reservation sync for a specific Airbnb account
 */
async function syncReservations(req, res) {
  try {
    const accountId = parseInt(req.params.accountId);
    const result = await airbnbSync.fetchReservations(req.userId, accountId);
    await logAudit(req, 'sync_reservations', 'airbnb_account', accountId);

    return res.json({
      success: true,
      message: `${result.synced} réservations synchronisées`,
      ...result
    });
  } catch (error) {
    logger.error('Sync reservations error:', error);

    if (error.message === 'AIRBNB_TOKEN_EXPIRED') {
      return res.status(401).json({ error: 'Token Airbnb expiré. Veuillez reconnecter le compte.' });
    }

    return res.status(500).json({ error: 'Erreur lors de la synchronisation des réservations' });
  }
}

/**
 * POST /api/sync/full/:accountId
 * Full sync (messages + reservations)
 */
async function fullSync(req, res) {
  try {
    const accountId = parseInt(req.params.accountId);
    const result = await airbnbSync.fullSync(req.userId, accountId);
    await logAudit(req, 'sync_full', 'airbnb_account', accountId);

    return res.json({
      success: true,
      message: 'Synchronisation complète terminée',
      ...result
    });
  } catch (error) {
    logger.error('Full sync error:', error);
    return res.status(500).json({ error: 'Erreur lors de la synchronisation complète' });
  }
}

/**
 * GET /api/sync/reservations
 * Get all reservations for the user
 */
async function getReservations(req, res) {
  try {
    const db = getDatabase();
    const { status, property_id } = req.query;

    let query = 'SELECT * FROM reservations WHERE user_id = ?';
    const params = [req.userId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    if (property_id) {
      query += ' AND property_id = ?';
      params.push(parseInt(property_id));
    }

    query += ' ORDER BY check_in_date DESC';

    const reservations = await db.query(query, params);

    // Strip raw JSON to reduce payload
    const cleaned = reservations.map(r => {
      const { airbnb_raw_json, ...rest } = r;
      return rest;
    });

    return res.json({ reservations: cleaned });
  } catch (error) {
    logger.error('Get reservations error:', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération des réservations' });
  }
}

/**
 * GET /api/sync/reservations/:id
 * Get a single reservation details
 */
async function getReservation(req, res) {
  try {
    const db = getDatabase();
    const reservationId = parseInt(req.params.id);

    const rows = await db.query(
      'SELECT * FROM reservations WHERE id = ? AND user_id = ?',
      [reservationId, req.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Réservation non trouvée' });
    }

    return res.json({ reservation: rows[0] });
  } catch (error) {
    logger.error('Get reservation error:', error);
    return res.status(500).json({ error: 'Erreur' });
  }
}

/**
 * GET /api/sync/logs
 * Get sync history
 */
async function getSyncLogs(req, res) {
  try {
    const db = getDatabase();
    const logs = await db.query(
      'SELECT * FROM sync_logs WHERE user_id = ? ORDER BY started_at DESC LIMIT 50',
      [req.userId]
    );
    return res.json({ logs });
  } catch (error) {
    logger.error('Get sync logs error:', error);
    return res.status(500).json({ error: 'Erreur' });
  }
}

/**
 * Audit log helper
 */
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

module.exports = {
  addAirbnbAccount,
  getAirbnbAccounts,
  removeAirbnbAccount,
  syncMessages,
  syncReservations,
  fullSync,
  getReservations,
  getReservation,
  getSyncLogs
};

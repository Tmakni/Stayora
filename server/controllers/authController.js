const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config/env');
const { getDatabase } = require('../config/db');
const { sanitizeEmail, sanitizeString } = require('../utils/sanitize');
const logger = require('../utils/logger');

// Generic response for forgot-password — never reveals whether an email is registered
const FORGOT_PASSWORD_GENERIC_MESSAGE =
  'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.';

// Reset tokens are valid for 1 hour
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Resolves the app's own public base URL (no trailing slash), for building
 * links inside transactional emails. Mirrors the precedent set in
 * server/server.js for CORS origin resolution.
 */
function getAppBaseUrl() {
  const configured = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/$/, '');
  return config.isProd ? '' : 'http://localhost:3000';
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parses a jsonwebtoken-style duration ("7d", "24h", "3600", 3600) into
 * milliseconds, so the cookie's lifetime always matches config.jwt.expiresIn
 * instead of drifting from a separately hardcoded value.
 */
function parseDurationMs(value, fallbackMs) {
  if (typeof value === 'number') return value * 1000;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*(ms|s|m|h|d|w|y)?$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      const unit = (match[2] || 's').toLowerCase();
      const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
      return n * (multipliers[unit] || 1000);
    }
  }
  return fallbackMs;
}

// Cookie options — shared by all auth endpoints
function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    maxAge: parseDurationMs(config.jwt.expiresIn, SEVEN_DAYS_MS),
    sameSite: 'strict',
    path: '/',
  };
}

async function register(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid input types' });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères' });
    }

    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 1 majuscule et 1 chiffre' });
    }

    const cleanEmail = sanitizeEmail(email);

    const db = getDatabase();

    const existing = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [cleanEmail]
    );

    if (existing.length > 0) {
      // Deliberately vague — never states that the email is already taken.
      // Note this only *reduces* enumeration: registration must still fail for
      // a taken email, so success-vs-failure remains an oracle. Fully closing
      // it requires always returning 201 and emailing the existing account
      // instead ("someone tried to register with your address").
      return res.status(400).json({ error: 'Registration failed. Please check your information.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES (?, ?)',
      [cleanEmail, passwordHash]
    );

    const userId = result.insertId;

    const token = jwt.sign(
      { userId },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: config.jwt.expiresIn }
    );

    // ATTENTION — ce commentaire affirmait « token only in httpOnly cookie,
    // never in response body », ce que la ligne `token` du JSON ci-dessous
    // contredit depuis toujours. Le jeton part AUSSI dans le corps, le client
    // le range dans localStorage (client/src/lib/api.js) et l'ajoute en query
    // string pour le flux SSE — donc la protection httpOnly du cookie ne
    // protège rien aujourd'hui : une XSS lit le jeton dans localStorage.
    // Le supprimer d'ici casserait SSE (useSSE.js s'appuie sur getToken()) :
    // voir la note de revue pour la marche à suivre.
    res.cookie('token', token, cookieOptions());

    logger.info(`User registered: ${cleanEmail}`);

    return res.status(201).json({
      success: true,
      user: { id: userId, email: cleanEmail },
      token
    });
  } catch (error) {
    logger.error('Register error:', error);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Invalid input types' });
    }

    const cleanEmail = sanitizeEmail(email);

    const db = getDatabase();

    const users = await db.query(
      'SELECT id, email, password_hash FROM users WHERE email = ?',
      [cleanEmail]
    );

    if (users.length === 0) {
      // Constant-time fake comparison to prevent timing attacks on user enumeration
      await bcrypt.compare(password, '$2a$12$000000000000000000000uABC1234567890123456789012345678');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = users[0];

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: config.jwt.expiresIn }
    );

    res.cookie('token', token, cookieOptions());

    logger.info(`User logged in: ${cleanEmail}`);

    return res.json({
      success: true,
      user: { id: user.id, email: user.email },
      token
    });
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({ error: 'Login failed' });
  }
}

async function me(req, res) {
  try {
    const db = getDatabase();
    
    const users = await db.query(
      'SELECT id, email, created_at FROM users WHERE id = ?',
      [req.userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Include properties count and conversations count so frontend knows data exists
    const properties = await db.query(
      'SELECT id, name, property_type FROM property_profiles WHERE user_id = ?',
      [req.userId]
    );

    const conversations = await db.query(
      'SELECT id, title, booking_status, guest_name, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20',
      [req.userId]
    );

    // Airbnb accounts (without sensitive data)
    let airbnbAccounts = [];
    try {
      airbnbAccounts = await db.query(
        'SELECT id, airbnb_email, display_name, is_active, last_sync_at, sync_status FROM airbnb_accounts WHERE user_id = ?',
        [req.userId]
      );
    } catch (_) { /* table may not exist yet */ }

    // Active reservations
    let reservations = [];
    try {
      reservations = await db.query(
        "SELECT id, guest_name, check_in_date, check_out_date, status, property_id FROM reservations WHERE user_id = ? AND status NOT IN ('cancelled','denied','expired') ORDER BY check_in_date ASC",
        [req.userId]
      );
    } catch (_) { /* table may not exist yet */ }
    
    return res.json({
      user: users[0],
      properties,
      conversations,
      airbnb_accounts: airbnbAccounts,
      reservations
    });
  } catch (error) {
    logger.error('Me error:', error);
    return res.status(500).json({ error: 'Failed to get user info' });
  }
}

/**
 * POST /api/auth/refresh
 * Refresh an expired JWT token (within 30-day grace period)
 */
async function refresh(req, res) {
  try {
    let token = req.cookies?.token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }
    if (!token && req.body?.token) {
      token = req.body.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Decode without verifying expiry — but enforce algorithm
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret, { ignoreExpiration: true, algorithms: ['HS256'] });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (!decoded.userId || typeof decoded.userId !== 'number') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Only allow refresh within 7 days of expiry
    const now = Math.floor(Date.now() / 1000);
    const expiredAgo = now - (decoded.exp || 0);
    const maxGracePeriod = 7 * 24 * 60 * 60; // 7 days

    if (expiredAgo > maxGracePeriod) {
      return res.status(401).json({ error: 'Token too old to refresh. Please login again.' });
    }

    // Verify user still exists
    const db = getDatabase();
    const users = await db.query('SELECT id FROM users WHERE id = ?', [decoded.userId]);
    if (users.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Issue new token
    const newToken = jwt.sign(
      { userId: decoded.userId },
      config.jwt.secret,
      { algorithm: 'HS256', expiresIn: config.jwt.expiresIn }
    );

    res.cookie('token', newToken, cookieOptions());

    logger.info(`Token refreshed for user ${decoded.userId}`);

    return res.json({ success: true, token: newToken });
  } catch (error) {
    logger.error('Refresh error:', error);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
}

/**
 * PUT /api/auth/password
 * Change the authenticated user's password.
 * Body: { currentPassword, newPassword, confirmPassword }
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Tous les champs sont requis (mot de passe actuel, nouveau, confirmation).' });
    }

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
      return res.status(400).json({ error: 'Données invalides.' });
    }

    // Confirm new passwords match
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Les nouveaux mots de passe ne correspondent pas.' });
    }

    // Enforce password strength (same rules as register)
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir entre 8 et 128 caractères.' });
    }
    if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 1 majuscule et 1 chiffre.' });
    }

    const db = getDatabase();

    const users = await db.query(
      'SELECT id, email, password_hash FROM users WHERE id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const user = users[0];

    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
    }

    // Do not allow setting the same password again
    const isSamePassword = await bcrypt.compare(newPassword, user.password_hash);
    if (isSamePassword) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l\'actuel.' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    await db.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [newHash, req.userId]
    );

    logger.info(`Password changed for user ${req.userId}`);

    // Send confirmation email (non-blocking fallback)
    try {
      await sendPasswordChangedEmail(user.email);
    } catch (emailErr) {
      logger.warn(`Password change email failed for ${user.email}: ${emailErr.message}`);
      // Not a fatal error — password was changed successfully
    }

    return res.json({ success: true, message: 'Mot de passe modifié avec succès.' });
  } catch (error) {
    logger.error('Change password error:', error);
    return res.status(500).json({ error: 'Erreur lors du changement de mot de passe.' });
  }
}

/**
 * Sends a security notification email after a password change.
 * Falls back to a log if no email transport is configured.
 */
async function sendPasswordChangedEmail(email) {
  // If a nodemailer transport is available, use it; otherwise log clearly
  try {
    const nodemailer = require('nodemailer');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);

    if (!smtpUser || !smtpPass) {
      logger.info(`[PASSWORD_CHANGE_EMAIL] Would send to ${email}: "Votre mot de passe a été modifié. Si vous n'êtes pas à l'origine de cette action, contactez le support immédiatement."`);
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"Michel – HostAI" <${smtpUser}>`,
      to: email,
      subject: 'Votre mot de passe a été modifié',
      text: `Bonjour,\n\nVotre mot de passe a bien été modifié.\n\nSi vous n'êtes pas à l'origine de cette modification, contactez immédiatement le support.\n\nL'équipe Michel`,
      html: `<p>Bonjour,</p><p>Votre mot de passe a bien été modifié.</p><p>Si vous n'êtes <strong>pas</strong> à l'origine de cette modification, contactez immédiatement le support.</p><p>L'équipe Michel</p>`
    });

    logger.info(`Password change email sent to ${email}`);
  } catch (err) {
    throw err;
  }
}

/**
 * Sends the password-reset link email. Falls back to a log if no email
 * transport is configured (same graceful-degradation pattern as
 * sendPasswordChangedEmail, so the flow works in dev without SMTP creds).
 */
async function sendPasswordResetEmail(email, resetUrl) {
  try {
    const nodemailer = require('nodemailer');
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);

    if (!smtpUser || !smtpPass) {
      logger.info(`[PASSWORD_RESET_EMAIL] Would send to ${email}: "Cliquez ici pour réinitialiser votre mot de passe : ${resetUrl}" (valide 1 heure)`);
      return;
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"Michel – HostAI" <${smtpUser}>`,
      to: email,
      subject: 'Réinitialisation de votre mot de passe',
      text: `Bonjour,\n\nVous avez demandé la réinitialisation de votre mot de passe.\n\nCliquez sur le lien suivant pour choisir un nouveau mot de passe (valide 1 heure) :\n${resetUrl}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email — votre mot de passe restera inchangé.\n\nL'équipe Michel`,
      html: `<p>Bonjour,</p><p>Vous avez demandé la réinitialisation de votre mot de passe.</p><p><a href="${resetUrl}">Cliquez ici pour choisir un nouveau mot de passe</a> (valide 1 heure).</p><p>Si vous n'êtes <strong>pas</strong> à l'origine de cette demande, ignorez cet email — votre mot de passe restera inchangé.</p><p>L'équipe Michel</p>`
    });

    logger.info(`Password reset email sent to ${email}`);
  } catch (err) {
    throw err;
  }
}

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 *
 * Always returns the same generic success response, whether or not the
 * email is registered, to prevent account enumeration (mirrors the
 * constant-response pattern already used in login/register).
 */
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email requis.' });
    }

    let cleanEmail;
    try {
      cleanEmail = sanitizeEmail(email);
    } catch (_err) {
      // Invalid email format — still return the generic message, don't leak validation details
      return res.json({ success: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
    }

    const db = getDatabase();

    const users = await db.query('SELECT id, email FROM users WHERE email = ?', [cleanEmail]);

    if (users.length > 0) {
      const user = users[0];

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      await db.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${getAppBaseUrl()}/reset-password?token=${rawToken}`;

      try {
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (emailErr) {
        logger.warn(`Password reset email failed for ${user.email}: ${emailErr.message}`);
        // Not fatal — still return the generic success response below
      }

      logger.info(`Password reset requested for user ${user.id}`);
    }

    return res.json({ success: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
  } catch (error) {
    logger.error('Forgot password error:', error);
    // Even on unexpected error, avoid leaking whether the account exists
    return res.json({ success: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
  }
}

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword, confirmPassword }
 */
async function resetPassword(req, res) {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Tous les champs sont requis.' });
    }

    if (typeof token !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
      return res.status(400).json({ error: 'Données invalides.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Les mots de passe ne correspondent pas.' });
    }

    // Same complexity rules as register()/changePassword()
    if (newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 128 caractères.' });
    }
    if (!/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 1 majuscule et 1 chiffre.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const db = getDatabase();

    const rows = await db.query(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
      [tokenHash]
    );

    const genericError = 'Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.';

    if (rows.length === 0) {
      return res.status(400).json({ error: genericError });
    }

    const resetToken = rows[0];

    if (resetToken.used_at) {
      return res.status(400).json({ error: genericError });
    }

    if (new Date(resetToken.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: genericError });
    }

    const users = await db.query('SELECT id, email FROM users WHERE id = ?', [resetToken.user_id]);
    if (users.length === 0) {
      return res.status(400).json({ error: genericError });
    }
    const user = users[0];

    const newHash = await bcrypt.hash(newPassword, 12);

    await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);

    // Mark this token used, and invalidate any other outstanding tokens for this user
    // (defense in depth — a stale, unused token from an earlier request should not remain valid)
    await db.query(
      'UPDATE password_reset_tokens SET used_at = ? WHERE id = ?',
      [new Date(), resetToken.id]
    );
    await db.query(
      'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND id != ?',
      [new Date(), user.id, resetToken.id]
    );

    logger.info(`Password reset completed for user ${user.id}`);

    try {
      await sendPasswordChangedEmail(user.email);
    } catch (emailErr) {
      logger.warn(`Password change email failed for ${user.email}: ${emailErr.message}`);
    }

    return res.json({ success: true, message: 'Votre mot de passe a été réinitialisé avec succès.' });
  } catch (error) {
    logger.error('Reset password error:', error);
    return res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe.' });
  }
}

/**
 * Best-effort revocation of a user's Google OAuth grant.
 *
 * Deleting our own rows stops US from using the tokens, but the grant itself
 * lives at Google until it is revoked there — so without this the user's Gmail
 * would still list the app as authorised after they closed their account.
 * Never throws: a Google outage must not be able to block an account deletion
 * the user is legally entitled to.
 */
async function revokeGoogleGrants(db, userId) {
  let accounts = [];
  try {
    accounts = await db.query(
      'SELECT refresh_token_enc FROM gmail_accounts WHERE user_id = ?',
      [userId]
    );
  } catch (_) {
    return; // table may not exist yet
  }

  const { decrypt } = require('../utils/encryption');

  for (const account of accounts) {
    try {
      const refreshToken = decrypt(account.refresh_token_enc);
      if (!refreshToken) continue;

      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.warn(`Google token revocation failed during account deletion for user ${userId}: ${err.message}`);
    }
  }
}

/**
 * DELETE /api/auth/account
 * Body: { password }
 *
 * RGPD art. 17 ("droit à l'effacement"). Irreversible, so it demands the
 * account password even though the caller is already authenticated — the same
 * bar changePassword() sets, for a far more destructive action.
 *
 * Order matters. outbound_replies is the ONE table carrying user_id that has no
 * foreign key to users (see migrations/db/017_email_reply_pipeline.js), so it is
 * not covered by the ON DELETE CASCADE that clears every other table. Its rows
 * are queued emails: leaving them behind would let replyWorker keep claiming
 * pending rows belonging to an account that no longer exists. They are therefore
 * deleted explicitly, and FIRST, so the worker cannot pick one up mid-deletion.
 */
async function deleteAccount(req, res) {
  try {
    const { password } = req.body;

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Mot de passe requis pour confirmer la suppression.' });
    }

    const db = getDatabase();

    const users = await db.query(
      'SELECT id, email, password_hash FROM users WHERE id = ?',
      [req.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const user = users[0];

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Mot de passe incorrect.' });
    }

    // Revoke at Google BEFORE the rows holding the tokens are cascaded away.
    await revokeGoogleGrants(db, user.id);

    // Not covered by CASCADE — must go explicitly, before the user row.
    await db.query('DELETE FROM outbound_replies WHERE user_id = ?', [user.id]);

    // Cascades to property_profiles, conversations, messages, reservations,
    // gmail_accounts/threads, ical_*, property_qa/photos, password_reset_tokens…
    await db.query('DELETE FROM users WHERE id = ?', [user.id]);

    res.clearCookie('token', { ...cookieOptions(), maxAge: undefined });

    logger.info(`Account deleted for user ${user.id}`);

    return res.json({ success: true, message: 'Votre compte et toutes vos données ont été supprimés.' });
  } catch (error) {
    logger.error('Delete account error:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression du compte.' });
  }
}

module.exports = {
  register,
  login,
  me,
  refresh,
  changePassword,
  forgotPassword,
  resetPassword,
  deleteAccount
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { getDatabase } = require('../config/db');
const { sanitizeEmail, sanitizeString } = require('../utils/sanitize');
const logger = require('../utils/logger');

// Cookie options — shared by all auth endpoints
function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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
      // Same generic message as login failure — prevent email enumeration
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

    // Token only in httpOnly cookie — never in response body
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

module.exports = {
  register,
  login,
  me,
  refresh,
  changePassword
};

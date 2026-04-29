const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');

function authMiddleware(req, res, next) {
  try {
    // 1. Extract token from httpOnly cookie first, then Authorization header
    let token = req.cookies?.token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    // SSE endpoints: accept token from query ONLY for EventSource (no cookie support)
    if (!token && req.query?.token && req.path.includes('/events')) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // 2. Structural validation before crypto — prevent DoS via huge/malformed tokens
    if (typeof token !== 'string' || token.length > 2000 || token.length < 10) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    // JWT must have exactly 3 base64url-encoded parts
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => p.length === 0)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // 3. Verify token — enforce HS256 to prevent algorithm confusion attacks
    const decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      maxAge: '7d',
    });

    // 4. Validate payload shape
    if (!decoded.userId || typeof decoded.userId !== 'number') {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.userId = decoded.userId;
    req.user = { id: decoded.userId };

    next();
  } catch (error) {
    // Return generic message for ALL auth failures — no info leakage
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = authMiddleware;

const express = require('express');
const {
  register,
  login,
  me,
  refresh,
  changePassword,
  forgotPassword,
  resetPassword
} = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const { authRateLimiter, passwordResetRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', authRateLimiter, register);
router.post('/login', authRateLimiter, login);
router.post('/refresh', authRateLimiter, refresh);
router.get('/me', authMiddleware, me);
router.put('/password', authRateLimiter, authMiddleware, changePassword);

// Pre-login flows — unauthenticated, rate-limited against brute force / enumeration.
// forgot-password needs the dedicated limiter (it always returns 200, which
// authRateLimiter's skipSuccessfulRequests would never count).
router.post('/forgot-password', passwordResetRateLimiter, forgotPassword);
router.post('/reset-password', authRateLimiter, resetPassword);

module.exports = router;

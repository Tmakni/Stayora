const express = require('express');
const { register, login, me, refresh, changePassword } = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const { authRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', authRateLimiter, register);
router.post('/login', authRateLimiter, login);
router.post('/refresh', authRateLimiter, refresh);
router.get('/me', authMiddleware, me);
router.put('/password', authRateLimiter, authMiddleware, changePassword);

module.exports = router;

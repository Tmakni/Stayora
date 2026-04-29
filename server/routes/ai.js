const express = require('express');
const { generateDraft } = require('../controllers/aiController');
const authMiddleware = require('../middleware/auth');
const { aiRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Auth + rate limit sur génération IA
router.post('/draft', authMiddleware, aiRateLimiter, generateDraft);

module.exports = router;

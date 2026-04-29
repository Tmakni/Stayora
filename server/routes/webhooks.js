const express = require('express');
const router  = express.Router();
const { handleSuperhot, getWebhookLogs } = require('../controllers/webhookController');
const authMiddleware = require('../middleware/auth');

/**
 * POST /api/webhook/superhot
 * Incoming messages from Superhot / channel manager
 * No auth – verified by HMAC signature in controller
 */
router.post('/superhot', handleSuperhot);

/**
 * GET /api/webhook/logs
 * Admin: view recent webhook logs (requires auth)
 */
router.get('/logs', authMiddleware, getWebhookLogs);

module.exports = router;

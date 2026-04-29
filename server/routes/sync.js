const express = require('express');
const router = express.Router();
const syncController = require('../controllers/syncController');
const authMiddleware = require('../middleware/auth');
const { addSSEClient, removeSSEClient, getSSEClientCount } = require('../services/syncScheduler');

const MAX_SSE_PER_USER = 3; // Prevent resource exhaustion

// ---- SSE endpoint (auth via query token) ----
router.get('/events', authMiddleware, (req, res) => {
  const userId = req.userId;

  // Limit concurrent SSE connections per user
  if (getSSEClientCount(userId) >= MAX_SSE_PER_USER) {
    return res.status(429).json({ error: 'Too many SSE connections' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write('event: connected\ndata: {"status":"ok"}\n\n');

  addSSEClient(userId, res);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try { res.write(':\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 30000);

  // Auto-close after 1 hour to prevent stale connections
  const maxLifetime = setTimeout(() => {
    try { res.end(); } catch (_) {}
  }, 60 * 60 * 1000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clearTimeout(maxLifetime);
    removeSSEClient(userId, res);
  });
});

// All routes below require authentication
router.use(authMiddleware);

// ---- Airbnb Account Management ----
router.post('/accounts', syncController.addAirbnbAccount);
router.get('/accounts', syncController.getAirbnbAccounts);
router.delete('/accounts/:id', syncController.removeAirbnbAccount);

// ---- Sync Triggers ----
router.post('/messages/:accountId', syncController.syncMessages);
router.post('/reservations/:accountId', syncController.syncReservations);
router.post('/full/:accountId', syncController.fullSync);

// ---- Reservations ----
router.get('/reservations', syncController.getReservations);
router.get('/reservations/:id', syncController.getReservation);

// ---- Sync Logs ----
router.get('/logs', syncController.getSyncLogs);

module.exports = router;

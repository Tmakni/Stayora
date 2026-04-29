const express = require('express');
const router = express.Router();
const gmailController = require('../controllers/gmailController');
const authMiddleware = require('../middleware/auth');

// ---- OAuth callback (browser redirect — no JWT required) ----
// Google redirects here after consent. Server-side handles everything:
// exchanges code, saves tokens, shows result page.
router.get('/oauth-callback', gmailController.oauthCallback);

// All routes below require authentication
router.use(authMiddleware);

// ---- OAuth flow ----
router.get('/auth-url', gmailController.getAuthUrl);
router.post('/callback', gmailController.handleCallback);

// ---- Account management ----
router.get('/accounts', gmailController.getAccounts);
router.get('/reauthorize/:accountId', gmailController.reauthorize);
router.delete('/accounts/:id', gmailController.removeAccount);

// ---- Sync triggers ----
router.post('/sync/:accountId', gmailController.syncMessages);

// ---- Cleanup ----
router.delete('/purge-non-airbnb', gmailController.purgeNonAirbnb);

module.exports = router;

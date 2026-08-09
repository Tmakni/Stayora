const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const replyController = require('../controllers/replyController');

router.use(authMiddleware);

// Mode d'envoi (global + par logement) et arrêt d'urgence.
router.get('/auto-reply', replyController.getAutoReplySettings);
router.put('/auto-reply', replyController.updateAutoReplySettings);

module.exports = router;

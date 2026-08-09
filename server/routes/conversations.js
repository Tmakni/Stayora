const express = require('express');
const {
  createConversation,
  getConversations,
  getConversation,
  addMessage,
  updateConversation,
  sendToAirbnb
} = require('../controllers/conversationController');
const authMiddleware = require('../middleware/auth');
const { responseCache } = require('../middleware/cache');
const replyController = require('../controllers/replyController');

const router = express.Router();

router.use(authMiddleware);

router.post('/', createConversation);
router.get('/', responseCache(8), getConversations);       // 8s cache — list, invalidated on write
router.get('/:id', responseCache(5), getConversation);     // 5s cache — individual conversation
router.put('/:id', updateConversation);
router.post('/:id/messages', addMessage);
router.post('/:id/send-airbnb', sendToAirbnb);

// ---- Réponse par e-mail (Gmail) ----
// L'envoi est mis en file puis traité par le worker : la requête ne dépend pas
// de la latence de Gmail. Le destinataire est résolu côté serveur.
router.post('/:id/reply', replyController.sendReply);
router.get('/:id/reply-status', replyController.getReplyStatus);
router.post('/:id/reply/:queueId/retry', replyController.retryReply);

module.exports = router;

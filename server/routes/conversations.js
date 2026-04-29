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

const router = express.Router();

router.use(authMiddleware);

router.post('/', createConversation);
router.get('/', responseCache(8), getConversations);       // 8s cache — list, invalidated on write
router.get('/:id', responseCache(5), getConversation);     // 5s cache — individual conversation
router.put('/:id', updateConversation);
router.post('/:id/messages', addMessage);
router.post('/:id/send-airbnb', sendToAirbnb);

module.exports = router;

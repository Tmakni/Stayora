const { getDatabase } = require('../config/db');
const { sanitizeString, validateId } = require('../utils/sanitize');
const { invalidatePattern } = require('../middleware/cache');
const logger = require('../utils/logger');
const airbnbSync = require('../services/airbnbSyncService');
const { autoUpdateStatus } = require('../services/statusDetector');

async function createConversation(req, res) {
  try {
    const { title, booking_status, property_id } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title required' });
    }
    
    const cleanTitle = sanitizeString(title);
    const status = booking_status || 'inquiry';
    
    const validStatuses = ['inquiry', 'request', 'confirmed', 'checkedin', 'checkedout'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid booking status' });
    }
    
    const db = getDatabase();
    
    const result = await db.query(
      'INSERT INTO conversations (user_id, title, booking_status, property_id) VALUES (?, ?, ?, ?)',
      [req.userId, cleanTitle, status, property_id || null]
    );
    
    logger.info(`Conversation created: ${result.insertId} by user ${req.userId}`);
    
    // Invalidate conversation list cache
    invalidatePattern(req.userId, '/api/conversations');
    
    return res.status(201).json({
      success: true,
      conversation: {
        id: result.insertId,
        user_id: req.userId,
        title: cleanTitle,
        booking_status: status,
        property_id: property_id || null
      }
    });
  } catch (error) {
    logger.error('Create conversation error:', error);
    return res.status(500).json({ error: 'Failed to create conversation' });
  }
}

async function getConversations(req, res) {
  try {
    const db = getDatabase();
    
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    
    // Single query: conversations + message count + last message preview
    const conversations = await db.query(
      `SELECT c.id, c.title, c.booking_status, c.property_id, c.guest_name,
              c.created_at, c.updated_at,
              COALESCE(m_agg.msg_count, 0) AS message_count,
              SUBSTR(m_last.content, 1, 120) AS last_message
       FROM conversations c
       LEFT JOIN (
         SELECT conversation_id, COUNT(*) AS msg_count
         FROM messages
         GROUP BY conversation_id
       ) m_agg ON m_agg.conversation_id = c.id
       LEFT JOIN (
         SELECT conversation_id, content,
                ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
         FROM messages
       ) m_last ON m_last.conversation_id = c.id AND m_last.rn = 1
       WHERE c.user_id = ?
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`,
      [req.userId, limit, offset]
    );
    
    return res.json({
      conversations
    });
  } catch (error) {
    logger.error('Get conversations error:', error);
    return res.status(500).json({ error: 'Failed to get conversations' });
  }
}

async function getConversation(req, res) {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid conversation ID' });
    
    const db = getDatabase();
    
    // Récupérer conversation
    const conversations = await db.query(
      'SELECT id, user_id, title, booking_status, property_id, airbnb_thread_id, airbnb_reply_url, external_id, external_provider, guest_name, created_at, updated_at FROM conversations WHERE id = ?',
      [id]
    );
    
    if (conversations.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const conversation = conversations[0];
    
    // Vérifier ownership
    if (conversation.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Récupérer messages
    const messages = await db.query(
      'SELECT id, role, content, metadata_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
      [id]
    );
    
    // Parse metadata
    const messagesWithMeta = messages.map(msg => ({
      ...msg,
      metadata: msg.metadata_json ? JSON.parse(msg.metadata_json) : null
    }));
    
    // Récupérer property context si existe
    let propertyContext = null;
    if (conversation.property_id) {
      const properties = await db.query(
        'SELECT id, name, context_json FROM property_profiles WHERE id = ?',
        [conversation.property_id]
      );
      
      if (properties.length > 0) {
        propertyContext = {
          id: properties[0].id,
          name: properties[0].name,
          context: JSON.parse(properties[0].context_json)
        };
      }
    }
    
    // Check if user has an active Airbnb account for API sending
    let hasAirbnbAccount = false;
    if (conversation.airbnb_thread_id) {
      const threads = await db.query(
        'SELECT airbnb_account_id FROM airbnb_threads WHERE conversation_id = ? LIMIT 1',
        [id]
      );
      hasAirbnbAccount = threads.length > 0;
    }
    if (!hasAirbnbAccount) {
      const accounts = await db.query(
        'SELECT id FROM airbnb_accounts WHERE user_id = ? AND is_active = TRUE LIMIT 1',
        [req.userId]
      );
      hasAirbnbAccount = accounts.length > 0;
    }

    // Determine if this is an Airbnb conversation
    const isAirbnb = !!(conversation.airbnb_thread_id ||
      conversation.external_provider === 'airbnb' ||
      (conversation.title && conversation.title.toLowerCase().startsWith('airbnb')));

    return res.json({
      conversation: {
        ...conversation,
        property_context: propertyContext,
        is_airbnb: isAirbnb,
        has_airbnb_api: hasAirbnbAccount && !!conversation.airbnb_thread_id
      },
      messages: messagesWithMeta
    });
  } catch (error) {
    logger.error('Get conversation error:', error);
    return res.status(500).json({ error: 'Failed to get conversation' });
  }
}

async function addMessage(req, res) {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid conversation ID' });
    const { role, content, metadata } = req.body;
    
    if (!role || !content) {
      return res.status(400).json({ error: 'Role and content required' });
    }
    
    if (!['incoming', 'outgoing'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    const cleanContent = sanitizeString(content);
    
    const db = getDatabase();
    
    // Vérifier conversation existe et ownership
    const conversations = await db.query(
      'SELECT user_id FROM conversations WHERE id = ?',
      [id]
    );
    
    if (conversations.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    if (conversations[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Ajouter message (avec protection anti-doublon)
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    
    // Check for duplicate: same role + same content among recent messages
    const recentMsgs = await db.query(
      'SELECT id, content, created_at FROM messages WHERE conversation_id = ? AND role = ? ORDER BY created_at DESC LIMIT 3',
      [id, role]
    );
    const isDupe = recentMsgs.some(m => {
      if (m.content !== cleanContent) return false;
      const age = Date.now() - new Date(m.created_at).getTime();
      return age < 120000; // 2 minutes
    });
    if (isDupe) {
      logger.warn(`Duplicate message blocked for conversation ${id} (role=${role})`);
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: { id: recentMsgs[0].id, conversation_id: parseInt(id), role, content: cleanContent, metadata: metadata || null }
      });
    }
    
    const result = await db.query(
      'INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)',
      [id, role, cleanContent, metadataJson]
    );
    
    logger.info(`Message added to conversation ${id}: ${result.insertId}`);
    
    // Invalidate cache for this user's conversations
    invalidatePattern(req.userId, '/api/conversations');
    
    // Auto-detect and update booking status based on message content
    const newStatus = await autoUpdateStatus(parseInt(id));
    
    // If host sends a message, invalidate style cache so it gets re-analyzed
    if (role === 'outgoing') {
      const db2 = getDatabase();
      db2.query('UPDATE users SET style_analyzed_at = NULL WHERE id = ?', [req.userId])
        .catch(e => logger.warn('Style invalidation failed:', e.message));
    }
    
    return res.status(201).json({
      success: true,
      message: {
        id: result.insertId,
        conversation_id: parseInt(id),
        role,
        content: cleanContent,
        metadata: metadata || null
      },
      new_booking_status: newStatus || undefined
    });
  } catch (error) {
    logger.error('Add message error:', error);
    return res.status(500).json({ error: 'Failed to add message' });
  }
}

async function updateConversation(req, res) {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid conversation ID' });
    const { booking_status, title } = req.body;
    const db = getDatabase();

    const convs = await db.query('SELECT user_id FROM conversations WHERE id = ?', [id]);
    if (convs.length === 0) return res.status(404).json({ error: 'Conversation not found' });
    if (convs[0].user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

    const fields = [];
    const values = [];
    const validStatuses = ['inquiry','request','confirmed','checkedin','checkedout'];

    if (booking_status && validStatuses.includes(booking_status)) {
      fields.push('booking_status = ?'); values.push(booking_status);
    }
    if (title) { fields.push('title = ?'); values.push(sanitizeString(title)); }

    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    values.push(id);
    await db.query(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`, values);

    return res.json({ success: true });
  } catch (error) {
    logger.error('Update conversation error:', error);
    return res.status(500).json({ error: 'Failed to update conversation' });
  }
}

/**
 * POST /api/conversations/:id/send-airbnb
 * Send a message to Airbnb for this conversation
 */
async function sendToAirbnb(req, res) {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid conversation ID' });
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const db = getDatabase();

    // Get conversation with airbnb thread info
    const conversations = await db.query(
      'SELECT id, user_id, airbnb_thread_id FROM conversations WHERE id = ?',
      [id]
    );

    if (conversations.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = conversations[0];

    if (conv.user_id !== req.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!conv.airbnb_thread_id) {
      return res.status(400).json({ error: 'Cette conversation n\'est pas liée à un thread Airbnb' });
    }

    // Find the Airbnb account linked to this thread
    const threads = await db.query(
      'SELECT airbnb_account_id FROM airbnb_threads WHERE conversation_id = ? AND airbnb_thread_id = ?',
      [id, conv.airbnb_thread_id]
    );

    if (threads.length === 0) {
      return res.status(400).json({ error: 'Aucun compte Airbnb lié à cette conversation' });
    }

    const accountId = threads[0].airbnb_account_id;

    // Send via Airbnb API
    const cleanMessage = sanitizeString(message);
    const result = await airbnbSync.sendMessageToThread(req.userId, accountId, conv.airbnb_thread_id, cleanMessage);

    // Save as outgoing message in DB
    const msgResult = await db.query(
      'INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)',
      [
        id,
        'outgoing',
        cleanMessage,
        JSON.stringify({
          source: 'airbnb_sent',
          airbnb_thread_id: conv.airbnb_thread_id,
          sent_at: new Date().toISOString()
        })
      ]
    );

    logger.info(`Message sent to Airbnb thread ${conv.airbnb_thread_id} for conversation ${id}`);

    return res.json({
      success: true,
      message: {
        id: msgResult.insertId,
        conversation_id: parseInt(id),
        role: 'outgoing',
        content: cleanMessage,
        metadata: { source: 'airbnb_sent', airbnb_thread_id: conv.airbnb_thread_id }
      }
    });
  } catch (error) {
    logger.error('Send to Airbnb error:', error);

    if (error.message === 'AIRBNB_TOKEN_EXPIRED') {
      return res.status(401).json({ error: 'Token Airbnb expiré. Veuillez reconnecter votre compte.' });
    }

    return res.status(500).json({ error: 'Échec de l\'envoi vers Airbnb' });
  }
}

module.exports = {
  createConversation,
  getConversations,
  getConversation,
  addMessage,
  updateConversation,
  sendToAirbnb
};

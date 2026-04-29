const { getDatabase } = require('../config/db');
const { sanitizeString } = require('../utils/sanitize');
const { generateDraftReply } = require('../services/aiService');
const { generateAvailabilityReply } = require('../services/availabilityReply');
const { getHostStyle } = require('../services/hostStyleService');
const { getRelevantQA, formatQAForPrompt } = require('../services/propertyQAService');
const logger = require('../utils/logger');

function getIcalService() {
  return require('../services/icalService');
}

async function generateDraft(req, res) {
  try {
    const {
      conversation_id,
      incoming_message,
      booking_status,
      property_context,
      guest_profile
    } = req.body;
    
    if (!incoming_message) {
      return res.status(400).json({ error: 'incoming_message required' });
    }
    
    const cleanMessage = sanitizeString(incoming_message);
    
    const db = getDatabase();
    
    // Récupérer conversation history si conversation_id fourni
    let conversationHistory = [];
    let propertyCtx = {};
    let propertyId = null;
    
    if (conversation_id) {
      // Vérifier ownership
      const conversations = await db.query(
        'SELECT user_id, property_id FROM conversations WHERE id = ?',
        [conversation_id]
      );
      
      if (conversations.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      
      if (conversations[0].user_id !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      
      propertyId = conversations[0].property_id;
      
      // Récupérer messages (limité aux 30 derniers pour performance + pertinence)
      const messages = await db.query(
        'SELECT role, content, metadata_json FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 30',
        [conversation_id]
      );
      
      conversationHistory = messages.reverse();
      
      // Charger le contexte depuis la DB si la conversation est liée à une propriété
      if (propertyId) {
        const properties = await db.query(
          'SELECT context_json FROM property_profiles WHERE id = ?',
          [propertyId]
        );
        
        if (properties.length > 0) {
          try {
            propertyCtx = JSON.parse(properties[0].context_json) || {};
          } catch (_) {}
        }
      }
    }
    
    // Fusionner avec le contexte additionnel envoyé par le client (panneau "Contexte supplémentaire")
    const additionalCtx = property_context && typeof property_context === 'object'
      ? property_context
      : {};
    if (Object.keys(additionalCtx).length > 0) {
      propertyCtx = { ...propertyCtx, ...additionalCtx };
    }
    
    // Récupérer l'airbnb_listing_id depuis le contexte (stocké dans context_json par buildContextData)
    const airbnbListingId = propertyCtx.airbnb_listing_id || null;
    
    // Synchroniser le calendrier iCal pour avoir les données les plus fraîches
    if (propertyId) {
      try {
        const icalSvc = require('../services/icalService');
        await icalSvc.syncPropertyCalendar(propertyId);
      } catch (syncErr) {
        // Pas bloquant — on utilise les données existantes
        logger.warn(`iCal pre-sync skipped for property ${propertyId}: ${syncErr.message}`);
      }
    }

    // Charger le style d'écriture de l'hôte (analysé depuis ses messages passés)
    let hostStyle = null;
    try {
      hostStyle = await getHostStyle(req.userId);
    } catch (e) {
      logger.warn('Could not load host style:', e.message);
    }

    // Fast-path: si c'est une question de disponibilité et qu'un calendrier iCal est connecté,
    // on vérifie le calendrier et on génère une réponse dans le style de l'hôte
    if (propertyId) {
      try {
        // Find the latest incoming message's metadata (for email subject dates)
        let messageMetadata = null;
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
          if (conversationHistory[i].role === 'incoming' && conversationHistory[i].metadata_json) {
            try {
              messageMetadata = typeof conversationHistory[i].metadata_json === 'string'
                ? JSON.parse(conversationHistory[i].metadata_json)
                : conversationHistory[i].metadata_json;
            } catch (_) {}
            break;
          }
        }

        const availReply = await generateAvailabilityReply({
          guestMessage: cleanMessage,
          propertyId,
          hostName: propertyCtx.host_name || null,
          propertyName: propertyCtx.name || null,
          hostStyle,
          conversationHistory,
          messageMetadata
        });

        if (availReply.handled) {
          logger.info(`[Availability] Fast-path reply for property ${propertyId}: ${availReply.dates ? availReply.dates.startDate + '→' + availReply.dates.endDate : 'no dates'}`);
          return res.json({
            success: true,
            draft_reply: availReply.reply,
            intent: 'availability',
            risk_level: 'low',
            escalate: false,
            needs_host: false,
            no_reply_needed: false,
            availability_check: availReply.availability,
            dates_detected: availReply.dates
          });
        }
      } catch (e) {
        logger.warn('Availability fast-path error (falling back to AI):', e.message);
      }
    }
    
    // Injecter le résumé de disponibilité dans le contexte pour l'IA (180 prochains jours)
    if (propertyId) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const in180 = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
        const { checkAvailability } = getIcalService();
        const avail = await checkAvailability(propertyId, today, in180);
        if (avail.conflictingBookings && avail.conflictingBookings.length > 0) {
          propertyCtx.availability_summary = avail.conflictingBookings.map(c =>
            `${c.start} → ${c.end} (${c.source}${c.summary ? ', ' + c.summary : ''})`
          ).join(' ; ');
        } else {
          propertyCtx.availability_summary = 'Entièrement disponible sur les 180 prochains jours';
        }
      } catch (e) {
        logger.warn('Could not fetch availability for AI context:', e.message);
      }
    }
    
    // Inject past Q&A from this property into the context so the AI learns from history
    if (propertyId) {
      try {
        const relevantQA = await getRelevantQA(propertyId, cleanMessage);
        if (relevantQA.length > 0) {
          propertyCtx._past_qa = formatQAForPrompt(relevantQA);
          logger.info(`[Q&A] Injecting ${relevantQA.length} past Q&A pair(s) for property ${propertyId}`);
        }
      } catch (qaErr) {
        logger.warn('Could not load Q&A context:', qaErr.message);
      }
    }

    // Générer réponse IA
    const result = await generateDraftReply({
      incomingMessage: cleanMessage,
      propertyContext: propertyCtx,
      conversationHistory,
      bookingStatus: booking_status || 'inquiry',
      guestProfile: guest_profile || null,
      airbnbListingId,
      hostStyle
    });
    
    logger.info(`Draft generated for conversation ${conversation_id || 'new'}: intent=${result.intent}, risk=${result.risk_level}`);
    
    // Auto-detect and update conversation status after each AI analysis
    let newStatus = null;
    if (conversation_id) {
      const { autoUpdateStatus } = require('../services/statusDetector');
      newStatus = await autoUpdateStatus(conversation_id);
    }
    
    return res.json({
      success: true,
      ...result,
      new_booking_status: newStatus || undefined
    });
  } catch (error) {
    logger.error('Generate draft error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate draft'
    });
  }
}

module.exports = {
  generateDraft
};

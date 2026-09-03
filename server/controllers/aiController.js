const { getDatabase } = require('../config/db');
const { sanitizeString } = require('../utils/sanitize');
const { generateDraftReply } = require('../services/aiService');
const { generateAvailabilityReply } = require('../services/availabilityReply');
const { evaluateReplyNecessity } = require('../services/replyNecessity');
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
      guest_profile,
      // L'hôte a vu le verdict « aucune réponse nécessaire » et demande quand
      // même un brouillon. Le contrôle informe, il n'interdit pas : écrire une
      // relance sur un fil auquel on a déjà répondu est parfaitement légitime.
      force,
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
    let bookingStatus = booking_status || null;

    if (conversation_id) {
      // Vérifier ownership
      const conversations = await db.query(
        'SELECT user_id, property_id, booking_status FROM conversations WHERE id = ?',
        [conversation_id]
      );

      if (conversations.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (conversations[0].user_id !== req.userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      propertyId = conversations[0].property_id;
      // Le statut stocké fait foi sur celui que poste le client : c'est le
      // même que lit le chemin automatique, donc les deux jugent sur la même
      // base.
      bookingStatus = conversations[0].booking_status || bookingStatus;

      // Récupérer messages (limité aux 30 derniers pour performance + pertinence)
      //
      // `id` et `created_at` sont sélectionnés parce que le contrôle de
      // nécessité ci-dessous en a besoin : la date pour reconnaître un fil
      // dormant, l'ordre pour savoir qui a parlé en dernier. Le départage sur
      // `id` évite que deux messages horodatés à la même seconde — le cas
      // normal quand un e-mail Airbnb en porte plusieurs — sortent dans un
      // ordre que ni SQLite ni MySQL ne garantissent.
      const messages = await db.query(
        'SELECT id, role, content, metadata_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 30',
        [conversation_id]
      );

      // ── Ce fil attend-il vraiment une réponse ? ──────────────────────────
      //
      // Placé AVANT l'appel au modèle, délibérément : quand il n'y a rien à
      // répondre, le brouillon ne doit pas exister du tout. Le générer puis
      // l'étiqueter reviendrait à poser sous les yeux de l'hôte un texte prêt
      // à envoyer, ce qui est exactement la faute que ce contrôle empêche —
      // et cela facturerait au passage une requête au modèle pour rien.
      //
      // Les trois signaux employés ici sont ceux du chemin automatique
      // (services/replyNecessity.js), pour que « Michel n'a pas répondu tout
      // seul » et « Michel n'aurait rien eu à dire » ne puissent pas diverger.
      if (!force) {
        const necessity = evaluateReplyNecessity({
          recent: messages,
          bookingStatus,
          incomingMessage: cleanMessage,
        });

        if (!necessity.needed) {
          logger.info(
            `Génération refusée pour la conversation ${conversation_id} : ` +
            `${necessity.code}${necessity.closureCode ? `/${necessity.closureCode}` : ''}`
          );
          return res.json({
            success: true,
            reply_needed: false,
            reply_needed_code: necessity.code,
            reply_needed_reason: necessity.reason,
            // Le brouillon est explicitement vide : rien à envoyer par
            // inadvertance si un client ancien lit ce champ sans lire le
            // verdict.
            draft_reply: '',
            no_reply_needed: true,
          });
        }
      }

      conversationHistory = messages.slice().reverse();

      // Charger le contexte depuis la DB si la conversation est liée à une propriété
      if (propertyId) {
        // `AND user_id = ?` : sans ce filtre, une conversation pointant sur le
        // logement d'un autre compte faisait entrer son `context_json` dans le
        // prompt, et Michel rédigeait un brouillon citant le mot de passe Wi-Fi
        // de quelqu'un d'autre. Voir conversationController.createConversation.
        const properties = await db.query(
          'SELECT context_json FROM property_profiles WHERE id = ? AND user_id = ?',
          [propertyId, req.userId]
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
            reply_needed: true,
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
      bookingStatus: bookingStatus || 'inquiry',
      guestProfile: guest_profile || null,
      airbnbListingId,
      hostStyle
    });
    
    logger.info(`Draft generated for conversation ${conversation_id || 'new'}: intent=${result.intent}, risk=${result.risk_level}`);

    // Le modèle lui-même juge qu'il n'y a rien à répondre.
    //
    // Le contrôle déterministe plus haut ne couvre pas tout : il reconnaît des
    // formes (adieux, politesse, fil clos), pas le sens. Un message comme
    // « je voulais juste vous prévenir qu'on arrive avec une heure de retard,
    // pas la peine de répondre » passe ces motifs et n'appelle pourtant rien.
    // Quand le modèle le signale, on le traite comme le verdict précédent :
    // pas de brouillon, un motif, et la main laissée à l'hôte.
    //
    // Un brouillon vide reçoit le même traitement : rendre une zone de texte
    // vide sous un bouton « Envoyer » n'aide personne.
    const draftText = typeof result.draft_reply === 'string' ? result.draft_reply.trim() : '';
    if (!force && (result.no_reply_needed === true || draftText === '')) {
      logger.info(
        `Génération sans réponse pour la conversation ${conversation_id || 'new'} : ` +
        `${result.no_reply_needed ? 'le modèle juge la réponse inutile' : 'brouillon vide'}`
      );
      return res.json({
        success: true,
        reply_needed: false,
        reply_needed_code: result.no_reply_needed === true ? 'ai_no_reply_needed' : 'empty_draft',
        reply_needed_reason: result.no_reply_needed === true
          ? "Michel a lu le message et estime qu'il n'appelle pas de réponse."
          : "Michel n'a rien trouvé à répondre à ce message.",
        intent: result.intent,
        risk_level: result.risk_level,
        host_note: result.host_note,
        draft_reply: '',
        no_reply_needed: true,
      });
    }

    // Auto-detect and update conversation status after each AI analysis
    let newStatus = null;
    if (conversation_id) {
      const { autoUpdateStatus } = require('../services/statusDetector');
      newStatus = await autoUpdateStatus(conversation_id);
    }
    
    return res.json({
      success: true,
      reply_needed: true,
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

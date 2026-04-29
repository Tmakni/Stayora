const OpenAI = require('openai');
const config = require('../config/env');
const logger = require('../utils/logger');
const { buildSystemPrompt, buildUserPrompt, buildFineTunedPrompt } = require('./promptBuilder');
const { classifyIntent, assessRisk, shouldEscalate } = require('./intentClassifier');
const { buildFallbackResponse } = require('./templateService');

/**
 * Clean AI reply tone: fix robotic patterns like "Bonjour!" and excessive exclamation marks.
 */
function cleanReplyTone(text) {
  if (!text) return text;
  // "Bonjour!" → "Bonjour," (same for Bonsoir, Salut, etc.)
  text = text.replace(/\b(Bonjour|Bonsoir|Salut|Coucou|Hello|Bonne journée|Bonne soirée)\s*!/gi, '$1,');
  // Limit exclamation marks to max 1 in entire message
  const exclMatches = text.match(/!/g);
  if (exclMatches && exclMatches.length > 1) {
    let count = 0;
    text = text.replace(/!/g, () => {
      count++;
      return count === 1 ? '!' : '.';
    });
  }
  return text;
}

let openai = null;

function initOpenAI() {
  if (!config.openai.apiKey || config.openai.apiKey === '') {
    logger.warn('OpenAI API key not configured - using fallback templates only');
    return null;
  }
  
  try {
    openai = new OpenAI({
      apiKey: config.openai.apiKey
    });
    logger.info('OpenAI client initialized');
    return openai;
  } catch (error) {
    logger.error('Failed to initialize OpenAI client:', error.message);
    return null;
  }
}

/**
 * Try to fetch extra data from Airbnb when the AI says it needs more info.
 * Returns merged property context or null if nothing new was found.
 */
async function enrichFromAirbnb(airbnbListingId, existingContext) {
  if (!airbnbListingId) return null;

  try {
    const { importAirbnbListing } = require('../controllers/airbnbImportController');
    
    // Create a mock req/res to reuse the existing import logic
    let importedData = null;
    const mockReq = { body: { url: String(airbnbListingId) } };
    const mockRes = {
      json: (data) => { importedData = data; return mockRes; },
      status: (code) => { mockRes._status = code; return mockRes; },
      _status: 200
    };

    await importAirbnbListing(mockReq, mockRes);

    if (!importedData?.success || !importedData?.data) return null;

    const d = importedData.data;
    const enriched = { ...existingContext };
    let hasNewInfo = false;

    // Merge fields only if they're missing from existing context
    const mergeIfMissing = (ctxKey, srcVal) => {
      if (srcVal && (!enriched[ctxKey] || enriched[ctxKey] === '')) {
        enriched[ctxKey] = srcVal;
        hasNewInfo = true;
      }
    };

    mergeIfMissing('check_in_time', d.check_in_time);
    mergeIfMissing('check_out_time', d.check_out_time);
    mergeIfMissing('nearby', d.nearby);
    mergeIfMissing('address', d.address);
    mergeIfMissing('description', d.description);
    mergeIfMissing('house_rules', d.house_rules);

    // Build amenities string from scraped booleans if we don't have amenities
    if (!enriched.amenities || enriched.amenities === '') {
      const amenityLabels = [];
      if (d.has_wifi) amenityLabels.push('Wi-Fi');
      if (d.has_kitchen) amenityLabels.push('Cuisine');
      if (d.has_parking) amenityLabels.push('Parking');
      if (d.has_pool) amenityLabels.push('Piscine');
      if (d.has_gym) amenityLabels.push('Salle de sport');
      if (d.has_tv) amenityLabels.push('TV');
      if (d.has_air_conditioning) amenityLabels.push('Climatisation');
      if (d.has_heating) amenityLabels.push('Chauffage');
      if (d.has_washing_machine) amenityLabels.push('Lave-linge');
      if (d.has_workspace) amenityLabels.push('Bureau');
      if (d.has_netflix) amenityLabels.push('Netflix');
      if (d.has_bathtub) amenityLabels.push('Baignoire');
      if (d.has_dishwasher) amenityLabels.push('Lave-vaisselle');
      if (d.has_coffee_maker) amenityLabels.push('Machine à café');
      if (d.has_bbq) amenityLabels.push('Barbecue');
      if (d.has_terrace) amenityLabels.push('Terrasse');
      if (d.has_garden) amenityLabels.push('Jardin');
      if (d.has_fireplace) amenityLabels.push('Cheminée');
      if (amenityLabels.length) {
        enriched.amenities = amenityLabels.join(', ');
        hasNewInfo = true;
      }
    }

    // Build rules if missing
    if (!enriched.rules || enriched.rules === '') {
      const rList = [];
      if (d.house_rules) rList.push(d.house_rules);
      if (d.allows_pets !== undefined) rList.push(d.allows_pets ? 'Animaux acceptés' : 'Animaux non autorisés');
      if (d.allows_smoking !== undefined) rList.push(d.allows_smoking ? 'Fumeurs OK' : 'Non-fumeur');
      if (rList.length) {
        enriched.rules = rList.join(' — ');
        hasNewInfo = true;
      }
    }

    if (d.max_guests && !enriched.max_guests) { enriched.max_guests = d.max_guests; hasNewInfo = true; }
    if (d.bedrooms && !enriched.bedrooms)     { enriched.bedrooms = d.bedrooms; hasNewInfo = true; }
    if (d.bathrooms && !enriched.bathrooms)    { enriched.bathrooms = d.bathrooms; hasNewInfo = true; }

    return hasNewInfo ? enriched : null;
  } catch (err) {
    logger.warn(`Airbnb enrichment failed for listing ${airbnbListingId}: ${err.message}`);
    return null;
  }
}

async function generateDraftReply({
  incomingMessage,
  propertyContext = {},
  conversationHistory = [],
  bookingStatus = 'inquiry',
  guestProfile = null,
  airbnbListingId = null,
  hostStyle = null
}) {
  // Classifier basique pour fallback
  const intent = classifyIntent(incomingMessage);
  const risk = assessRisk(incomingMessage);
  const escalate = shouldEscalate(intent, risk, incomingMessage.length);
  
  // Tenter OpenAI si disponible
  if (!openai) {
    openai = initOpenAI();
  }
  
  if (openai) {
    try {
      const result = await generateWithOpenAI({
        incomingMessage,
        propertyContext,
        conversationHistory,
        bookingStatus,
        guestProfile,
        fallbackIntent: intent,
        fallbackRisk: risk,
        hostStyle
      });
      
      // If AI says it needs host info, try enriching from Airbnb first
      if (result.needs_host && airbnbListingId) {
        logger.info(`AI needs more info — trying Airbnb re-fetch for listing ${airbnbListingId}`);
        const enrichedContext = await enrichFromAirbnb(airbnbListingId, propertyContext);
        
        if (enrichedContext) {
          logger.info('Got enriched context from Airbnb, retrying AI generation');
          try {
            const retryResult = await generateWithOpenAI({
              incomingMessage,
              propertyContext: enrichedContext,
              conversationHistory,
              bookingStatus,
              guestProfile,
              fallbackIntent: intent,
              fallbackRisk: risk,
              hostStyle
            });
            
            // If retry succeeded (AI no longer needs host), use that result
            if (!retryResult.needs_host && retryResult.draft_reply) {
              retryResult._enriched_from_airbnb = true;
              return retryResult;
            }
            // Still needs host even after enrichment — fall through to escalate
            return retryResult;
          } catch (retryErr) {
            logger.warn('Retry after enrichment failed:', retryErr.message);
          }
        }
      }
      
      return result;
    } catch (error) {
      logger.error('OpenAI generation failed, using fallback:', error.message);
      // Continue to fallback
    }
  }
  
  // Fallback sur templates
  logger.info('Using template fallback for response generation');
  return buildFallbackResponse(intent, risk, propertyContext, incomingMessage);
}

/**
 * Detect if the configured model is a fine-tuned model (starts with "ft:")
 */
function isFineTunedModel(model) {
  return model && model.startsWith('ft:');
}

async function generateWithOpenAI({
  incomingMessage,
  propertyContext,
  conversationHistory,
  bookingStatus,
  guestProfile,
  fallbackIntent,
  fallbackRisk,
  hostStyle
}) {
  const model = config.openai.model;
  if (!process.env.OPENAI_MODEL) {
    logger.warn('OPENAI_MODEL not set in .env — using fallback: ' + model);
  }
  logger.info(`Using OpenAI model: ${model}`);

  // Fine-tuned models were trained on plain text (not JSON) — use a different flow
  if (isFineTunedModel(model)) {
    return generateWithFineTuned({
      model, incomingMessage, propertyContext, conversationHistory, bookingStatus, guestProfile, fallbackIntent, fallbackRisk, hostStyle
    });
  }

  // Standard model: use JSON response format
  const systemPrompt = buildSystemPrompt(propertyContext, hostStyle);
  const userPrompt = buildUserPrompt(incomingMessage, conversationHistory, bookingStatus, guestProfile);
  
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 500,
    response_format: { type: 'json_object' }
  });
  
  const content = completion.choices[0].message.content;
  
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    logger.error('Failed to parse OpenAI JSON response:', error.message);
    throw new Error('Invalid JSON from OpenAI');
  }
  
  return {
    draft_reply: cleanReplyTone(parsed.draft_reply || parsed.reply || ''),
    intent: parsed.intent || fallbackIntent,
    risk_level: parsed.risk_level || fallbackRisk,
    escalate: parsed.escalate === true,
    needs_host: parsed.needs_host === true,
    no_reply_needed: parsed.no_reply_needed === true,
    host_note: parsed.host_note || null,
    host_question: parsed.host_question || null,
    missing_info_questions: Array.isArray(parsed.missing_info_questions) 
      ? parsed.missing_info_questions.slice(0, 3) 
      : []
  };
}

/**
 * Generate reply using the fine-tuned model (plain text output, no JSON).
 * The fine-tuned model was trained on direct host-style French responses.
 * We use the local intent classifier for metadata.
 */
async function generateWithFineTuned({
  model,
  incomingMessage,
  propertyContext,
  conversationHistory,
  bookingStatus,
  guestProfile,
  fallbackIntent,
  fallbackRisk,
  hostStyle
}) {
  const { systemPrompt, userPrompt } = buildFineTunedPrompt(
    incomingMessage, conversationHistory, bookingStatus, guestProfile, propertyContext, hostStyle
  );

  logger.info(`[Fine-tuned] Generating plain text reply with ${model}`);

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 600
    // NO response_format — fine-tuned model outputs plain text
  });

  const replyText = (completion.choices[0].message.content || '').trim();

  if (!replyText) {
    logger.warn('[Fine-tuned] Empty response from model');
    return {
      draft_reply: '',
      intent: fallbackIntent,
      risk_level: fallbackRisk,
      escalate: shouldEscalate(fallbackIntent, fallbackRisk, incomingMessage.length),
      needs_host: true,
      no_reply_needed: false,
      host_note: null,
      host_question: 'Le modèle n\'a pas pu générer de réponse.',
      missing_info_questions: []
    };
  }

  // Use local classifiers for metadata (intent, risk, escalation, courtesy detection)
  const intent = fallbackIntent;
  const risk = fallbackRisk;
  const escalate = shouldEscalate(intent, risk, incomingMessage.length);

  // Detect courtesy messages that don't need a reply
  const courtesyPatterns = /^(merci|ok|d'accord|super|parfait|top|cool|nickel|genial|génial|bonne journée|bonne soirée|bonsoir|thanks|thank you|great|perfect|awesome|noted|got it|okay|ok merci|merci beaucoup|super merci|parfait merci|c'est noté|c'est parfait|tres bien|très bien)[.!\s]*$/i;
  const noReply = courtesyPatterns.test(incomingMessage.trim());

  return {
    draft_reply: noReply ? '' : cleanReplyTone(replyText),
    intent,
    risk_level: risk,
    escalate,
    needs_host: false,
    no_reply_needed: noReply,
    host_note: null,
    host_question: null,
    missing_info_questions: []
  };
}

module.exports = {
  generateDraftReply
};

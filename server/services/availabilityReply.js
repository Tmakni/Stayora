/**
 * Availability Reply Service
 * 
 * Generates automatic replies about property availability.
 * Extracts dates from guest messages, checks the calendar, and produces
 * a human-friendly response in the host's writing style (via OpenAI)
 * or falls back to templates.
 */
const { extractDatesFromMessage, extractDatesFromSubject, isAvailabilityQuestion } = require('./dateExtractor');
const { detectLanguage } = require('./promptBuilder');
const { buildStylePromptSection } = require('./hostStyleService');
const logger = require('../utils/logger');

function getIcalService() {
  return require('./icalService');
}

/**
 * Generate an availability-aware reply for a guest message.
 * 
 * @param {Object} params
 * @param {string} params.guestMessage - The guest's message
 * @param {number} params.propertyId - The property ID
 * @param {string} [params.hostName] - Host name for signature
 * @param {string} [params.propertyName] - Property name for context
 * @param {Object} [params.hostStyle] - Host writing style profile
 * @param {Object} [params.conversationHistory] - Previous messages for context
 * @returns {{ handled: boolean, reply: string|null, dates: Object|null, availability: Object|null }}
 */
async function generateAvailabilityReply({ guestMessage, propertyId, hostName, propertyName, hostStyle, conversationHistory, messageMetadata }) {
  // 1. Check if this is an availability question
  if (!isAvailabilityQuestion(guestMessage)) {
    return { handled: false, reply: null, dates: null, availability: null };
  }

  // 2. Check if property has iCal connected
  const { checkAvailability, getCalendarInfo } = getIcalService();
  const calInfo = await getCalendarInfo(propertyId);
  if (!calInfo) {
    // No calendar connected — can't check availability, let AI handle normally
    logger.info(`[Availability] Property ${propertyId} has no iCal — skipping auto-reply`);
    return { handled: false, reply: null, dates: null, availability: null };
  }

  // 3. Extract dates from the message text first, then fall back to email subject metadata
  let dates = extractDatesFromMessage(guestMessage);
  if (!dates && messageMetadata && messageMetadata.subject) {
    dates = extractDatesFromSubject(messageMetadata.subject);
    if (dates) {
      logger.info(`[Availability] Dates extracted from email subject: ${dates.startDate}→${dates.endDate}`);
    }
  }
  const lang = detectLanguage(guestMessage);

  // 4. No dates found → ask guest to clarify
  if (!dates) {
    const reply = buildNoDatesReply(lang, hostName);
    return { handled: true, reply, dates: null, availability: null };
  }

  // 5. Check availability
  const availability = await checkAvailability(propertyId, dates.startDate, dates.endDate);

  // 6. Generate reply using AI + host style, or fallback to templates
  let reply;
  try {
    reply = await generateStyledReply({
      lang, dates, availability, hostName, propertyName, hostStyle,
      guestMessage, conversationHistory
    });
  } catch (e) {
    logger.warn('AI availability reply failed, using template:', e.message);
    reply = availability.available
      ? buildAvailableReply(lang, dates, hostName, propertyName)
      : buildUnavailableReply(lang, dates, hostName, propertyName);
  }

  logger.info(`[Availability] Property ${propertyId}: ${dates.startDate}→${dates.endDate} = ${availability.available ? 'DISPO' : 'INDISPO'}`);

  return { handled: true, reply, dates, availability };
}

// ================================================================
// AI-powered styled reply
// ================================================================

/**
 * Generate an availability reply using OpenAI, mimicking the host's writing style.
 * Falls back to templates if OpenAI is unavailable.
 */
async function generateStyledReply({ lang, dates, availability, hostName, propertyName, hostStyle, guestMessage, conversationHistory }) {
  // If no host style or no OpenAI, use templates directly
  if (!hostStyle || !hostStyle.sample_messages || hostStyle.sample_messages.length === 0) {
    return availability.available
      ? buildAvailableReply(lang, dates, hostName, propertyName)
      : buildUnavailableReply(lang, dates, hostName, propertyName);
  }

  // Try to use OpenAI
  let openai;
  try {
    const OpenAI = require('openai');
    const config = require('../config/env');
    if (!config.openai.apiKey) throw new Error('No API key');
    openai = new OpenAI({ apiKey: config.openai.apiKey });
  } catch (_) {
    return availability.available
      ? buildAvailableReply(lang, dates, hostName, propertyName)
      : buildUnavailableReply(lang, dates, hostName, propertyName);
  }

  const startHuman = formatDateHuman(dates.startDate, lang);
  const endHuman = formatDateHuman(dates.endDate, lang);
  const isAvailable = availability.available;

  // Build system prompt with host style
  const styleSection = buildStylePromptSection(hostStyle);

  // Add availability-specific examples if we have them
  let availExamples = '';
  if (hostStyle.availability_samples && hostStyle.availability_samples.length > 0) {
    availExamples = '\nEXEMPLES DE RÉPONSES DE L\'HÔTE À DES DEMANDES DE DISPONIBILITÉ:\n';
    for (const sample of hostStyle.availability_samples) {
      if (sample.guest_question) {
        availExamples += `Voyageur: ${sample.guest_question}\n`;
      }
      availExamples += `Hôte: ${sample.host_reply}\n---\n`;
    }
  }

  const langMap = { 'français': 'en français', 'english': 'in English', 'español': 'en español', 'deutsch': 'auf Deutsch', 'italiano': 'in italiano' };
  const langInstruction = langMap[lang] || 'en français';

  const systemPrompt = `Tu es ${hostName || 'l\'hôte'}, hôte Airbnb. Tu réponds ${langInstruction} à un voyageur qui demande si ton logement${propertyName ? ' ' + propertyName : ''} est disponible.

CALENDRIER (vérifié automatiquement):
- Dates demandées: du ${startHuman} au ${endHuman}
- ${isAvailable ? 'DISPONIBLE' : 'NON DISPONIBLE'}
${!isAvailable && availability.conflictingBookings ? '- Conflits: ' + availability.conflictingBookings.map(c => c.start + ' → ' + c.end).join(', ') : ''}

COMMENT ÉCRIRE:
- ${isAvailable ? 'Confirme la dispo et encourage à réserver' : 'Dis que ce n\'est pas dispo et propose de regarder d\'autres dates'}
- 2-3 phrases MAX. Court et direct.
- UN SEUL emoji dans tout le message (🌼 ou 😊), placé à la toute fin avant ta signature. PAS PLUS.
- Pas de guillemets autour du nom du logement
- Ne mentionne jamais le calendrier ou iCal
- INTERDIT: "merci pour votre intérêt", "merci pour votre message", "je reste à votre disposition", "n'hésitez pas à me contacter" — trop robot
- INTERDIT: "Bonjour!" avec point d'exclamation → toujours "Bonjour," avec virgule. Pas de ! après les salutations.
- Limiter les ! au strict minimum (max 1 dans tout le message)
- Écris comme Delphine écrirait vraiment: simple, direct, chaleureux, humain
- Signe juste avec ton prénom

MAUVAIS EXEMPLE (trop robot, trop d'emojis, "Bonjour!" avec ! = pas humain):
"Bonjour! Merci pour votre intérêt 😊 Le logement n'est pas disponible ✨ N'hésitez pas à me demander 🌼😉 Delphine"

BON EXEMPLE:
"Bonjour, malheureusement le Cocon Terracotta n'est pas dispo du 1er au 6 avril, c'est déjà réservé. Dites-moi si vous avez d'autres dates, je regarde avec plaisir 🌼
Delphine"
${styleSection}${availExamples}`;

  // Build conversation context
  let userPrompt = '';
  if (conversationHistory && conversationHistory.length > 0) {
    userPrompt += 'Historique:\n';
    conversationHistory.slice(-4).forEach(msg => {
      const role = msg.role === 'incoming' ? 'Voyageur' : 'Hôte';
      userPrompt += `${role}: ${msg.content.substring(0, 200)}\n`;
    });
    userPrompt += '\n';
  }
  userPrompt += `Message du voyageur: "${guestMessage}"\n\nRédige ta réponse:`;

  const config = require('../config/env');
  const completion = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.8,
    max_tokens: 200
  });

  let reply = (completion.choices[0].message.content || '').trim();
  if (!reply) throw new Error('Empty AI reply');

  // Post-process: limit emojis to max 2 in the entire reply
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2728}\u{2717}\u{2714}\u{2705}\u{274C}\u{2B50}]/gu;
  const emojis = reply.match(emojiRegex);
  if (emojis && emojis.length > 2) {
    // Keep only the last 1 emoji (most natural position)
    let emojiCount = 0;
    const totalEmojis = emojis.length;
    reply = reply.replace(emojiRegex, (match) => {
      emojiCount++;
      // Keep only the last one
      return emojiCount === totalEmojis ? match : '';
    });
    // Clean up any double spaces left behind
    reply = reply.replace(/  +/g, ' ').trim();
  }

  // Post-process: fix "Bonjour!" → "Bonjour," (not human)
  reply = reply.replace(/\b(Bonjour|Bonsoir|Salut|Coucou|Hello|Bonne journée|Bonne soirée)\s*!/gi, '$1,');
  // Limit excessive exclamation marks (keep max 1 in entire message)
  const exclMatches = reply.match(/!/g);
  if (exclMatches && exclMatches.length > 1) {
    let exclCount = 0;
    reply = reply.replace(/!/g, () => {
      exclCount++;
      return exclCount === 1 ? '!' : '.';
    });
  }

  logger.info(`[Availability] AI-styled reply generated (${reply.length} chars)`);
  return reply;
}

// ================================================================
// Reply templates by language (fallback)
// ================================================================

function buildAvailableReply(lang, dates, hostName, propertyName) {
  const start = formatDateHuman(dates.startDate, lang);
  const end = formatDateHuman(dates.endDate, lang);
  const sign = hostName ? `\n${hostName}` : '';

  if (lang === 'français') {
    return `Bonjour, oui le logement${propertyName ? ' ' + propertyName : ''} est disponible du ${start} au ${end}. N'hésitez pas à réserver ou à me poser d'autres questions.${sign}`;
  }
  if (lang === 'español') {
    return `Hola, ¡gracias por su mensaje! Sí, el alojamiento${propertyName ? ' ' + propertyName : ''} está disponible del ${start} al ${end}. No dude en reservar o hacerme más preguntas.${sign}`;
  }
  if (lang === 'deutsch') {
    return `Hallo, vielen Dank für Ihre Nachricht! Ja, die Unterkunft${propertyName ? ' ' + propertyName : ''} ist vom ${start} bis ${end} verfügbar. Zögern Sie nicht zu buchen oder weitere Fragen zu stellen.${sign}`;
  }
  // Default: English
  return `Hello, thank you for your message! Yes, the property${propertyName ? ' ' + propertyName : ''} is available from ${start} to ${end}. Feel free to book or ask any other questions.${sign}`;
}

function buildUnavailableReply(lang, dates, hostName, propertyName) {
  const start = formatDateHuman(dates.startDate, lang);
  const end = formatDateHuman(dates.endDate, lang);
  const sign = hostName ? `\n${hostName}` : '';

  if (lang === 'français') {
    return `Bonjour, malheureusement le logement${propertyName ? ' ' + propertyName : ''} n'est pas disponible du ${start} au ${end}. Dites-moi si d'autres dates vous intéressent.${sign}`;
  }
  if (lang === 'español') {
    return `Hola, gracias por su mensaje. Lamentablemente, el alojamiento${propertyName ? ' ' + propertyName : ''} no está disponible del ${start} al ${end}. Quedo a su disposición si desea consultar otras fechas.${sign}`;
  }
  if (lang === 'deutsch') {
    return `Hallo, vielen Dank für Ihre Nachricht. Leider ist die Unterkunft${propertyName ? ' ' + propertyName : ''} vom ${start} bis ${end} nicht verfügbar. Ich stehe Ihnen gerne zur Verfügung, wenn Sie andere Daten prüfen möchten.${sign}`;
  }
  return `Hello, thank you for your message. Unfortunately, the property${propertyName ? ' ' + propertyName : ''} is not available from ${start} to ${end}. I'm happy to help if you'd like to check other dates.${sign}`;
}

function buildNoDatesReply(lang, hostName) {
  const sign = hostName ? `\n${hostName}` : '';

  if (lang === 'français') {
    return `Bonjour, pourriez-vous me préciser vos dates de séjour que je puisse vérifier la disponibilité ?${sign}`;
  }
  if (lang === 'español') {
    return `Hola, ¡gracias por su mensaje! ¿Podría indicarme sus fechas de estancia para que pueda verificar la disponibilidad?${sign}`;
  }
  if (lang === 'deutsch') {
    return `Hallo, vielen Dank für Ihre Nachricht! Könnten Sie mir Ihre gewünschten Reisedaten mitteilen, damit ich die Verfügbarkeit prüfen kann?${sign}`;
  }
  return `Hello, thank you for your message! Could you please provide your travel dates so I can check the availability?${sign}`;
}

// ================================================================
// Date formatting
// ================================================================

const FR_MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const EN_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ES_MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DE_MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

function formatDateHuman(dateStr, lang) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDate();
  const month = d.getMonth();

  if (lang === 'français') return `${day} ${FR_MONTH_NAMES[month]}`;
  if (lang === 'español') return `${day} de ${ES_MONTH_NAMES[month]}`;
  if (lang === 'deutsch') return `${day}. ${DE_MONTH_NAMES[month]}`;
  return `${EN_MONTH_NAMES[month]} ${day}`;
}

module.exports = {
  generateAvailabilityReply
};

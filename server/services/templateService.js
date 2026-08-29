// Templates fallback si OpenAI échoue
const logger = require('../utils/logger');

const TEMPLATES = {
  'check-in': {
    fr: "Bonjour ! Le check-in est prévu à partir de {check_in_time}. Le code d'accès est {access_code}. N'hésitez pas si vous avez des questions. Au plaisir de vous accueillir !",
    en: "Hello! Check-in is from {check_in_time}. The access code is {access_code}. Don't hesitate if you have any questions. Looking forward to welcoming you!"
  },
  'check-out': {
    fr: "Le check-out est à {check_out_time}. Merci de laisser les clés dans l'appartement et de bien fermer la porte. Merci pour votre séjour !",
    en: "Check-out is at {check_out_time}. Please leave the keys in the apartment and close the door. Thank you for your stay!"
  },
  'wifi': {
    fr: "Le réseau WiFi est '{wifi_name}' et le mot de passe est '{wifi_password}'. N'hésitez pas si vous avez besoin d'aide !",
    en: "The WiFi network is '{wifi_name}' and the password is '{wifi_password}'. Let me know if you need any help!"
  },
  'parking': {
    fr: "Pour le parking : {parking}. N'hésitez pas si vous avez d'autres questions !",
    en: "For parking: {parking}. Feel free to ask if you have more questions!"
  },
  'amenities': {
    fr: "Le logement dispose de : {amenities}. Tout est à votre disposition. Bon séjour !",
    en: "The place has: {amenities}. Everything is available for your use. Enjoy your stay!"
  },
  'location': {
    fr: "À proximité : {nearby}. N'hésitez pas si vous avez besoin de recommandations !",
    en: "Nearby: {nearby}. Feel free to ask if you need recommendations!"
  },
  'rules': {
    fr: "Les règles de la maison : {rules}. Merci de les respecter pour le confort de tous !",
    en: "House rules: {rules}. Please respect them for everyone's comfort!"
  },
  'problem': {
    fr: "Je suis désolé pour ce désagrément. Je vais regarder cela immédiatement et revenir vers vous très vite. Merci de votre patience.",
    en: "I'm sorry for the inconvenience. I'll look into this right away and get back to you very soon. Thank you for your patience."
  },
  'price-negotiation': {
    fr: "Merci pour votre intérêt ! Les prix affichés sont nos tarifs actuels. Je vous invite à consulter les disponibilités pour trouver les meilleures offres.",
    en: "Thank you for your interest! The displayed prices are our current rates. I invite you to check availability to find the best deals."
  },
  'cancellation': {
    fr: "Pour toute question concernant l'annulation, merci de consulter la politique d'annulation sur Airbnb. Je reste à votre disposition pour toute question.",
    en: "For any questions about cancellation, please refer to the cancellation policy on Airbnb. I'm available if you have questions."
  },
  'other': {
    fr: "Merci pour votre message ! Je reviens vers vous très rapidement avec une réponse détaillée. Belle journée !",
    en: "Thank you for your message! I'll get back to you very soon with a detailed response. Have a great day!"
  }
};

function detectLanguage(message) {
  // Detection simple FR/EN
  const frWords = ['bonjour', 'merci', 'salut', 'oui', 'non', 'est-ce', 'nous', 'vous', 'pour', 'je', 'la', 'le', 'un', 'une'];
  const enWords = ['hello', 'thank', 'yes', 'please', 'we', 'you', 'for', 'the', 'is', 'are'];
  
  const lowerMessage = message.toLowerCase();
  
  let frScore = 0;
  let enScore = 0;
  
  frWords.forEach(word => {
    if (lowerMessage.includes(word)) frScore++;
  });
  
  enWords.forEach(word => {
    if (lowerMessage.includes(word)) enScore++;
  });
  
  return frScore > enScore ? 'fr' : 'en';
}

function generateFromTemplate(intent, propertyContext, incomingMessage) {
  const lang = detectLanguage(incomingMessage);
  
  let template = TEMPLATES[intent]?.[lang] || TEMPLATES.other[lang];

  // propertyContext is normally already a parsed object (every caller pre-parses
  // context_json in a try/catch), but stay defensive: a malformed/non-JSON string
  // must never crash the process.
  let context = propertyContext;
  if (typeof propertyContext === 'string') {
    try {
      context = JSON.parse(propertyContext);
    } catch (err) {
      logger.warn('templateService: failed to parse propertyContext JSON, using empty context:', err.message);
      context = {};
    }
  }
  context = context || {};

  // Replace placeholders
  template = template.replace(/{check_in_time}/g, context.check_in_time || '15:00');
  template = template.replace(/{check_out_time}/g, context.check_out_time || '11:00');
  template = template.replace(/{access_code}/g, context.access_code || '[À FOURNIR]');
  template = template.replace(/{wifi_name}/g, context.wifi_name || '[À FOURNIR]');
  template = template.replace(/{wifi_password}/g, context.wifi_password || '[À FOURNIR]');
  template = template.replace(/{parking}/g, context.parking || 'information à confirmer');
  template = template.replace(/{amenities}/g, context.amenities || 'tous les équipements standard');
  template = template.replace(/{nearby}/g, context.nearby || 'plusieurs commerces et transports');
  template = template.replace(/{rules}/g, context.rules || 'non-fumeur, respect du voisinage');
  
  return template;
}

/**
 * Réponse de repli quand OpenAI est indisponible.
 *
 * Le résultat porte `fallback: true` et `confidence: null`. Ce n'est pas une
 * décoration : ces gabarits comblent une information absente par une valeur par
 * défaut (« le check-in est prévu à partir de 15:00 », « le code d'accès est [À
 * FOURNIR] »). Rien de tout cela ne vient de la fiche du logement, et rien dans
 * les autres garde-fous ne le distinguait d'une vraie réponse : sujet
 * whitelisté, risque faible, longueur plausible, aucune formule d'esquive.
 * Une panne d'OpenAI envoyait donc au voyageur une heure d'arrivée inventée.
 *
 * Le brouillon reste utile — l'hôte le relit et l'envoie — mais jamais seul.
 */
function buildFallbackResponse(intent, risk, propertyContext, incomingMessage) {
  // Check for courtesy messages that need no reply
  const courtesyPattern = /^(merci|ok|d'accord|super|parfait|top|cool|nickel|genial|g[ée]nial|bonne journ[ée]e|bonne soir[ée]e|thanks|thank you|great|perfect|awesome|noted|got it|okay|ok merci|merci beaucoup|super merci|parfait merci|c'est not[ée]|c'est parfait|tres bien|très bien)[.!\s]*$/i;
  if (courtesyPattern.test(incomingMessage.trim())) {
    return {
      draft_reply: '',
      intent: 'courtesy',
      risk_level: 'low',
      escalate: false,
      no_reply_needed: true,
      confidence: null,
      fallback: true,
      host_note: null,
      missing_info_questions: []
    };
  }

  const draftReply = generateFromTemplate(intent, propertyContext, incomingMessage);
  
  // Déterminer escalade basée sur intent
  const escalateIntents = ['problem', 'cancellation', 'price-negotiation'];
  const escalate = escalateIntents.includes(intent) || risk === 'high';
  
  let hostNote = null;
  if (escalate) {
    if (intent === 'problem') {
      hostNote = "Le voyageur signale un problème. Vérifier et résoudre rapidement.";
    } else if (intent === 'cancellation') {
      hostNote = "Demande d'annulation. Vérifier la politique et traiter manuellement.";
    } else if (intent === 'price-negotiation') {
      hostNote = "Demande de réduction. Décider si acceptable selon occupation.";
    } else if (risk === 'high') {
      hostNote = "Message à risque élevé. Traitement manuel requis immédiatement.";
    }
  }
  
  return {
    draft_reply: draftReply,
    intent,
    risk_level: risk,
    escalate,
    confidence: null,
    fallback: true,
    host_note: hostNote,
    missing_info_questions: []
  };
}

module.exports = {
  generateFromTemplate,
  buildFallbackResponse,
  detectLanguage
};

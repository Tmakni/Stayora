// Détection d'intention et classification basée sur règles simples

const INTENTS = {
  CHECK_IN: 'check-in',
  CHECK_OUT: 'check-out',
  WIFI: 'wifi',
  PARKING: 'parking',
  AMENITIES: 'amenities',
  LOCATION: 'location',
  PRICE_NEGOTIATION: 'price-negotiation',
  CANCELLATION: 'cancellation',
  PROBLEM: 'problem',
  RULES: 'rules',
  BOOKING_INQUIRY: 'booking-inquiry',
  MODIFICATION: 'modification',
  OTHER: 'other'
};

const INTENT_KEYWORDS = {
  [INTENTS.CHECK_IN]: ['check.?in', 'arrivée', 'arrive', 'arrival', 'clé', 'key', 'code', 'accès', 'access'],
  [INTENTS.CHECK_OUT]: ['check.?out', 'départ', 'leave', 'leaving', 'partir'],
  [INTENTS.WIFI]: ['wifi', 'wi.?fi', 'internet', 'mot de passe', 'password', 'réseau', 'network'],
  [INTENTS.PARKING]: ['parking', 'garer', 'park', 'voiture', 'car', 'stationnement'],
  [INTENTS.AMENITIES]: ['machine', 'laver', 'washing', 'lave.?linge', 'cuisine', 'kitchen', 'équipement', 'amenities'],
  [INTENTS.LOCATION]: ['près', 'proche', 'near', 'métro', 'metro', 'restaurant', 'pharmacie', 'pharmacy', 'supermarché', 'supermarket'],
  [INTENTS.PRICE_NEGOTIATION]: ['réduction', 'discount', 'prix', 'price', 'moins cher', 'cheaper', 'négocier', 'negotiate'],
  [INTENTS.CANCELLATION]: ['annuler', 'cancel', 'remboursement', 'refund'],
  [INTENTS.PROBLEM]: ['problème', 'problem', 'issue', 'broken', 'cassé', 'ne fonctionne pas', 'doesn\'t work', 'fuite', 'leak'],
  [INTENTS.RULES]: ['règle', 'rule', 'fumeur', 'smoking', 'animaux', 'pet', 'fête', 'party', 'bruit', 'noise'],
  [INTENTS.BOOKING_INQUIRY]: ['disponible', 'available', 'réserver', 'book', 'libre', 'free'],
  [INTENTS.MODIFICATION]: ['modifier', 'modify', 'changer', 'change', 'update', 'dates']
};

const RISK_KEYWORDS = {
  high: ['urgent', 'emergency', 'police', 'danger', 'lawyer', 'avocat', 'legal', 'justice', 'tribunal', 'court', 'scam', 'arnaque', 'vol', 'theft'],
  medium: ['problem', 'problème', 'broken', 'cassé', 'not working', 'ne fonctionne pas', 'refund', 'remboursement', 'cancel', 'annuler', 'complaint', 'plainte']
};

function classifyIntent(message) {
  const lowerMessage = message.toLowerCase();
  
  const scores = {};
  
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    scores[intent] = 0;
    
    for (const keyword of keywords) {
      const regex = new RegExp(keyword, 'i');
      if (regex.test(lowerMessage)) {
        scores[intent]++;
      }
    }
  }
  
  // Trouver l'intent avec le meilleur score
  let maxScore = 0;
  let detectedIntent = INTENTS.OTHER;
  
  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detectedIntent = intent;
    }
  }
  
  return detectedIntent;
}

function assessRisk(message) {
  const lowerMessage = message.toLowerCase();
  
  // Check high risk
  for (const keyword of RISK_KEYWORDS.high) {
    if (lowerMessage.includes(keyword)) {
      return 'high';
    }
  }
  
  // Check medium risk
  for (const keyword of RISK_KEYWORDS.medium) {
    if (lowerMessage.includes(keyword)) {
      return 'medium';
    }
  }
  
  return 'low';
}

function shouldEscalate(intent, risk, messageLength) {
  // Escalade si risque élevé
  if (risk === 'high') {
    return true;
  }
  
  // Escalade sur certains intents sensibles
  const sensitiveIntents = [INTENTS.CANCELLATION, INTENTS.PROBLEM, INTENTS.PRICE_NEGOTIATION];
  if (sensitiveIntents.includes(intent) && risk === 'medium') {
    return true;
  }
  
  // Escalade si message très long (peut indiquer situation complexe)
  if (messageLength > 1000) {
    return true;
  }
  
  return false;
}

module.exports = {
  classifyIntent,
  assessRisk,
  shouldEscalate,
  INTENTS
};

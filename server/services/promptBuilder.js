// Construction du prompt pour OpenAI
const { buildStylePromptSection } = require('./hostStyleService');
const logger = require('../utils/logger');

/**
 * Safely coerce propertyContext into an object.
 * propertyContext is normally already a parsed object by the time it reaches
 * here (every caller pre-parses context_json in a try/catch), but this stays
 * defensive: a malformed/non-JSON string must never crash the process.
 */
function safeParsePropertyContext(propertyContext) {
  if (typeof propertyContext !== 'string') return propertyContext || {};
  try {
    return JSON.parse(propertyContext);
  } catch (err) {
    logger.warn('promptBuilder: failed to parse propertyContext JSON, using empty context:', err.message);
    return {};
  }
}

function buildSystemPrompt(propertyContext, hostStyle) {
  const context = safeParsePropertyContext(propertyContext);

  const hostSignature = context.host_name || '';
  const signatureInstruction = hostSignature
    ? `Tu signes toujours tes messages avec le prénom "${hostSignature}".`
    : '';
  
  return `Tu es un assistant qui répond comme un hôte Airbnb humain, chaleureux, clair et professionnel. Tu donnes les informations pratiques de façon rassurante, polie et concise. ${signatureInstruction}

CONTEXTE DE LA PROPRIÉTÉ:
${formatPropertyContext(context)}
${context._past_qa ? '\n' + context._past_qa + '\n' : ''}
RÈGLES STRICTES:
1. Réponse courte: 2-6 phrases maximum (sauf si guide détaillé explicitement demandé)
2. Ton: professionnel, chaleureux, humain, accueillant
3. Langue: TOUJOURS répondre dans la même langue que le message du voyageur (FR/EN principalement)
4. Ne JAMAIS inventer: Si une information n'est pas dans le contexte, NE RÉPONDS PAS au voyageur — mets "needs_host": true et "draft_reply": ""
5. JAMAIS demander email/téléphone/paiement en dehors d'Airbnb
6. Si situation sensible (problème, litige, urgence): signale "escalate": true
7. Si information manquante cruciale que seul l'hôte peut fournir: mets "needs_host": true et "host_question": la question simplifiée pour l'hôte

RÈGLE CRITIQUE — INFORMATION MANQUANTE:
Quand le voyageur pose une question (ex: "Y a-t-il un parking ?", "Comment fonctionne le chauffage ?", "Où est le supermarché le plus proche ?") et que tu n'as PAS l'information dans le contexte ci-dessus:
- Mets "needs_host": true
- Mets "draft_reply": "" (chaîne vide — PAS de réponse inventée)
- Mets "host_question": une version simplifiée et claire de la question du voyageur, formulée pour l'hôte
- Ex: voyageur demande "À quelle heure je peux arriver ?" et pas de check_in_time → host_question: "À quelle heure est le check-in pour vos voyageurs ?"

FORMAT DE SORTIE (JSON strict):
{
  "draft_reply": "La réponse complète à envoyer au voyageur (VIDE si needs_host ou no_reply_needed est true)",
  "intent": "check-in|wifi|parking|problem|courtesy|...",
  "risk_level": "low|medium|high",
  "escalate": true|false,
  "needs_host": true|false,
  "no_reply_needed": true|false,
  "host_note": "Note pour l'hôte si escalade nécessaire",
  "host_question": "Question simplifiée pour l'hôte quand l'info manque",
  "missing_info_questions": ["question1", "question2"]
}

EXEMPLES DE BONNES RÉPONSES:
- Check-in anticipé (info disponible): "Bonjour, le check-in anticipé à 13h est possible si le logement est libre, avec des frais de 20€. Je vous confirme la disponibilité très bientôt."
- WiFi (info disponible): "Le WiFi est '${context.wifi_name || '[NOM_MANQUANT]'}' et le mot de passe: '${context.wifi_password || '[MDP_MANQUANT]'}'. N'hésitez pas si vous avez besoin d'aide."

STYLE D'ÉCRITURE OBLIGATOIRE:
- JAMAIS de point d'exclamation après "Bonjour", "Bonsoir", "Salut" → écrire "Bonjour," et non "Bonjour!"
- Limiter les points d'exclamation au strict minimum (max 1 dans tout le message, et seulement si naturel)
- Ton professionnel et chaleureux, comme un vrai humain qui écrit un message
- Info MANQUANTE: { "needs_host": true, "draft_reply": "", "host_question": "Le voyageur demande le code WiFi. Quel est le nom du réseau et le mot de passe ?" }

DISPONIBILITÉ & CALENDRIER:
- Si le voyageur demande si le logement est disponible à certaines dates, utilise les données de la section "DISPONIBILITÉ DU LOGEMENT" du contexte.
- Si des dates sont marquées comme occupées (réservation iCal, bloc manuel, ou réservation existante), indique que le logement n'est PAS disponible à ces dates.
- Si aucun conflit n'est trouvé pour les dates demandées, confirme que le logement est disponible.
- Le calendrier est synchronisé automatiquement toutes les 5 minutes. Les données sont fiables et à jour.
- Si tu n'as pas d'information de disponibilité dans le contexte, mets "needs_host": true.

${buildStylePromptSection(hostStyle)}
DÉTECTION ESCALADE:
- Problème urgent/sécurité → escalate true
- Demande de remboursement/annulation → escalate true + host_note
- Litige/plainte → escalate true
- Demande complexe → escalate true si besoin de décision hôte

MESSAGES DE COURTOISIE (AUCUNE RÉPONSE NÉCESSAIRE):
Si le message du voyageur est un simple remerciement, une confirmation courte, ou un message de politesse qui ne nécessite PAS de réponse (exemples: "merci", "ok merci", "super merci", "parfait", "top", "d'accord", "c'est noté", "thanks", "great", "ok", "cool", "nickel", "merci beaucoup", "c'est parfait", "bonne journée"), alors:
- Mets "no_reply_needed": true
- Mets "draft_reply": "" (vide)
- Mets l'intent correspondant
Ne génère PAS de réponse pour ces messages de courtoisie sauf s'ils contiennent une vraie question.
`;
}

function formatPropertyContext(context) {
  const lines = [];

  // --- Informations de base ---
  if (context.name) lines.push(`- Logement: ${context.name}`);
  if (context.property_type) lines.push(`- Type: ${context.property_type}`);
  if (context.max_guests) lines.push(`- Capacité max: ${context.max_guests} personnes`);
  if (context.bedrooms) lines.push(`- Chambres: ${context.bedrooms}`);
  if (context.beds) lines.push(`- Lits: ${context.beds}`);
  if (context.bathrooms) lines.push(`- Salles de bain: ${context.bathrooms}`);

  // --- Arrivée, accès & départ ---
  if (context.check_in_time) lines.push(`- Check-in: ${context.check_in_time}`);
  if (context.check_out_time) lines.push(`- Check-out: ${context.check_out_time}`);
  if (context.checkin_method) {
    const methods = { 'self-checkin': 'Arrivée autonome', 'lockbox': 'Boîte à clés', 'in-person': 'Remise en main propre', 'smart-lock': 'Serrure connectée', 'concierge': 'Concierge/Gardien' };
    lines.push(`- Méthode d'arrivée: ${methods[context.checkin_method] || context.checkin_method}`);
  }
  if (context.key_location) lines.push(`- Emplacement clés: ${context.key_location}`);
  if (context.access_code) lines.push(`- Code d'accès: ${context.access_code}`);
  if (context.gate_code) lines.push(`- Code portail/interphone: ${context.gate_code}`);
  if (context.building_entry) lines.push(`- Accès immeuble: ${context.building_entry}`);
  if (context.floor_number) lines.push(`- Étage: ${context.floor_number}`);
  if (context.has_elevator) lines.push(`- Ascenseur: Oui`);
  if (context.luggage_storage) {
    const storage = { 'before-checkin': 'Avant check-in', 'after-checkout': 'Après check-out', 'both': 'Avant et après', 'none': 'Non disponible' };
    lines.push(`- Consigne bagages: ${storage[context.luggage_storage] || context.luggage_storage}`);
  }
  if (context.early_checkin) lines.push(`- Check-in anticipé: ${context.early_checkin}`);
  if (context.late_checkout) lines.push(`- Check-out tardif: ${context.late_checkout}`);
  if (context.checkout_instructions) lines.push(`- Instructions départ: ${context.checkout_instructions}`);

  // --- WiFi & Connectivité ---
  if (context.wifi_name) lines.push(`- Réseau WiFi: ${context.wifi_name}`);
  if (context.wifi_password) lines.push(`- Mot de passe WiFi: ${context.wifi_password}`);
  if (context.wifi_speed) lines.push(`- Débit internet: ${context.wifi_speed}`);
  if (context.mobile_coverage) {
    const cov = { excellent: 'Excellente (4G/5G)', good: 'Bonne', poor: 'Faible', none: 'Aucune' };
    lines.push(`- Couverture mobile: ${cov[context.mobile_coverage] || context.mobile_coverage}`);
  }
  if (context.has_ethernet) lines.push(`- Prise Ethernet: Oui`);

  // --- Transport & Localisation ---
  if (context.neighborhood_name) lines.push(`- Quartier: ${context.neighborhood_name}`);
  if (context.distance_center) lines.push(`- Distance centre-ville: ${context.distance_center}`);
  if (context.distance_beach) lines.push(`- Distance plage: ${context.distance_beach}`);
  if (context.distance_ski) lines.push(`- Distance ski: ${context.distance_ski}`);
  if (context.nearest_airport) lines.push(`- Aéroport: ${context.nearest_airport}`);
  if (context.airport_transfer) lines.push(`- Comment venir (aéroport/gare): ${context.airport_transfer}`);
  if (context.nearest_train) lines.push(`- Gare: ${context.nearest_train}`);
  if (context.nearest_metro_bus) lines.push(`- Métro/Bus: ${context.nearest_metro_bus}`);
  if (context.parking || context.parking_info) lines.push(`- Parking: ${context.parking || context.parking_info}`);
  if (context.parking_type) {
    const pt = { 'free-street': 'Gratuit (rue)', 'free-private': 'Gratuit (privé)', 'paid-street': 'Payant (rue)', 'paid-garage': 'Payant (garage)', 'private-garage': 'Garage privé', 'none': 'Pas de parking' };
    lines.push(`- Type parking: ${pt[context.parking_type] || context.parking_type}`);
  }
  if (context.paid_parking) lines.push(`- Parking payant: ${context.paid_parking}`);
  if (context.has_taxi_uber) lines.push(`- Taxi/Uber: Disponible`);
  if (context.has_ev_charging) lines.push(`- Borne recharge électrique: Oui`);
  if (context.nearby) lines.push(`- À proximité: ${context.nearby}`);

  // --- Commerces & Services ---
  if (context.nearest_supermarket) lines.push(`- Supermarché: ${context.nearest_supermarket}`);
  if (context.nearest_bakery) lines.push(`- Boulangerie: ${context.nearest_bakery}`);
  if (context.nearest_restaurant) lines.push(`- Restaurants: ${context.nearest_restaurant}`);
  if (context.nearest_pharmacy) lines.push(`- Pharmacie: ${context.nearest_pharmacy}`);
  if (context.nearest_hospital) lines.push(`- Hôpital/Urgences: ${context.nearest_hospital}`);
  if (context.nearest_atm) lines.push(`- Distributeur/Banque: ${context.nearest_atm}`);

  // --- Équipements ---
  if (context.amenities) {
    if (typeof context.amenities === 'string' && context.amenities.trim()) {
      lines.push(`- Équipements: ${context.amenities}`);
    } else if (typeof context.amenities === 'object') {
      const AMENITY_LABELS = {
        wifi: 'Wi-Fi', kitchen: 'Cuisine', parking: 'Parking', pool: 'Piscine',
        gym: 'Salle de sport', tv: 'TV', washing_machine: 'Lave-linge',
        air_conditioning: 'Climatisation', heating: 'Chauffage', workspace: 'Bureau',
        hair_dryer: 'Sèche-cheveux', iron: 'Fer à repasser', bathtub: 'Baignoire',
        dryer: 'Sèche-linge', dishwasher: 'Lave-vaisselle', microwave: 'Micro-ondes',
        refrigerator: 'Réfrigérateur', coffee_maker: 'Machine à café', bbq: 'Barbecue',
        terrace: 'Terrasse', garden: 'Jardin', netflix: 'Netflix', fireplace: 'Cheminée'
      };
      const list = Object.entries(AMENITY_LABELS)
        .filter(([k]) => context.amenities[k])
        .map(([, v]) => v);
      if (list.length) lines.push(`- Équipements: ${list.join(', ')}`);
    }
  }

  // --- Cuisine détaillée ---
  if (context.kitchen_extras) lines.push(`- Cuisine (détail): ${context.kitchen_extras}`);
  if (context.kitchen_equipment_details) lines.push(`- Équipement cuisine: ${context.kitchen_equipment_details}`);
  if (context.stove_type) {
    const st = { gas: 'Gaz', electric: 'Électrique', induction: 'Induction', vitro: 'Vitrocéramique' };
    lines.push(`- Plaque cuisson: ${st[context.stove_type] || context.stove_type}`);
  }
  if (context.drinking_water) {
    const dw = { 'tap-safe': 'Eau du robinet potable', filter: 'Eau filtrée', bottled: 'Eau en bouteille fournie', 'tap-unsafe': 'Robinet non potable' };
    lines.push(`- Eau potable: ${dw[context.drinking_water] || context.drinking_water}`);
  }
  if (context.has_breakfast) lines.push(`- Petit-déjeuner: ${context.breakfast_details || 'Inclus'}`);

  // --- Chambres & Literie ---
  if (context.bedroom_extras) lines.push(`- Literie: ${context.bedroom_extras}`);
  if (context.bed_types) lines.push(`- Types de lits: ${context.bed_types}`);
  if (context.has_extra_bed) lines.push(`- Lit supplémentaire: Disponible${context.extra_bed_fee ? ' (' + context.extra_bed_fee + ')' : ''}`);
  if (context.linen_change) lines.push(`- Changement draps: ${context.linen_change}`);

  // --- Salle de bain ---
  if (context.bathroom_extras) lines.push(`- Salle de bain: ${context.bathroom_extras}`);
  if (context.shower_type) {
    const sh = { 'walk-in': 'Douche italienne', 'bathtub-combo': 'Baignoire + douche', 'rain-shower': 'Douche pluie', standard: 'Douche standard' };
    lines.push(`- Type douche: ${sh[context.shower_type] || context.shower_type}`);
  }
  if (context.hot_water_type) {
    const hw = { unlimited: 'Illimitée (chaudière)', tank: 'Cumulus (limité)', instant: 'Instantanée (gaz)', solar: 'Solaire' };
    lines.push(`- Eau chaude: ${hw[context.hot_water_type] || context.hot_water_type}`);
  }
  if (context.hot_water_instructions) lines.push(`- Instructions eau chaude: ${context.hot_water_instructions}`);
  if (context.towel_change) lines.push(`- Changement serviettes: ${context.towel_change}`);
  if (context.second_bathroom_details) lines.push(`- 2ème SDB: ${context.second_bathroom_details}`);

  // --- Ménage & Linge ---
  if (context.cleaning_extras) lines.push(`- Ménage dispo: ${context.cleaning_extras}`);
  if (context.cleaning_fee) lines.push(`- Frais ménage: ${context.cleaning_fee}`);
  if (context.cleaning_frequency) {
    const cf = { none: 'Aucun', daily: 'Quotidien', weekly: 'Hebdomadaire', 'on-request': 'Sur demande' };
    lines.push(`- Ménage pendant séjour: ${cf[context.cleaning_frequency] || context.cleaning_frequency}`);
  }
  if (context.washing_instructions) lines.push(`- Lave-linge: ${context.washing_instructions}`);
  if (context.dryer_instructions) lines.push(`- Sèche-linge: ${context.dryer_instructions}`);

  // --- Extérieur & Loisirs ---
  if (context.outdoor_extras) lines.push(`- Extérieur: ${context.outdoor_extras}`);
  if (context.pool_type) {
    const pt = { private: 'Privée', shared: 'Partagée', indoor: 'Intérieure', rooftop: 'Rooftop' };
    lines.push(`- Type piscine: ${pt[context.pool_type] || context.pool_type}`);
  }
  if (context.pool_hours) lines.push(`- Horaires piscine: ${context.pool_hours}`);
  if (context.has_jacuzzi) {
    const ja = { 'all-year': 'toute l\'année', summer: 'été uniquement (mai-sept)', winter: 'hiver uniquement (oct-avril)', seasonal: 'saisonnier', off: 'HORS SERVICE actuellement' };
    let jacLine = 'Jacuzzi/Spa';
    if (context.jacuzzi_availability) jacLine += ` — ${ja[context.jacuzzi_availability] || context.jacuzzi_availability}`;
    if (context.jacuzzi_notes) jacLine += ` (${context.jacuzzi_notes})`;
    lines.push(`- ${jacLine}`);
  }
  if (context.bikes_details) lines.push(`- Vélos: ${context.bikes_details}`);
  if (context.outdoor_other) lines.push(`- Autres activités/loisirs: ${context.outdoor_other}`);

  // --- Divertissement ---
  if (context.entertainment_extras) lines.push(`- Divertissement: ${context.entertainment_extras}`);
  if (context.cable_channels) lines.push(`- TV/Streaming: ${context.cable_channels}`);

  // --- Sécurité ---
  if (context.security_extras) lines.push(`- Sécurité: ${context.security_extras}`);
  if (context.emergency_numbers) lines.push(`- Numéros urgence: ${context.emergency_numbers}`);
  if (context.fire_escape) lines.push(`- Issue secours: ${context.fire_escape}`);

  // --- Enfants ---
  if (context.children_extras) lines.push(`- Enfants/Bébés: ${context.children_extras}`);

  // --- Règles ---
  if (context.rules) {
    if (typeof context.rules === 'string' && context.rules.trim()) {
      lines.push(`- Règles: ${context.rules}`);
    } else if (typeof context.rules === 'object') {
      const rlist = [];
      if (context.rules.pets !== undefined) rlist.push(context.rules.pets ? 'Animaux acceptés' : 'Pas d\'animaux');
      if (context.rules.smoking !== undefined) rlist.push(context.rules.smoking ? 'Fumeurs OK' : 'Non-fumeur');
      if (context.rules.events !== undefined) rlist.push(context.rules.events ? 'Événements OK' : 'Pas d\'événements');
      if (rlist.length) lines.push(`- Règles: ${rlist.join(', ')}`);
    }
  } else if (context.house_rules && context.house_rules.trim()) {
    lines.push(`- Règles: ${context.house_rules}`);
  }
  if (context.quiet_hours) lines.push(`- Heures calmes: ${context.quiet_hours}`);
  if (context.trash_instructions) lines.push(`- Poubelles/Tri: ${context.trash_instructions}`);
  if (context.min_stay) lines.push(`- Séjour minimum: ${context.min_stay}`);
  if (context.max_stay) lines.push(`- Séjour maximum: ${context.max_stay}`);
  if (context.cancellation_policy) {
    const cp = { flexible: 'Flexible', moderate: 'Modérée', strict: 'Stricte', 'super-strict': 'Très stricte' };
    lines.push(`- Annulation: ${cp[context.cancellation_policy] || context.cancellation_policy}`);
  }
  if (context.age_minimum) lines.push(`- Âge minimum: ${context.age_minimum}`);
  if (context.smoking_area) lines.push(`- Zone fumeur: ${context.smoking_area}`);

  // --- Tarifs, Caution & Paiements ---
  if (context.has_deposit_required) {
    let depositInfo = 'Caution OBLIGATOIRE';
    if (context.deposit_amount) depositInfo += ` — ${context.deposit_amount}`;
    if (context.deposit_method) {
      const dm = { airbnb: 'via Airbnb', 'card-hold': 'empreinte CB', cash: 'espèces', 'bank-transfer': 'virement', cheque: 'chèque' };
      depositInfo += ` (${dm[context.deposit_method] || context.deposit_method})`;
    }
    lines.push(`- ${depositInfo}`);
    if (context.deposit_refund_delay) {
      const dr = { checkout: 'remboursée au départ', '48h': 'remboursée sous 48h', '7days': 'remboursée sous 7 jours', '14days': 'remboursée sous 14 jours', '30days': 'remboursée sous 30 jours' };
      lines.push(`- Remboursement caution: ${dr[context.deposit_refund_delay] || context.deposit_refund_delay}`);
    }
    if (context.deposit_covers) lines.push(`- La caution couvre: ${context.deposit_covers}`);
  }
  if (context.security_deposit) lines.push(`- Détails caution: ${context.security_deposit}`);
  if (context.has_price_per_guest) {
    let priceInfo = 'Le prix AUGMENTE avec le nombre de voyageurs';
    if (context.extra_guest_threshold) priceInfo += ` (${context.extra_guest_threshold})`;
    lines.push(`- ${priceInfo}`);
  }
  if (context.extra_guest_fee) lines.push(`- Supplément par voyageur: ${context.extra_guest_fee}`);
  if (context.price_extra_guest_amount) lines.push(`- Détails tarification voyageurs: ${context.price_extra_guest_amount}`);
  if (context.has_tourist_tax) {
    lines.push(`- Taxe de séjour: ${context.tourist_tax_amount || 'applicable (montant à confirmer)'}`);
  }
  if (context.has_cleaning_fee_included) {
    lines.push(`- Frais de ménage: INCLUS dans le prix${context.cleaning_fee ? ' (' + context.cleaning_fee + ')' : ''}`);
  } else if (context.cleaning_fee) {
    lines.push(`- Frais de ménage: ${context.cleaning_fee} (EN PLUS du prix)`);
  }
  if (context.payment_extras_method) {
    const pm = { 'cash-only': 'Espèces uniquement', 'card-only': 'Carte bancaire uniquement', 'cash-card': 'Espèces ou CB', transfer: 'Virement bancaire', all: 'Espèces, CB ou virement', 'airbnb-only': 'Uniquement via Airbnb' };
    lines.push(`- Paiement extras sur place: ${pm[context.payment_extras_method] || context.payment_extras_method}`);
  }
  if (context.payment_notes) lines.push(`- Notes tarification: ${context.payment_notes}`);

  // --- Animaux ---
  if (context.pet_fee) lines.push(`- Frais animaux: ${context.pet_fee}`);
  if (context.pet_size_limit) lines.push(`- Limite animaux: ${context.pet_size_limit}`);
  if (context.pet_rules) lines.push(`- Règles animaux: ${context.pet_rules}`);

  // --- Hôte ---
  if (context.host_name) lines.push(`- Hôte: ${context.host_name}`);
  if (context.host_languages) lines.push(`- Langues hôte: ${context.host_languages}`);
  if (context.host_response_time) lines.push(`- Temps de réponse: ${context.host_response_time}`);
  if (context.host_lives) {
    const hl = { 'on-site': 'Sur place', nearby: 'À proximité', remote: 'À distance' };
    lines.push(`- Localisation hôte: ${hl[context.host_lives] || context.host_lives}`);
  }
  if (context.cohost_name) lines.push(`- Contact sur place: ${context.cohost_name}${context.cohost_phone ? ' (' + context.cohost_phone + ')' : ''}`);

  // --- FAQ personnalisées ---
  if (context.custom_faq && context.custom_faq.trim()) {
    lines.push(`\nFAQ DU PROPRIÉTAIRE (utilise ces réponses exactes si pertinent):\n${context.custom_faq}`);
  }

  // --- Description ---
  if (context.description && context.description.trim()) {
    lines.push(`\nDESCRIPTION DU LOGEMENT:\n${context.description}`);
  }
  if (context.address && context.address.trim()) {
    lines.push(`- Adresse: ${context.address}`);
  }

  // --- Disponibilité (calendrier iCal) ---
  if (context.availability_summary) {
    lines.push(`\nDISPONIBILITÉ DU LOGEMENT (source: calendrier iCal, mis à jour automatiquement):\n${context.availability_summary}`);
  }
  
  return lines.length > 0 ? lines.join('\n') : 'Aucune information de propriété fournie.';
}

function buildUserPrompt(incomingMessage, conversationHistory, bookingStatus, guestProfile) {
  let prompt = `STATUT RÉSERVATION: ${bookingStatus || 'inquiry'}\n\n`;
  
  // Detect language using the full conversation for accuracy (not just last msg)
  const allIncomingText = (conversationHistory || [])
    .filter(m => m.role === 'incoming')
    .map(m => m.content)
    .join(' ');
  const textForLangDetect = allIncomingText ? allIncomingText + ' ' + incomingMessage : incomingMessage;
  const detectedLang = detectLanguage(textForLangDetect);
  prompt += `LANGUE DÉTECTÉE DU VOYAGEUR: ${detectedLang}\nIMPORTANT: Tu DOIS répondre en ${detectedLang}. Ne réponds JAMAIS dans une autre langue.\n\n`;
  
  if (guestProfile) {
    prompt += `PROFIL VOYAGEUR:\n`;
    if (guestProfile.language) prompt += `- Langue: ${guestProfile.language}\n`;
    if (guestProfile.num_guests) prompt += `- Nombre de personnes: ${guestProfile.num_guests}\n`;
    if (guestProfile.dates) prompt += `- Dates: ${guestProfile.dates}\n`;
    prompt += '\n';
  }
  
  if (conversationHistory && conversationHistory.length > 0) {
    prompt += `HISTORIQUE CONVERSATION:\n`;
    conversationHistory.slice(-8).forEach(msg => {
      const role = msg.role === 'incoming' ? 'VOYAGEUR' : 'HÔTE';
      const preview = msg.content.substring(0, 300);
      prompt += `${role}: ${preview}${msg.content.length > 300 ? '...' : ''}\n`;
    });
    prompt += '\n';
  }
  
  prompt += `DERNIER MESSAGE DU VOYAGEUR (à répondre):\n"${incomingMessage}"\n\n`;
  prompt += `Génère la réponse JSON maintenant (en ${detectedLang}):`;
  
  return prompt;
}

/**
 * Simple language detection based on common words.
 * Returns a human-readable language name.
 */
function detectLanguage(text) {
  const lower = text.toLowerCase();
  
  const patterns = [
    { lang: 'français', words: ['bonjour', 'merci', 'bonsoir', 'salut', 'je ', 'nous ', 'vous ', 'est-ce', 'comment', 'quand', 'combien', 'pourquoi', 'arrivée', 'départ', 'séjour', 'logement', 'chambre', 'clé', 'réservation', 'pouvez', 'avez', 'est ', "l'", "d'", "j'", "s'", "n'", "qu'"] },
    { lang: 'español', words: ['hola', 'gracias', 'buenos', 'buenas', 'cómo', 'cuándo', 'dónde', 'llegada', 'salida', 'habitación', 'reserva', 'estoy', 'tengo', 'puede', 'nosotros'] },
    { lang: 'deutsch', words: ['hallo', 'guten', 'danke', 'bitte', 'wann', 'wie ', 'ankunft', 'abreise', 'zimmer', 'buchung', 'ich ', 'wir ', 'können', 'haben'] },
    { lang: 'italiano', words: ['ciao', 'buongiorno', 'buonasera', 'grazie', 'arrivo', 'partenza', 'camera', 'prenotazione', 'posso', 'abbiamo', 'quando', 'come '] },
    { lang: 'english', words: ['hello', 'hi ', 'hey ', 'thanks', 'thank you', 'good morning', 'good evening', 'how ', 'when ', 'where ', 'what ', 'check-in', 'check-out', 'booking', 'reservation', 'room', 'stay', 'arrive', 'the ', 'is ', 'are ', 'we ', 'our ', "i'm", "we're", 'could', 'would', 'please'] }
  ];
  
  let bestLang = 'français';
  let bestScore = 0;
  
  for (const { lang, words } of patterns) {
    let score = 0;
    for (const w of words) {
      if (lower.includes(w)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }
  
  return bestLang;
}

/**
 * Build a prompt pair for the fine-tuned model.
 * The fine-tuned model was trained with:
 *   system: short instruction about being a warm Airbnb host
 *   user: a clear task description with context
 *   assistant: plain text response in the guest's language
 * 
 * We match this format exactly for best results.
 */
function buildFineTunedPrompt(incomingMessage, conversationHistory, bookingStatus, guestProfile, propertyContext, hostStyle) {
  // Handle when called with positional args from aiService
  const context = safeParsePropertyContext(propertyContext);
  
  // Detect language from full conversation
  const allIncomingText = (conversationHistory || [])
    .filter(m => m.role === 'incoming')
    .map(m => m.content)
    .join(' ');
  const textForLangDetect = allIncomingText ? allIncomingText + ' ' + incomingMessage : incomingMessage;
  const detectedLang = detectLanguage(textForLangDetect);

  const langMap = { 'français': 'en français', 'english': 'in English', 'español': 'en español', 'deutsch': 'auf Deutsch', 'italiano': 'in italiano' };
  const langInstruction = langMap[detectedLang] || 'en français';

  const hostName = context.host_name || '';
  const signPart = hostName ? ` Signe avec le prénom "${hostName}".` : '';

  // System prompt matches training format
  const styleSection = buildStylePromptSection(hostStyle);
  const systemPrompt = `Tu es un assistant qui répond comme un hôte Airbnb humain, chaleureux, clair et professionnel. Tu donnes les informations pratiques de façon rassurante, polie et concise. Tu réponds ${langInstruction}.${signPart}${styleSection ? '\n' + styleSection : ''}`;

  // Build user prompt with all context
  let userPrompt = '';

  // Property context (compact)
  const ctxParts = [];
  if (context.name) ctxParts.push(`Logement : ${context.name}`);
  if (context.address) ctxParts.push(`Adresse : ${context.address}`);
  if (context.check_in_time) ctxParts.push(`Check-in : ${context.check_in_time}`);
  if (context.check_out_time) ctxParts.push(`Check-out : ${context.check_out_time}`);
  if (context.wifi_name) ctxParts.push(`WiFi : ${context.wifi_name}`);
  if (context.wifi_password) ctxParts.push(`Mot de passe WiFi : ${context.wifi_password}`);
  if (context.access_code) ctxParts.push(`Code d'accès : ${context.access_code}`);
  if (context.key_location) ctxParts.push(`Emplacement clés : ${context.key_location}`);
  if (context.checkin_method) ctxParts.push(`Arrivée : ${context.checkin_method}`);
  if (context.checkout_instructions) ctxParts.push(`Instructions départ : ${context.checkout_instructions}`);
  if (context.parking || context.parking_info) ctxParts.push(`Parking : ${context.parking || context.parking_info}`);
  if (context.max_guests) ctxParts.push(`Capacité : ${context.max_guests} personnes`);
  if (context.host_name) ctxParts.push(`Hôte : ${context.host_name}`);
  // Availability info if present
  if (context.availability_summary) ctxParts.push(`Disponibilité : ${context.availability_summary}`);
  
  if (typeof context.rules === 'string' && context.rules.trim()) {
    ctxParts.push(`Règles : ${context.rules}`);
  }
  if (context.custom_faq) ctxParts.push(`FAQ : ${context.custom_faq}`);

  if (ctxParts.length > 0) {
    userPrompt += `Informations du logement :\n${ctxParts.join('. ')}.\n\n`;
  }

  // Conversation history
  if (conversationHistory && conversationHistory.length > 1) {
    userPrompt += `Historique de la conversation :\n`;
    conversationHistory.slice(-6).forEach(msg => {
      const role = msg.role === 'incoming' ? 'Voyageur' : 'Hôte';
      userPrompt += `${role} : ${msg.content.substring(0, 300)}${msg.content.length > 300 ? '...' : ''}\n`;
    });
    userPrompt += '\n';
  }

  userPrompt += `Rédige une réponse ${langInstruction} au dernier message du voyageur : "${incomingMessage}"`;

  return { systemPrompt, userPrompt };
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  buildFineTunedPrompt,
  detectLanguage
};

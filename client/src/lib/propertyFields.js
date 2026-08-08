// Data-driven configuration for the property profile form.
// The backend stores ~150 "practical info" fields as free-form JSON
// (server/controllers/propertyController.js -> CONTEXT_ONLY_FIELDS) plus a
// smaller set of real amenity columns. The frontend doesn't need to treat
// them differently — every field below is just a key in the flat payload
// sent to POST/PUT /api/properties.

// Groups the 21 field-groups (below) into a manageable number of form tabs.
export const FORM_TABS = [
  { id: 'general', label: 'Général', groups: ['basics'] },
  { id: 'access', label: 'Arrivée & Accès', groups: ['access'] },
  { id: 'location', label: 'Connectivité & Localisation', groups: ['wifi', 'transport', 'nearby-services'] },
  { id: 'amenities', label: 'Équipements', groups: [], amenities: true },
  { id: 'rooms', label: 'Cuisine & Chambres', groups: ['kitchen-detail', 'bedroom', 'bathroom-detail', 'cleaning'] },
  { id: 'outdoor', label: 'Extérieur, Loisirs & Sécurité', groups: ['outdoor-detail', 'entertainment', 'security-detail', 'children'] },
  { id: 'rules', label: 'Règles & Tarifs', groups: ['rules', 'payments'] },
  { id: 'host', label: 'Hôte & FAQ', groups: ['host', 'faq'] },
  { id: 'photos', label: 'Photos', groups: [], photos: true },
];

export const AMENITY_GROUPS = [
  {
    id: 'essentials',
    title: 'Essentiels',
    fields: [
      { key: 'has_wifi', label: 'Wi-Fi' },
      { key: 'has_kitchen', label: 'Cuisine équipée' },
      { key: 'has_parking', label: 'Parking' },
      { key: 'has_air_conditioning', label: 'Climatisation' },
      { key: 'has_heating', label: 'Chauffage' },
      { key: 'has_workspace', label: 'Espace de travail' },
      { key: 'has_tv', label: 'TV' },
      { key: 'has_netflix', label: 'Netflix / Streaming' },
      { key: 'has_fireplace', label: 'Cheminée' },
    ],
  },
  {
    id: 'bathroom',
    title: 'Salle de bain',
    fields: [
      { key: 'has_bathtub', label: 'Baignoire' },
      { key: 'has_hair_dryer', label: 'Sèche-cheveux' },
      { key: 'has_iron', label: 'Fer à repasser' },
    ],
  },
  {
    id: 'kitchen',
    title: 'Cuisine',
    fields: [
      { key: 'has_dryer', label: 'Sèche-linge' },
      { key: 'has_washing_machine', label: 'Lave-linge' },
      { key: 'has_dishwasher', label: 'Lave-vaisselle' },
      { key: 'has_microwave', label: 'Micro-ondes' },
      { key: 'has_refrigerator', label: 'Réfrigérateur' },
      { key: 'has_coffee_maker', label: 'Machine à café' },
    ],
  },
  {
    id: 'outdoor',
    title: 'Extérieur & Loisirs',
    fields: [
      { key: 'has_pool', label: 'Piscine' },
      { key: 'has_gym', label: 'Salle de sport' },
      { key: 'has_bbq', label: 'Barbecue' },
      { key: 'has_terrace', label: 'Terrasse / Balcon' },
      { key: 'has_garden', label: 'Jardin' },
    ],
  },
  {
    id: 'security',
    title: 'Sécurité',
    fields: [
      { key: 'has_smoke_detector', label: 'Détecteur de fumée' },
      { key: 'has_carbon_monoxide_detector', label: 'Détecteur CO' },
      { key: 'has_fire_extinguisher', label: 'Extincteur' },
      { key: 'has_first_aid_kit', label: 'Trousse de secours' },
    ],
  },
];

// Flattened list — used for compact "tag" rendering on PropertyCard.
export const ALL_AMENITIES = AMENITY_GROUPS.flatMap((g) => g.fields);

export const FIELD_GROUPS = [
  {
    id: 'basics',
    title: 'Informations de base',
    description: 'L\u2019essentiel pour identifier le logement.',
    fields: [
      { key: 'name', label: 'Nom du logement', type: 'text', required: true, span: 2 },
      { key: 'property_type', label: 'Type de logement', type: 'select', required: true, options: 'PROPERTY_TYPES' },
      { key: 'bedrooms', label: 'Chambres', type: 'number', required: true },
      { key: 'beds', label: 'Lits', type: 'number', required: true },
      { key: 'bathrooms', label: 'Salles de bain', type: 'number', required: true },
      { key: 'max_guests', label: 'Voyageurs max.', type: 'number', required: true },
      { key: 'city', label: 'Ville', type: 'text' },
      { key: 'country', label: 'Pays', type: 'text' },
    ],
  },
  {
    id: 'access',
    title: 'Arrivée, accès & départ',
    description: 'Les questions les plus fréquentes des voyageurs.',
    fields: [
      { key: 'check_in_time', label: 'Heure d\u2019arrivée', type: 'time' },
      { key: 'check_out_time', label: 'Heure de départ', type: 'time' },
      { key: 'checkin_method', label: 'Méthode d\u2019arrivée', type: 'select', options: [
        { value: 'self-checkin', label: 'Auto check-in' },
        { value: 'lockbox', label: 'Boîte à clés' },
        { value: 'in-person', label: 'En personne' },
        { value: 'smart-lock', label: 'Serrure connectée' },
        { value: 'concierge', label: 'Conciergerie' },
      ] },
      { key: 'key_location', label: 'Emplacement des clés', type: 'textarea' },
      { key: 'access_code', label: 'Code d\u2019accès', type: 'text' },
      { key: 'gate_code', label: 'Code portail / interphone', type: 'text' },
      { key: 'building_entry', label: 'Instructions d\u2019entrée', type: 'textarea' },
      { key: 'floor_number', label: 'Étage / N° appartement', type: 'text' },
      { key: 'has_elevator', label: 'Ascenseur disponible', type: 'checkbox' },
      { key: 'luggage_storage', label: 'Consigne bagages', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'none', label: 'Non disponible' },
        { value: 'on_request', label: 'Sur demande' },
        { value: 'dedicated', label: 'Consigne dédiée' },
        { value: 'paid_nearby', label: 'Bagagerie payante à proximité' },
      ] },
      { key: 'early_checkin', label: 'Arrivée anticipée', type: 'textarea' },
      { key: 'late_checkout', label: 'Départ tardif', type: 'textarea' },
      { key: 'checkout_instructions', label: 'Instructions de départ', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'wifi',
    title: 'WiFi & Connectivité',
    fields: [
      { key: 'wifi_name', label: 'Nom du réseau WiFi', type: 'text' },
      { key: 'wifi_password', label: 'Mot de passe WiFi', type: 'text' },
      { key: 'wifi_speed', label: 'Débit WiFi', type: 'text' },
      { key: 'mobile_coverage', label: 'Couverture mobile', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'excellent', label: 'Excellente' },
        { value: 'good', label: 'Bonne' },
        { value: 'average', label: 'Moyenne' },
        { value: 'low', label: 'Faible' },
      ] },
      { key: 'has_ethernet', label: 'Prise Ethernet disponible', type: 'checkbox' },
    ],
  },
  {
    id: 'transport',
    title: 'Transport & Localisation',
    fields: [
      { key: 'neighborhood_name', label: 'Quartier', type: 'text' },
      { key: 'distance_center', label: 'Distance centre-ville', type: 'text' },
      { key: 'distance_beach', label: 'Distance plage', type: 'text' },
      { key: 'distance_ski', label: 'Distance pistes de ski', type: 'text' },
      { key: 'nearest_airport', label: 'Aéroport le plus proche', type: 'text' },
      { key: 'airport_transfer', label: 'Transfert aéroport', type: 'textarea' },
      { key: 'nearest_train', label: 'Gare la plus proche', type: 'text' },
      { key: 'nearest_metro_bus', label: 'Métro / Bus à proximité', type: 'text' },
      { key: 'parking_type', label: 'Type de parking', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'free_onsite', label: 'Gratuit sur place' },
        { value: 'paid_onsite', label: 'Payant sur place' },
        { value: 'free_street', label: 'Rue (gratuit)' },
        { value: 'paid_street', label: 'Rue (payant)' },
        { value: 'public_nearby', label: 'Parking public à proximité' },
        { value: 'none', label: 'Aucun' },
      ] },
      { key: 'paid_parking', label: 'Détails parking payant', type: 'text' },
      { key: 'has_taxi_uber', label: 'Taxi / VTC facile', type: 'checkbox' },
      { key: 'has_ev_charging', label: 'Borne de recharge électrique', type: 'checkbox' },
      { key: 'nearby', label: 'Résumé des environs', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'nearby-services',
    title: 'Commerces & Services à proximité',
    fields: [
      { key: 'nearest_supermarket', label: 'Supermarché', type: 'text' },
      { key: 'nearest_bakery', label: 'Boulangerie', type: 'text' },
      { key: 'nearest_restaurant', label: 'Restaurant', type: 'text' },
      { key: 'nearest_pharmacy', label: 'Pharmacie', type: 'text' },
      { key: 'nearest_hospital', label: 'Hôpital', type: 'text' },
      { key: 'nearest_atm', label: 'Distributeur (ATM)', type: 'text' },
    ],
  },
  {
    id: 'kitchen-detail',
    title: 'Cuisine & Repas',
    fields: [
      { key: 'has_oven', label: 'Four', type: 'checkbox' },
      { key: 'has_toaster', label: 'Grille-pain', type: 'checkbox' },
      { key: 'has_kettle', label: 'Bouilloire', type: 'checkbox' },
      { key: 'has_blender', label: 'Mixeur', type: 'checkbox' },
      { key: 'has_basic_condiments', label: 'Condiments de base', type: 'checkbox' },
      { key: 'has_breakfast', label: 'Petit-déjeuner inclus', type: 'checkbox' },
      { key: 'stove_type', label: 'Type de plaque', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'induction', label: 'Induction' },
        { value: 'ceramic', label: 'Vitrocéramique' },
        { value: 'gas', label: 'Gaz' },
        { value: 'electric', label: 'Électrique' },
      ] },
      { key: 'drinking_water', label: 'Eau potable', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'tap', label: 'Eau du robinet potable' },
        { value: 'bottled', label: 'Eau en bouteille fournie' },
        { value: 'not_potable', label: 'Non potable' },
      ] },
      { key: 'kitchen_equipment_details', label: 'Détails équipement cuisine', type: 'textarea', span: 2 },
      { key: 'breakfast_details', label: 'Détails petit-déjeuner', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'bedroom',
    title: 'Chambres & Literie',
    fields: [
      { key: 'has_extra_bed', label: 'Lit supplémentaire dispo.', type: 'checkbox' },
      { key: 'has_blackout_curtains', label: 'Rideaux occultants', type: 'checkbox' },
      { key: 'has_linen', label: 'Linge de lit fourni', type: 'checkbox' },
      { key: 'has_children_bed', label: 'Lit enfant', type: 'checkbox' },
      { key: 'bed_types', label: 'Détail des lits par chambre', type: 'textarea', span: 2 },
      { key: 'extra_bed_fee', label: 'Frais lit supplémentaire', type: 'text' },
      { key: 'linen_change', label: 'Changement des draps', type: 'text' },
    ],
  },
  {
    id: 'bathroom-detail',
    title: 'Salle de bain (détails)',
    fields: [
      { key: 'has_toiletries', label: 'Produits de toilette', type: 'checkbox' },
      { key: 'has_towels', label: 'Serviettes fournies', type: 'checkbox' },
      { key: 'has_bidet', label: 'Bidet', type: 'checkbox' },
      { key: 'shower_type', label: 'Type de douche', type: 'text' },
      { key: 'hot_water_type', label: 'Type d\u2019eau chaude', type: 'text' },
      { key: 'towel_change', label: 'Changement des serviettes', type: 'text' },
      { key: 'hot_water_instructions', label: 'Instructions eau chaude', type: 'textarea', span: 2 },
      { key: 'second_bathroom_details', label: '2ème salle de bain', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'cleaning',
    title: 'Ménage & Linge',
    fields: [
      { key: 'has_cleaning_products', label: 'Produits ménagers fournis', type: 'checkbox' },
      { key: 'has_vacuum', label: 'Aspirateur', type: 'checkbox' },
      { key: 'has_iron_board', label: 'Table à repasser', type: 'checkbox' },
      { key: 'cleaning_frequency', label: 'Fréquence du ménage', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'per_stay', label: 'Avant chaque séjour' },
        { value: 'on_request', label: 'Sur demande' },
        { value: 'weekly', label: 'Hebdomadaire (longs séjours)' },
      ] },
      { key: 'cleaning_fee', label: 'Frais de ménage', type: 'text' },
      { key: 'washing_instructions', label: 'Instructions lave-linge', type: 'textarea' },
      { key: 'dryer_instructions', label: 'Instructions sèche-linge', type: 'textarea' },
    ],
  },
  {
    id: 'outdoor-detail',
    title: 'Extérieur & Loisirs (détails)',
    fields: [
      { key: 'has_pool_heated', label: 'Piscine chauffée', type: 'checkbox' },
      { key: 'has_jacuzzi', label: 'Jacuzzi / Spa', type: 'checkbox' },
      { key: 'has_beach_access', label: 'Accès plage', type: 'checkbox' },
      { key: 'has_beach_towels', label: 'Serviettes de plage', type: 'checkbox' },
      { key: 'has_outdoor_furniture', label: 'Mobilier extérieur', type: 'checkbox' },
      { key: 'has_outdoor_dining', label: 'Coin repas extérieur', type: 'checkbox' },
      { key: 'has_private_entrance', label: 'Entrée privée', type: 'checkbox' },
      { key: 'has_bike_storage', label: 'Local à vélos', type: 'checkbox' },
      { key: 'has_bikes', label: 'Vélos disponibles', type: 'checkbox' },
      { key: 'pool_type', label: 'Type de piscine', type: 'text' },
      { key: 'pool_hours', label: 'Horaires piscine', type: 'text' },
      { key: 'jacuzzi_availability', label: 'Disponibilité jacuzzi', type: 'text' },
      { key: 'bikes_details', label: 'Détails vélos', type: 'textarea' },
      { key: 'jacuzzi_notes', label: 'Notes jacuzzi', type: 'textarea' },
      { key: 'outdoor_other', label: 'Autres loisirs', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'entertainment',
    title: 'Divertissement',
    fields: [
      { key: 'has_game_console', label: 'Console de jeux', type: 'checkbox' },
      { key: 'has_board_games', label: 'Jeux de société', type: 'checkbox' },
      { key: 'has_books', label: 'Bibliothèque / Livres', type: 'checkbox' },
      { key: 'has_sound_system', label: 'Système audio', type: 'checkbox' },
      { key: 'has_projector', label: 'Vidéoprojecteur', type: 'checkbox' },
      { key: 'has_smart_home', label: 'Maison connectée', type: 'checkbox' },
      { key: 'cable_channels', label: 'Chaînes TV / Streaming', type: 'text', span: 2 },
    ],
  },
  {
    id: 'security-detail',
    title: 'Sécurité (détails)',
    fields: [
      { key: 'has_bedroom_lock', label: 'Verrou sur chambre', type: 'checkbox' },
      { key: 'has_safe', label: 'Coffre-fort', type: 'checkbox' },
      { key: 'has_exterior_camera', label: 'Caméra extérieure', type: 'checkbox' },
      { key: 'has_alarm', label: 'Système d\u2019alarme', type: 'checkbox' },
      { key: 'emergency_numbers', label: 'Numéros d\u2019urgence', type: 'textarea', span: 2 },
      { key: 'fire_escape', label: 'Issue de secours', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'children',
    title: 'Enfants & Bébés',
    fields: [
      { key: 'has_baby_crib', label: 'Lit bébé', type: 'checkbox' },
      { key: 'has_baby_highchair', label: 'Chaise haute', type: 'checkbox' },
      { key: 'has_child_safe', label: 'Protections sécurité enfants', type: 'checkbox' },
      { key: 'has_toys', label: 'Jouets', type: 'checkbox' },
      { key: 'has_baby_bath', label: 'Baignoire bébé', type: 'checkbox' },
    ],
  },
  {
    id: 'rules',
    title: 'Règles de la maison',
    fields: [
      { key: 'allows_pets', label: 'Animaux acceptés', type: 'checkbox' },
      { key: 'allows_smoking', label: 'Fumeurs autorisés', type: 'checkbox' },
      { key: 'allows_events', label: 'Événements autorisés', type: 'checkbox' },
      { key: 'has_shoes_off', label: 'Chaussures à enlever', type: 'checkbox' },
      { key: 'has_id_required', label: 'Pièce d\u2019identité requise', type: 'checkbox' },
      { key: 'quiet_hours', label: 'Heures calmes', type: 'text' },
      { key: 'age_minimum', label: 'Âge minimum', type: 'text' },
      { key: 'min_stay', label: 'Séjour minimum', type: 'text' },
      { key: 'max_stay', label: 'Séjour maximum', type: 'text' },
      { key: 'cancellation_policy', label: 'Politique d\u2019annulation', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'flexible', label: 'Flexible' },
        { value: 'moderate', label: 'Modérée' },
        { value: 'strict', label: 'Stricte' },
      ] },
      { key: 'smoking_area', label: 'Zone fumeur', type: 'text' },
      { key: 'trash_instructions', label: 'Instructions poubelles / tri', type: 'textarea', span: 2 },
      { key: 'pet_fee', label: 'Frais animaux', type: 'text' },
      { key: 'pet_size_limit', label: 'Limite taille/poids animaux', type: 'text' },
      { key: 'pet_rules', label: 'Règles animaux', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'payments',
    title: 'Tarifs, Caution & Paiements',
    fields: [
      { key: 'has_deposit_required', label: 'Caution obligatoire', type: 'checkbox' },
      { key: 'deposit_amount', label: 'Montant de la caution', type: 'text' },
      { key: 'deposit_method', label: 'Méthode de collecte', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'card_hold', label: 'Empreinte carte bancaire' },
        { value: 'transfer', label: 'Virement' },
        { value: 'cash', label: 'Espèces' },
        { value: 'platform', label: 'Plateforme (Airbnb/Booking)' },
      ] },
      { key: 'deposit_refund_delay', label: 'Délai de remboursement', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: '24h', label: '24 heures' },
        { value: '48h', label: '48 heures' },
        { value: '7d', label: '7 jours' },
        { value: '14d', label: '14 jours' },
      ] },
      { key: 'deposit_covers', label: 'Ce que couvre la caution', type: 'text' },
      { key: 'has_price_per_guest', label: 'Prix augmente selon voyageurs', type: 'checkbox' },
      { key: 'extra_guest_threshold', label: 'À partir de combien de personnes', type: 'text' },
      { key: 'price_extra_guest_amount', label: 'Supplément par voyageur', type: 'text' },
      { key: 'extra_guest_fee', label: 'Frais voyageur supplémentaire', type: 'text' },
      { key: 'has_tourist_tax', label: 'Taxe de séjour', type: 'checkbox' },
      { key: 'tourist_tax_amount', label: 'Montant taxe de séjour', type: 'text' },
      { key: 'has_cleaning_fee_included', label: 'Frais de ménage inclus', type: 'checkbox' },
      { key: 'payment_extras_method', label: 'Paiement des extras', type: 'text' },
      { key: 'security_deposit', label: 'Dépôt de garantie (notes)', type: 'text' },
      { key: 'payment_notes', label: 'Notes paiement / tarification', type: 'textarea', span: 2 },
    ],
  },
  {
    id: 'host',
    title: 'Informations hôte',
    fields: [
      { key: 'host_name', label: 'Nom / Prénom', type: 'text' },
      { key: 'host_languages', label: 'Langues parlées', type: 'text' },
      { key: 'host_lives', label: 'Localisation hôte', type: 'select', options: [
        { value: '', label: 'Non renseigné' },
        { value: 'on-site', label: 'Sur place' },
        { value: 'nearby', label: 'À proximité' },
        { value: 'remote', label: 'À distance' },
      ] },
      { key: 'host_response_time', label: 'Temps de réponse habituel', type: 'text' },
      { key: 'cohost_name', label: 'Co-hôte / Contact', type: 'text' },
      { key: 'cohost_phone', label: 'Téléphone de contact', type: 'text' },
    ],
  },
  {
    id: 'faq',
    title: 'FAQ personnalisées',
    fields: [
      { key: 'custom_faq', label: 'Questions fréquentes & réponses', type: 'textarea', span: 2, hint: 'L\u2019IA utilisera ces réponses exactes en priorité.' },
    ],
  },
];

export const BASE_FIELD_DEFAULTS = {
  name: '',
  property_type: '',
  bedrooms: '',
  beds: '',
  bathrooms: '',
  max_guests: '',
  city: '',
  country: '',
  address: '',
  description: '',
  house_rules: '',
  auto_reply_enabled: false,
  reply_tone: 'professional',
};

export function buildEmptyFormData() {
  const data = { ...BASE_FIELD_DEFAULTS };
  for (const group of FIELD_GROUPS) {
    for (const f of group.fields) {
      data[f.key] = f.type === 'checkbox' ? false : '';
    }
  }
  for (const group of AMENITY_GROUPS) {
    for (const f of group.fields) {
      data[f.key] = false;
    }
  }
  return data;
}

// Flattens a property record (DB columns + parsed context_json, or raw
// Airbnb-import data) into the form's flat value map, coercing booleans
// (SQLite can return 0/1 for BOOLEAN columns depending on the driver).
export function normalizePropertyIntoFormData(source = {}) {
  const empty = buildEmptyFormData();
  const merged = { ...empty };
  for (const key of Object.keys(empty)) {
    if (source[key] === undefined || source[key] === null) continue;
    merged[key] = typeof empty[key] === 'boolean' ? !!source[key] : source[key];
  }
  return merged;
}


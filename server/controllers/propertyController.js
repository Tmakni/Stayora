const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const { isPlaceholderName } = require('../services/airbnbListingResolver');

/**
 * Does this DB error mean "a row with these unique values already exists"?
 * Covers SQLite (SQLITE_CONSTRAINT_UNIQUE) and MySQL (ER_DUP_ENTRY / 1062).
 *
 * Needed because the SELECT-then-INSERT duplicate check is a TOCTOU race: two
 * simultaneous imports of the same listing both see "not present" and both
 * insert. Migration 016 makes the database the authority; this turns the
 * resulting constraint error back into the same friendly 409 the pre-check
 * returns, instead of a 500.
 */
function isUniqueViolation(err) {
  const message = String(err && err.message || '');
  return (
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'ER_DUP_ENTRY' ||
    err?.errno === 1062 ||
    /UNIQUE constraint failed|Duplicate entry/i.test(message)
  );
}

// Champs stockés uniquement dans context_json (pas de colonnes DB)
const CONTEXT_ONLY_FIELDS = [
  'check_in_time', 'check_out_time', 'wifi_name', 'wifi_password', 'access_code',
  'parking_info', 'nearby', 'early_checkin', 'late_checkout',
  'checkin_method', 'key_location', 'building_entry', 'floor_number', 'has_elevator',
  'gate_code', 'luggage_storage', 'checkout_instructions',
  'wifi_speed', 'mobile_coverage', 'has_ethernet',
  'nearest_airport', 'airport_transfer', 'nearest_train', 'nearest_metro_bus',
  'has_taxi_uber', 'parking_type', 'paid_parking', 'has_ev_charging',
  'neighborhood_name', 'distance_center', 'distance_beach', 'distance_ski',
  'nearest_supermarket', 'nearest_restaurant', 'nearest_pharmacy',
  'nearest_hospital', 'nearest_atm', 'nearest_bakery',
  'has_oven', 'stove_type', 'has_toaster', 'has_kettle', 'has_blender',
  'has_basic_condiments', 'kitchen_equipment_details', 'drinking_water',
  'has_breakfast', 'breakfast_details',
  'bed_types', 'has_extra_bed', 'extra_bed_fee', 'has_blackout_curtains',
  'has_linen', 'linen_change', 'has_baby_crib', 'has_baby_highchair', 'has_children_bed',
  'shower_type', 'hot_water_type', 'hot_water_instructions',
  'has_toiletries', 'has_towels', 'towel_change', 'has_bidet', 'second_bathroom_details',
  'washing_instructions', 'dryer_instructions', 'has_cleaning_products',
  'has_vacuum', 'has_iron_board', 'cleaning_fee', 'cleaning_frequency',
  'pool_type', 'pool_hours', 'has_pool_heated', 'has_jacuzzi', 'jacuzzi_availability', 'jacuzzi_notes',
  'has_beach_access', 'has_beach_towels', 'has_outdoor_furniture',
  'has_outdoor_dining', 'has_private_entrance', 'has_bike_storage',
  'has_bikes', 'bikes_details', 'outdoor_other',
  'has_game_console', 'has_board_games', 'has_books',
  'has_sound_system', 'has_projector', 'cable_channels', 'has_smart_home',
  'has_bedroom_lock', 'has_safe', 'has_exterior_camera',
  'has_alarm', 'emergency_numbers', 'fire_escape',
  'pet_fee', 'pet_size_limit', 'pet_rules',
  'has_child_safe', 'has_toys', 'has_baby_bath',
  'quiet_hours', 'has_shoes_off', 'trash_instructions',
  'smoking_area', 'extra_guest_fee', 'extra_guest_threshold', 'security_deposit',
  'has_deposit_required', 'deposit_amount', 'deposit_method', 'deposit_refund_delay',
  'deposit_covers', 'has_price_per_guest', 'price_extra_guest_amount',
  'has_tourist_tax', 'tourist_tax_amount', 'has_cleaning_fee_included',
  'payment_extras_method', 'payment_notes',
  'cancellation_policy', 'min_stay', 'max_stay',
  'has_id_required', 'age_minimum',
  'host_name', 'host_languages', 'host_response_time',
  'cohost_name', 'cohost_phone', 'host_lives',
  'custom_faq'
];

/**
 * Construit le context_json avec toutes les infos dont l'IA a besoin pour répondre aux voyageurs.
 */
function buildContextData(f) {
  const amenityList = [];
  if (f.has_wifi)              amenityList.push('Wi-Fi');
  if (f.has_kitchen)           amenityList.push('Cuisine équipée');
  if (f.has_parking)           amenityList.push('Parking');
  if (f.has_pool)              amenityList.push('Piscine');
  if (f.has_gym)               amenityList.push('Salle de sport');
  if (f.has_tv)                amenityList.push('TV');
  if (f.has_netflix)           amenityList.push('Netflix/Streaming');
  if (f.has_washing_machine)   amenityList.push('Lave-linge');
  if (f.has_dryer)             amenityList.push('Sèche-linge');
  if (f.has_dishwasher)        amenityList.push('Lave-vaisselle');
  if (f.has_air_conditioning)  amenityList.push('Climatisation');
  if (f.has_heating)           amenityList.push('Chauffage');
  if (f.has_workspace)         amenityList.push('Bureau/Espace de travail');
  if (f.has_hair_dryer)        amenityList.push('Sèche-cheveux');
  if (f.has_iron)              amenityList.push('Fer à repasser');
  if (f.has_bathtub)           amenityList.push('Baignoire');
  if (f.has_microwave)         amenityList.push('Micro-ondes');
  if (f.has_refrigerator)      amenityList.push('Réfrigérateur');
  if (f.has_coffee_maker)      amenityList.push('Machine à café');
  if (f.has_bbq)               amenityList.push('Barbecue');
  if (f.has_terrace)           amenityList.push('Terrasse/Balcon');
  if (f.has_garden)            amenityList.push('Jardin');
  if (f.has_fireplace)         amenityList.push('Cheminée');
  if (f.has_smoke_detector)    amenityList.push('Détecteur de fumée');
  if (f.has_carbon_monoxide_detector) amenityList.push('Détecteur CO');
  if (f.has_fire_extinguisher) amenityList.push('Extincteur');
  if (f.has_first_aid_kit)     amenityList.push('Trousse de secours');

  const rulesList = [];
  if (f.allows_pets !== undefined)    rulesList.push(f.allows_pets    ? 'Animaux acceptés' : 'Animaux non autorisés');
  if (f.allows_smoking !== undefined) rulesList.push(f.allows_smoking ? 'Fumeurs OK'       : 'Non-fumeur');
  if (f.allows_events !== undefined)  rulesList.push(f.allows_events  ? 'Événements OK'    : 'Pas d\'événements');
  if (f.has_shoes_off) rulesList.push('Chaussures à enlever');
  if (f.has_id_required) rulesList.push('Pièce d\'identité requise');

  const kitchenExtras = [];
  if (f.has_oven) kitchenExtras.push('Four');
  if (f.has_toaster) kitchenExtras.push('Grille-pain');
  if (f.has_kettle) kitchenExtras.push('Bouilloire');
  if (f.has_blender) kitchenExtras.push('Mixeur/Blender');
  if (f.has_basic_condiments) kitchenExtras.push('Condiments de base (sel, poivre, huile)');

  const bedroomExtras = [];
  if (f.has_extra_bed) bedroomExtras.push('Lit supplémentaire disponible');
  if (f.has_blackout_curtains) bedroomExtras.push('Rideaux occultants');
  if (f.has_linen) bedroomExtras.push('Linge de lit fourni');

  const bathroomExtras = [];
  if (f.has_toiletries) bathroomExtras.push('Produits de toilette fournis');
  if (f.has_towels) bathroomExtras.push('Serviettes fournies');
  if (f.has_bidet) bathroomExtras.push('Bidet');

  const outdoorExtras = [];
  if (f.has_pool_heated) outdoorExtras.push('Piscine chauffée');
  if (f.has_jacuzzi) outdoorExtras.push('Jacuzzi/Spa');
  if (f.has_beach_access) outdoorExtras.push('Accès plage');
  if (f.has_beach_towels) outdoorExtras.push('Serviettes de plage');
  if (f.has_outdoor_furniture) outdoorExtras.push('Mobilier extérieur');
  if (f.has_outdoor_dining) outdoorExtras.push('Coin repas extérieur');
  if (f.has_private_entrance) outdoorExtras.push('Entrée privée');
  if (f.has_bike_storage) outdoorExtras.push('Local vélos');
  if (f.has_bikes) outdoorExtras.push('Vélos disponibles');

  const entertainmentExtras = [];
  if (f.has_game_console) entertainmentExtras.push('Console de jeux');
  if (f.has_board_games) entertainmentExtras.push('Jeux de société');
  if (f.has_books) entertainmentExtras.push('Bibliothèque/Livres');
  if (f.has_sound_system) entertainmentExtras.push('Système audio/Enceinte');
  if (f.has_projector) entertainmentExtras.push('Vidéoprojecteur');
  if (f.has_smart_home) entertainmentExtras.push('Maison connectée');

  const securityExtras = [];
  if (f.has_bedroom_lock) securityExtras.push('Verrou sur chambre');
  if (f.has_safe) securityExtras.push('Coffre-fort');
  if (f.has_exterior_camera) securityExtras.push('Caméra extérieure');
  if (f.has_alarm) securityExtras.push('Système d\'alarme');

  const childrenExtras = [];
  if (f.has_baby_crib) childrenExtras.push('Lit bébé');
  if (f.has_baby_highchair) childrenExtras.push('Chaise haute bébé');
  if (f.has_children_bed) childrenExtras.push('Lit enfant');
  if (f.has_child_safe) childrenExtras.push('Protections sécurité enfants');
  if (f.has_toys) childrenExtras.push('Jouets');
  if (f.has_baby_bath) childrenExtras.push('Baignoire bébé');

  const cleaningExtras = [];
  if (f.has_cleaning_products) cleaningExtras.push('Produits ménagers fournis');
  if (f.has_vacuum) cleaningExtras.push('Aspirateur');
  if (f.has_iron_board) cleaningExtras.push('Table à repasser');

  return {
    name:           f.name,
    property_type:  f.property_type,
    bedrooms:       f.bedrooms,
    beds:           f.beds,
    bathrooms:      f.bathrooms,
    max_guests:     f.max_guests,
    // Infos pratiques pour les réponses IA
    check_in_time:  f.check_in_time  || '',
    check_out_time: f.check_out_time || '',
    wifi_name:      f.wifi_name      || '',
    wifi_password:  f.wifi_password  || '',
    access_code:    f.access_code    || '',
    parking:        f.parking_info   || f.parking   || '',
    nearby:         f.nearby         || '',
    early_checkin:  f.early_checkin  || '',
    late_checkout:  f.late_checkout  || '',
    // Listes lisibles pour l'IA
    amenities: amenityList.join(', '),
    rules:     [f.house_rules || '', rulesList.join(', ')].filter(Boolean).join(' — '),
    // Données brutes conservées pour usage futur
    amenities_detail: {
      wifi: !!f.has_wifi, kitchen: !!f.has_kitchen, parking: !!f.has_parking,
      pool: !!f.has_pool, gym: !!f.has_gym, tv: !!f.has_tv,
      washing_machine: !!f.has_washing_machine, air_conditioning: !!f.has_air_conditioning,
      heating: !!f.has_heating, workspace: !!f.has_workspace,
      hair_dryer: !!f.has_hair_dryer, iron: !!f.has_iron, bathtub: !!f.has_bathtub,
      dryer: !!f.has_dryer, dishwasher: !!f.has_dishwasher, microwave: !!f.has_microwave,
      refrigerator: !!f.has_refrigerator, coffee_maker: !!f.has_coffee_maker,
      smoke_detector: !!f.has_smoke_detector, carbon_monoxide_detector: !!f.has_carbon_monoxide_detector,
      fire_extinguisher: !!f.has_fire_extinguisher, first_aid_kit: !!f.has_first_aid_kit,
      bbq: !!f.has_bbq, terrace: !!f.has_terrace, garden: !!f.has_garden,
      netflix: !!f.has_netflix, fireplace: !!f.has_fireplace
    },
    rules_detail: {
      pets: !!f.allows_pets, smoking: !!f.allows_smoking, events: !!f.allows_events
    },
    address:     f.address     || '',
    description: f.description || '',
    house_rules: f.house_rules || '',
    ...(f.airbnb_listing_id ? { airbnb_listing_id: f.airbnb_listing_id } : {}),
    // Arrivée & Accès
    checkin_method:       f.checkin_method       || '',
    key_location:         f.key_location         || '',
    building_entry:       f.building_entry       || '',
    floor_number:         f.floor_number         || '',
    has_elevator:         !!f.has_elevator,
    gate_code:            f.gate_code            || '',
    luggage_storage:      f.luggage_storage      || '',
    checkout_instructions: f.checkout_instructions || '',
    // WiFi étendu
    wifi_speed:           f.wifi_speed           || '',
    mobile_coverage:      f.mobile_coverage      || '',
    has_ethernet:         !!f.has_ethernet,
    // Transport & Localisation
    nearest_airport:      f.nearest_airport      || '',
    airport_transfer:     f.airport_transfer     || '',
    nearest_train:        f.nearest_train        || '',
    nearest_metro_bus:    f.nearest_metro_bus    || '',
    has_taxi_uber:        !!f.has_taxi_uber,
    parking_type:         f.parking_type         || '',
    paid_parking:         f.paid_parking         || '',
    has_ev_charging:      !!f.has_ev_charging,
    neighborhood_name:    f.neighborhood_name    || '',
    distance_center:      f.distance_center      || '',
    distance_beach:       f.distance_beach       || '',
    distance_ski:         f.distance_ski         || '',
    // Commerces & Services
    nearest_supermarket:  f.nearest_supermarket  || '',
    nearest_restaurant:   f.nearest_restaurant   || '',
    nearest_pharmacy:     f.nearest_pharmacy     || '',
    nearest_hospital:     f.nearest_hospital     || '',
    nearest_atm:          f.nearest_atm          || '',
    nearest_bakery:       f.nearest_bakery       || '',
    // Cuisine détaillée
    kitchen_extras:      kitchenExtras.join(', '),
    has_oven:            !!f.has_oven,
    stove_type:          f.stove_type           || '',
    has_toaster:         !!f.has_toaster,
    has_kettle:          !!f.has_kettle,
    has_blender:         !!f.has_blender,
    has_basic_condiments: !!f.has_basic_condiments,
    kitchen_equipment_details: f.kitchen_equipment_details || '',
    drinking_water:      f.drinking_water       || '',
    has_breakfast:       !!f.has_breakfast,
    breakfast_details:   f.breakfast_details    || '',
    // Chambres & Literie
    bedroom_extras:      bedroomExtras.join(', '),
    bed_types:           f.bed_types            || '',
    has_extra_bed:       !!f.has_extra_bed,
    extra_bed_fee:       f.extra_bed_fee        || '',
    has_blackout_curtains: !!f.has_blackout_curtains,
    has_linen:           !!f.has_linen,
    linen_change:        f.linen_change         || '',
    has_baby_crib:       !!f.has_baby_crib,
    has_baby_highchair:  !!f.has_baby_highchair,
    has_children_bed:    !!f.has_children_bed,
    // Salle de bain
    bathroom_extras:     bathroomExtras.join(', '),
    shower_type:         f.shower_type          || '',
    hot_water_type:      f.hot_water_type       || '',
    hot_water_instructions: f.hot_water_instructions || '',
    has_toiletries:      !!f.has_toiletries,
    has_towels:          !!f.has_towels,
    towel_change:        f.towel_change         || '',
    has_bidet:           !!f.has_bidet,
    second_bathroom_details: f.second_bathroom_details || '',
    // Ménage & Linge
    cleaning_extras:     cleaningExtras.join(', '),
    washing_instructions: f.washing_instructions || '',
    dryer_instructions:  f.dryer_instructions   || '',
    has_cleaning_products: !!f.has_cleaning_products,
    has_vacuum:          !!f.has_vacuum,
    has_iron_board:      !!f.has_iron_board,
    cleaning_fee:        f.cleaning_fee         || '',
    cleaning_frequency:  f.cleaning_frequency   || '',
    // Extérieur étendu
    outdoor_extras:      outdoorExtras.join(', '),
    pool_type:           f.pool_type            || '',
    pool_hours:          f.pool_hours           || '',
    has_pool_heated:     !!f.has_pool_heated,
    has_jacuzzi:         !!f.has_jacuzzi,
    jacuzzi_availability: f.jacuzzi_availability || '',
    jacuzzi_notes:       f.jacuzzi_notes        || '',
    has_beach_access:    !!f.has_beach_access,
    has_beach_towels:    !!f.has_beach_towels,
    has_outdoor_furniture: !!f.has_outdoor_furniture,
    has_outdoor_dining:  !!f.has_outdoor_dining,
    has_private_entrance: !!f.has_private_entrance,
    has_bike_storage:    !!f.has_bike_storage,
    has_bikes:           !!f.has_bikes,
    bikes_details:       f.bikes_details        || '',
    outdoor_other:       f.outdoor_other        || '',
    // Divertissement étendu
    entertainment_extras: entertainmentExtras.join(', '),
    has_game_console:    !!f.has_game_console,
    has_board_games:     !!f.has_board_games,
    has_books:           !!f.has_books,
    has_sound_system:    !!f.has_sound_system,
    has_projector:       !!f.has_projector,
    cable_channels:      f.cable_channels       || '',
    has_smart_home:      !!f.has_smart_home,
    // Sécurité étendue
    security_extras:     securityExtras.join(', '),
    has_bedroom_lock:    !!f.has_bedroom_lock,
    has_safe:            !!f.has_safe,
    has_exterior_camera: !!f.has_exterior_camera,
    has_alarm:           !!f.has_alarm,
    emergency_numbers:   f.emergency_numbers    || '',
    fire_escape:         f.fire_escape          || '',
    // Enfants & Bébés
    children_extras:     childrenExtras.join(', '),
    has_child_safe:      !!f.has_child_safe,
    has_toys:            !!f.has_toys,
    has_baby_bath:       !!f.has_baby_bath,
    // Animaux détails
    pet_fee:             f.pet_fee              || '',
    pet_size_limit:      f.pet_size_limit       || '',
    pet_rules:           f.pet_rules            || '',
    // Tarifs, Caution & Paiements
    has_deposit_required: !!f.has_deposit_required,
    deposit_amount:      f.deposit_amount       || '',
    deposit_method:      f.deposit_method       || '',
    deposit_refund_delay: f.deposit_refund_delay || '',
    deposit_covers:      f.deposit_covers       || '',
    has_price_per_guest: !!f.has_price_per_guest,
    extra_guest_threshold: f.extra_guest_threshold || '',
    price_extra_guest_amount: f.price_extra_guest_amount || '',
    has_tourist_tax:     !!f.has_tourist_tax,
    tourist_tax_amount:  f.tourist_tax_amount   || '',
    has_cleaning_fee_included: !!f.has_cleaning_fee_included,
    payment_extras_method: f.payment_extras_method || '',
    payment_notes:       f.payment_notes        || '',
    // Règles détaillées
    quiet_hours:         f.quiet_hours          || '',
    has_shoes_off:       !!f.has_shoes_off,
    trash_instructions:  f.trash_instructions   || '',
    smoking_area:        f.smoking_area         || '',
    extra_guest_fee:     f.extra_guest_fee      || '',
    security_deposit:    f.security_deposit     || '',
    cancellation_policy: f.cancellation_policy  || '',
    min_stay:            f.min_stay             || '',
    max_stay:            f.max_stay             || '',
    has_id_required:     !!f.has_id_required,
    age_minimum:         f.age_minimum          || '',
    // Info hôte
    host_name:           f.host_name            || '',
    host_languages:      f.host_languages       || '',
    host_response_time:  f.host_response_time   || '',
    cohost_name:         f.cohost_name          || '',
    cohost_phone:        f.cohost_phone         || '',
    host_lives:          f.host_lives           || '',
    // FAQ personnalisées
    custom_faq:          f.custom_faq           || ''
  };
}


async function createProperty(req, res) {
  try {
    const userId = req.userId;
    
    const db = getDatabase();
    
    const {
      name,
      property_type,
      bedrooms,
      beds,
      bathrooms,
      max_guests,
      // Infos pratiques (pour les réponses IA)
      check_in_time,
      check_out_time,
      wifi_name,
      wifi_password,
      access_code,
      parking_info,
      nearby,
      early_checkin,
      late_checkout,
      // Équipements
      has_wifi,
      has_kitchen,
      has_parking,
      has_pool,
      has_gym,
      has_tv,
      has_washing_machine,
      has_air_conditioning,
      has_heating,
      has_workspace,
      has_hair_dryer,
      has_iron,
      // Salle de bain
      has_bathtub,
      // Chambre & linge
      has_dryer,
      // Cuisine
      has_dishwasher,
      has_microwave,
      has_refrigerator,
      has_coffee_maker,
      // Sécurité
      has_smoke_detector,
      has_carbon_monoxide_detector,
      has_fire_extinguisher,
      has_first_aid_kit,
      // Extérieur
      has_bbq,
      has_terrace,
      has_garden,
      // Divertissement
      has_netflix,
      has_fireplace,
      // Règles
      allows_pets,
      allows_smoking,
      allows_events,
      // Informations supplémentaires
      address,
      description,
      house_rules,
      // Auto-reply settings
      auto_reply_enabled,
      reply_tone,
      // Import Airbnb
      airbnb_listing_id,
      source,
      source_url,
      city,
      country,
      photos
    } = req.body;

    // Validation des champs obligatoires
    if (!name || !property_type || !bedrooms || !beds || !bathrooms || !max_guests) {
      return res.status(400).json({
        error: 'Les champs nom, type de propriété, chambres, lits, salles de bain et nombre maximum d\'invités sont obligatoires'
      });
    }

    // Refuse the auto-generated placeholder names ("Logement Airbnb #<id>",
    // a bare listing id, the literal "Airbnb"). This is the endpoint the import
    // flow actually saves through, so it is where the guarantee has to hold —
    // a stale client must not be able to persist a placeholder.
    if (isPlaceholderName(name, airbnb_listing_id)) {
      return res.status(400).json({
        error: "Merci de saisir le vrai nom du logement (un nom automatique n'est pas accepté).",
        needs_name_confirmation: true,
      });
    }

    // Anti-doublon Airbnb : même user, même listing_id
    if (airbnb_listing_id) {
      const existing = await db.query(
        'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ? LIMIT 1',
        [userId, String(airbnb_listing_id)]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          alreadyExists: true,
          existingId: existing[0].id,
          message: 'Ce logement Airbnb existe déjà sur votre compte.'
        });
      }
    }

    // Récupérer tous les champs context-only depuis le body
    const contextFields = {};
    for (const key of CONTEXT_ONLY_FIELDS) {
      if (req.body[key] !== undefined) contextFields[key] = req.body[key];
    }

    const contextData = buildContextData({
      name, property_type, bedrooms, beds, bathrooms, max_guests,
      has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
      has_washing_machine, has_air_conditioning, has_heating, has_workspace,
      has_hair_dryer, has_iron, has_bathtub, has_dryer, has_dishwasher,
      has_microwave, has_refrigerator, has_coffee_maker, has_smoke_detector,
      has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
      has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
      allows_pets, allows_smoking, allows_events,
      address, description, house_rules, airbnb_listing_id,
      ...contextFields
    });

    const query = `
      INSERT INTO property_profiles (
        user_id, name, property_type, bedrooms, beds, bathrooms, max_guests,
        has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
        has_washing_machine, has_air_conditioning, has_heating, has_workspace,
        has_hair_dryer, has_iron,
        has_bathtub, has_dryer, has_dishwasher, has_microwave, has_refrigerator, has_coffee_maker,
        has_smoke_detector, has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
        has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
        allows_pets, allows_smoking, allows_events,
        address, description, house_rules, auto_reply_enabled, reply_tone, context_json,
        source, source_url, airbnb_listing_id, city, country, main_photo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Determine main photo URL for quick display
    const mainPhoto = Array.isArray(photos) ? photos.find(p => p.is_main) || photos[0] : null;
    const mainPhotoUrl = mainPhoto ? (mainPhoto.url || null) : null;

    const result = await db.query(query, [
      userId, name, property_type, bedrooms, beds, bathrooms, max_guests,
      !!has_wifi, !!has_kitchen, !!has_parking, !!has_pool, !!has_gym, !!has_tv,
      !!has_washing_machine, !!has_air_conditioning, !!has_heating, !!has_workspace,
      !!has_hair_dryer, !!has_iron,
      !!has_bathtub, !!has_dryer, !!has_dishwasher, !!has_microwave, !!has_refrigerator, !!has_coffee_maker,
      !!has_smoke_detector, !!has_carbon_monoxide_detector, !!has_fire_extinguisher, !!has_first_aid_kit,
      !!has_bbq, !!has_terrace, !!has_garden, !!has_netflix, !!has_fireplace,
      !!allows_pets, !!allows_smoking, !!allows_events,
      address || null, description || null, house_rules || null,
      !!auto_reply_enabled, reply_tone || 'professional',
      JSON.stringify(contextData),
      source || null, source_url || null,
      airbnb_listing_id ? String(airbnb_listing_id) : null,
      city || null, country || null, mainPhotoUrl
    ]);

    // Record whether this name is the user's or came from the import.
    // Only a name the user typed/confirmed is protected from a later re-scan
    // (see airbnbImportController.updateFromAirbnb).
    if (result.insertId) {
      const nameSource = (req.body.name_confirmed_by_user || !airbnb_listing_id) ? 'manual' : 'airbnb_auto';
      await db.query(
        'UPDATE property_profiles SET name_source = ? WHERE id = ? AND user_id = ?',
        [nameSource, result.insertId, userId]
      );
    }

    // Save imported photos
    if (Array.isArray(photos) && photos.length > 0 && result.insertId) {
      const propId = result.insertId;
      for (const photo of photos.slice(0, 25)) {
        if (!photo.url) continue;
        await db.query(
          `INSERT INTO property_photos (property_id, user_id, source, source_url, image_url, position, alt, is_main)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            propId, userId,
            photo.source || 'airbnb',
            photo.url,
            photo.url,
            photo.position != null ? photo.position : 0,
            photo.alt || '',
            photo.is_main ? 1 : 0
          ]
        );
      }
    }

    logger.info(`Property created: ${result ? result.insertId : 'NO_RESULT'} by user ${userId}`);

    res.status(201).json({
      message: 'Propriété créée avec succès',
      property: {
        id: result.insertId,
        name,
        property_type,
        bedrooms,
        beds,
        bathrooms,
        max_guests
      }
    });
  } catch (error) {
    // Lost the race against a simultaneous import of the same listing — the
    // unique index (migration 016) rejected the second insert. Report the same
    // "already exists" outcome the pre-check would have given, pointing at the
    // row that did win, rather than a 500.
    if (isUniqueViolation(error)) {
      try {
        const existing = await getDatabase().query(
          'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ? LIMIT 1',
          [req.userId, String(req.body?.airbnb_listing_id || '')]
        );
        logger.info(`Concurrent import of listing ${req.body?.airbnb_listing_id} for user ${req.userId} — kept existing property`);
        return res.status(409).json({
          alreadyExists: true,
          existingId: existing[0]?.id,
          message: 'Ce logement Airbnb existe déjà sur votre compte.',
        });
      } catch (_) {
        // fall through to the generic error below
      }
    }
    logger.error('Error creating property:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la propriété' });
  }
}

/**
 * Récupérer toutes les propriétés de l'utilisateur
 */
async function getProperties(req, res) {
  try {
    const userId = req.userId;
    const db = getDatabase();

    // Pagination optionnelle (rétrocompatible) : mêmes bornes que
    // conversationController.getConversations. Le client n'envoie
    // actuellement pas ces paramètres, donc par défaut on renvoie
    // jusqu'à `limit` (largement au-dessus du nombre de logements
    // réel d'un hôte) plutôt que de casser la forme de réponse actuelle
    // (un simple tableau, pas { properties: [...] }).
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = parseInt(req.query.offset) || 0;

    const query = `
      SELECT id, name, property_type, bedrooms, beds, bathrooms, max_guests,
             has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
             has_washing_machine, has_air_conditioning, has_heating, has_workspace,
             has_hair_dryer, has_iron,
             has_bathtub, has_dryer, has_dishwasher, has_microwave, has_refrigerator, has_coffee_maker,
             has_smoke_detector, has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
             has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
             allows_pets, allows_smoking, allows_events,
             address, description, house_rules, auto_reply_enabled, reply_tone,
             city, country, main_photo_url, source, airbnb_listing_id,
             created_at, updated_at
      FROM property_profiles
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const properties = await db.query(query, [userId, limit, offset]);

    res.json(properties);
  } catch (error) {
    logger.error('Error fetching properties:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des propriétés' });
  }
}

/**
 * Récupérer une propriété spécifique
 */
async function getPropertyById(req, res) {
  try {
    const userId = req.userId;
    const propertyId = req.params.id;
    const db = getDatabase();

    const query = `
      SELECT id, name, property_type, bedrooms, beds, bathrooms, max_guests,
             has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
             has_washing_machine, has_air_conditioning, has_heating, has_workspace,
             has_hair_dryer, has_iron,
             has_bathtub, has_dryer, has_dishwasher, has_microwave, has_refrigerator, has_coffee_maker,
             has_smoke_detector, has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
             has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
             allows_pets, allows_smoking, allows_events,
             address, description, house_rules, context_json,
             city, country, main_photo_url, source, source_url, airbnb_listing_id, auto_reply_enabled, reply_tone,
             created_at, updated_at
      FROM property_profiles
      WHERE id = ? AND user_id = ?
    `;

    const properties = await db.query(query, [propertyId, userId]);

    if (properties.length === 0) {
      return res.status(404).json({ error: 'Propriété non trouvée' });
    }

    res.json(properties[0]);
  } catch (error) {
    logger.error('Error fetching property:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la propriété' });
  }
}

/**
 * Mettre à jour une propriété
 */
async function updateProperty(req, res) {
  try {
    const userId = req.userId;
    const propertyId = req.params.id;
    const updates = req.body;
    const db = getDatabase();

    // Récupérer toute la propriété existante pour pouvoir rebuilder context_json
    const existing = await db.query(
      'SELECT * FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Propriété non trouvée' });
    }

    const current = existing[0];

    // Récupérer les infos pratiques stockées dans context_json
    let currentCtx = {};
    try { currentCtx = JSON.parse(current.context_json || '{}'); } catch (_) {}

    // Colonnes DB directement mettables à jour
    const allowedFields = [
      'name', 'property_type', 'bedrooms', 'beds', 'bathrooms', 'max_guests',
      'has_wifi', 'has_kitchen', 'has_parking', 'has_pool', 'has_gym', 'has_tv',
      'has_washing_machine', 'has_air_conditioning', 'has_heating', 'has_workspace',
      'has_hair_dryer', 'has_iron',
      'has_bathtub', 'has_dryer', 'has_dishwasher', 'has_microwave', 'has_refrigerator', 'has_coffee_maker',
      'has_smoke_detector', 'has_carbon_monoxide_detector', 'has_fire_extinguisher', 'has_first_aid_kit',
      'has_bbq', 'has_terrace', 'has_garden', 'has_netflix', 'has_fireplace',
      'allows_pets', 'allows_smoking', 'allows_events',
      'address', 'description', 'house_rules', 'auto_reply_enabled', 'reply_tone',
      'superhot_listing_id', 'city', 'country'
    ];

    const updateFields = [];
    const values = [];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = ?`);
        values.push(updates[field]);
      }
    }

    // Renaming by hand claims the name: a later "mettre à jour depuis Airbnb"
    // must not revert it (see airbnbImportController.updateFromAirbnb).
    if (updates.name !== undefined && String(updates.name).trim() !== String(current.name || '').trim()) {
      updateFields.push('name_source = ?');
      values.push('manual');
    }

    // Construire le contexte fusionné (DB + infos pratiques actuelles + nouvelles valeurs)
    const mergedPractical = {};
    for (const k of CONTEXT_ONLY_FIELDS) {
      if (updates[k] !== undefined) {
        mergedPractical[k] = updates[k];
      } else if (currentCtx[k] !== undefined) {
        mergedPractical[k] = currentCtx[k];
      } else {
        mergedPractical[k] = k.startsWith('has_') ? false : '';
      }
    }

    const mergedFields = {
      ...current,
      ...updates,
      // infos pratiques issues du contexte existant ou des nouvelles valeurs
      parking_info: mergedPractical.parking_info || currentCtx.parking || '',
      ...mergedPractical
    };
    const newContext = buildContextData(mergedFields);
    updateFields.push('context_json = ?');
    values.push(JSON.stringify(newContext));

    if (updateFields.length === 1) {
      // Seul context_json, ok on continue quand même
    }

    values.push(propertyId, userId);

    await db.query(
      `UPDATE property_profiles SET ${updateFields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );

    logger.info(`Property updated: ${propertyId} by user ${userId}`);

    res.json({ message: 'Propriété mise à jour avec succès' });
  } catch (error) {
    logger.error('Error updating property:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la propriété' });
  }
}

/**
 * Supprimer une propriété
 */
async function deleteProperty(req, res) {
  try {
    const userId = req.userId;
    const propertyId = req.params.id;
    const db = getDatabase();

    const result = await db.query(
      'DELETE FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Propriété non trouvée' });
    }

    logger.info(`Property deleted: ${propertyId} by user ${userId}`);

    res.json({ message: 'Propriété supprimée avec succès' });
  } catch (error) {
    logger.error('Error deleting property:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la propriété' });
  }
}

// ---- Calendar / Availability ----

/**
 * GET /api/properties/:id/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns availability blocks + reservations for a property within the date range.
 */
async function getCalendar(req, res) {
  try {
    const { id } = req.params;
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to = req.query.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

    const db = getDatabase();

    // Check ownership
    const props = await db.query('SELECT id FROM property_profiles WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (props.length === 0) return res.status(404).json({ error: 'Propriété non trouvée' });

    // Get manual availability blocks
    const blocks = await db.query(
      `SELECT id, start_date, end_date, reason, guest_name, source, notes, reservation_id
       FROM availability_blocks
       WHERE property_id = ? AND end_date >= ? AND start_date <= ?
       ORDER BY start_date ASC`,
      [id, from, to]
    );

    // Get reservations for this property in the date range
    const reservations = await db.query(
      `SELECT id, guest_name, check_in_date AS start_date, check_out_date AS end_date, status, confirmation_code
       FROM reservations
       WHERE property_id = ? AND check_out_date >= ? AND check_in_date <= ? AND status NOT IN ('cancelled', 'declined')
       ORDER BY check_in_date ASC`,
      [id, from, to]
    );

    // Merge into a unified events list
    const events = [];

    for (const b of blocks) {
      events.push({
        id: 'block_' + b.id,
        start: b.start_date,
        end: b.end_date,
        type: b.reason || 'blocked',
        title: b.guest_name || (b.reason === 'maintenance' ? 'Maintenance' : 'Indisponible'),
        source: b.source,
        notes: b.notes,
        blockId: b.id
      });
    }

    for (const r of reservations) {
      // Skip if there's already a block linked to this reservation
      if (blocks.some(b => b.reservation_id === r.id)) continue;
      events.push({
        id: 'res_' + r.id,
        start: r.start_date,
        end: r.end_date,
        type: 'reservation',
        title: r.guest_name || 'Réservation',
        status: r.status,
        confirmationCode: r.confirmation_code,
        reservationId: r.id
      });
    }

    return res.json({ success: true, events, from, to });
  } catch (error) {
    logger.error('Get calendar error:', error);
    return res.status(500).json({ error: 'Erreur lors du chargement du calendrier' });
  }
}

/**
 * POST /api/properties/:id/calendar
 * Add a new availability block (manual blocking, maintenance, etc.)
 */
async function addCalendarBlock(req, res) {
  try {
    const { id } = req.params;
    const { start_date, end_date, reason, guest_name, notes } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date et end_date requis' });
    }
    if (new Date(end_date) <= new Date(start_date)) {
      return res.status(400).json({ error: 'end_date doit être après start_date' });
    }

    const db = getDatabase();
    const props = await db.query('SELECT id FROM property_profiles WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (props.length === 0) return res.status(404).json({ error: 'Propriété non trouvée' });

    const result = await db.query(
      `INSERT INTO availability_blocks (property_id, user_id, start_date, end_date, reason, guest_name, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [id, req.userId, start_date, end_date, reason || 'blocked', guest_name || null, notes || null]
    );

    logger.info(`Calendar block added for property ${id}: ${start_date} → ${end_date}`);
    return res.status(201).json({ success: true, blockId: result.insertId });
  } catch (error) {
    logger.error('Add calendar block error:', error);
    return res.status(500).json({ error: 'Erreur lors de l\'ajout du blocage' });
  }
}

/**
 * DELETE /api/properties/:id/calendar/:blockId
 */
async function deleteCalendarBlock(req, res) {
  try {
    const { id, blockId } = req.params;
    const db = getDatabase();

    const blocks = await db.query(
      'SELECT id FROM availability_blocks WHERE id = ? AND property_id = ? AND user_id = ?',
      [blockId, id, req.userId]
    );
    if (blocks.length === 0) return res.status(404).json({ error: 'Blocage non trouvé' });

    await db.query('DELETE FROM availability_blocks WHERE id = ?', [blockId]);
    logger.info(`Calendar block ${blockId} deleted for property ${id}`);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Delete calendar block error:', error);
    return res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
}

/**
 * Check availability for a property between two dates.
 * Returns { available: true/false, conflicts: [...] }
 */
async function checkAvailability(propertyId, checkIn, checkOut) {
  const db = getDatabase();

  const conflicts = await db.query(
    `SELECT start_date, end_date, reason, guest_name FROM availability_blocks
     WHERE property_id = ? AND end_date > ? AND start_date < ?`,
    [propertyId, checkIn, checkOut]
  );

  const resConflicts = await db.query(
    `SELECT check_in_date AS start_date, check_out_date AS end_date, guest_name, status FROM reservations
     WHERE property_id = ? AND check_out_date > ? AND check_in_date < ? AND status NOT IN ('cancelled', 'declined')`,
    [propertyId, checkIn, checkOut]
  );

  const allConflicts = [...conflicts, ...resConflicts];
  return { available: allConflicts.length === 0, conflicts: allConflicts };
}

module.exports = {
  createProperty,
  getProperties,
  getPropertyById,
  updateProperty,
  deleteProperty,
  getCalendar,
  addCalendarBlock,
  deleteCalendarBlock,
  checkAvailability
};

/**
 * Codes d'équipement Airbnb → champs Michel.
 *
 * Les codes ci-dessous sont ceux réellement observés dans `listings.json` d'un
 * export de données personnelles Airbnb (94 codes distincts sur 43 annonces),
 * complétés de quelques variantes rencontrées ailleurs. Aucun code n'est
 * inventé : un code inconnu de toutes les tables est simplement ignoré, ce qui
 * vaut mieux que de cocher une case au hasard.
 *
 * Trois destinations possibles :
 *   1. AMENITY_TO_FIELD          — une ou plusieurs cases à cocher de la fiche ;
 *   2. KITCHEN_/LEISURE_DETAIL   — pas de case dédiée, mais un voyageur peut
 *                                  poser la question : le libellé part en texte
 *                                  dans « Détails équipement cuisine » ou
 *                                  « Autres loisirs » ;
 *   3. CHECKIN_METHOD_AMENITIES  — renseigne la méthode d'arrivée.
 */

/**
 * Un code peut cocher plusieurs champs : Airbnb regroupe sous « essentials »
 * ce que la fiche Michel détaille en serviettes et produits de toilette.
 */
const AMENITY_TO_FIELD = {
  // Essentiels
  wireless_internet: ['has_wifi'],
  wifi: ['has_wifi'],
  internet: ['has_wifi'],
  ethernet_connection: ['has_ethernet'],
  kitchen: ['has_kitchen'],
  kitchenette: ['has_kitchen'],
  ac: ['has_air_conditioning'],
  air_conditioning: ['has_air_conditioning'],
  heating: ['has_heating'],
  tv: ['has_tv'],
  cable_tv: ['has_tv'],
  laptop_friendly_workspace: ['has_workspace'],
  dedicated_workspace: ['has_workspace'],
  elevator: ['has_elevator'],
  fireplace: ['has_fireplace'],
  indoor_fireplace: ['has_fireplace'],
  gym: ['has_gym'],

  // Stationnement
  free_parking: ['has_parking'],
  free_parking_on_premises: ['has_parking'],
  paid_parking_on_premises: ['has_parking'],
  street_parking: ['has_parking'],
  free_street_parking: ['has_parking'],
  disabled_parking_spot: ['has_parking'],
  ev_charger: ['has_ev_charging'],

  // Cuisine
  oven: ['has_oven'],
  microwave: ['has_microwave'],
  refrigerator: ['has_refrigerator'],
  mini_fridge: ['has_refrigerator'],
  freezer: ['has_refrigerator'],
  dishwasher: ['has_dishwasher'],
  coffee_maker: ['has_coffee_maker'],
  nespresso_machine: ['has_coffee_maker'],
  coffee: ['has_coffee_maker'],
  toaster: ['has_toaster'],
  hot_water_kettle: ['has_kettle'],
  cooking_basics: ['has_basic_condiments'],

  // Linge et ménage
  washer: ['has_washing_machine'],
  dryer: ['has_dryer'],
  iron: ['has_iron'],
  hair_dryer: ['has_hair_dryer'],
  bed_linens: ['has_linen'],
  cleaning_products: ['has_cleaning_products'],
  room_darkening_shades: ['has_blackout_curtains'],

  // Salle de bain — « essentials » couvre chez Airbnb serviettes, draps,
  // savon et papier toilette.
  essentials: ['has_towels', 'has_toiletries'],
  shampoo: ['has_toiletries'],
  conditioner: ['has_toiletries'],
  body_soap: ['has_toiletries'],
  shower_gel: ['has_toiletries'],
  bathtub: ['has_bathtub'],
  bidet: ['has_bidet'],

  // Extérieur
  pool: ['has_pool'],
  private_pool: ['has_pool'],
  shared_pool: ['has_pool'],
  heated_pool: ['has_pool', 'has_pool_heated'],
  jacuzzi: ['has_jacuzzi'],
  hot_tub: ['has_jacuzzi'],
  bbq_area: ['has_bbq'],
  barbeque_utensils: ['has_bbq'],
  bbq_grill: ['has_bbq'],
  patio: ['has_terrace'],
  patio_or_belcony: ['has_terrace'],
  patio_or_balcony: ['has_terrace'],
  balcony: ['has_terrace'],
  garden_or_backyard: ['has_garden'],
  outdoor_seating: ['has_outdoor_furniture'],
  sun_loungers: ['has_outdoor_furniture'],
  hammock: ['has_outdoor_furniture'],
  alfresco_dining: ['has_outdoor_dining'],
  beach_access: ['has_beach_access'],
  lake_access: ['has_beach_access'],
  waterfront: ['has_beach_access'],
  beach_essentials: ['has_beach_towels'],
  private_entrance: ['has_private_entrance'],
  bike_storage: ['has_bike_storage'],
  bikes: ['has_bikes'],

  // Divertissement
  game_console: ['has_game_console'],
  arcade_machine: ['has_game_console'],
  board_games: ['has_board_games'],
  books: ['has_books'],
  sound_system: ['has_sound_system'],
  projector: ['has_projector'],
  netflix: ['has_tv', 'has_netflix'],
  smart_home: ['has_smart_home'],

  // Sécurité
  smoke_detector: ['has_smoke_detector'],
  carbon_monoxide_detector: ['has_carbon_monoxide_detector'],
  fire_extinguisher: ['has_fire_extinguisher'],
  first_aid_kit: ['has_first_aid_kit'],
  safe: ['has_safe'],
  lock_on_bedroom_door: ['has_bedroom_lock'],

  // Enfants
  crib: ['has_baby_crib'],
  pack_n_play_travel_crib: ['has_baby_crib'],
  high_chair: ['has_baby_highchair'],
  childrens_books_and_toys: ['has_toys', 'has_books'],
  baby_bath: ['has_baby_bath'],
  children_bed: ['has_children_bed'],

  // Règles portées par un équipement
  allows_pets: ['allows_pets'],
  pets_allowed: ['allows_pets'],
  event_friendly: ['allows_events'],
  suitable_for_events: ['allows_events'],
};

/**
 * Codes qui décrivent l'arrivée. Le premier rencontré renseigne la méthode :
 * « self_checkin » et « lockbox » cohabitent souvent, et le second précise le
 * premier.
 */
const CHECKIN_METHOD_AMENITIES = {
  lockbox: 'lockbox',
  keypad: 'smart-lock',
  smart_lock: 'smart-lock',
  self_checkin: 'self-checkin',
  host_checkin: 'in-person',
  building_staff: 'concierge',
  doorman: 'concierge',
};

/**
 * Pas de case dédiée, mais un voyageur peut poser la question : le libellé
 * part en texte dans « Détails équipement cuisine ».
 */
const KITCHEN_DETAIL_AMENITIES = new Set([
  'dishes_and_silverware', 'wine_glasses', 'baking_sheet', 'stove',
  'barbeque_utensils', 'dining_table', 'blender',
]);

/**
 * Loisirs sans case dédiée : part en texte dans « Autres loisirs ».
 *
 * Volontairement RESTREINT aux vrais loisirs. Les codes de confort courant
 * (cintres, penderie, oreillers supplémentaires, ventilateur…) n'y sont pas :
 * les entasser sous « Autres loisirs » remplissait le champ d'un fatras que
 * l'hôte aurait dû nettoyer à la main, pour une information que personne ne
 * demande.
 */
const LEISURE_DETAIL_AMENITIES = new Set([
  'ping_pong_table', 'bowling_alley', 'playground', 'sauna', 'theme_room',
  'alfresco_shower', 'pool_table', 'tennis_court', 'kayak', 'surfing',
  'skiing', 'piano', 'gym_equipment',
]);

/** Libellés français des codes qui partent en texte. */
const AMENITY_LABELS = {
  dishes_and_silverware: 'Vaisselle et couverts',
  wine_glasses: 'Verres à vin',
  baking_sheet: 'Plaque de cuisson au four',
  stove: 'Plaques de cuisson',
  barbeque_utensils: 'Ustensiles à barbecue',
  dining_table: 'Table à manger',
  blender: 'Mixeur',
  ping_pong_table: 'Table de ping-pong',
  bowling_alley: 'Bowling',
  playground: 'Aire de jeux',
  sauna: 'Sauna',
  theme_room: 'Chambre à thème',
  alfresco_shower: 'Douche extérieure',
  pool_table: 'Billard',
  tennis_court: 'Court de tennis',
  piano: 'Piano',
  gym_equipment: 'Équipement de sport',
};

module.exports = {
  AMENITY_TO_FIELD,
  AMENITY_LABELS,
  KITCHEN_DETAIL_AMENITIES,
  LEISURE_DETAIL_AMENITIES,
  CHECKIN_METHOD_AMENITIES,
};

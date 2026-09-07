/**
 * Lecture STRUCTURÉE de l'export de données personnelles Airbnb.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * `airbnbArchiveImport.js` reconnaît un logement à sa FORME : un objet qui
 * porte un nom et quelques indices. Cette heuristique a le mérite de survivre
 * aux changements de format, mais sur l'export réel elle ne voyait presque
 * rien — et pour une raison précise, qui est le bogue que ce module corrige.
 *
 * Dans `listings.json`, l'objet d'un logement NE PORTE PAS de clé `name` :
 *
 *     { "id": 39244203, "nickname": null, "bedrooms": 1, "city": "Parempuyre",
 *       "listingDescriptions": [ { "name": "Studio CHIC et cosy…", … } ], … }
 *
 * Le vrai titre est enfoui dans `listingDescriptions[0].name`. La seule clé de
 * nom au premier niveau est `nickname`, le surnom interne que l'hôte donne à
 * son annonce — et il est le plus souvent `null`. L'heuristique ne retenait
 * donc QUE les annonces surnommées : 8 sur 43 dans l'export qui a servi à
 * écrire ce module, nommées « Chambre 7 » ou « Maison 2 » au lieu de leur
 * titre réel. Tout le reste — description, adresse, capacité, équipements —
 * n'était même pas regardé, `pickListing` ne gardant que nom, identifiant et
 * lien.
 *
 * Ce module lit donc la structure RÉELLE plutôt que de la deviner, et
 * l'heuristique reste en second rideau pour les millésimes d'export qu'on ne
 * connaît pas (voir `airbnbArchiveImport.js`).
 *
 * VIE PRIVÉE — LISTE BLANCHE
 * --------------------------
 * L'export complet pèse plus de 150 Mo et contient l'intégralité des
 * conversations avec les voyageurs, les virements, les pièces d'identité et
 * l'historique de navigation. RIEN de tout cela n'est ouvert : seuls les
 * fichiers retenus par `isListingFile` sont décompressés, les autres ne sont
 * jamais lus. `SENSITIVE_FILE` double la garantie en interdisant explicitement
 * les fichiers connus pour être sensibles, quel que soit leur chemin.
 *
 * `reservations.json` est VOLONTAIREMENT exclu. Il porte bien un lien vers le
 * logement (`hostingUrl`), mais son contenu est celui des voyageurs : profils,
 * messages, devises, nombre d'enfants. Le seul champ qui pouvait passer pour
 * une donnée de logement, `guestCheckinTimeFrom`, est en fait l'heure d'arrivée
 * ANNONCÉE PAR CHAQUE VOYAGEUR — elle varie d'une réservation à l'autre sur un
 * même logement (16-18 h, 21-23 h, 13-15 h…). Ce n'est pas l'horaire d'arrivée
 * de l'annonce, et l'écrire comme tel serait faux.
 */

const {
  AMENITY_TO_FIELD,
  AMENITY_LABELS,
  KITCHEN_DETAIL_AMENITIES,
  LEISURE_DETAIL_AMENITIES,
  CHECKIN_METHOD_AMENITIES,
} = require('./airbnbAmenities');

// ── Fichiers de l'archive ───────────────────────────────────────────────────

/**
 * Les quatre fichiers réellement utiles, et ce qu'on en tire. La clé est le
 * nom de base attendu dans l'export Airbnb actuel.
 */
const EXPORT_FILES = {
  listings: 'listings',                 // source principale : détecte les logements
  listing_pricing: 'pricing',           // tarifs, caution, supplément voyageur
  listing_calendar: 'calendar',         // durées minimales, dates bloquées
  listing_permits: 'permits',           // numéro d'enregistrement, adresse déclarée
  reviews: 'reviews',                   // note moyenne et nombre d'avis
  reservations: 'reservations',         // séjours à venir, dates et statut
  host_quick_replies: 'quickreplies',   // modèles écrits par l'hôte (source secondaire)
};

/**
 * Les conversations, ouvertes SÉPARÉMENT et pour un autre usage.
 *
 * Elles ne remplissent jamais un champ de la fiche : elles alimentent la
 * détection de faits candidats (`airbnbMessages.js`), qui exige des preuves
 * répétées sur plusieurs réservations avant de proposer quoi que ce soit.
 * D'où une table à part — un fichier de conversations n'est pas une source de
 * `parseExportDocuments`, et ne doit pas pouvoir le devenir par inadvertance.
 *
 *   messages                 le fichier brut d'Airbnb (70 Mo sur l'export de
 *                            référence). Accepté seulement en dépôt direct.
 *   airbnb_message_digest    le condensé produit par le navigateur : fils
 *                            rattachables, messages de l'hôte uniquement.
 */
const MESSAGE_FILES = {
  messages: 'messages',
  airbnb_message_digest: 'messagedigest',
};

/**
 * Priorité des sources, de la plus autoritative à la moins.
 *
 * Sert à trancher un conflit sans jamais choisir au hasard : une source plus
 * basse ne remplace JAMAIS une valeur déjà posée par une source plus haute.
 * Les désaccords sont journalisés par `parseExportDocuments`.
 *
 * `quickreplies` est volontairement en dernier : ce sont des messages écrits à
 * la main, pas un champ de l'annonce.
 */
const SOURCE_PRIORITY = ['listings', 'pricing', 'calendar', 'permits', 'reviews', 'quickreplies'];

/** Nom du fichier d'où vient une donnée, pour la traçabilité. */
const SOURCE_FILES = {
  listings: 'listings.json',
  pricing: 'listing_pricing.json',
  calendar: 'listing_calendar.json',
  permits: 'listing_permits.json',
  reviews: 'reviews.json',
  reservations: 'reservations.json',
  quickreplies: 'host_quick_replies.json',
};

/**
 * Fichiers interdits, quel que soit leur emplacement. Cette liste ne sert pas
 * à filtrer au quotidien (la liste blanche s'en charge) : elle existe pour
 * qu'un fichier sensible ne puisse jamais être ouvert par accident si la liste
 * blanche s'assouplit un jour.
 */
const SENSITIVE_FILE = new RegExp(
  '(' + [
    'activity_log', 'message', 'payment_processing', 'payment_instrument',
    'payments_asset_ledger', 'payout', 'third_party_payees',
    'id_verification', 'kyc', 'search_history', 'search_telemetry',
    'profile_information', 'wishlist', 'coupons_and_credits',
    'guest_referral', 'report_history', 'resolution_center',
    'customer_support',
  ].join('|') + ')',
  'i'
);

/**
 * Fichiers ouverts par l'import. Deux niveaux :
 *   - les noms exacts de `EXPORT_FILES`, lus par le parseur structuré ;
 *   - un motif plus large (`listing`, `annonce`, `logement`, `propert`) qui
 *     laisse passer les millésimes d'export nommés autrement, confiés alors à
 *     l'heuristique de forme.
 * Tout le reste de l'archive n'est jamais décompressé.
 *
 * `messages.json` est désormais OUVERT, ce qui n'était pas le cas auparavant.
 * Ce qui a changé n'est pas l'appréciation du risque, c'est qu'il existe
 * maintenant un rattachement DÉTERMINISTE d'une conversation à un logement
 * (code de réservation → `reservations.json` → annonce, voir
 * `airbnbMessages.js`) et une chaîne de preuves qui refuse d'écrire quoi que ce
 * soit sur une seule phrase. Le fichier n'alimente aucun champ directement : il
 * alimente des faits candidats, comptés puis confirmés.
 */
const LISTING_FILE = /(listing|annonce|logement|propert)/i;

function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}

/**
 * Analyse un JSON de l'export SANS abîmer les identifiants d'annonce.
 *
 * Les identifiants Airbnb récents font 19 chiffres — 1684090983577235984 —
 * très au-delà de ce qu'un nombre JavaScript sait représenter exactement
 * (2^53 − 1, soit 16 chiffres). `JSON.parse` les arrondit SILENCIEUSEMENT :
 *
 *     JSON.parse('{"id":1684090983577235984}').id  →  1684090983577236000
 *
 * L'identifiant enregistré était donc faux pour toutes les annonces récentes.
 * Conséquences concrètes : le lien vers l'annonce ne mène nulle part, la clé
 * de déduplication (user_id, airbnb_listing_id) ne correspond plus à rien de
 * réel, et surtout le rattachement à `listing_permits.json` — qui identifie le
 * logement par une URL, donc par une CHAÎNE exacte — échouait pour tout le
 * monde sauf les rares annonces d'avant 2022.
 *
 * Le correctif met entre guillemets les entiers longs des clés d'identifiant
 * AVANT l'analyse, pour qu'ils arrivent en chaînes intactes. Le motif vise les
 * seules clés concernées, jamais un nombre quelconque : une somme d'argent ou
 * un horodatage n'atteignent pas 16 chiffres, et un chiffre à l'intérieur d'un
 * texte n'est pas précédé d'un nom de clé.
 */
const LONG_ID_KEY = /"(id|listingId|listing_id|listingid|roomId|room_id|hostUserId|entityId|bookableId|reviewId|revieweeId|reviewerId)"(\s*:\s*)(\d{16,20})(?=\s*[,}\]])/g;

function parseAirbnbJson(text) {
  // Le BOM que produisent certains éditeurs Windows fait échouer JSON.parse
  // sur un fichier pourtant valide.
  const cleaned = String(text).replace(/^﻿/, '');
  return JSON.parse(cleaned.replace(LONG_ID_KEY, '"$1"$2"$3"'));
}

/**
 * Ce fichier de l'archive doit-il être ouvert ?
 *
 * L'ordre compte : la liste blanche des noms EXACTS est consultée en premier,
 * parce qu'elle est explicite et tenue à jour à la main. La liste noire ne sert
 * qu'ensuite, comme filet pour les noms approchants — sans quoi
 * `messages.json`, autorisé nommément, serait rejeté par le motif « message »
 * qui existe justement pour bloquer tout le reste.
 */
function isListingFile(path) {
  const base = baseName(path);
  if (!/\.json$/i.test(base)) return false;
  const stem = base.replace(/\.json$/i, '').toLowerCase();
  if (EXPORT_FILES[stem] || MESSAGE_FILES[stem]) return true;
  if (SENSITIVE_FILE.test(base)) return false;
  return LISTING_FILE.test(base);
}

/** Quel parseur structuré s'applique à ce fichier ? `null` = aucun. */
function exportKind(path) {
  const base = baseName(path).replace(/\.json$/i, '').toLowerCase();
  return EXPORT_FILES[base] || MESSAGE_FILES[base] || null;
}

/** Ce document porte-t-il des conversations plutôt qu'une section de logements ? */
function isMessageKind(kind) {
  return kind === 'messages' || kind === 'messagedigest';
}

/**
 * Même question, mais posée au CONTENU.
 *
 * Le nom ne suffit pas : l'hôte qui décompresse son export et redépose un
 * fichier l'a souvent renommé (« mes annonces.json », « listings (1).json »),
 * et le dépôt d'un fichier seul ne transmet de toute façon aucun nom au
 * serveur. Reconnaître la section de premier niveau, elle, est fiable — c'est
 * exactement ce que le parseur ira lire ensuite.
 */
const SECTION_KINDS = [
  ['listings', 'listings'],
  ['pricingData', 'pricing'],
  ['listingsCalendarData', 'calendar'],
  ['listingRegistrations', 'permits'],
  ['reviewsReceived', 'reviews'],
  ['reservations', 'reservations'],
  ['templates', 'quickreplies'],
  ['messageThreads', 'messages'],
  ['messageDigest', 'messagedigest'],
];

function kindFromContent(data) {
  for (const [key, kind] of SECTION_KINDS) {
    if (section(data, key).length > 0) return kind;
  }
  return null;
}

// ── Petites conversions ─────────────────────────────────────────────────────

/**
 * Rend une chaîne, jamais un objet. C'est ce qui garantit qu'aucun champ ne
 * peut finir en « [object Object] » : une valeur non scalaire est écartée.
 */
function text(value, max = 5000) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  const str = String(value).trim();
  return str ? str.slice(0, max) : '';
}

function whole(value, { min = 0, max = 1000 } = {}) {
  // `Number(null)` vaut 0 et `Number('')` aussi : sans ce garde, une valeur
  // ABSENTE de l'export devenait « zéro chambre », ce qui faisait ensuite
  // passer le logement pour un studio. Une donnée absente doit rester absente.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** `{ amount: 89, currency: "EUR" }` → « 89 EUR ». */
function money(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const currency = text(value.currency, 8);
  return currency ? `${amount} ${currency}` : String(amount);
}

function amountOf(value) {
  const amount = Number(value && value.amount);
  return Number.isFinite(amount) ? amount : 0;
}

/** Identifiant Airbnb : un entier, et rien d'autre. */
function listingId(value) {
  const str = text(value, 32);
  return /^\d{4,20}$/.test(str) ? str : null;
}

/** `https://www.airbnb.com/rooms/1684090983577235984` → l'identifiant. */
function listingIdFromUrl(url) {
  const match = text(url, 500).match(/\/rooms\/(?:plus\/)?(\d{4,20})/);
  return match ? match[1] : null;
}

/** `YYYY-MM-DD`, et rien d'autre. */
function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Ajoute `days` jours à une date ISO. Arithmétique exacte, pas d'estimation. */
function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * L'export enveloppe tout : `[ { "listings": [ … ] } ]`. Cette fonction rend
 * le tableau nommé `key`, qu'il soit au premier ou au second niveau, sans
 * jamais descendre plus loin — on lit une structure connue, on n'explore pas.
 */
function section(data, key) {
  const roots = Array.isArray(data) ? data : [data];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    const value = root[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// ── Vocabulaires Airbnb → vocabulaire Michel ────────────────────────────────

// La fiche n'offre que six types ; y écrire « Guest suite » afficherait un
// menu vide dans le formulaire. Toute valeur inconnue est donc laissée de côté
// plutôt que recopiée telle quelle.
const PROPERTY_TYPES = {
  apartment: 'apartment',
  condominium: 'apartment',
  'guest suite': 'apartment',
  'serviced apartment': 'apartment',
  aparthotel: 'apartment',
  loft: 'loft',
  villa: 'villa',
  house: 'house',
  townhouse: 'house',
  'tiny house': 'house',
  'bed and breakfast': 'house',
  castle: 'house',
  bungalow: 'house',
  cottage: 'house',
  'farm stay': 'house',
  cabin: 'chalet',
  chalet: 'chalet',
};

/** ISO → nom lisible. Airbnb livre « FR », le formulaire attend « France ». */
const COUNTRIES = {
  FR: 'France', BE: 'Belgique', CH: 'Suisse', ES: 'Espagne', IT: 'Italie',
  PT: 'Portugal', DE: 'Allemagne', NL: 'Pays-Bas', GB: 'Royaume-Uni',
  US: 'États-Unis', CA: 'Canada', MA: 'Maroc', LU: 'Luxembourg', GR: 'Grèce',
};

/** Ce qu'Airbnb appelle « points à noter » sur l'annonce. */
const EXPECTATION_LABELS = {
  requires_stairs: 'Escaliers à monter',
  shared_spaces: 'Espaces partagés',
  pool_or_jacuzzi_with_no_fence: 'Piscine ou jacuzzi sans barrière',
  potential_for_noise: 'Bruit possible',
  pet_lives_on_property: 'Un animal vit sur place',
  no_parking_on_property: 'Pas de stationnement sur place',
  some_spaces_are_shared: 'Certains espaces sont partagés',
  surveillance_or_recording_devices: 'Dispositif de surveillance sur la propriété',
  weapons_on_property: 'Armes sur la propriété',
  dangerous_animals_on_property: 'Animaux dangereux sur la propriété',
};

/** Codes de literie d'une chambre (`rooms[].amenities`). */
const BED_LABELS = {
  KING_BED: 'lit king size',
  QUEEN_BED: 'lit queen size',
  DOUBLE_BED: 'lit double',
  SINGLE_BED: 'lit simple',
  BUNK_BED: 'lits superposés',
  SOFA_BED: 'canapé-lit',
  CRIB_BED: 'lit bébé',
  FLOOR_MATTRESS: 'matelas au sol',
  AIR_MATTRESS: 'matelas gonflable',
  TODDLER_BED: 'lit enfant',
};

/** Faute de table, on rend le code lisible plutôt que de le cacher. */
function humanize(slug) {
  return text(slug, 80).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// ── listings.json → fiche Michel ────────────────────────────────────────────

/**
 * Traduit UN logement de `listings.json` en champs Michel.
 *
 * Ne renvoie que ce qui existe vraiment : une clé absente de l'export est
 * absente du résultat, elle n'est jamais remplacée par une valeur inventée.
 */
function profileFromListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = listingId(raw.id);

  // Le titre réel est dans listingDescriptions ; `nickname` n'est que le
  // surnom interne de l'hôte, et il est le plus souvent nul.
  const description = (Array.isArray(raw.listingDescriptions) && raw.listingDescriptions[0]) || {};
  const name = text(description.name, 200) || text(raw.nickname, 200);
  if (!name) return null;

  const profile = { airbnb_listing_id: id, name };

  // ── Identité et capacité ──────────────────────────────────────────────
  //
  // Rien n'est déduit ici. Un type de logement qu'Airbnb nomme autrement que
  // le menu de la fiche est TRADUIT (« Condominium » → appartement) ; un type
  // inconnu de la table n'est pas remplacé par un voisin plausible, il est
  // laissé vide. En particulier, un logement à zéro chambre n'est PAS déclaré
  // « studio » : Airbnb ne dit pas que c'en est un.
  const type = PROPERTY_TYPES[text(raw.propertyType, 60).toLowerCase()];
  if (type) profile.property_type = type;

  const bedrooms = whole(raw.bedrooms, { max: 50 });
  if (bedrooms !== null) profile.bedrooms = bedrooms;
  const beds = whole(raw.beds, { max: 100 });
  if (beds !== null) profile.beds = beds;
  const guests = whole(raw.personCapacity, { min: 1, max: 100 });
  if (guests !== null) profile.max_guests = guests;

  // Airbnb compte les demi-salles d'eau (1.5, 2.5…) ; la colonne, elle, est
  // entière. La valeur EXACTE est conservée à part et c'est elle que Michel
  // cite au voyageur : arrondir 1,5 à 2 ferait promettre une salle de bain qui
  // n'existe pas.
  // `Number(null)` vaut 0, et `Math.max(1, 0)` vaut 1 : sans ce garde, une
  // salle de bain non renseignée en devenait une, ce qui est précisément le
  // genre de valeur inventée qu'un voyageur pourrait nous opposer.
  const bathrooms = raw.bathrooms === null || raw.bathrooms === undefined || raw.bathrooms === ''
    ? NaN
    : Number(raw.bathrooms);
  if (Number.isFinite(bathrooms) && bathrooms > 0) {
    profile.bathrooms = Math.max(1, Math.round(bathrooms));
    profile.bathrooms_exact = bathrooms;
  }

  // ── Textes ────────────────────────────────────────────────────────────
  const summary = text(description.description, 4000) || text(description.summary, 4000);
  if (summary) profile.description = summary;
  const neighborhood = text(description.neighborhoodOverview, 2000);
  if (neighborhood) profile.nearby = neighborhood;
  const space = text(description.space, 2000);
  if (space) profile.listing_space = space;
  const notes = text(description.notes, 2000);
  if (notes) profile.listing_notes = notes;
  const interaction = text(description.interaction, 1000);
  if (interaction) profile.host_interaction = interaction;
  // « Comment s'y rendre » : sur l'export réel, ce champ contient bien les
  // consignes d'entrée (« 2 portails à cette adresse, la vôtre est… »).
  const directions = text(raw.directions, 2000);
  if (directions) profile.building_entry = directions;
  const manual = text(raw.houseManual, 4000);
  if (manual) profile.house_manual = manual;

  // ── Localisation ──────────────────────────────────────────────────────
  const address = text(raw.formattedAddress, 500)
    || [text(raw.street, 200), text(raw.zipcode, 20), text(raw.city, 120), text(raw.country, 80)]
      .filter(Boolean).join(', ');
  if (address) profile.address = address;
  const city = text(raw.city, 120) || text(raw.cityNative, 120);
  if (city) profile.city = city;
  const country = text(raw.country, 80);
  if (country) profile.country = COUNTRIES[country.toUpperCase()] || country;
  // Bâtiment, étage, numéro d'appartement : Airbnb range tout cela dans
  // `apartment` (« Cimbats 2, Bâtiment 7, Appt 154, 8ème étage »).
  const unit = text(raw.apartment, 200);
  if (unit) profile.floor_number = unit;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    profile.latitude = String(lat);
    profile.longitude = String(lng);
  }

  // ── Numéro d'enregistrement ───────────────────────────────────────────
  const license = text(raw.license, 120);
  if (license) profile.registration_number = license;

  // ── Équipements ───────────────────────────────────────────────────────
  applyAmenities(profile, raw.amenities);

  // ── Règles ────────────────────────────────────────────────────────────
  if (typeof raw.petsAllowed === 'boolean') profile.allows_pets = raw.petsAllowed;
  if (typeof raw.smokingAllowed === 'boolean') profile.allows_smoking = raw.smokingAllowed;
  if (typeof raw.eventsAllowed === 'boolean') profile.allows_events = raw.eventsAllowed;

  // Le règlement écrit par l'hôte vient en premier : c'est le texte que le
  // voyageur a accepté. Les « points à noter » d'Airbnb le complètent.
  const rules = [];
  const written = text(description.houseRules, 3000);
  if (written) rules.push(written);
  if (raw.infantsAllowed === false) rules.push('Bébés non acceptés');
  // `childrenAlloewd` : la faute de frappe vient de l'export Airbnb lui-même.
  if (raw.childrenAlloewd === false) rules.push('Enfants non acceptés');
  if (text(raw.bathroomType, 40).toLowerCase() === 'shared') rules.push('Salle de bain partagée');
  for (const expectation of Array.isArray(raw.expectations) ? raw.expectations : []) {
    if (!expectation || expectation.hasExpectation === false) continue;
    const slug = text(expectation.expectationType, 80);
    const label = EXPECTATION_LABELS[slug] || (slug ? humanize(slug) : '');
    const detail = text(expectation.addedDetails, 400);
    if (label && detail) rules.push(`${label} : ${detail}`);
    else if (label) rules.push(label);
  }
  if (rules.length > 0) profile.house_rules = rules.join('\n');

  // ── Chambres et literie ───────────────────────────────────────────────
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const bedDetail = rooms
    .filter((room) => room && text(room.roomType, 40).toUpperCase() === 'BEDROOM')
    .sort((a, b) => (whole(a.roomNumber) || 0) - (whole(b.roomNumber) || 0))
    .map((room) => {
      // Seuls les codes de literie, reconnus au suffixe `_BED` : `BED_LINENS`
      // (le linge de lit) n'est pas un lit et n'a rien à faire ici.
      const beds = (Array.isArray(room.amenities) ? room.amenities : [])
        .map((a) => text(a, 60).toUpperCase())
        .filter((a) => /_BED$/.test(a))
        .map((a) => BED_LABELS[a] || humanize(a.toLowerCase()));
      const label = `Chambre ${whole(room.roomNumber) || '?'}`;
      const privacy = room.isPrivate === false ? ' (partagée)' : '';
      return beds.length > 0 ? `${label}${privacy} : ${beds.join(', ')}` : `${label}${privacy}`;
    });
  if (bedDetail.length > 0) profile.bed_types = bedDetail.join('\n');

  return profile;
}

/**
 * Coche les équipements Michel à partir des codes Airbnb.
 *
 * Les codes sans équivalent direct mais qu'un voyageur peut demander (ping-pong,
 * sauna, ustensiles de cuisine…) ne sont pas jetés : ils partent en texte dans
 * les deux champs de détail prévus pour ça. Un code inconnu de toutes les
 * tables est ignoré — mieux vaut ne rien dire que dire faux.
 */
function applyAmenities(profile, amenities) {
  if (!Array.isArray(amenities) || amenities.length === 0) return;

  const codes = new Set(amenities.map((a) => text(a, 80).toLowerCase()).filter(Boolean));

  for (const code of codes) {
    const fields = AMENITY_TO_FIELD[code];
    if (!fields) continue;
    for (const field of fields) profile[field] = true;
  }

  for (const code of codes) {
    const method = CHECKIN_METHOD_AMENITIES[code];
    // Le premier code rencontré gagne : « self_checkin » et « lockbox »
    // coexistent souvent, et le second décrit le premier.
    if (method && !profile.checkin_method) profile.checkin_method = method;
  }
  // Deux traductions ont été retirées ici, volontairement :
  //   - « luggage_dropoff_allowed » vers « consigne sur demande » : Airbnb dit
  //     que le dépôt est possible, pas qu'il faut le demander ;
  //   - « cleaning_before_checkout » vers une phrase d'instructions de départ :
  //     cette phrase aurait été écrite par nous, pas par l'hôte.
  // Dans les deux cas la nuance ajoutée n'était pas dans l'export.

  const kitchen = [...codes].filter((c) => KITCHEN_DETAIL_AMENITIES.has(c))
    .map((c) => AMENITY_LABELS[c] || humanize(c));
  if (kitchen.length > 0) profile.kitchen_equipment_details = kitchen.join(', ');

  const leisure = [...codes].filter((c) => LEISURE_DETAIL_AMENITIES.has(c))
    .map((c) => AMENITY_LABELS[c] || humanize(c));
  if (leisure.length > 0) profile.outdoor_other = leisure.join(', ');
}

// ── listing_pricing.json → tarifs ───────────────────────────────────────────

/**
 * `pricingData[]` porte `listingId` : le rattachement est direct.
 *
 * `pricingRules[]`, en revanche, ne porte AUCUN identifiant dans l'export —
 * il est donc impossible de savoir à quel logement une règle s'applique, et
 * rien n'en est tiré. Deviner serait pire que de ne rien dire.
 */
function pricingByListing(data) {
  const result = new Map();

  for (const entry of section(data, 'pricingData')) {
    const id = listingId(entry && entry.listingId);
    if (!id) continue;

    const setting = (entry.listingPriceSetting && typeof entry.listingPriceSetting === 'object')
      ? entry.listingPriceSetting : {};
    const profile = {};
    const notes = [];

    const nightly = money(setting.defaultDailyPrice);
    if (nightly) notes.push(`Tarif de base ${nightly} par nuit`);
    const weekend = money(setting.weekendPrice);
    if (weekend) notes.push(`Week-end ${weekend}`);

    // Airbnb stocke une remise en facteur (0.9 = −10 %).
    const weekly = Number(setting.weeklyPriceFactor);
    if (Number.isFinite(weekly) && weekly > 0 && weekly < 1) {
      notes.push(`Remise à la semaine ${Math.round((1 - weekly) * 100)} %`);
    }
    const monthly = Number(setting.monthlyPriceFactor);
    if (Number.isFinite(monthly) && monthly > 0 && monthly < 1) {
      notes.push(`Remise au mois ${Math.round((1 - monthly) * 100)} %`);
    }

    const smart = (entry.smartPricingSetting && typeof entry.smartPricingSetting === 'object')
      ? entry.smartPricingSetting : {};
    if (smart.isEnabled === true) {
      const min = money(smart.minPrice);
      const max = money(smart.maxPrice);
      notes.push(`Tarification intelligente activée${min && max ? ` (de ${min} à ${max})` : ''}`);
    }

    if (notes.length > 0) profile.payment_notes = notes.join(' · ');

    const deposit = amountOf(setting.securityDeposit);
    if (deposit > 0) {
      profile.has_deposit_required = true;
      profile.deposit_amount = money(setting.securityDeposit);
    }

    const extraPerson = amountOf(setting.pricePerExtraPerson);
    if (extraPerson > 0) {
      profile.has_price_per_guest = true;
      profile.price_extra_guest_amount = money(setting.pricePerExtraPerson);
      const included = whole(setting.guestsIncluded, { min: 1, max: 100 });
      // Le supplément s'applique AU-DELÀ du nombre inclus.
      if (included !== null) profile.extra_guest_threshold = String(included + 1);
    }

    if (Object.keys(profile).length > 0) result.set(id, profile);
  }

  return result;
}

// ── listing_calendar.json → durées minimales et dates bloquées ──────────────

/**
 * `listingsCalendarData[]` porte `listingId`.
 *
 * Deux choses en sortent :
 *   - la durée minimale de séjour la plus courante (`seasonalMinNights`), qui
 *     devient un champ de la fiche ;
 *   - les dates que l'hôte a bloquées (`dailyCalendarData.busyOverrides`), qui
 *     deviennent des indisponibilités réelles. Seul l'AVENIR est retenu : un
 *     calendrier passé ne sert à personne et ferait des dizaines de milliers de
 *     lignes inutiles (911 dates par logement sur l'export de référence).
 *
 * `ruleGroupAvailabilityRules`, comme `pricingRules`, ne porte aucun
 * identifiant de logement : rien n'en est tiré.
 */
function calendarByListing(data, { today = new Date(), maxBlocks = 400 } = {}) {
  const result = new Map();
  const from = today.toISOString().slice(0, 10);

  for (const entry of section(data, 'listingsCalendarData')) {
    const id = listingId(entry && entry.listingId);
    if (!id) continue;

    const profile = {};

    // Durée minimale : celle de la période qui COUVRE AUJOURD'HUI, et rien
    // d'autre. Elle varie d'une saison à l'autre ; prendre la plus fréquente,
    // ou la plus courte, reviendrait à fabriquer une valeur qu'Airbnb n'énonce
    // nulle part. Si aucune période ne couvre aujourd'hui, le champ reste vide.
    const seasonal = (entry.seasonalCalendarData && entry.seasonalCalendarData.seasonalMinNights) || [];
    for (const range of Array.isArray(seasonal) ? seasonal : []) {
      if (!range) continue;
      const start = text(range.startDate, 10);
      const end = text(range.endDate, 10);
      if (!isIsoDate(start) || !isIsoDate(end)) continue;
      if (from < start || from > end) continue;
      const nights = whole(range.minNights, { min: 1, max: 365 });
      if (nights === null) continue;
      profile.min_stay = `${nights} nuit${nights > 1 ? 's' : ''}`;
      break;
    }

    const daily = (entry.dailyCalendarData && typeof entry.dailyCalendarData === 'object')
      ? entry.dailyCalendarData : {};
    const busy = (Array.isArray(daily.busyOverrides) ? daily.busyOverrides : [])
      .map((o) => text(o && o.calendarDate, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from)
      .sort();

    const blocked = mergeConsecutiveDates(busy).slice(0, maxBlocks);

    // L'entrée est posée MÊME SI elle est vide. C'est ce qui distingue « le
    // calendrier a été lu et rien n'est bloqué » de « le calendrier n'a pas
    // été fourni » — et donc ce qui permet à l'import de libérer des dates que
    // l'hôte a rouvertes chez Airbnb, au lieu de les garder bloquées pour
    // toujours.
    result.set(id, { ...profile, blocked_dates: blocked });
  }

  return result;
}

/**
 * `['2026-01-01','2026-01-02','2026-01-05']` → deux plages plutôt que trois
 * lignes. `end_date` est exclusive, comme partout ailleurs dans ce schéma
 * (`availability_blocks`, iCal).
 */
function mergeConsecutiveDates(dates) {
  const ranges = [];
  let start = null;
  let previous = null;

  const nextDay = (iso) => addDays(iso, 1);

  for (const date of dates) {
    if (date === previous) continue;             // doublon dans l'export
    if (start === null) {
      start = date;
    } else if (date !== nextDay(previous)) {
      ranges.push({ start_date: start, end_date: nextDay(previous) });
      start = date;
    }
    previous = date;
  }
  if (start !== null) ranges.push({ start_date: start, end_date: nextDay(previous) });

  return ranges;
}

// ── listing_permits.json → informations complémentaires ─────────────────────

/**
 * ATTENTION — ce fichier NE PORTE PAS `listingId`.
 *
 * `listingRegistrations[]` identifie le logement par `listingUrl`
 * (« https://www.airbnb.com/rooms/1684090983577235984 »). L'identifiant est
 * donc extrait de l'URL. C'est le seul fichier de l'export où la clé de
 * liaison a une forme différente, et le supposer nommé `listingId` aurait
 * silencieusement rattaché zéro permis.
 */
function permitsByListing(data) {
  const result = new Map();

  for (const entry of section(data, 'listingRegistrations')) {
    const id = listingIdFromUrl(entry && entry.listingUrl);
    if (!id) continue;

    const profile = {};
    const numbers = [];
    let declaredAddress = '';

    for (const registration of Array.isArray(entry.registrations) ? entry.registrations : []) {
      const submissions = (registration && registration.registrationSubmissions) || [];
      for (const submission of Array.isArray(submissions) ? submissions : []) {
        const fields = (submission && submission.data && typeof submission.data === 'object')
          ? submission.data : {};
        const number = text(fields.permit_number, 120);
        if (number && !numbers.includes(number)) numbers.push(number);
        if (!declaredAddress) declaredAddress = text(fields.listing_address, 500);
      }
    }

    if (numbers.length > 0) profile.registration_number = numbers.join(', ');
    // Sert de repli quand `listings.json` n'a pas d'adresse : la fusion plus
    // bas ne l'écrit que si la fiche n'en porte pas déjà une.
    if (declaredAddress) profile.address = declaredAddress;

    if (Object.keys(profile).length > 0) result.set(id, profile);
  }

  return result;
}

// ── reviews.json → note moyenne et nombre d'avis ────────────────────────────

/**
 * `reviewsReceived[].review` porte `entityId` (l'annonce) et `rating`.
 *
 * Le filtre n'est pas cosmétique : on ne compte que les avis REÇUS par l'hôte
 * sur un logement (`revieweeRole: HOST`, `entityType: HOME`), réellement soumis
 * et non générés automatiquement par Airbnb. Compter les avis que l'hôte a
 * LAISSÉS à ses voyageurs (`reviewsProvided`) donnerait une note qui n'est pas
 * celle du logement.
 *
 * La moyenne est un calcul exact sur des notes présentes, pas une estimation.
 */
function reviewsByListing(data) {
  const totals = new Map();

  for (const entry of section(data, 'reviewsReceived')) {
    const review = (entry && entry.review && typeof entry.review === 'object') ? entry.review : null;
    if (!review) continue;
    if (text(review.entityType, 20).toUpperCase() !== 'HOME') continue;
    if (text(review.revieweeRole, 20).toUpperCase() !== 'HOST') continue;
    if (review.hasSubmitted !== true) continue;
    if (review.isSystemAutoGenerated === true) continue;

    const id = listingId(review.entityId);
    const rating = Number(review.rating);
    if (!id || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;

    const current = totals.get(id) || { sum: 0, count: 0 };
    current.sum += rating;
    current.count += 1;
    totals.set(id, current);
  }

  const result = new Map();
  for (const [id, { sum, count }] of totals) {
    result.set(id, {
      rating: Math.round((sum / count) * 100) / 100,
      review_count: count,
    });
  }
  return result;
}

// ── reservations.json → séjours à venir ─────────────────────────────────────

/**
 * `reservations[]` identifie le logement par `hostingUrl`, comme les permis.
 *
 * SEULS LES SÉJOURS À VENIR SONT RETENUS. L'export en contient plus de 1 600
 * remontant à 2015 ; les séjours passés n'apprennent rien sur la disponibilité
 * et n'ont aucune raison d'entrer dans la base d'un hôte.
 *
 * La date de départ n'est pas dans l'export : elle se CALCULE, exactement, en
 * ajoutant `nights` à `startDate`. Ce n'est pas une estimation, c'est la
 * définition d'une nuitée.
 *
 * Ce qui est délibérément LAISSÉ : `message`, `guestProfileUrl`,
 * `guestVatCountry`, les devises. Ce sont les données du voyageur, pas celles
 * du séjour, et Michel n'en a pas besoin pour savoir qu'une date est prise.
 */
function reservationsByListing(data, { today = new Date(), maxPerListing = 200 } = {}) {
  const from = today.toISOString().slice(0, 10);
  const result = new Map();

  for (const entry of section(data, 'reservations')) {
    if (!entry || typeof entry !== 'object') continue;

    const id = listingIdFromUrl(entry.hostingUrl);
    const start = text(entry.startDate, 10);
    const nights = whole(entry.nights, { min: 1, max: 3650 });
    const code = text(entry.confirmationCode, 50);
    if (!id || !isIsoDate(start) || nights === null || !code) continue;

    const end = addDays(start, nights);
    if (end < from) continue;                       // séjour terminé

    const status = text(entry.status, 30).toLowerCase();
    // Le schéma n'accepte que ces statuts ; un statut inconnu est écarté
    // plutôt que traduit au jugé.
    if (!['accepted', 'cancelled', 'denied', 'pending', 'confirmed'].includes(status)) continue;

    const list = result.get(id) || [];
    if (list.length >= maxPerListing) continue;
    list.push({
      confirmation_code: code,
      check_in_date: start,
      check_out_date: end,
      nights,
      status,
      number_of_guests: whole(entry.numberOfGuests, { min: 1, max: 100 }),
      booked_at: text(entry.createdAt, 40) || null,
    });
    result.set(id, list);
  }

  return result;
}

/**
 * Index de TOUTES les réservations, code de confirmation → logement.
 *
 * Différent de `reservationsByListing`, et pour une raison de fond : celui-ci
 * ne filtre PAS sur les séjours à venir. C'est l'inverse qui est utile ici — ce
 * sont les séjours PASSÉS qui portent l'historique de conversations, et un
 * séjour de 2021 rattache aussi sûrement un fil à un logement qu'un séjour de
 * la semaine prochaine.
 *
 * Rien du voyageur n'est retenu : ni nom, ni profil, ni message. Seulement de
 * quel logement il s'agit et quand.
 */
function reservationIndex(data) {
  const index = new Map();
  for (const entry of section(data, 'reservations')) {
    if (!entry || typeof entry !== 'object') continue;
    const code = text(entry.confirmationCode, 50);
    const id = listingIdFromUrl(entry.hostingUrl);
    if (!code || !id || index.has(code)) continue;
    const start = text(entry.startDate, 10);
    index.set(code, {
      listing_id: id,
      start_date: isIsoDate(start) ? start : null,
    });
  }
  return index;
}

/**
 * Identifiants Airbnb de l'hôte, lus dans `listings.json`.
 *
 * C'est ce qui permet de distinguer, dans une conversation, ce que l'hôte a
 * écrit de ce que le voyageur a écrit. Sans cette information, aucun corps de
 * message n'est retenu : une phrase de voyageur ne doit jamais devenir une
 * caractéristique du logement.
 *
 * `profile_information.json` donnerait la même chose, mais il est sur la liste
 * noire et le restera : l'identifiant est déjà porté par les annonces.
 */
function hostAccountIds(data) {
  const ids = new Set();
  for (const row of section(data, 'listings')) {
    if (!row || typeof row !== 'object') continue;
    const id = text(row.hostUserId, 32);
    if (/^\d{3,20}$/.test(id)) ids.add(id);
  }
  return ids;
}

// ── host_quick_replies.json → source SECONDAIRE, sous conditions ────────────

/**
 * Les modèles de réponse rapide sont écrits par l'hôte et rattachés
 * explicitement à des annonces (`entities[].entityType === 'LISTING'`). C'est
 * ce qui les distingue des conversations : on sait qui a écrit, et pour quel
 * logement.
 *
 * CE QUI EST EXTRAIT, ET RIEN D'AUTRE : l'heure d'arrivée, quand elle est
 * écrite en toutes lettres. Quatre garde-fous, tous nécessaires :
 *
 *   1. le modèle ne vise QU'UNE seule annonce. Un modèle rattaché à vingt
 *      logements ne dit pas l'heure de l'un d'eux en particulier ;
 *   2. l'heure est littérale. `#{CHECK_IN_TIME}` est un espace réservé
 *      qu'Airbnb remplace à l'envoi : sa valeur n'est PAS dans l'export ;
 *   3. tous les modèles de ce logement doivent donner la MÊME heure. Deux
 *      modèles qui se contredisent laissent le champ vide ;
 *   4. cette source arrive en dernier : elle ne peut jamais écraser une donnée
 *      structurée.
 *
 * Sur l'export de référence, cela renseigne l'heure d'arrivée de 3 logements
 * sur 41. Peu, mais chacun des trois est vérifiable dans le fichier.
 */
// `\b` n'est pas utilisable devant « à » : en expression régulière JavaScript,
// une lettre accentuée n'est pas un caractère de mot, et la limite ne tombe
// donc jamais où on l'attend.
const CHECKIN_PHRASE = /(?:à|a)\s+partir\s+de\s+(\d{1,2})\s*h(?:\s*(\d{2}))?/gi;

function quickRepliesByListing(data) {
  const candidates = new Map();

  for (const template of section(data, 'templates')) {
    if (!template || typeof template !== 'object') continue;

    const listings = (Array.isArray(template.entities) ? template.entities : [])
      .filter((e) => e && text(e.entityType, 30).toUpperCase() === 'LISTING')
      .map((e) => listingId(e.entityId))
      .filter(Boolean);
    // Garde-fou 1 : un seul logement visé.
    if (listings.length !== 1) continue;
    const id = listings[0];

    for (const entry of Array.isArray(template.texts) ? template.texts : []) {
      const message = text(entry && entry.message, 4000);
      if (!message) continue;

      CHECKIN_PHRASE.lastIndex = 0;
      let match;
      while ((match = CHECKIN_PHRASE.exec(message)) !== null) {
        const hours = Number(match[1]);
        const minutes = match[2] ? Number(match[2]) : 0;
        if (!Number.isInteger(hours) || hours > 23 || minutes > 59) continue;
        const value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        const set = candidates.get(id) || new Set();
        set.add(value);
        candidates.set(id, set);
      }
    }
  }

  const result = new Map();
  for (const [id, values] of candidates) {
    // Garde-fou 3 : un désaccord vaut absence.
    if (values.size !== 1) continue;
    result.set(id, { check_in_time: [...values][0] });
  }
  return result;
}

// ── Assemblage ──────────────────────────────────────────────────────────────

/**
 * Lit les documents allowlistés et rend les fiches prêtes à écrire.
 *
 * `listings.json` est la SOURCE : un logement absent de ce fichier n'est pas
 * créé, même s'il apparaît dans les tarifs ou le calendrier (l'export de
 * référence porte 49 entrées de tarifs pour 43 annonces — les annonces
 * supprimées y restent). Les autres fichiers ne font qu'enrichir, et seulement
 * les champs que `listings.json` n'a pas déjà remplis.
 *
 * @param {Array<{name: string, data: any}>} documents JSON déjà analysés
 * @returns {{listings: Array, sources: object, warnings: string[]}}
 */
function parseExportDocuments(documents, options = {}) {
  const warnings = [];
  const conflicts = [];
  const sources = {
    listings: false, pricing: false, calendar: false,
    permits: false, reviews: false, reservations: false, quickreplies: false,
  };

  const extras = {
    pricing: new Map(),
    calendar: new Map(),
    permits: new Map(),
    reviews: new Map(),
    quickreplies: new Map(),
  };
  let reservations = new Map();
  const profiles = new Map();
  // Provenance : pour chaque logement, quel fichier a fourni quel champ.
  const provenance = new Map();

  for (const document of Array.isArray(documents) ? documents : []) {
    if (!document) continue;
    // Le nom d'abord — c'est le cas courant et il ne coûte rien —, puis le
    // contenu pour les fichiers renommés et pour un dépôt qui n'a pas de nom.
    const kind = exportKind(document.name) || kindFromContent(document.data);
    if (!kind) continue;

    try {
      if (kind === 'listings') {
        const rows = section(document.data, 'listings');
        for (const row of rows) {
          const profile = profileFromListing(row);
          if (!profile) continue;
          // Un même identifiant peut revenir si l'hôte dépose deux exports :
          // la première fiche gagne.
          const key = profile.airbnb_listing_id || `name:${profile.name.toLowerCase()}`;
          if (profiles.has(key)) continue;
          profiles.set(key, profile);
          const origin = {};
          for (const field of Object.keys(profile)) origin[field] = SOURCE_FILES.listings;
          provenance.set(key, origin);
        }
        if (rows.length > 0) sources.listings = true;
      } else if (kind === 'pricing') {
        extras.pricing = pricingByListing(document.data);
        sources.pricing = extras.pricing.size > 0;
      } else if (kind === 'calendar') {
        extras.calendar = calendarByListing(document.data, options);
        sources.calendar = extras.calendar.size > 0;
      } else if (kind === 'permits') {
        extras.permits = permitsByListing(document.data);
        sources.permits = extras.permits.size > 0;
      } else if (kind === 'reviews') {
        extras.reviews = reviewsByListing(document.data);
        sources.reviews = extras.reviews.size > 0;
      } else if (kind === 'quickreplies') {
        extras.quickreplies = quickRepliesByListing(document.data);
        sources.quickreplies = extras.quickreplies.size > 0;
      } else if (kind === 'reservations') {
        reservations = reservationsByListing(document.data, options);
        sources.reservations = reservations.size > 0;
      }
    } catch (err) {
      // Un fichier au format inattendu ne doit pas emporter les autres. Le NOM
      // du fichier est journalisé, jamais son contenu.
      warnings.push(`Fichier ignoré (structure inattendue) : ${baseName(document.name)}`);
    }
  }

  const listings = [];
  for (const [key, profile] of profiles) {
    const id = profile.airbnb_listing_id;
    const origin = provenance.get(key) || {};
    const contributed = { listings: true };

    if (id) {
      // Les sources sont parcourues de la plus autoritative à la moins : une
      // valeur déjà posée n'est jamais remplacée, et le désaccord est noté.
      for (const source of SOURCE_PRIORITY) {
        if (source === 'listings') continue;
        const extra = extras[source] && extras[source].get(id);
        if (!extra) continue;
        contributed[source] = true;

        for (const [field, value] of Object.entries(extra)) {
          if (profile[field] === undefined) {
            profile[field] = value;
            origin[field] = SOURCE_FILES[source];
            continue;
          }
          if (profile[field] !== value && field !== 'blocked_dates') {
            // Ni l'un ni l'autre n'est écrasé au hasard : la source la plus
            // autoritative garde la main, et le désaccord est journalisé.
            conflicts.push({
              listing_id: id,
              field,
              kept_from: origin[field] || SOURCE_FILES.listings,
              ignored_from: SOURCE_FILES[source],
            });
          }
        }
      }
    }

    const stays = (id && reservations.get(id)) || [];
    if (stays.length > 0) contributed.reservations = true;

    listings.push({
      ...profile,
      external_listing_id: id,
      import_status: id ? 'ready' : 'needs_verification',
      reservations: stays,
      found: categorize(profile, contributed, stays),
      // Traçabilité : quel fichier de l'export a fourni quel champ. Conservé
      // en base pour le diagnostic, jamais affiché au voyageur.
      import_sources: origin,
    });
  }

  listings.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { listings, sources, warnings, conflicts };
}

/**
 * Ce qui a réellement été trouvé pour CE logement, en catégories lisibles.
 *
 * Chaque case est cochée d'après la présence effective de données, jamais
 * d'après la présence du fichier : un `listing_pricing.json` qui ne parle pas
 * de ce logement ne coche pas « Tarifs ».
 */
function categorize(profile, contributed, stays) {
  const has = (...fields) => fields.some((f) => profile[f] !== undefined && profile[f] !== '');

  return {
    general: has('name', 'description', 'property_type', 'listing_space', 'listing_notes'),
    address: has('address', 'city', 'country', 'latitude'),
    capacity: has('max_guests', 'bedrooms', 'beds', 'bathrooms'),
    amenities: Object.keys(profile).some((k) => k.startsWith('has_') && profile[k] === true),
    rules: has('house_rules', 'allows_pets', 'allows_smoking', 'allows_events'),
    access: has('building_entry', 'house_manual', 'checkin_method', 'check_in_time', 'floor_number'),
    pricing: !!contributed.pricing,
    calendar: Array.isArray(profile.blocked_dates) && profile.blocked_dates.length > 0,
    reviews: !!contributed.reviews,
    reservations: stays.length > 0,
    permits: !!contributed.permits,
  };
}

module.exports = {
  parseExportDocuments,
  parseAirbnbJson,
  isListingFile,
  exportKind,
  isMessageKind,
  reservationIndex,
  hostAccountIds,
  EXPORT_FILES,
  MESSAGE_FILES,
  SENSITIVE_FILE,
  SOURCE_FILES,
  SOURCE_PRIORITY,
  // Exposés pour les tests.
  __profileFromListing: profileFromListing,
  __pricingByListing: pricingByListing,
  __calendarByListing: calendarByListing,
  __permitsByListing: permitsByListing,
  __reviewsByListing: reviewsByListing,
  __reservationsByListing: reservationsByListing,
  __quickRepliesByListing: quickRepliesByListing,
  __mergeConsecutiveDates: mergeConsecutiveDates,
};

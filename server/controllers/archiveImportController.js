const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const { sanitizeString } = require('../utils/sanitize');
const { extractListingsFromUpload } = require('../services/airbnbArchiveImport');
const { ZipError } = require('../services/zipReader');
const { isPlaceholderName } = require('../services/airbnbListingResolver');
const { SOURCE_FILES } = require('../services/airbnbExport');
const { buildContextData, CONTEXT_ONLY_FIELDS } = require('./propertyController');

// Les seuls noms de fichiers qu'une provenance a le droit de citer. Le client
// renvoie cette carte, donc elle est du contenu non fiable comme le reste.
const EXPORT_FILE_NAMES = new Set(Object.values(SOURCE_FILES));

/**
 * Import en masse des logements depuis l'archive de données personnelles Airbnb.
 *
 * PARCOURS
 * --------
 *   1. l'hôte dépose son ZIP           → POST /api/properties/import-archive/preview
 *   2. le serveur lit les 4 fichiers utiles et confronte au déjà-importé
 *   3. l'hôte voit les logements ET ce qui a été trouvé pour chacun
 *   4. un seul clic                    → POST /api/properties/import-archive
 *   5. un résumé indique ce qui a été ajouté, mis à jour, ignoré, en erreur
 *
 * POURQUOI LA FICHE COMPLÈTE TRANSITE PAR LE CLIENT
 * -------------------------------------------------
 * La prévisualisation rend une fiche déjà NORMALISÉE (champs Michel, pas
 * champs Airbnb), et l'import la reçoit en retour. Le serveur ne garde donc
 * rien entre les deux requêtes : pas de cache, pas de fichier temporaire, pas
 * d'état à expirer. En contrepartie ce qui revient est du contenu client, donc
 * non fiable : `validateListing` le repasse intégralement au filtre — clés
 * inconnues jetées, types forcés, longueurs bornées, valeurs de menu
 * vérifiées. Le client ne peut écrire que ce que ce filtre laisse passer.
 *
 * IDEMPOTENCE
 * -----------
 * La déduplication s'appuie sur la contrainte qui existe déjà dans ce schéma :
 * UNIQUE(user_id, airbnb_listing_id) (migration 016), avec `source = 'airbnb'`
 * comme fournisseur. Réimporter le même ZIP met donc à jour, jamais ne
 * duplique. Le contrôle applicatif ci-dessous est doublé par l'interception de
 * la violation d'unicité : sous deux imports simultanés, seule la base arbitre
 * correctement.
 *
 * CE QU'UNE MISE À JOUR NE TOUCHE PAS
 * -----------------------------------
 * Seuls les champs que l'export CONTIENT sont écrits. Le reste de la fiche est
 * laissé tel quel — c'est ce qui préserve le mot de passe Wi-Fi, l'emplacement
 * des clés et le code d'accès, qu'Airbnb n'exporte pas et que l'hôte a saisis à
 * la main. Un nom renommé par l'utilisateur (name_source = 'manual') n'est
 * jamais réécrit non plus.
 *
 * IDENTIFIANT ABSENT
 * ------------------
 * Un logement sans identifiant Airbnb n'est PAS rejeté et son identifiant n'est
 * PAS inventé : il est créé avec import_status = 'needs_verification'
 * (migration 022) et dédupliqué au nom, faute de mieux.
 *
 * VIE PRIVÉE
 * ----------
 * Rien n'est écrit sur le disque : l'archive est traitée en mémoire et le
 * tampon est relâché à la fin de la requête. Seuls les fichiers de la liste
 * blanche sont décompressés (voir services/airbnbExport.js) ; les paiements,
 * les pièces d'identité, l'historique de navigation et les conversations que
 * contient aussi l'archive ne sont jamais ouverts.
 *
 * Des réservations, seuls les FAITS DU SÉJOUR sont retenus — dates, statut,
 * nombre de voyageurs. Le nom du voyageur, son profil et ses messages ne sont
 * ni lus ni enregistrés : Michel a besoin de savoir qu'une date est prise, pas
 * de savoir par qui.
 */

// Valeurs par défaut des seules colonnes NOT NULL, quand l'export ne les porte
// pas. Ce ne sont pas des données : ce sont les valeurs minimales qui
// permettent d'écrire la ligne, que l'hôte corrige ensuite dans le formulaire.
const DEFAULTS = {
  property_type: 'apartment',
  bedrooms: 1,
  beds: 1,
  bathrooms: 1,
  max_guests: 2,
};

// Le menu du formulaire n'offre que ces six valeurs : en écrire une autre
// afficherait un champ vide côté client.
const PROPERTY_TYPES = new Set(['apartment', 'house', 'villa', 'studio', 'loft', 'chalet']);

const NUMBER_COLUMNS = {
  bedrooms: { min: 0, max: 50 },
  beds: { min: 0, max: 100 },
  bathrooms: { min: 0, max: 50 },
  max_guests: { min: 1, max: 100 },
};

const TEXT_COLUMNS = {
  address: 500,
  description: 5000,
  house_rules: 5000,
  city: 255,
  country: 100,
};

// Note moyenne et nombre d'avis, calculés depuis reviews.json. Les colonnes
// existent depuis la migration 008 et n'étaient jusqu'ici jamais remplies.
const RATING_BOUNDS = { min: 1, max: 5 };
const MAX_REVIEW_COUNT = 100000;

// Statuts acceptés par l'énumération de la table `reservations` (migration 001).
const RESERVATION_STATUSES = new Set([
  'pending', 'accepted', 'confirmed', 'checkedin', 'checkedout',
  'cancelled', 'denied', 'expired',
]);
const MAX_RESERVATIONS_PER_LISTING = 200;

// Colonnes booléennes de property_profiles (migration 001). Cette liste est la
// seule autorité : une clé `has_*` absente d'ici n'est pas une colonne et part
// dans context_json, ou nulle part.
const BOOLEAN_COLUMNS = [
  'has_wifi', 'has_kitchen', 'has_parking', 'has_pool', 'has_gym', 'has_tv',
  'has_washing_machine', 'has_air_conditioning', 'has_heating', 'has_workspace',
  'has_hair_dryer', 'has_iron', 'has_bathtub', 'has_dryer', 'has_dishwasher',
  'has_microwave', 'has_refrigerator', 'has_coffee_maker', 'has_smoke_detector',
  'has_carbon_monoxide_detector', 'has_fire_extinguisher', 'has_first_aid_kit',
  'has_bbq', 'has_terrace', 'has_garden', 'has_netflix', 'has_fireplace',
  'allows_pets', 'allows_smoking', 'allows_events',
];

const CONTEXT_FIELDS = new Set(CONTEXT_ONLY_FIELDS);

// Bornes de l'import du calendrier. Une plage bloquée par logement tient dans
// une ligne ; 400 couvre plusieurs années de blocages morcelés.
const MAX_BLOCKS_PER_LISTING = 400;
const BLOCK_SOURCE = 'airbnb_export';

function isUniqueViolation(err) {
  const message = String((err && err.message) || '');
  return (
    err?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err?.code === 'SQLITE_CONSTRAINT' ||
    err?.code === 'ER_DUP_ENTRY' ||
    err?.errno === 1062 ||
    /UNIQUE constraint failed|Duplicate entry/i.test(message)
  );
}

/** Texte nettoyé et borné, ou chaîne vide. Jamais un objet. */
function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return sanitizeString(String(value)).trim().slice(0, max);
}

function cleanNumber(value, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** `YYYY-MM-DD`, et rien d'autre. */
function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Revalide les séjours que le client renvoie.
 *
 * Rien de ce qui touche au voyageur n'est accepté ici, même si le client
 * l'envoie : ni nom, ni adresse de profil, ni message. Seuls les faits du
 * séjour passent, parce que ce sont les seuls dont Michel a besoin pour savoir
 * qu'une date est prise.
 */
function validateReservations(raw) {
  if (!Array.isArray(raw)) return null;      // absent : ne pas toucher aux séjours

  const stays = [];
  for (const entry of raw.slice(0, MAX_RESERVATIONS_PER_LISTING)) {
    if (!entry || typeof entry !== 'object') continue;

    const code = cleanText(entry.confirmation_code, 50);
    const checkIn = entry.check_in_date;
    const checkOut = entry.check_out_date;
    const status = cleanText(entry.status, 30).toLowerCase();

    if (!code || !isIsoDate(checkIn) || !isIsoDate(checkOut)) continue;
    if (checkOut <= checkIn) continue;
    if (!RESERVATION_STATUSES.has(status)) continue;

    stays.push({
      confirmation_code: code,
      check_in_date: checkIn,
      check_out_date: checkOut,
      status,
      number_of_guests: cleanNumber(entry.number_of_guests, { min: 1, max: 100 }) || 1,
    });
  }
  return stays;
}

/**
 * Revalide côté serveur ce que le client renvoie : il vient d'un fichier, donc
 * de nulle part. Tout ce qui n'est pas explicitement autorisé ici est jeté.
 *
 * @returns {object|null} `null` si le logement est inutilisable
 */
function validateListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = cleanText(raw.name, 200);
  if (name.length < 2) return null;

  // Le nom passe le MÊME contrôle que l'import d'une annonce seule.
  //
  // Il ne le passait pas : cette voie acceptait n'importe quelle chaîne de deux
  // caractères, donc les titres qu'Airbnb sert à la place d'une fiche — « 404
  // Page Not Found », « Redirection vers fr.airbnb.com », son titre d'accueil
  // générique — s'inscrivaient tels quels comme nom de logement. Un tel nom ne
  // se voit pas dans la liste : il ressemble à un vrai. Et c'est celui que
  // Michel cite au voyageur.
  if (isPlaceholderName(name, raw.external_listing_id)) return null;

  const idStr = raw.external_listing_id === null || raw.external_listing_id === undefined
    ? ''
    : String(raw.external_listing_id).trim();
  const externalId = /^\d{4,20}$/.test(idStr) ? idStr : null;

  // Une URL n'est conservée que si elle pointe vraiment chez Airbnb : c'est ce
  // qui empêche l'archive (ou un client modifié) d'implanter un lien arbitraire
  // dans la fiche du logement.
  let url = null;
  if (typeof raw.url === 'string' && /^https:\/\/([a-z0-9-]+\.)*airbnb\.[a-z.]+\//i.test(raw.url)) {
    url = raw.url.slice(0, 500);
  } else if (externalId) {
    // L'export ne porte pas d'URL d'annonce : celle-ci se déduit de
    // l'identifiant, elle n'est pas devinée.
    url = `https://www.airbnb.fr/rooms/${externalId}`;
  }

  // Le client peut signaler qu'il a POSÉ le nom faute de mieux (scan de profil
  // dont Airbnb masque le titre). Un tel logement ne doit pas être présenté
  // comme vérifié, même quand son identifiant Airbnb, lui, est certain.
  const provisional = raw.name_provisional === true;

  const listing = {
    name,
    external_listing_id: externalId,
    url,
    import_status: externalId && !provisional ? 'ready' : 'needs_verification',
    columns: {},
    context: {},
    blocked_dates: [],
  };

  // ── Colonnes ──────────────────────────────────────────────────────────
  const type = cleanText(raw.property_type, 100).toLowerCase();
  if (PROPERTY_TYPES.has(type)) listing.columns.property_type = type;

  for (const [key, bounds] of Object.entries(NUMBER_COLUMNS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const n = cleanNumber(raw[key], bounds);
    if (n !== null) listing.columns[key] = n;
  }

  for (const [key, max] of Object.entries(TEXT_COLUMNS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = cleanText(raw[key], max);
    if (value) listing.columns[key] = value;
  }

  for (const key of BOOLEAN_COLUMNS) {
    if (typeof raw[key] !== 'boolean') continue;
    listing.columns[key] = raw[key];
  }

  // Note moyenne et nombre d'avis : calculés sur reviews.json, donc écrits
  // seulement si le calcul a réellement eu lieu.
  const rating = Number(raw.rating);
  const reviewCount = cleanNumber(raw.review_count, { min: 0, max: MAX_REVIEW_COUNT });
  if (Number.isFinite(rating) && rating >= RATING_BOUNDS.min && rating <= RATING_BOUNDS.max
      && reviewCount !== null && reviewCount > 0) {
    listing.columns.rating = Math.round(rating * 100) / 100;
    listing.columns.review_count = reviewCount;
  }

  // ── Champs de contexte ────────────────────────────────────────────────
  // Bornés à la liste que le formulaire connaît : une clé inventée par un
  // client modifié n'entre pas dans context_json.
  for (const key of CONTEXT_FIELDS) {
    if (key === 'import_sources') continue;      // traité juste après
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') {
      listing.context[key] = value;
    } else if (typeof value !== 'object') {
      const text = cleanText(value, 4000);
      if (text) listing.context[key] = text;
    }
  }

  // ── Traçabilité ───────────────────────────────────────────────────────
  // Une carte { champ → fichier d'origine }, réduite aux champs réellement
  // écrits et aux noms de fichiers de l'export. Sert au diagnostic, jamais à
  // l'affichage, et n'est donc pas un champ du formulaire.
  const provenance = {};
  if (raw.import_sources && typeof raw.import_sources === 'object' && !Array.isArray(raw.import_sources)) {
    for (const [field, file] of Object.entries(raw.import_sources)) {
      if (!EXPORT_FILE_NAMES.has(file)) continue;
      if (listing.columns[field] === undefined && listing.context[field] === undefined
          && field !== 'name' && field !== 'airbnb_listing_id') continue;
      provenance[field] = file;
    }
  }
  if (Object.keys(provenance).length > 0) {
    listing.context.import_sources = JSON.stringify(provenance).slice(0, 4000);
  }

  // ── Calendrier ────────────────────────────────────────────────────────
  //
  // La PRÉSENCE du tableau, et non son contenu, dit si cet import parle du
  // calendrier. La distinction compte : un tableau vide signifie « le
  // calendrier a été lu, plus rien n'est bloqué » et doit effacer les blocages
  // précédents, alors qu'un import qui ne parle pas du calendrier (le scan de
  // profil, qui ne rend qu'un nom et un lien) ne doit toucher à rien.
  listing.has_calendar = Array.isArray(raw.blocked_dates);
  if (listing.has_calendar) {
    for (const block of raw.blocked_dates.slice(0, MAX_BLOCKS_PER_LISTING)) {
      if (!block || typeof block !== 'object') continue;
      const { start_date: start, end_date: end } = block;
      if (!isIsoDate(start) || !isIsoDate(end) || end <= start) continue;
      listing.blocked_dates.push({ start_date: start, end_date: end });
    }
  }

  // ── Séjours ───────────────────────────────────────────────────────────
  // Même règle que pour le calendrier : c'est la PRÉSENCE du tableau qui dit
  // si cet import parle des réservations.
  listing.reservations = validateReservations(raw.reservations);

  return listing;
}

/**
 * POST /api/properties/import-archive/preview
 * Corps : le fichier brut, ZIP d'archive Airbnb ou JSON déjà décompressé.
 *
 * Le format est reconnu au CONTENU et non à l'extension : l'hôte qui a
 * décompressé son export, ou n'a gardé que le fichier des annonces, n'a pas à
 * le remettre dans un ZIP pour être servi.
 */
async function previewArchive(req, res) {
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({
      error: "Aucun fichier reçu. Déposez l'archive ZIP de vos données Airbnb, ou le fichier JSON qu'elle contient.",
    });
  }

  let extracted;
  try {
    // Le nom d'origine n'est pas transmis : l'ajouter en en-tete imposerait un
    // pre-vol CORS pour un simple libelle de diagnostic.
    extracted = extractListingsFromUpload(buffer);
  } catch (err) {
    if (err instanceof ZipError) {
      // Le code de l'archive est utile au client ; son CONTENU n'est jamais
      // renvoyé ni journalisé.
      logger.warn(`Import archive refusé (user ${req.userId}) : ${err.code}`);
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error('Import archive: lecture impossible:', err.message);
    return res.status(400).json({ error: 'Fichier illisible.' });
  }

  const db = getDatabase();
  const existing = await db.query(
    'SELECT id, name, airbnb_listing_id FROM property_profiles WHERE user_id = ?',
    [req.userId]
  );
  const byListingId = new Map(
    existing.filter((p) => p.airbnb_listing_id).map((p) => [String(p.airbnb_listing_id), p])
  );
  const byName = new Map(existing.map((p) => [String(p.name).toLowerCase().trim(), p]));

  const listings = extracted.listings.map((listing) => {
    const match = listing.external_listing_id
      ? byListingId.get(listing.external_listing_id)
      : byName.get(listing.name.toLowerCase().trim());
    return {
      ...listing,
      already_imported: !!match,
      existing_property_id: match ? match.id : null,
    };
  });

  logger.info(
    `Import archive (user ${req.userId}) : ${listings.length} logement(s) détecté(s) ` +
    `dans ${extracted.jsonFiles} fichier(s) JSON`
  );

  return res.json({
    listings,
    total: listings.length,
    already_imported: listings.filter((l) => l.already_imported).length,
    needs_verification: listings.filter((l) => l.import_status === 'needs_verification').length,
    // Quels fichiers de l'export ont réellement servi : l'interface s'en sert
    // pour dire ce qu'elle a trouvé, sans le promettre à l'avance.
    sources: extracted.sources || null,
    // Désaccords entre deux fichiers de l'export sur un même champ. La valeur
    // de la source la plus autoritative a été gardée ; ceci dit laquelle a été
    // écartée, pour que le choix soit vérifiable et non subi.
    conflicts: (extracted.conflicts || []).slice(0, 50),
    warnings: extracted.warnings,
    // Sert uniquement au diagnostic quand rien n'est détecté : ce sont des noms
    // de fichiers de l'archive, pas leur contenu.
    scanned_files: extracted.scannedFiles.slice(0, 40),
  });
}

/**
 * POST /api/properties/import-archive
 * Corps JSON : { listings: [ fiche normalisée ] }
 */
async function bulkImport(req, res) {
  const input = Array.isArray(req.body?.listings) ? req.body.listings : null;
  if (!input) {
    return res.status(400).json({ error: 'Aucun logement à importer.' });
  }
  if (input.length > 500) {
    return res.status(400).json({ error: 'Trop de logements en une seule opération (maximum 500).' });
  }

  const db = getDatabase();
  const summary = { created: [], updated: [], skipped: [], failed: [] };

  for (const raw of input) {
    const listing = validateListing(raw);
    if (!listing) {
      // Un logement invalide n'interrompt PAS les autres.
      summary.failed.push({
        name: typeof raw?.name === 'string' ? raw.name.slice(0, 80) : '(sans nom)',
        reason: "Nom de logement inutilisable. Airbnb n'a pas renvoyé le vrai titre de l'annonce.",
      });
      continue;
    }

    try {
      const outcome = await importOne(db, req.userId, listing);
      summary[outcome.status].push({
        name: listing.name,
        id: outcome.id,
        external_listing_id: listing.external_listing_id,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      });
    } catch (err) {
      // Chaque logement est écrit indépendamment : un échec n'a rien laissé à
      // moitié fait, et les suivants continuent. Une transaction globale
      // annulerait au contraire l'import entier pour une seule ligne.
      logger.error(`Import archive: échec sur un logement (user ${req.userId}): ${err.message}`);
      summary.failed.push({ name: listing.name, reason: "Erreur d'enregistrement." });
    }
  }

  logger.info(
    `Import archive terminé (user ${req.userId}) : ${summary.created.length} ajouté(s), ` +
    `${summary.updated.length} mis à jour, ${summary.skipped.length} ignoré(s), ` +
    `${summary.failed.length} en erreur`
  );

  return res.status(200).json({
    success: true,
    summary: {
      created: summary.created.length,
      updated: summary.updated.length,
      skipped: summary.skipped.length,
      failed: summary.failed.length,
    },
    details: summary,
  });
}

/**
 * Crée ou met à jour UN logement. Idempotent par (user_id, airbnb_listing_id),
 * ou par nom quand l'archive ne portait aucun identifiant.
 *
 * @returns {{status: 'created'|'updated'|'skipped', id: number|null, reason?: string}}
 */
async function importOne(db, userId, listing) {
  // Les deux requêtes de recherche filtrent sur user_id : un logement d'un
  // autre compte ne peut être ni trouvé, ni mis à jour, ni fusionné.
  //
  // La fiche entière est relue, et pas seulement son identifiant : le contexte
  // est reconstruit par `buildContextData`, qui compose des listes lisibles
  // (« Wi-Fi, Cuisine équipée, Piscine ») à partir de TOUTES les colonnes. Ne
  // lui donner que les colonnes de l'import effacerait de ces listes les
  // équipements que l'hôte avait cochés lui-même.
  const existing = listing.external_listing_id
    ? await db.query(
        'SELECT * FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ?',
        [userId, listing.external_listing_id]
      )
    : await db.query(
        'SELECT * FROM property_profiles WHERE user_id = ? AND LOWER(name) = ?',
        [userId, listing.name.toLowerCase()]
      );

  if (existing.length > 0) {
    const current = existing[0];

    // Sans identifiant, on n'a pas de preuve qu'il s'agit du même logement :
    // on ne touche à rien et on le signale comme déjà présent.
    if (!listing.external_listing_id) {
      return { status: 'skipped', id: current.id, reason: 'Déjà présent (rapproché par le nom).' };
    }

    const fields = [];
    const values = [];

    // Un nom saisi ou confirmé par l'utilisateur ne se réécrit jamais depuis un
    // fichier — même règle que updateFromAirbnb.
    if (current.name_source !== 'manual' && listing.name !== current.name) {
      fields.push('name = ?');
      values.push(listing.name);
    }
    for (const [column, value] of Object.entries(listing.columns)) {
      fields.push(`${column} = ?`);
      values.push(value);
    }
    if (listing.url) {
      fields.push('source_url = COALESCE(source_url, ?)');
      values.push(listing.url);
    }

    // Fusion du contexte : ce que l'export apporte écrase la valeur
    // correspondante, tout le reste est conservé. C'est ce qui préserve le mot
    // de passe Wi-Fi, l'emplacement des clés et le code d'accès, qu'Airbnb
    // n'exporte pas et que l'hôte a saisis à la main.
    fields.push('context_json = ?');
    values.push(mergeContext(current.context_json, listing, { ...current, ...listing.columns }));

    fields.push('import_status = ?');
    values.push(listing.import_status);
    fields.push('updated_at = NOW()');

    values.push(current.id, userId);
    await db.query(
      `UPDATE property_profiles SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );

    if (listing.has_calendar) await replaceExportBlocks(db, userId, current.id, listing.blocked_dates);
    await upsertReservations(db, userId, current.id, listing.external_listing_id, listing.reservations);
    return { status: 'updated', id: current.id };
  }

  const columns = { ...DEFAULTS, ...listing.columns };
  const columnNames = Object.keys(columns);
  const placeholders = columnNames.map(() => '?').join(', ');

  try {
    const result = await db.query(
      `INSERT INTO property_profiles
         (user_id, source, source_url, airbnb_listing_id, name, name_source, import_status,
          context_json${columnNames.length ? ', ' + columnNames.join(', ') : ''})
       VALUES (?, 'airbnb', ?, ?, ?, 'airbnb_auto', ?, ?${columnNames.length ? ', ' + placeholders : ''})`,
      [
        userId,
        listing.url,
        listing.external_listing_id,
        listing.name,
        listing.import_status,
        mergeContext(null, listing, { name: listing.name, ...columns }),
        ...columnNames.map((c) => columns[c]),
      ]
    );
    if (listing.has_calendar) await replaceExportBlocks(db, userId, result.insertId, listing.blocked_dates);
    await upsertReservations(db, userId, result.insertId, listing.external_listing_id, listing.reservations);
    return { status: 'created', id: result.insertId };
  } catch (err) {
    // Deux imports simultanés du même ZIP : la base tranche, pas le contrôle
    // applicatif au-dessus, qui est un TOCTOU.
    if (isUniqueViolation(err)) {
      const [row] = await db.query(
        'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ?',
        [userId, listing.external_listing_id]
      );
      return { status: 'skipped', id: row ? row.id : null, reason: 'Déjà importé.' };
    }
    throw err;
  }
}

/**
 * Reconstruit context_json comme le ferait le formulaire.
 *
 * Passer par `buildContextData` plutôt que d'écrire un objet à la main est
 * délibéré : c'est la seule façon que la fiche importée soit relue correctement
 * par le formulaire et par promptBuilder, qui attendent tous deux cette forme
 * exacte (`amenities` en texte, `amenities_detail` en objet, etc.).
 */
function mergeContext(currentJson, listing, columns) {
  let current = {};
  try {
    current = JSON.parse(currentJson || '{}');
  } catch (_) {
    // Contexte illisible : on repart des colonnes plutôt que d'échouer.
  }

  const practical = {};
  for (const key of CONTEXT_ONLY_FIELDS) {
    if (listing.context[key] !== undefined) practical[key] = listing.context[key];
    else if (current[key] !== undefined) practical[key] = current[key];
    else practical[key] = key.startsWith('has_') ? false : '';
  }

  return JSON.stringify(buildContextData({
    ...columns,
    ...practical,
    airbnb_listing_id: listing.external_listing_id || undefined,
    parking_info: practical.parking_info || current.parking || '',
  }));
}

/**
 * Réécrit les indisponibilités venues de l'export, et elles seules.
 *
 * Le filtre sur `source` est ce qui rend l'opération sûre : les blocages saisis
 * à la main et ceux qui viennent d'un calendrier iCal portent une autre source
 * et ne sont jamais supprimés. Réimporter le même export ne crée donc pas de
 * doublon de dates non plus.
 */
/**
 * Enregistre les séjours à venir venus de l'export.
 *
 * UPSERT, jamais de suppression. Un séjour absent du nouvel export ne veut pas
 * dire qu'il est annulé : l'export est un instantané, souvent plus ancien que
 * ce que la synchronisation Gmail a déjà appris. Effacer serait perdre une
 * information plus fraîche que la nôtre.
 *
 * La clé est (user_id, airbnb_reservation_id) — l'index unique posé par la
 * migration 021 — et l'identifiant employé est le code de confirmation, comme
 * le fait déjà airbnbSyncService. Un séjour connu des deux sources converge
 * donc sur la même ligne au lieu d'être dupliqué.
 */
async function upsertReservations(db, userId, propertyId, listingId, stays) {
  if (!propertyId || !Array.isArray(stays) || stays.length === 0) return 0;

  let written = 0;
  for (const stay of stays.slice(0, MAX_RESERVATIONS_PER_LISTING)) {
    const existing = await db.query(
      'SELECT id FROM reservations WHERE user_id = ? AND airbnb_reservation_id = ?',
      [userId, stay.confirmation_code]
    );

    try {
      if (existing.length > 0) {
        // `property_id` est rattaché s'il manquait, jamais réécrit : la
        // synchronisation peut l'avoir posé sur un logement mieux identifié.
        await db.query(
          `UPDATE reservations
             SET check_in_date = ?, check_out_date = ?, status = ?, number_of_guests = ?,
                 airbnb_listing_id = COALESCE(airbnb_listing_id, ?),
                 property_id = COALESCE(property_id, ?),
                 updated_at = NOW()
           WHERE id = ? AND user_id = ?`,
          [
            stay.check_in_date, stay.check_out_date, stay.status, stay.number_of_guests,
            listingId, propertyId, existing[0].id, userId,
          ]
        );
      } else {
        await db.query(
          `INSERT INTO reservations
             (user_id, property_id, airbnb_reservation_id, airbnb_listing_id, confirmation_code,
              number_of_guests, check_in_date, check_out_date, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId, propertyId, stay.confirmation_code, listingId, stay.confirmation_code,
            stay.number_of_guests, stay.check_in_date, stay.check_out_date, stay.status,
          ]
        );
      }
      written += 1;
    } catch (err) {
      // Deux imports simultanés : la base tranche. Le séjour existe déjà, il
      // n'y a rien à réparer.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return written;
}

async function replaceExportBlocks(db, userId, propertyId, blocks) {
  if (!propertyId) return;

  await db.query(
    'DELETE FROM availability_blocks WHERE property_id = ? AND user_id = ? AND source = ?',
    [propertyId, userId, BLOCK_SOURCE]
  );

  for (const block of blocks.slice(0, MAX_BLOCKS_PER_LISTING)) {
    await db.query(
      `INSERT INTO availability_blocks (property_id, user_id, start_date, end_date, reason, source)
       VALUES (?, ?, ?, ?, 'blocked', ?)`,
      [propertyId, userId, block.start_date, block.end_date, BLOCK_SOURCE]
    );
  }
}

module.exports = {
  previewArchive,
  bulkImport,
  // Exposé pour les tests.
  __validateListing: validateListing,
};

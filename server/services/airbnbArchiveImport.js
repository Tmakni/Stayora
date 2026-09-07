const { listEntries, readEntry, ZipError } = require('./zipReader');
const logger = require('../utils/logger');
const {
  parseExportDocuments,
  parseAirbnbJson,
  isListingFile,
  exportKind,
  isMessageKind,
} = require('./airbnbExport');
const { analyzeExportFacts } = require('./airbnbFactAnalysis');

/**
 * Lecture des logements dans l'archive de données personnelles Airbnb.
 *
 * POURQUOI CETTE SOURCE
 * ---------------------
 * Il n'existe pas d'accès officiel à l'API partenaire Airbnb pour ce projet. La
 * seule voie légitime et stable pour récupérer SES logements est donc l'export
 * de données personnelles qu'Airbnb fournit à l'hôte sur demande (format JSON,
 * livré en ZIP). Aucun scraping, aucune API privée, aucun identifiant Airbnb
 * demandé à l'utilisateur.
 *
 * DEUX LECTURES, DANS CET ORDRE
 * -----------------------------
 *   1. STRUCTURÉE (`airbnbExport.js`). L'export réel a une forme connue et
 *      stable : `listings.json` porte les annonces, `listing_pricing.json` les
 *      tarifs, `listing_calendar.json` le calendrier, `listing_permits.json`
 *      les enregistrements. C'est de là que vient TOUT le détail d'une fiche —
 *      description, adresse, capacité, équipements, règles.
 *
 *   2. HEURISTIQUE (ce fichier, plus bas). Si la lecture structurée ne trouve
 *      rien — export d'un autre millésime, fichier renommé, extrait partiel —
 *      on retombe sur la reconnaissance à la FORME : un objet qui porte un nom
 *      d'annonce et quelques indices. Elle ne rend que le nom, l'identifiant
 *      et le lien, mais elle ne dépend d'aucun nom de fichier.
 *
 * L'ordre compte : l'heuristique seule ne voyait qu'une annonce sur cinq de
 * l'export réel, et sous son surnom interne plutôt que son titre (voir l'en-tête
 * de `airbnbExport.js`).
 *
 * VIE PRIVÉE — LISTE BLANCHE
 * --------------------------
 * L'archive contient bien plus que des logements : virements, pièces
 * d'identité, historique de navigation. Seuls les fichiers retenus par
 * `isListingFile` sont DÉCOMPRESSÉS ; les autres ne sont jamais ouverts. Rien
 * n'est écrit sur le disque, et aucun contenu de l'archive n'est journalisé —
 * uniquement des décomptes et des noms de fichiers.
 *
 * `messages.json` fait exception depuis l'ajout de la deuxième couche : il est
 * ouvert, pour les conversations et pour rien d'autre. Il est écarté AVANT la
 * détection de logements (`readDocuments`) et n'alimente que
 * `airbnbFactAnalysis.js`. En pratique le navigateur ne l'envoie même pas : il
 * le réduit d'abord à un condensé des seuls messages de l'hôte
 * (`client/src/lib/airbnbMessageDigest.js`), et le fichier d'origine reste sur
 * la machine de l'hôte.
 */

// Bornes de balayage : une archive légitime tient très largement dedans.
const MAX_JSON_FILES = 400;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
// Les conversations ont leur propre budget, et il est plus large : sur l'export
// de référence `messages.json` pèse 70 Mo à lui seul. Un budget commun l'aurait
// fait manger celui des fichiers de logement, qui sont les plus importants.
//
// Ce chemin ne sert qu'au DÉPÔT DIRECT du fichier brut. Le navigateur envoie
// normalement un condensé de quelques mégaoctets (voir `airbnbMessages.js`).
const MAX_MESSAGE_BYTES = 96 * 1024 * 1024;
const MAX_LISTINGS = 500;
// Profondeur de recherche dans un JSON : au-delà, on n'est plus dans une
// structure de données mais dans du bruit.
const MAX_DEPTH = 8;

const ID_KEYS = [
  'listing_id', 'listingid', 'room_id', 'roomid', 'id_annonce', 'annonce_id',
  'listing', 'id',
];
const NAME_KEYS = [
  'listing_name', 'listingname', 'listing_title', 'listingtitle',
  'name', 'title', 'nom', 'titre', 'internal_name', 'internalname',
  'nickname', 'display_name', 'displayname',
];
const URL_KEYS = [
  'listing_url', 'listingurl', 'url', 'link', 'permalink', 'web_url', 'weburl',
];
// Indices qu'un objet parle bien d'un logement et non d'autre chose (un
// paiement, un message, un appareil connecté...).
const LISTING_HINT_KEYS = [
  'listing', 'room', 'property', 'annonce', 'logement', 'bedrooms', 'beds',
  'bathrooms', 'accommodates', 'person_capacity', 'room_type', 'property_type',
  'city', 'country', 'address',
];

/** Clé normalisée : insensible à la casse, aux tirets et aux underscores. */
function normKey(key) {
  return String(key).toLowerCase().replace(/[\s_-]/g, '');
}

/** Première valeur non vide parmi une liste de clés candidates. */
function firstValue(obj, candidateKeys) {
  const index = new Map();
  for (const key of Object.keys(obj)) index.set(normKey(key), obj[key]);
  for (const candidate of candidateKeys) {
    const value = index.get(normKey(candidate));
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return null;
}

/** Un identifiant Airbnb est un entier ; on refuse tout le reste. */
function normalizeListingId(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!/^\d{4,20}$/.test(str)) return null;
  return str;
}

/** Extrait un identifiant d'annonce d'une URL Airbnb (rooms/<id>). */
function listingIdFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/rooms\/(?:plus\/)?(\d{4,20})/);
  return match ? match[1] : null;
}

function looksLikeListing(obj) {
  const keys = Object.keys(obj).map(normKey);
  const hasName = NAME_KEYS.some((k) => keys.includes(normKey(k)));
  if (!hasName) return false;
  // Un simple {name: "..."} n'est pas un logement : il faut au moins un second
  // signal, sinon toute entrée nommée de l'archive serait proposée à l'import.
  return LISTING_HINT_KEYS.some((k) => keys.includes(normKey(k)));
}

/**
 * Réduit un objet brut aux seuls champs fiables dont l'import a besoin.
 * Tout le reste de l'archive est ignoré, y compris à l'intérieur de cet objet.
 */
function pickListing(obj, sourceFile) {
  const rawId = firstValue(obj, ID_KEYS);
  const name = firstValue(obj, NAME_KEYS);
  const url = firstValue(obj, URL_KEYS);

  if (!name) return null;

  const externalId = normalizeListingId(rawId) || listingIdFromUrl(url);

  return {
    external_listing_id: externalId,
    name: name.slice(0, 200),
    // Une URL n'est retenue que si elle pointe réellement chez Airbnb : sinon
    // ce n'est pas l'annonce, c'est autre chose qui s'appelait « url ».
    url: url && /(^|\.)airbnb\.[a-z.]+\//i.test(url) ? url.slice(0, 500) : null,
    // Un logement sans identifiant Airbnb ne peut pas être dédupliqué de façon
    // fiable, et l'inventer serait pire que de ne rien mettre : il part en
    // vérification et l'utilisateur tranche.
    import_status: externalId ? 'ready' : 'needs_verification',
    source_file: sourceFile,
  };
}

/** Parcourt une valeur JSON et collecte tout ce qui ressemble à un logement. */
function collectListings(value, sourceFile, out, depth = 0) {
  if (out.length >= MAX_LISTINGS) return;
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;

  if (Array.isArray(value)) {
    for (const item of value) collectListings(item, sourceFile, out, depth + 1);
    return;
  }

  if (looksLikeListing(value)) {
    const picked = pickListing(value, sourceFile);
    if (picked) {
      out.push(picked);
      // On ne descend pas dans un objet déjà reconnu : ses sous-objets
      // (hôte, tarifs, photos) ne sont pas des logements.
      return;
    }
  }

  for (const key of Object.keys(value)) {
    collectListings(value[key], sourceFile, out, depth + 1);
  }
}

/**
 * Déduplique à l'intérieur de l'archive elle-même.
 * Un même logement apparaît souvent dans plusieurs fichiers de l'export.
 */
function dedupe(listings) {
  const byId = new Map();
  const byName = new Map();
  const result = [];

  for (const listing of listings) {
    if (listing.external_listing_id) {
      const existing = byId.get(listing.external_listing_id);
      if (existing) {
        // Garder la version la plus complète.
        if (!existing.url && listing.url) existing.url = listing.url;
        continue;
      }
      byId.set(listing.external_listing_id, listing);
      result.push(listing);
      continue;
    }

    const key = listing.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (byName.has(key)) continue;
    byName.set(key, listing);
    result.push(listing);
  }

  // Les logements identifiés d'abord : ce sont ceux que l'import sait
  // dédupliquer entre deux exécutions.
  return result.sort((a, b) => {
    if (!!a.external_listing_id !== !!b.external_listing_id) return a.external_listing_id ? -1 : 1;
    return a.name.localeCompare(b.name, 'fr');
  });
}

/**
 * Lit une archive Airbnb et rend les logements détectés.
 *
 * @param {Buffer} buffer contenu du ZIP
 * @returns {{listings: Array, scannedFiles: string[], jsonFiles: number, warnings: string[]}}
 * @throws {ZipError} archive invalide, dangereuse ou hors limites
 */
function extractListingsFromArchive(buffer) {
  const entries = listEntries(buffer);
  const warnings = [];

  const jsonEntries = entries.filter((e) => /\.json$/i.test(e.name));
  if (jsonEntries.length === 0) {
    throw new ZipError(
      "Cette archive ne contient aucun fichier JSON. Demandez votre export Airbnb au format JSON (et non HTML/CSV), puis déposez le ZIP tel quel.",
      'NO_JSON'
    );
  }

  // LISTE BLANCHE. Sur l'export réel, cela ramène 28 fichiers à 4 — et laisse
  // fermés `messages.json` (70 Mo de conversations), `activity_log.json`,
  // `payment_processing.json`, `id_verification.json` et le reste. Ces
  // fichiers ne sont pas seulement écartés du résultat : ils ne sont jamais
  // décompressés.
  const relevant = jsonEntries.filter((e) => isListingFile(e.name)).slice(0, MAX_JSON_FILES);
  // Les conversations ne comptent pas : elles enrichissent des logements, elles
  // n'en produisent aucun. Une archive qui n'aurait que `messages.json` reste
  // donc refusée, comme avant.
  if (relevant.every((e) => isMessageKind(exportKind(e.name)))) {
    throw new ZipError(
      "Cette archive ne contient aucun fichier de logement (listings.json et compagnie). "
      + "Vérifiez qu'il s'agit bien de l'export de vos données Airbnb.",
      'NO_LISTING_FILE'
    );
  }

  // Les fichiers structurés connus d'abord : `listings.json` est la source, et
  // la lire en premier évite de garder les autres en mémoire pour rien si elle
  // est absente.
  const ordered = [
    ...relevant.filter((e) => exportKind(e.name)),
    ...relevant.filter((e) => !exportKind(e.name)),
  ];

  const documents = [];
  const scannedFiles = [];
  let bytesRead = 0;
  let messageBytesRead = 0;

  for (const entry of ordered) {
    const isMessages = isMessageKind(exportKind(entry.name));

    if (!isMessages && bytesRead >= MAX_JSON_BYTES) {
      warnings.push("Archive volumineuse : la lecture a été bornée, certains fichiers JSON n'ont pas été examinés.");
      break;
    }
    if (isMessages && messageBytesRead >= MAX_MESSAGE_BYTES) {
      // Les conversations sont un ENRICHISSEMENT : les écarter ne compromet
      // aucun logement, alors qu'interrompre l'import les perdrait tous.
      warnings.push('Fichier de conversations trop volumineux : il a été ignoré, les logements sont importés sans lui.');
      continue;
    }

    let text;
    try {
      const content = readEntry(buffer, entry);
      if (isMessages) messageBytesRead += content.length;
      else bytesRead += content.length;
      text = content.toString('utf8');
    } catch (err) {
      // Un fichier illisible ne doit pas faire échouer tout l'import : les
      // autres logements restent importables.
      warnings.push(`Fichier ignoré (illisible) : ${entry.name}`);
      continue;
    }

    try {
      documents.push({ name: entry.name, data: parseAirbnbJson(text) });
      scannedFiles.push(entry.name);
    } catch (_) {
      warnings.push(`Fichier ignoré (JSON invalide) : ${entry.name}`);
    }
  }

  const result = readDocuments(documents, warnings);
  return { ...result, scannedFiles, jsonFiles: jsonEntries.length };
}

/**
 * Lecture structurée d'abord, heuristique ensuite.
 *
 * Les deux ne sont pas interchangeables : la structurée rend une fiche
 * complète, l'heuristique un nom et un identifiant. On ne bascule donc sur la
 * seconde que si la première n'a RIEN trouvé — sur un export d'un autre
 * millésime, ou sur un extrait que l'hôte a renommé.
 *
 * @param {Array<{name: string, data: any}>} documents
 * @param {string[]} warnings enrichi au passage
 */
function readDocuments(documents, warnings, options = {}) {
  // Les conversations sont mises de côté AVANT toute détection de logement.
  //
  // Ce n'est pas un détail de rangement : sans cette séparation, un
  // `messages.json` finirait dans l'heuristique de forme, qui reconnaît un
  // logement à la présence d'un nom et de quelques indices. Un message de
  // voyageur portant un prénom et le mot « chambre » deviendrait un logement
  // nommé « Florine ». Les conversations n'ont qu'un seul usage, et il est
  // ailleurs.
  const listingDocuments = (Array.isArray(documents) ? documents : [])
    .filter((d) => d && !isMessageKind(exportKind(d.name)));

  const structured = parseExportDocuments(listingDocuments, options);
  warnings.push(...structured.warnings);

  if (structured.listings.length > 0) {
    const listings = structured.listings.slice(0, MAX_LISTINGS);
    if (structured.listings.length > MAX_LISTINGS) {
      warnings.push(`Limite de ${MAX_LISTINGS} logements atteinte : les suivants ont été ignorés.`);
    }

    // Deuxième couche : ce que les conversations de l'hôte apprennent en plus.
    // Elle ne modifie AUCUN champ de la fiche — elle attache des faits, avec
    // leur statut et leurs preuves, que l'utilisateur confirmera ou non.
    // Un échec ici ne doit pas emporter l'import des logements, qui est le
    // service principal.
    let analysis = { byListing: new Map(), available: false, stats: null };
    try {
      analysis = analyzeExportFacts(documents, listings, options);
    } catch (err) {
      warnings.push("Les conversations n'ont pas pu être analysées ; les logements sont importés sans elles.");
      logger.warn(`Analyse des conversations impossible : ${err.message}`);
    }

    for (const listing of listings) {
      const found = analysis.byListing.get(String(listing.airbnb_listing_id));
      listing.facts = found ? found.facts : [];
      listing.fact_stats = found ? { ...found.stats, tier: found.tier } : null;
      listing.found = { ...listing.found, facts: !!(found && found.facts.length > 0) };
    }

    // Décompte uniquement : le CONTENU de l'export n'est jamais journalisé.
    logger.info(
      `Import Airbnb (lecture structurée) : ${listings.length} logement(s), `
      + `sources ${Object.entries(structured.sources).filter(([, v]) => v).map(([k]) => k).join(', ') || 'aucune'}`
    );
    return {
      listings,
      warnings,
      sources: { ...structured.sources, messages: analysis.available },
      conflicts: structured.conflicts,
      fact_analysis: analysis.stats,
    };
  }

  const collected = [];
  for (const document of listingDocuments) {
    collectListings(document.data, document.name, collected);
    if (collected.length >= MAX_LISTINGS) {
      warnings.push(`Limite de ${MAX_LISTINGS} logements atteinte : les suivants ont été ignorés.`);
      break;
    }
  }

  const listings = dedupe(collected).slice(0, MAX_LISTINGS).map((listing) => ({
    ...listing,
    // Même forme que la lecture structurée, pour que l'interface n'ait pas à
    // distinguer les deux. L'heuristique ne rend qu'un nom et un identifiant :
    // une seule catégorie est donc cochée, et c'est la vérité.
    found: {
      general: true, address: false, capacity: false, amenities: false,
      rules: false, access: false, pricing: false, calendar: false,
      reviews: false, reservations: false, permits: false, facts: false,
    },
    facts: [],
    fact_stats: null,
  }));

  logger.info(`Import Airbnb (lecture par forme) : ${listings.length} logement(s) détecté(s)`);
  return {
    listings,
    warnings,
    conflicts: [],
    sources: {
      listings: listings.length > 0,
      pricing: false, calendar: false, permits: false,
      reviews: false, reservations: false, quickreplies: false, messages: false,
    },
    fact_analysis: null,
  };
}

/**
 * Lit un fichier JSON Airbnb SEUL, hors archive.
 *
 * POURQUOI CE CHEMIN EN PLUS DU ZIP
 * ---------------------------------
 * Airbnb livre l'export en ZIP, mais l'hôte le décompresse souvent avant de
 * revenir sur l'application, ou ne conserve que le fichier des annonces. Lui
 * répondre « déposez le ZIP, sans le décompresser » est un mur inutile : le
 * contenu à lire est exactement le même. Ce chemin accepte donc le .json
 * directement, et passe au MÊME détecteur de logements que l'archive — il n'y
 * a pas deux logiques d'extraction à maintenir.
 *
 * @param {Buffer} buffer contenu du fichier JSON
 * @param {string} [fileName] nom affiché dans les diagnostics
 * @returns {{listings: Array, scannedFiles: string[], jsonFiles: number, warnings: string[]}}
 * @throws {ZipError} fichier vide, trop volumineux ou JSON invalide
 */
function extractListingsFromJson(buffer, fileName = 'export.json') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ZipError('Fichier vide.', 'EMPTY');
  }
  if (buffer.length > MAX_JSON_BYTES) {
    throw new ZipError(
      `Fichier JSON trop volumineux (maximum ${Math.floor(MAX_JSON_BYTES / (1024 * 1024))} Mo).`,
      'TOO_LARGE'
    );
  }

  let parsed;
  try {
    parsed = parseAirbnbJson(buffer.toString('utf8'));
  } catch (_) {
    throw new ZipError(
      "Ce fichier n'est pas un JSON valide. Déposez le fichier tel qu'Airbnb l'a fourni, ou le ZIP complet.",
      'INVALID_JSON'
    );
  }

  const warnings = [];
  const result = readDocuments([{ name: fileName, data: parsed }], warnings);

  return { ...result, scannedFiles: [fileName], jsonFiles: 1 };
}

/** Le tampon est-il une archive ZIP ? (signature locale « PK ») */
function looksLikeZip(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  );
}

/**
 * Point d'entrée unique de l'import de fichier : reconnaît un ZIP ou un JSON
 * d'après son CONTENU, pas d'après son extension. Un fichier renommé, ou
 * envoyé par un client modifié, est donc traité pour ce qu'il est réellement.
 *
 * @param {Buffer} buffer
 * @param {string} [fileName] nom d'origine, à titre indicatif seulement
 */
function extractListingsFromUpload(buffer, fileName = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ZipError('Fichier vide.', 'EMPTY');
  }
  return looksLikeZip(buffer)
    ? extractListingsFromArchive(buffer)
    : extractListingsFromJson(buffer, fileName || 'export.json');
}

module.exports = {
  extractListingsFromArchive,
  extractListingsFromJson,
  extractListingsFromUpload,
  readDocuments,
  looksLikeZip,
  // Exposés pour les tests et pour un futur ajustement au vu d'un export réel.
  __pickListing: pickListing,
  __collectListings: collectListings,
  __dedupe: dedupe,
  __normalizeListingId: normalizeListingId,
  MAX_LISTINGS,
};

const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const { sanitizeString } = require('../utils/sanitize');
const { extractListingsFromUpload } = require('../services/airbnbArchiveImport');
const { ZipError } = require('../services/zipReader');
const { isPlaceholderName } = require('../services/airbnbListingResolver');

/**
 * Import en masse des logements depuis l'archive de données personnelles Airbnb.
 *
 * PARCOURS
 * --------
 *   1. l'hôte dépose son ZIP           → POST /api/properties/import-archive/preview
 *   2. le serveur détecte les logements et les confronte à ce qui existe déjà
 *   3. l'hôte voit le nombre et les noms, tout est sélectionné par défaut
 *   4. un seul clic                    → POST /api/properties/import-archive
 *   5. un résumé indique ce qui a été ajouté, mis à jour, ignoré, en erreur
 *
 * IDEMPOTENCE
 * -----------
 * La déduplication s'appuie sur la contrainte qui existe déjà dans ce schéma :
 * UNIQUE(user_id, airbnb_listing_id) (migration 016), avec `source = 'airbnb'`
 * comme fournisseur. Réimporter le même ZIP met donc à jour ou ignore, jamais
 * ne duplique. Le contrôle applicatif ci-dessous est doublé par l'interception
 * de la violation d'unicité : sous deux imports simultanés, seule la base
 * arbitre correctement.
 *
 * IDENTIFIANT ABSENT
 * ------------------
 * Un logement sans identifiant Airbnb n'est PAS rejeté et son identifiant n'est
 * PAS inventé : il est créé avec import_status = 'needs_verification'
 * (migration 022) et dédupliqué au nom, faute de mieux. La stratégie est
 * volontairement prudente et visible plutôt que silencieuse.
 *
 * VIE PRIVÉE
 * ----------
 * Rien n'est écrit sur le disque : l'archive est traitée en mémoire et le
 * tampon est relâché à la fin de la requête. Seuls les champs de logement sont
 * lus ; les messages, paiements et données de compte que contient aussi
 * l'archive ne sont ni extraits ni journalisés.
 */

// Ce que l'import écrit, et rien d'autre. Les valeurs par défaut ne servent
// qu'à satisfaire les colonnes NOT NULL du schéma : l'hôte complète ensuite
// dans le formulaire, où la sauvegarde automatique prend le relais.
const DEFAULTS = {
  property_type: 'apartment',
  bedrooms: 1,
  beds: 1,
  bathrooms: 1,
  max_guests: 2,
};

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

/** Revalide côté serveur ce que le client renvoie : il vient d'un fichier. */
function validateListing(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = sanitizeString(String(raw.name || '')).trim().slice(0, 200);
  if (name.length < 2) return null;

  // Le nom passe le MÊME contrôle que l'import d'une annonce seule.
  //
  // Il ne le passait pas : cette voie acceptait n'importe quelle chaîne de deux
  // caractères, donc les titres qu'Airbnb sert à la place d'une fiche — « 404
  // Page Not Found », « Redirection vers fr.airbnb.com », son titre d'accueil
  // générique — s'inscrivaient tels quels comme nom de logement. Un tel nom ne
  // se voit pas dans la liste : il ressemble à un vrai. Et c'est celui que
  // Michel cite au voyageur.
  //
  // Mieux vaut refuser le logement et le dire que d'en créer un mal nommé.
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
  }

  // Le client peut signaler qu'il a POSÉ le nom faute de mieux (scan de profil
  // dont Airbnb masque le titre). Un tel logement ne doit pas être présenté
  // comme vérifié, même quand son identifiant Airbnb, lui, est certain.
  const provisional = raw.name_provisional === true;

  return {
    name,
    external_listing_id: externalId,
    url,
    import_status: externalId && !provisional ? 'ready' : 'needs_verification',
  };
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
    warnings: extracted.warnings,
    // Sert uniquement au diagnostic quand rien n'est détecté : ce sont des noms
    // de fichiers de l'archive, pas leur contenu.
    scanned_files: extracted.scannedFiles.slice(0, 40),
  });
}

/**
 * POST /api/properties/import-archive
 * Corps JSON : { listings: [{ name, external_listing_id, url }] }
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
      // Chaque logement est écrit par une instruction unique : un échec n'a rien
      // laissé à moitié fait, et les suivants continuent. Une transaction
      // globale annulerait au contraire l'import entier pour une seule ligne.
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
  const existing = listing.external_listing_id
    ? await db.query(
        'SELECT id, name, name_source FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ?',
        [userId, listing.external_listing_id]
      )
    : await db.query(
        'SELECT id, name, name_source FROM property_profiles WHERE user_id = ? AND LOWER(name) = ?',
        [userId, listing.name.toLowerCase()]
      );

  if (existing.length > 0) {
    const current = existing[0];

    // Sans identifiant, on n'a pas de preuve qu'il s'agit du même logement :
    // on ne touche à rien et on le signale comme déjà présent.
    if (!listing.external_listing_id) {
      return { status: 'skipped', id: current.id, reason: 'Déjà présent (rapproché par le nom).' };
    }

    // Un nom saisi ou confirmé par l'utilisateur ne se réécrit jamais depuis un
    // fichier — même règle que updateFromAirbnb.
    const fields = [];
    const values = [];
    if (current.name_source !== 'manual' && listing.name !== current.name) {
      fields.push('name = ?');
      values.push(listing.name);
    }
    if (listing.url) {
      fields.push('source_url = COALESCE(source_url, ?)');
      values.push(listing.url);
    }
    fields.push('import_status = ?');
    values.push(listing.import_status);
    fields.push('updated_at = NOW()');

    values.push(current.id, userId);
    await db.query(
      `UPDATE property_profiles SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );
    return { status: 'updated', id: current.id };
  }

  try {
    const result = await db.query(
      `INSERT INTO property_profiles
         (user_id, source, source_url, airbnb_listing_id, name, name_source, import_status,
          property_type, bedrooms, beds, bathrooms, max_guests)
       VALUES (?, 'airbnb', ?, ?, ?, 'airbnb_auto', ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        listing.url,
        listing.external_listing_id,
        listing.name,
        listing.import_status,
        DEFAULTS.property_type,
        DEFAULTS.bedrooms,
        DEFAULTS.beds,
        DEFAULTS.bathrooms,
        DEFAULTS.max_guests,
      ]
    );
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

module.exports = {
  previewArchive,
  bulkImport,
};

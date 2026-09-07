/**
 * Deuxième couche de l'import : ce que les conversations de l'hôte ajoutent aux
 * fichiers structurés.
 *
 * La première couche (`airbnbExport.js`) lit `listings.json` et compagnie et
 * remplit la fiche. Elle laisse forcément des trous : l'heure d'arrivée réelle,
 * l'emplacement du parking, l'endroit où se trouve la boîte à clés ne sont dans
 * AUCUN fichier de l'export. Ils sont dans ce que l'hôte écrit à ses voyageurs,
 * séjour après séjour.
 *
 * Cette couche ne remplace jamais la première. Elle n'écrit rien non plus
 * directement : elle produit des FAITS avec un statut, et c'est le statut qui
 * décide de ce qui peut être appliqué automatiquement (rien de sensible, rien
 * de contredit, rien sur un logement sans historique) et de ce qui part en
 * confirmation.
 *
 * L'ENCHAÎNEMENT
 * --------------
 *   conversations
 *     → rattachement certain à un logement        (airbnbMessages.js)
 *     → extraction de candidats, phrase par phrase (factExtraction.js)
 *     → comptage, temporalité, contradictions      (factAggregation.js)
 *     → faits, avec statut et traçabilité          (ici)
 *
 * Chaque maillon peut ne rien rendre. Un logement sans conversation
 * rattachable, ou dont les phrases ne contiennent aucune valeur littérale, sort
 * de cette couche exactement comme il y est entré.
 */

const logger = require('../utils/logger');
const {
  exportKind, isMessageKind, reservationIndex, hostAccountIds,
} = require('./airbnbExport');
const { reduceThreads, parseDigest, wrapDigest } = require('./airbnbMessages');
const { aggregateFacts } = require('./factAggregation');
const { FACT_KEYS } = require('./factExtraction');

/**
 * @param {Array<{name: string, data: any}>} documents documents déjà analysés
 * @param {Array} listings fiches rendues par `parseExportDocuments`
 * @param {object} [options]
 * @param {Date} [options.today]
 * @returns {{byListing: Map<string, object>, stats: object, available: boolean}}
 */
function analyzeExportFacts(documents, listings, options = {}) {
  const docs = Array.isArray(documents) ? documents : [];
  const today = options.today || new Date();

  const messageDocs = [];
  let listingsDoc = null;
  let reservationsDoc = null;

  for (const document of docs) {
    if (!document) continue;
    const kind = exportKind(document.name) || kindOfContent(document.data);
    if (isMessageKind(kind)) { messageDocs.push({ kind, data: document.data }); continue; }
    if (kind === 'listings' && !listingsDoc) listingsDoc = document.data;
    if (kind === 'reservations' && !reservationsDoc) reservationsDoc = document.data;
  }

  const empty = {
    byListing: new Map(),
    available: false,
    stats: {
      threads_total: 0, threads_linked: 0, threads_unlinked: 0,
      host_messages: 0, guest_messages: 0, candidates: 0, exceptions: 0,
      listings_with_facts: 0, facts_total: 0,
    },
  };

  if (messageDocs.length === 0) return empty;
  if (!reservationsDoc) {
    // Sans `reservations.json`, aucun code de confirmation ne mène à un
    // logement. Rattacher au jugé — par ressemblance de nom, par exemple —
    // serait exactement ce que le cahier des charges interdit.
    logger.info('Analyse des conversations ignorée : reservations.json absent, aucun rattachement certain possible.');
    return empty;
  }

  const index = reservationIndex(reservationsDoc);
  const knownListingIds = new Set(
    (Array.isArray(listings) ? listings : [])
      .map((l) => l && l.airbnb_listing_id)
      .filter(Boolean)
      .map(String)
  );
  if (index.size === 0 || knownListingIds.size === 0) return empty;

  // Les identifiants de l'hôte viennent des annonces elles-mêmes. Sans eux, le
  // condensé brut ne retient aucun corps de message.
  const hosts = listingsDoc ? hostAccountIds(listingsDoc) : new Set();

  const threads = [];
  let threadsSeen = 0;
  for (const document of messageDocs) {
    if (document.kind === 'messagedigest') {
      const parsed = parseDigest(document.data);
      threads.push(...parsed.threads);
      threadsSeen += parsed.threads_seen;
      continue;
    }
    if (hosts.size === 0) {
      logger.info("Analyse des conversations ignorée : l'identifiant de l'hôte est introuvable dans listings.json.");
      continue;
    }
    const parsed = parseDigest(wrapDigest(reduceThreads(document.data, { hostAccountIds: hosts })));
    threads.push(...parsed.threads);
    threadsSeen += parsed.threads_seen;
  }

  if (threads.length === 0) return empty;

  // Import tardif pour éviter un cycle : airbnbMessages a besoin de
  // factExtraction, qui n'a besoin de personne.
  const { evidenceByListing } = require('./airbnbMessages');
  const { byListing, stats } = evidenceByListing(threads, index, knownListingIds);

  const byId = new Map(
    (Array.isArray(listings) ? listings : [])
      .filter((l) => l && l.airbnb_listing_id)
      .map((l) => [String(l.airbnb_listing_id), l])
  );

  const results = new Map();
  let factsTotal = 0;

  for (const [listingId, entry] of byListing) {
    const profile = byId.get(listingId) || {};
    // Ce que la fiche sait déjà, pour repérer les concordances : une valeur qui
    // dit la même chose que l'export structuré est plus solide qu'une valeur
    // qui n'est portée que par des messages.
    const structuredValues = {};
    for (const key of FACT_KEYS) {
      if (profile[key] !== undefined && profile[key] !== null && profile[key] !== '') {
        structuredValues[key] = profile[key];
      }
    }

    const { facts, tier } = aggregateFacts(entry.evidence, {
      reservationCount: entry.reservations.size,
      today,
      structuredValues,
    });

    factsTotal += facts.length;
    results.set(listingId, {
      listing_id: listingId,
      facts,
      tier,
      stats: {
        threads: entry.threads.size,
        reservations: entry.reservations.size,
        host_messages: entry.host_messages,
        guest_messages: entry.guest_messages,
        exceptions: entry.exceptions,
        candidates: entry.evidence.length,
      },
    });
  }

  logger.info(
    `Analyse des conversations : ${stats.threads_linked} fil(s) rattaché(s) sur ${stats.threads_total}, `
    + `${stats.host_messages} message(s) de l'hôte, ${factsTotal} fait(s) sur ${results.size} logement(s)`
  );

  return {
    byListing: results,
    available: true,
    stats: {
      ...stats,
      // Total de l'export, avant la réduction qui n'a gardé que les fils
      // rattachables et les messages de l'hôte.
      threads_in_export: threadsSeen,
      listings_with_facts: results.size,
      facts_total: factsTotal,
    },
  };
}

/**
 * Reconnaissance par le CONTENU, pour un fichier renommé ou déposé sans nom.
 * Volontairement minimale : seules les deux sections de conversations, le reste
 * étant déjà traité par `airbnbExport.kindFromContent`.
 */
function kindOfContent(data) {
  const roots = Array.isArray(data) ? data : [data];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    if (Array.isArray(root.messageDigest)) return 'messagedigest';
    if (Array.isArray(root.messageThreads)) return 'messages';
  }
  return null;
}

module.exports = { analyzeExportFacts, __kindOfContent: kindOfContent };

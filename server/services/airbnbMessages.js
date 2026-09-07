/**
 * Lecture des conversations de l'export Airbnb — et rattachement CERTAIN d'une
 * conversation à un logement.
 *
 * POURQUOI CE FICHIER EXISTE MAINTENANT
 * -------------------------------------
 * `messages.json` était jusqu'ici volontairement fermé : rien n'y permettait
 * d'établir de façon déterministe qu'une phrase décrivait le logement plutôt
 * qu'une faveur faite à un voyageur. Le premier point reste vrai et se traite
 * ailleurs (`factExtraction.js`, `factAggregation.js`). Le second — savoir DE
 * QUEL LOGEMENT parle une conversation — se traite ici, et il se traite bien :
 *
 *     fil de discussion  →  confirmationCode  →  reservations.json  →  logement
 *
 * Le code de réservation est écrit noir sur blanc dans la carte que le service
 * Airbnb dépose au début de chaque fil (« Réservation confirmée »), et
 * `reservations.json` associe ce même code à une URL `/rooms/<id>`. Les deux
 * bouts sont des CHAÎNES exactes : aucun rapprochement approximatif, aucune
 * ressemblance de nom.
 *
 * Sur l'export de référence : 4 029 fils, dont 1 171 portent un code — et
 * jamais deux. Les 2 850 autres (demandes sans suite, messages hors
 * réservation) sont IGNORÉS. C'est voulu : mieux vaut jeter 70 % des fils que
 * d'attribuer une phrase au mauvais logement.
 *
 * CE QUI CIRCULE, ET CE QUI RESTE SUR LA MACHINE DE L'HÔTE
 * --------------------------------------------------------
 * Le navigateur réduit `messages.json` (70 Mo) à un CONDENSÉ avant tout envoi :
 * uniquement les fils rattachables, uniquement les messages écrits par l'hôte,
 * et pour les voyageurs un simple décompte. Les 70 Mo d'origine ne quittent
 * jamais la machine. `reduceThreads` ci-dessous produit exactement le même
 * condensé côté serveur, pour le cas où l'hôte dépose `messages.json` en direct.
 *
 * Rien du contenu n'est journalisé : seulement des décomptes.
 */

const { extractCandidates } = require('./factExtraction');

// Bornes de lecture. Un export légitime tient très largement dedans.
const MAX_THREADS = 50000;
const MAX_MESSAGES_PER_THREAD = 2000;
const MAX_BODY_LENGTH = 20000;
const MAX_EVIDENCE_PER_LISTING = 20000;

const DIGEST_SECTION = 'messageDigest';
const DIGEST_VERSION = 1;

// Le code de réservation tel qu'il apparaît dans les cartes de service du fil.
const CONFIRMATION_CODE = /confirmationCode=([A-Z0-9]{8,12})/g;
// Repli : certains fils ne portent pas de code mais un lien direct vers
// l'annonce. Même exigence — une seule valeur, sinon on ignore.
const ROOM_LINK = /\/rooms\/(?:plus\/)?(\d{6,20})/g;

function uniqueMatches(text, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
    if (found.size > 4) break;   // au-delà, le fil est de toute façon rejeté
  }
  return found;
}

/** Première section nommée d'un document Airbnb (`[{ <clé>: [...] }]`). */
function section(data, name) {
  for (const entry of Array.isArray(data) ? data : [data]) {
    if (entry && typeof entry === 'object' && Array.isArray(entry[name])) return entry[name];
    if (entry && typeof entry === 'object' && entry[name] && typeof entry[name] === 'object') {
      return entry[name];
    }
  }
  return [];
}

/**
 * Réduit `messages.json` au strict nécessaire.
 *
 * @param {any} data contenu analysé de messages.json
 * @param {object} options
 * @param {Iterable<string|number>} options.hostAccountIds identifiants de l'hôte
 *        (`listings.json` → `hostUserId`). Sans eux, AUCUN corps de message
 *        n'est retenu : on ne saurait pas distinguer l'hôte du voyageur, et un
 *        message de voyageur ne doit jamais devenir une caractéristique.
 * @returns {{version, threads: Array}} le condensé
 */
function reduceThreads(data, { hostAccountIds } = {}) {
  const hosts = new Set([...(hostAccountIds || [])].map((id) => String(id)));
  const threads = [];

  const rawThreads = section(data, 'messageThreads');
  const seen = Array.isArray(rawThreads) ? rawThreads.length : 0;
  for (const thread of Array.isArray(rawThreads) ? rawThreads : []) {
    if (threads.length >= MAX_THREADS) break;
    if (!thread || typeof thread !== 'object') continue;

    const items = Array.isArray(thread.messagesAndContents)
      ? thread.messagesAndContents.slice(0, MAX_MESSAGES_PER_THREAD)
      : [];
    if (items.length === 0) continue;

    // Le code est cherché dans la sérialisation du fil : il vit à l'intérieur
    // des cartes de service, dont la forme interne n'est pas documentée et
    // change. Chercher la chaîne est plus robuste que suivre un chemin.
    const serialized = JSON.stringify(items);
    const codes = uniqueMatches(serialized, CONFIRMATION_CODE);
    const rooms = uniqueMatches(serialized, ROOM_LINK);

    // UNE seule valeur, sinon le rattachement n'est pas certain — et un
    // rattachement incertain n'est pas un rattachement.
    const code = codes.size === 1 ? [...codes][0] : null;
    const room = rooms.size === 1 ? [...rooms][0] : null;
    if (!code && !room) continue;

    const messages = [];
    let guestTexts = 0;

    for (const entry of items) {
      const meta = entry && entry.message;
      if (!meta || meta.contentType !== 'TextContent') continue;
      const body = entry.messageContent
        && entry.messageContent.textContent
        && entry.messageContent.textContent.body;
      if (typeof body !== 'string' || !body.trim()) continue;

      if (!hosts.has(String(meta.accountId))) { guestTexts++; continue; }

      messages.push({
        id: meta.id === undefined || meta.id === null ? null : String(meta.id),
        at: typeof meta.createdAt === 'string' ? meta.createdAt : null,
        body: body.slice(0, MAX_BODY_LENGTH),
      });
    }

    if (messages.length === 0) continue;
    threads.push({
      id: thread.id === undefined || thread.id === null ? null : String(thread.id),
      code,
      listing_id: room,
      guest_texts: guestTexts,
      messages,
    });
  }

  // `threads_seen` dit combien de fils l'export contenait AU TOTAL. Sans lui,
  // le rapport annoncerait « 747 rattachés sur 1 053 » alors que le vrai
  // dénominateur est 4 029 : la différence est ce que le condensé a écarté
  // avant même de partir, et c'est une information de vie privée utile.
  return { version: DIGEST_VERSION, threads, threads_seen: seen };
}

/**
 * Enveloppe le condensé dans la forme des documents Airbnb — `[{ <section>:
 * [...] }]` — pour qu'il emprunte le même chemin de lecture que les autres
 * fichiers de l'export, y compris la reconnaissance par le contenu.
 */
function wrapDigest(digest) {
  return [{ [DIGEST_SECTION]: [digest] }];
}

/**
 * Lit un condensé, quelle que soit son origine (navigateur ou `reduceThreads`).
 * Tout champ absent ou du mauvais type est ignoré plutôt que corrigé.
 */
function parseDigest(data) {
  const raw = section(data, DIGEST_SECTION);
  const digest = Array.isArray(raw) ? raw[0] : raw;
  const threads = digest && Array.isArray(digest.threads) ? digest.threads : [];

  const out = [];
  for (const thread of threads.slice(0, MAX_THREADS)) {
    if (!thread || typeof thread !== 'object') continue;
    const messages = (Array.isArray(thread.messages) ? thread.messages : [])
      .slice(0, MAX_MESSAGES_PER_THREAD)
      .filter((m) => m && typeof m.body === 'string' && m.body.trim())
      .map((m) => ({
        id: m.id === undefined || m.id === null ? null : String(m.id).slice(0, 64),
        at: typeof m.at === 'string' ? m.at : null,
        body: m.body.slice(0, MAX_BODY_LENGTH),
      }));
    if (messages.length === 0) continue;

    out.push({
      id: thread.id === undefined || thread.id === null ? null : String(thread.id).slice(0, 64),
      code: typeof thread.code === 'string' && /^[A-Z0-9]{6,16}$/.test(thread.code) ? thread.code : null,
      listing_id: typeof thread.listing_id === 'string' && /^\d{4,20}$/.test(thread.listing_id)
        ? thread.listing_id : null,
      guest_texts: Number.isInteger(thread.guest_texts) && thread.guest_texts >= 0 ? thread.guest_texts : 0,
      messages,
    });
  }

  return {
    threads: out,
    // Combien de fils l'export contenait avant réduction. Absent d'un condensé
    // d'une version antérieure : on retombe alors sur ce qu'on a sous la main.
    threads_seen: Number.isInteger(digest && digest.threads_seen) && digest.threads_seen >= 0
      ? digest.threads_seen
      : out.length,
  };
}

/**
 * Preuves par logement.
 *
 * Un fil n'est retenu que si son code de réservation désigne un logement CONNU
 * de l'export. Un code inconnu (séjour où l'hôte était voyageur, annonce
 * supprimée) ne rattache rien : la conversation est écartée, pas devinée.
 *
 * @param {Array} threads sortie de `parseDigest`
 * @param {Map<string, {listing_id: string, start_date: string|null}>} reservationIndex
 * @param {Set<string>} knownListingIds logements réellement présents dans l'export
 * @returns {{byListing: Map<string, object>, stats: object}}
 */
function evidenceByListing(threads, reservationIndex, knownListingIds) {
  const byListing = new Map();
  const stats = {
    threads_total: threads.length,
    threads_linked: 0,
    threads_unlinked: 0,
    host_messages: 0,
    guest_messages: 0,
    candidates: 0,
    exceptions: 0,
  };

  const known = knownListingIds instanceof Set
    ? knownListingIds
    : new Set([...(knownListingIds || [])].map(String));

  for (const thread of threads) {
    let listingId = null;
    let reservationCode = null;

    if (thread.code) {
      const reservation = reservationIndex.get(thread.code);
      if (reservation && known.has(String(reservation.listing_id))) {
        listingId = String(reservation.listing_id);
        reservationCode = thread.code;
      }
    }
    // Le lien direct vers l'annonce ne sert que si le code n'a rien donné.
    if (!listingId && thread.listing_id && known.has(thread.listing_id)) {
      listingId = thread.listing_id;
    }

    stats.guest_messages += thread.guest_texts || 0;

    if (!listingId) { stats.threads_unlinked++; continue; }
    stats.threads_linked++;

    const entry = byListing.get(listingId) || {
      listing_id: listingId,
      evidence: [],
      threads: new Set(),
      reservations: new Set(),
      host_messages: 0,
      guest_messages: 0,
      exceptions: 0,
    };

    entry.threads.add(thread.id || `t${entry.threads.size}`);
    if (reservationCode) entry.reservations.add(reservationCode);
    entry.guest_messages += thread.guest_texts || 0;

    for (const message of thread.messages) {
      entry.host_messages++;
      stats.host_messages++;
      if (entry.evidence.length >= MAX_EVIDENCE_PER_LISTING) continue;

      for (const candidate of extractCandidates(message.body)) {
        if (candidate.kind === 'EXCEPTION') { entry.exceptions++; stats.exceptions++; }
        stats.candidates++;
        entry.evidence.push({
          key: candidate.key,
          value: candidate.value,
          kind: candidate.kind,
          snippet: candidate.snippet,
          thread_ref: thread.id,
          message_ref: message.id,
          // Sans code, la preuve ne pourra jamais compter comme « réservation
          // distincte » : c'est la mesure la plus exigeante, et c'est voulu.
          reservation_code: reservationCode,
          observed_at: message.at,
        });
      }
    }

    byListing.set(listingId, entry);
  }

  return { byListing, stats };
}

module.exports = {
  reduceThreads,
  parseDigest,
  wrapDigest,
  evidenceByListing,
  DIGEST_SECTION,
  DIGEST_VERSION,
  MAX_THREADS,
};

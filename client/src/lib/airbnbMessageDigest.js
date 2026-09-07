/**
 * Condensé des conversations, produit DANS LE NAVIGATEUR.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * `messages.json` pèse 70 Mo sur l'export de référence et contient l'intégralité
 * des échanges de l'hôte avec ses voyageurs. Michel a besoin d'une petite partie
 * de ce fichier : les fils rattachables à une réservation, et à l'intérieur, ce
 * que l'HÔTE a écrit. Soit environ 3 Mo.
 *
 * Envoyer les 70 Mo pour n'en lire que 4 % reviendrait à téléverser toutes les
 * conversations privées de l'hôte, y compris celles de voyageurs qui n'ont
 * jamais réservé, pour rien. La réduction se fait donc ici, avant tout départ :
 *
 *   - un fil sans code de réservation UNIQUE est écarté (il ne pourra de toute
 *     façon jamais être rattaché à un logement de façon certaine) ;
 *   - les messages des voyageurs sont réduits à un simple DÉCOMPTE : leur texte
 *     ne quitte jamais la machine ;
 *   - les cartes de service (« Réservation confirmée ») sont écartées après en
 *     avoir extrait le code.
 *
 * Le serveur sait produire exactement le même condensé (`airbnbMessages.js`),
 * pour le cas où l'hôte déposerait `messages.json` directement. Les deux doivent
 * rester d'accord sur la FORME ; c'est le serveur qui fait foi.
 *
 * BEST EFFORT, JAMAIS BLOQUANT
 * ----------------------------
 * Analyser 70 Mo de JSON coûte de la mémoire. Sur une machine modeste cela peut
 * échouer. Un échec ici ne doit rien casser : les logements s'importent sans les
 * conversations, et l'hôte le voit dans le récapitulatif.
 */

const DIGEST_FILE = 'airbnb_message_digest.json';
const DIGEST_SECTION = 'messageDigest';
const DIGEST_VERSION = 1;

// Au-delà, on n'essaie même pas : le coût mémoire de l'analyse dépasserait ce
// qu'un onglet peut absorber, et l'échec serait un plantage plutôt qu'un
// message.
const MAX_MESSAGES_BYTES = 220 * 1024 * 1024;
const MAX_BODY_LENGTH = 20000;
const MAX_MESSAGES_PER_THREAD = 2000;

const CONFIRMATION_CODE = /confirmationCode=([A-Z0-9]{8,12})/g;
const ROOM_LINK = /\/rooms\/(?:plus\/)?(\d{6,20})/g;

// Les identifiants Airbnb récents dépassent ce qu'un nombre JavaScript
// représente exactement : `JSON.parse` les arrondirait en silence. Même
// correctif que côté serveur — on les met entre guillemets avant l'analyse.
const LONG_ID_KEY =
  /"(id|listingId|listing_id|roomId|room_id|hostUserId|accountId|entityId|threadId)"(\s*:\s*)(\d{16,20})(?=\s*[,}\]])/g;

function parseAirbnbJson(text) {
  return JSON.parse(String(text).replace(/^﻿/, '').replace(LONG_ID_KEY, '"$1"$2"$3"'));
}

function sectionOf(data, key) {
  const roots = Array.isArray(data) ? data : [data];
  for (const root of roots) {
    if (root && typeof root === 'object' && Array.isArray(root[key])) return root[key];
  }
  return [];
}

function uniqueMatches(text, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
    if (found.size > 4) break;
  }
  return found;
}

/** Identifiants Airbnb de l'hôte, lus dans `listings.json`. */
export function hostIdsFromListings(listingsData) {
  const ids = new Set();
  for (const row of sectionOf(listingsData, 'listings')) {
    if (!row || typeof row !== 'object') continue;
    const id = row.hostUserId === null || row.hostUserId === undefined ? '' : String(row.hostUserId).trim();
    if (/^\d{3,20}$/.test(id)) ids.add(id);
  }
  return ids;
}

/**
 * @param {Uint8Array} messagesBytes contenu de messages.json
 * @param {Uint8Array} listingsBytes contenu de listings.json (pour l'hôte)
 * @returns {{bytes: Uint8Array, threads: number, threadsSeen: number, hostMessages: number}|null}
 *          `null` si rien d'exploitable — jamais une exception.
 */
export function buildMessageDigest(messagesBytes, listingsBytes) {
  if (!messagesBytes || messagesBytes.length === 0) return null;
  if (messagesBytes.length > MAX_MESSAGES_BYTES) return null;
  if (!listingsBytes || listingsBytes.length === 0) return null;

  let hosts;
  let data;
  try {
    hosts = hostIdsFromListings(parseAirbnbJson(new TextDecoder('utf-8').decode(listingsBytes)));
    // Sans l'identifiant de l'hôte, impossible de distinguer ce qu'il a écrit
    // de ce que le voyageur a écrit. On n'envoie alors AUCUN message.
    if (hosts.size === 0) return null;
    data = parseAirbnbJson(new TextDecoder('utf-8').decode(messagesBytes));
  } catch (_) {
    return null;
  }

  const rawThreads = sectionOf(data, 'messageThreads');
  const threads = [];
  let hostMessages = 0;

  for (const thread of rawThreads) {
    if (!thread || typeof thread !== 'object') continue;
    const items = Array.isArray(thread.messagesAndContents)
      ? thread.messagesAndContents.slice(0, MAX_MESSAGES_PER_THREAD)
      : [];
    if (items.length === 0) continue;

    const serialized = JSON.stringify(items);
    const codes = uniqueMatches(serialized, CONFIRMATION_CODE);
    const rooms = uniqueMatches(serialized, ROOM_LINK);
    const code = codes.size === 1 ? [...codes][0] : null;
    const room = rooms.size === 1 ? [...rooms][0] : null;
    // Un fil qu'on ne saura pas rattacher à un logement ne part pas : il ne
    // servirait à rien et son contenu est privé.
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

      // Message de voyageur : on ne garde que le fait qu'il existe.
      if (!hosts.has(String(meta.accountId))) { guestTexts++; continue; }

      messages.push({
        id: meta.id === null || meta.id === undefined ? null : String(meta.id),
        at: typeof meta.createdAt === 'string' ? meta.createdAt : null,
        body: body.slice(0, MAX_BODY_LENGTH),
      });
    }

    if (messages.length === 0) continue;
    hostMessages += messages.length;
    threads.push({
      id: thread.id === null || thread.id === undefined ? null : String(thread.id),
      code,
      listing_id: room,
      guest_texts: guestTexts,
      messages,
    });
  }

  if (threads.length === 0) return null;

  const digest = [{
    [DIGEST_SECTION]: [{ version: DIGEST_VERSION, threads, threads_seen: rawThreads.length }],
  }];

  return {
    bytes: new TextEncoder().encode(JSON.stringify(digest)),
    threads: threads.length,
    threadsSeen: rawThreads.length,
    hostMessages,
  };
}

export { DIGEST_FILE, DIGEST_SECTION, DIGEST_VERSION, MAX_MESSAGES_BYTES };

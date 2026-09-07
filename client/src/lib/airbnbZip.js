/**
 * Préparation du dépôt d'un export Airbnb, côté navigateur.
 *
 * LE PROBLÈME
 * -----------
 * L'export de données personnelles Airbnb est livré NON COMPRESSÉ : sur
 * l'export qui a servi de référence, 156 Mo pour 28 fichiers, dont
 * `messages.json` (70 Mo de conversations avec les voyageurs) et
 * `activity_log.json` (54 Mo d'historique de navigation). Les quatre fichiers
 * dont Michel a besoin — annonces, tarifs, calendrier, enregistrements — pèsent
 * ensemble 13 Mo, soit moins de 9 % de l'archive.
 *
 * Téléverser les 156 Mo reviendrait à envoyer au serveur l'intégralité des
 * conversations privées de l'hôte, ses virements et sa pièce d'identité, pour
 * n'en lire que 9 %. Ce module ouvre donc l'archive DANS LE NAVIGATEUR et
 * n'envoie que les fichiers utiles : le reste ne quitte jamais la machine de
 * l'hôte.
 *
 * Ce n'est pas la seule barrière. Le serveur applique la MÊME liste blanche à
 * sa réception (`services/airbnbExport.js`) : un client modifié qui enverrait
 * l'archive entière n'obtiendrait pas pour autant que les fichiers sensibles
 * soient ouverts. Ici, la liste blanche évite le téléversement ; là-bas, elle
 * évite la lecture.
 *
 * COMMENT
 * -------
 * Un ZIP porte son sommaire à la FIN (« end of central directory »). On lit
 * donc quelques kilo-octets de queue, on y trouve la position de chaque
 * fichier, puis on ne lit que les tranches utiles — `File.slice()` ne charge
 * rien d'autre en mémoire. Les fichiers retenus sont réassemblés en un petit
 * ZIP que le serveur traite exactement comme l'original : il n'y a qu'UN
 * format d'entrée côté serveur, et donc qu'un seul chemin à maintenir.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// Bornes de lecture. Une archive Airbnb légitime tient très largement dedans,
// et un fichier qui les dépasse est refusé ici plutôt qu'au bout d'un
// téléversement de plusieurs minutes.
export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;  // le ZIP déposé
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;     // ce qui part au serveur
const MAX_ENTRY_BYTES = 48 * 1024 * 1024;             // un fichier extrait
const MAX_ENTRIES = 20000;

/**
 * Fichiers retenus. Même intention que la liste blanche du serveur
 * (`services/airbnbExport.js`), écrite ici de façon un peu plus large : mieux
 * vaut envoyer un fichier que le serveur écartera que d'en retenir un dont il
 * avait besoin.
 *
 * Les deux listes doivent rester d'accord sur l'essentiel. Si le serveur
 * ouvre un fichier de plus, il faut l'ajouter ici, sinon le navigateur ne le
 * téléverse simplement jamais — c'est silencieux, et ça se voit seulement à
 * une case qui ne se coche pas.
 */
const EXACT = new Set([
  'listings.json', 'listing_pricing.json', 'listing_calendar.json',
  'listing_permits.json', 'reviews.json', 'reservations.json',
  'host_quick_replies.json',
]);
const SENSITIVE = /(activity_log|message|payment|payout|kyc|id_verification|search_|profile_information|wishlist|coupon|referral|report_history|resolution|support)/i;
const USEFUL = /(listing|annonce|logement|propert)/i;

function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}

export function isUsefulExportFile(path) {
  const base = baseName(path);
  if (!/\.json$/i.test(base)) return false;
  if (EXACT.has(base.toLowerCase())) return true;
  if (SENSITIVE.test(base)) return false;
  return USEFUL.test(base);
}

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

async function sliceBuffer(file, start, end) {
  return new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

/**
 * Lit le sommaire du ZIP sans décompresser quoi que ce soit.
 * @returns {Promise<Array<{name, method, compressedSize, uncompressedSize, offset}>>}
 */
async function readCentralDirectory(file) {
  // Le commentaire final peut atteindre 65 535 octets ; au-delà de la taille
  // fixe de l'enregistrement (22 octets), on ne cherche pas plus loin.
  const tailSize = Math.min(file.size, 0xffff + 22);
  const tail = await sliceBuffer(file, file.size - tailSize, file.size);
  const tailView = new DataView(tail.buffer);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tailView, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('Archive ZIP incomplète ou corrompue.');

  const entryCount = u16(tailView, eocd + 10);
  const centralSize = u32(tailView, eocd + 12);
  const centralOffset = u32(tailView, eocd + 16);

  // Sentinelles ZIP64 : plutôt que de lire de travers, on le dit.
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ArchiveError(
      "Archive ZIP64 non prise en charge. Décompressez-la et déposez les fichiers .json à la place."
    );
  }
  if (entryCount > MAX_ENTRIES) throw new ArchiveError('Archive refusée : trop de fichiers.');
  if (centralOffset + centralSize > file.size) {
    throw new ArchiveError('Archive ZIP incomplète ou corrompue.');
  }

  const central = await sliceBuffer(file, centralOffset, centralOffset + centralSize);
  const view = new DataView(central.buffer);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let cursor = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > central.length || u32(view, cursor) !== SIG_CENTRAL) {
      throw new ArchiveError('Archive ZIP incomplète ou corrompue.');
    }
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const offset = u32(view, cursor + 42);

    const name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    // Un chemin remontant ou absolu n'a rien à faire dans une archive de
    // confiance. Rien n'étant écrit sur le disque, il serait inerte — on le
    // refuse quand même, parce qu'une telle archive n'est pas celle d'Airbnb.
    if (name.includes('\0') || /^([a-zA-Z]:[\\/]|[\\/])/.test(name)) continue;
    if (name.split(/[\\/]/).some((part) => part === '..')) continue;
    if (name.endsWith('/') || name.endsWith('\\')) continue;

    entries.push({ name, method, compressedSize, uncompressedSize, offset });
  }

  return entries;
}

/** Décompresse UNE entrée, en mémoire. */
async function readEntry(file, entry) {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ArchiveError(`Fichier trop volumineux dans l'archive : ${baseName(entry.name)}.`);
  }

  // Les longueurs du nom et du champ « extra » de l'en-tête LOCAL peuvent
  // différer de celles du sommaire : il faut relire celles-ci.
  const header = await sliceBuffer(file, entry.offset, entry.offset + 30);
  const view = new DataView(header.buffer);
  if (header.length < 30 || u32(view, 0) !== SIG_LOCAL) {
    throw new ArchiveError('Archive ZIP incomplète ou corrompue.');
  }
  const start = entry.offset + 30 + u16(view, 26) + u16(view, 28);
  const raw = await sliceBuffer(file, start, start + entry.compressedSize);

  if (entry.method === METHOD_STORE) return raw;
  if (entry.method === METHOD_DEFLATE) {
    if (typeof DecompressionStream !== 'function') {
      throw new ArchiveError('Ce navigateur ne sait pas décompresser cette archive.');
    }
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length > MAX_ENTRY_BYTES) {
      throw new ArchiveError(`Fichier trop volumineux dans l'archive : ${baseName(entry.name)}.`);
    }
    return bytes;
  }
  throw new ArchiveError(`Méthode de compression non prise en charge pour ${baseName(entry.name)}.`);
}

// ── Écriture d'un ZIP « stocké » ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble un ZIP sans compression à partir de fichiers en mémoire.
 *
 * Sans compression volontairement : le contenu part de toute façon sur une
 * connexion HTTPS qui compresse, et l'archive produite est jetée dès la
 * réponse du serveur. Le CRC est calculé pour de bon — une archive au CRC nul
 * serait refusée par n'importe quel autre outil, et ce n'est pas parce que
 * notre lecteur ne le vérifie pas qu'il faut écrire un ZIP malhonnête.
 */
function buildStoredZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, bytes } of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIG_LOCAL, true);
    localView.setUint16(4, 20, true);            // version nécessaire
    localView.setUint16(6, 0x0800, true);        // drapeau : nom en UTF-8
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIG_CENTRAL, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, METHOD_STORE, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, bytes);
    centrals.push(central);
    offset += local.length + bytes.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, eocd], { type: 'application/zip' });
}

// ── Point d'entrée ──────────────────────────────────────────────────────────

/** Les quatre premiers octets d'un ZIP. */
async function looksLikeZip(file) {
  if (file.size < 4) return false;
  const head = await sliceBuffer(file, 0, 4);
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
}

/**
 * Prépare ce qui sera téléversé.
 *
 * @param {File[]} files ce que l'hôte a déposé : le ZIP d'Airbnb, ou des .json
 * @returns {Promise<{blob: Blob, files: string[], skipped: number}>}
 */
export async function prepareAirbnbUpload(files) {
  const list = Array.from(files || []);
  if (list.length === 0) throw new ArchiveError('Aucun fichier sélectionné.');

  const total = list.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('Fichier trop volumineux (maximum 1 Go).');
  }

  // Un seul .json : il part tel quel, le serveur sait le lire directement.
  if (list.length === 1 && !(await looksLikeZip(list[0]))) {
    if (list[0].size > MAX_UPLOAD_BYTES) {
      throw new ArchiveError('Fichier JSON trop volumineux (maximum 60 Mo).');
    }
    return { blob: list[0], files: [list[0].name], skipped: 0 };
  }

  const useful = [];
  let skipped = 0;

  for (const file of list) {
    if (await looksLikeZip(file)) {
      const entries = await readCentralDirectory(file);
      for (const entry of entries) {
        if (!isUsefulExportFile(entry.name)) { skipped++; continue; }
        useful.push({ name: baseName(entry.name), bytes: await readEntry(file, entry) });
      }
    } else if (isUsefulExportFile(file.name)) {
      useful.push({ name: baseName(file.name), bytes: new Uint8Array(await file.arrayBuffer()) });
    } else {
      skipped++;
    }
  }

  if (useful.length === 0) {
    throw new ArchiveError(
      "Aucun fichier de logement trouvé (listings.json et compagnie). "
      + "Vérifiez qu'il s'agit bien de l'export de vos données Airbnb."
    );
  }

  const blob = buildStoredZip(useful);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new ArchiveError(
      'Les fichiers de logement de cet export dépassent 60 Mo. Déposez uniquement listings.json.'
    );
  }

  return { blob, files: useful.map((f) => f.name), skipped };
}

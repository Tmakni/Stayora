const zlib = require('zlib');

/**
 * Lecteur ZIP minimal, en mémoire, sans dépendance.
 *
 * POURQUOI PAS UNE BIBLIOTHÈQUE
 * -----------------------------
 * L'archive de données personnelles Airbnb est lue une fois, à la demande de
 * l'hôte, pour en extraire quelques fichiers JSON. `zlib` est dans Node depuis
 * toujours et fait tout le travail de décompression ; le reste tient dans la
 * lecture d'un répertoire central de quelques dizaines d'octets par entrée.
 * Ajouter une dépendance d'extraction — surtout une qui ÉCRIT sur le disque —
 * apporterait ici plus de surface d'attaque que de valeur.
 *
 * CE QUI EST DÉLIBÉRÉMENT INTERDIT
 * --------------------------------
 *   - écrire quoi que ce soit sur le disque. Rien n'est extrait : les entrées
 *     utiles sont décompressées en mémoire et jetées. Zip Slip, les chemins
 *     `../`, les chemins absolus et les liens symboliques ne peuvent donc pas
 *     produire d'effet de bord — ils sont malgré tout rejetés à la lecture,
 *     parce qu'une archive qui en contient n'est pas une archive de confiance ;
 *   - dépasser les bornes. Nombre d'entrées, taille décompressée par fichier et
 *     taille décompressée cumulée sont plafonnés : une archive « bombe » est
 *     refusée avant d'avoir consommé la mémoire ;
 *   - deviner. Seules les méthodes 0 (stocké) et 8 (deflate) sont acceptées, et
 *     une archive ZIP64 est signalée comme telle plutôt que mal interprétée.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// Bit de mode Unix signalant un lien symbolique (S_IFLNK), stocké dans les
// 16 bits de poids fort des attributs externes.
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const DEFAULTS = {
  maxEntries: 20000,
  maxEntrySize: 64 * 1024 * 1024,   // 64 Mo décompressés pour UN fichier
  maxTotalSize: 256 * 1024 * 1024,  // 256 Mo décompressés au total
};

class ZipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/** Un nom d'entrée acceptable : ni absolu, ni remontant, ni piégé. */
function isSafeEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0')) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return false;           // C:\... sous Windows
  const parts = name.split(/[\\/]/);
  if (parts.some((p) => p === '..')) return false;
  return true;
}

/** Localise l'enregistrement de fin de répertoire central. */
function findEndOfCentralDirectory(buffer) {
  // Le commentaire final peut faire jusqu'à 65 535 octets : on ne cherche pas
  // plus loin que ça au-delà de la taille fixe de l'enregistrement (22 octets).
  const minOffset = Math.max(0, buffer.length - (0xffff + 22));
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Lit le répertoire central et rend la liste des entrées, sans rien décompresser.
 *
 * @returns {Array<{name, method, compressedSize, uncompressedSize, localHeaderOffset, isDirectory}>}
 */
function listEntries(buffer, options = {}) {
  const limits = { ...DEFAULTS, ...options };

  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipError('Fichier illisible : ce n\'est pas une archive ZIP.', 'NOT_A_ZIP');
  }
  if (buffer.readUInt32LE(0) !== SIG_LOCAL && buffer.readUInt32LE(0) !== SIG_CENTRAL) {
    throw new ZipError('Fichier illisible : ce n\'est pas une archive ZIP.', 'NOT_A_ZIP');
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw new ZipError('Archive ZIP incomplète ou corrompue.', 'CORRUPT_ZIP');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  // Sentinelles ZIP64 : plutôt que de lire de travers, on le dit.
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError(
      'Archive ZIP64 non prise en charge. Réexportez vos données Airbnb, ou décompressez puis recompressez l\'archive.',
      'ZIP64_UNSUPPORTED'
    );
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(
      `Archive refusée : ${entryCount} fichiers (maximum ${limits.maxEntries}).`,
      'TOO_MANY_ENTRIES'
    );
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError('Archive ZIP incomplète ou corrompue.', 'CORRUPT_ZIP');
  }

  const entries = [];
  let cursor = centralOffset;
  let declaredTotal = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError('Archive ZIP incomplète ou corrompue.', 'CORRUPT_ZIP');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttrs = buffer.readUInt32LE(cursor + 38);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!isSafeEntryName(name)) {
      throw new ZipError(
        `Archive refusée : elle contient un chemin dangereux (${name.slice(0, 80)}).`,
        'UNSAFE_PATH'
      );
    }

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & S_IFMT) === S_IFLNK;
    const isDirectory = name.endsWith('/') || name.endsWith('\\');

    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxTotalSize) {
      throw new ZipError(
        'Archive refusée : taille décompressée hors limite.',
        'ARCHIVE_TOO_LARGE'
      );
    }

    // Les liens symboliques ne sont jamais suivis. Rien n'étant écrit sur le
    // disque, ils sont inertes ; on les ignore simplement.
    if (isSymlink || isDirectory) continue;

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
  }

  return entries;
}

/**
 * Décompresse UNE entrée en mémoire.
 *
 * @returns {Buffer}
 */
function readEntry(buffer, entry, options = {}) {
  const limits = { ...DEFAULTS, ...options };

  if (entry.uncompressedSize > limits.maxEntrySize) {
    throw new ZipError(
      `Fichier trop volumineux dans l'archive : ${entry.name}.`,
      'ENTRY_TOO_LARGE'
    );
  }

  const off = entry.localHeaderOffset;
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== SIG_LOCAL) {
    throw new ZipError('Archive ZIP incomplète ou corrompue.', 'CORRUPT_ZIP');
  }

  // Les longueurs du nom et du champ « extra » de l'en-tête LOCAL peuvent
  // différer de celles du répertoire central : il faut relire celles-ci.
  const nameLength = buffer.readUInt16LE(off + 26);
  const extraLength = buffer.readUInt16LE(off + 28);
  const start = off + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;

  if (end > buffer.length) {
    throw new ZipError('Archive ZIP incomplète ou corrompue.', 'CORRUPT_ZIP');
  }

  const raw = buffer.subarray(start, end);

  if (entry.method === METHOD_STORE) return Buffer.from(raw);

  if (entry.method === METHOD_DEFLATE) {
    // maxOutputLength est la vraie protection contre une bombe de décompression :
    // la taille annoncée dans l'en-tête n'engage que l'auteur de l'archive.
    return zlib.inflateRawSync(raw, { maxOutputLength: limits.maxEntrySize });
  }

  throw new ZipError(
    `Méthode de compression non prise en charge (${entry.method}) pour ${entry.name}.`,
    'UNSUPPORTED_METHOD'
  );
}

module.exports = {
  ZipError,
  listEntries,
  readEntry,
  isSafeEntryName,
  DEFAULTS,
};

/**
 * Import en masse des logements depuis l'archive de données personnelles Airbnb.
 *
 * PÉRIMÈTRE ASSUMÉ
 * ----------------
 * Il n'existe pas d'accès officiel à l'API partenaire Airbnb pour ce projet :
 * pas de bouton OAuth Airbnb, pas d'API privée, pas de scraping, aucun
 * identifiant Airbnb demandé. La seule source légitime est l'export de données
 * personnelles que l'hôte demande lui-même à Airbnb.
 *
 * Le contenu exact de cet export n'est pas documenté publiquement et change
 * avec le temps. Le parseur ne suppose donc AUCUNE arborescence : il reconnaît
 * un logement à sa FORME. Les archives construites ici couvrent plusieurs
 * conventions de nommage plausibles pour vérifier cette souplesse — elles ne
 * prétendent pas être l'export réel, et la prévisualisation existe précisément
 * pour que l'utilisateur voie ce qui a été détecté avant toute écriture.
 *
 * CE QUI EST VERROUILLÉ
 * ---------------------
 *   - plus de 10 logements importés en une seule opération ;
 *   - un second import du même ZIP ne duplique rien ;
 *   - une archive invalide ou dangereuse est refusée (Zip Slip, bombe, ZIP64,
 *     méthode inconnue, fichier qui n'est pas un ZIP) ;
 *   - un logement invalide n'emporte pas les autres ;
 *   - isolation stricte entre deux hôtes.
 */

const zlib = require('zlib');
const request = require('supertest');
const serverModule = require('../server');
const app = serverModule;
const { initializeApp } = serverModule;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');
const { listEntries, readEntry, ZipError } = require('../services/zipReader');
const {
  extractListingsFromArchive,
  extractListingsFromJson,
  extractListingsFromUpload,
  looksLikeZip,
} = require('../services/airbnbArchiveImport');

const TAG = `arch-${process.pid}-${Date.now()}`;
const EMAIL_A = `arch-a-${TAG}@example.test`;
const EMAIL_B = `arch-b-${TAG}@example.test`;
const PASSWORD = 'ArchiveTest12345';

let db;
let tokenA;
let tokenB;

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`);

// ────────────────────────────────────────────────────────────────────────────
// Fabrique de ZIP minimale — construit un vrai fichier ZIP en mémoire, pour
// que les tests exercent le lecteur réel et non une simulation.
// ────────────────────────────────────────────────────────────────────────────

function makeZip(files, { externalAttrs = {}, forceZip64 = false, method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);           // crc32 (non vérifié par le lecteur)
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(externalAttrs[name] || 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  eocd.writeUInt16LE(forceZip64 ? 0xffff : count, 8);
  eocd.writeUInt16LE(forceZip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** Une forme plausible d'export : un tableau de logements sous une clé. */
function listingsFile(listings) {
  return JSON.stringify({
    listings: listings.map((l) => ({
      id: l.id,
      name: l.name,
      room_type: 'Entire home/apt',
      bedrooms: 2,
      city: 'Bordeaux',
      listing_url: l.id ? `https://www.airbnb.fr/rooms/${l.id}` : undefined,
    })),
  });
}

function manyListings(count, prefix, idBase = 200000) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(idBase + i),
    name: `${prefix} ${i + 1}`,
  }));
}

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

function postArchive(token, zip) {
  return authed(request(app).post('/api/properties/import-archive/preview'), token)
    .set('Content-Type', 'application/zip')
    .send(zip);
}

// Le .json part en octet-stream, exactement comme le fait le client : annonce
// en application/json, il serait capte par le express.json() global de
// server.js et sa borne a 1 Mo, bien avant d'atteindre cette route.
function postJson(token, buffer) {
  return authed(request(app).post('/api/properties/import-archive/preview'), token)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8'));
}

beforeAll(async () => {
  await initializeApp();
  db = getDatabase();
  tokenA = await registerAndLogin(EMAIL_A);
  tokenB = await registerAndLogin(EMAIL_B);
}, 30000);

afterAll(async () => {
  stopScheduler();
  if (db) {
    try {
      const users = await db.query('SELECT id FROM users WHERE email IN (?, ?)', [EMAIL_A, EMAIL_B]);
      const ids = users.map((u) => u.id);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(', ');
        await db.query(`DELETE FROM property_profiles WHERE user_id IN (${ph})`, ids);
        await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err.message);
    }
  }
}, 30000);

// ────────────────────────────────────────────────────────────────────────────
describe('lecture de l\'archive', () => {
  it('détecte les logements quelle que soit la convention de nommage', () => {
    const zip = makeZip({
      'account/profile.json': JSON.stringify({ user: { name: 'Delphine' } }),
      'listings/listings.json': listingsFile([{ id: '11739290151', name: 'La Villa Cosy' }]),
      'annonces/mes_annonces.json': JSON.stringify([
        { listingId: 22222222, title: 'Le Nid Douillet', property_type: 'apartment', beds: 1 },
      ]),
    });

    const { listings } = extractListingsFromArchive(zip);
    const names = listings.map((l) => l.name).sort();
    expect(names).toEqual(['La Villa Cosy', 'Le Nid Douillet']);
    expect(listings.find((l) => l.name === 'La Villa Cosy').external_listing_id).toBe('11739290151');
    expect(listings.find((l) => l.name === 'Le Nid Douillet').external_listing_id).toBe('22222222');
  });

  it("n'invente jamais un identifiant absent : le logement part en vérification", () => {
    const zip = makeZip({
      'listings.json': JSON.stringify([{ name: 'Studio sans identifiant', bedrooms: 1, city: 'Lyon' }]),
    });
    const { listings } = extractListingsFromArchive(zip);
    expect(listings).toHaveLength(1);
    expect(listings[0].external_listing_id).toBeNull();
    expect(listings[0].import_status).toBe('needs_verification');
  });

  it('retrouve un identifiant dans l\'URL de l\'annonce', () => {
    const zip = makeZip({
      'listings.json': JSON.stringify([
        { name: 'Maison du Port', url: 'https://www.airbnb.fr/rooms/33333333', bedrooms: 3 },
      ]),
    });
    const { listings } = extractListingsFromArchive(zip);
    expect(listings[0].external_listing_id).toBe('33333333');
  });

  // La garantie a changé de nature : ces fichiers ne sont plus « lus puis
  // écartés », ils ne sont PLUS OUVERTS DU TOUT (liste blanche de
  // services/airbnbExport.js). Une archive qui n'en contient pas d'autres est
  // donc refusée d'emblée, faute de fichier de logement.
  it("n'ouvre aucun fichier de données personnelles", () => {
    const zip = makeZip({
      'messages/messages.json': JSON.stringify([
        { name: 'Florine', message: 'Bonjour, le parking est-il inclus ?', sent_at: '2026-01-01' },
      ]),
      'payments/payouts.json': JSON.stringify([{ name: 'Virement mars', amount: 1250, currency: 'EUR' }]),
    });
    expect(() => extractListingsFromArchive(zip)).toThrow(/aucun fichier de logement/i);
  });

  it("ne retient que les logements quand l'archive mélange tout", () => {
    const zip = makeZip({
      'payment_processing.json': JSON.stringify([{ name: 'Virement mars', amount: 1250, city: 'Paris' }]),
      'id_verification.json': JSON.stringify([{ name: 'Passeport', country: 'FR', address: 'x' }]),
      'listings.json': listingsFile([{ id: '77777777', name: 'La Villa Cosy' }]),
    });
    const { listings, scannedFiles } = extractListingsFromArchive(zip);
    expect(listings.map((l) => l.name)).toEqual(['La Villa Cosy']);
    // Le point qui compte : les autres fichiers n'apparaissent même pas dans
    // ce qui a été examiné.
    expect(scannedFiles).toEqual(['listings.json']);
  });

  // `messages.json` est désormais ouvert — pour les conversations, et pour rien
  // d'autre. Il ne doit produire AUCUN logement, y compris quand son contenu
  // ressemble de loin à une annonce : c'est exactement le piège que
  // l'heuristique de forme tendrait sans la séparation faite en amont.
  it("ouvre les conversations sans jamais en tirer un logement", () => {
    const zip = makeZip({
      'messages.json': JSON.stringify([
        { name: 'Florine', message: 'Bonjour, le parking est-il inclus ?', bedrooms: 2, city: 'Lyon' },
      ]),
      'listings.json': listingsFile([{ id: '77777777', name: 'La Villa Cosy' }]),
    });
    const { listings } = extractListingsFromArchive(zip);
    expect(listings.map((l) => l.name)).toEqual(['La Villa Cosy']);
  });

  it("refuse une archive qui n'aurait que des conversations", () => {
    const zip = makeZip({
      'messages.json': JSON.stringify([{ messageThreads: [] }]),
    });
    expect(() => extractListingsFromArchive(zip)).toThrow(/aucun fichier de logement/i);
  });

  it('déduplique un logement présent dans plusieurs fichiers de l\'archive', () => {
    const zip = makeZip({
      'a/listings.json': listingsFile([{ id: '44444444', name: 'La Villa Cosy' }]),
      'b/listings_backup.json': listingsFile([{ id: '44444444', name: 'La Villa Cosy' }]),
    });
    const { listings } = extractListingsFromArchive(zip);
    expect(listings).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('archives invalides ou dangereuses', () => {
  it('refuse un fichier qui n\'est pas un ZIP', () => {
    expect(() => extractListingsFromArchive(Buffer.from('ceci est un PDF', 'utf8')))
      .toThrow(ZipError);
  });

  it('refuse un chemin remontant (Zip Slip)', () => {
    const zip = makeZip({ '../../etc/passwd.json': '{}' });
    expect(() => listEntries(zip)).toThrow(/chemin dangereux/i);
  });

  it('refuse un chemin absolu', () => {
    const zip = makeZip({ '/etc/shadow.json': '{}' });
    expect(() => listEntries(zip)).toThrow(/chemin dangereux/i);
  });

  it('ignore les liens symboliques au lieu de les suivre', () => {
    // 0o120777 << 16 : S_IFLNK dans les attributs externes.
    const zip = makeZip(
      { 'lien.json': 'ignored', 'listings.json': listingsFile([{ id: '55555555', name: 'Vrai logement' }]) },
      { externalAttrs: { 'lien.json': (0o120777 << 16) >>> 0 } }
    );
    const entries = listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['listings.json']);
  });

  it('refuse une archive ZIP64', () => {
    const zip = makeZip({ 'listings.json': '{}' }, { forceZip64: true });
    expect(() => listEntries(zip)).toThrow(/ZIP64/);
  });

  it('refuse une méthode de compression non prise en charge', () => {
    const zip = makeZip({ 'listings.json': '{}' }, { method: 12 }); // bzip2
    const [entry] = listEntries(zip);
    expect(() => readEntry(zip, entry)).toThrow(/non prise en charge/i);
  });

  it('borne la décompression : une bombe ZIP est refusée', () => {
    // 8 Mo de zéros se compriment en quelques kilo-octets.
    const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
    const zip = makeZip({ 'listings.json': bomb });
    const [entry] = listEntries(zip);
    expect(() => readEntry(zip, entry, { maxEntrySize: 64 * 1024 })).toThrow();
  });

  it('refuse une archive sans aucun fichier JSON', () => {
    const zip = makeZip({ 'donnees.csv': 'a,b,c' });
    expect(() => extractListingsFromArchive(zip)).toThrow(/JSON/);
  });

  it('un fichier JSON invalide n\'empêche pas de lire les autres', () => {
    const zip = makeZip({
      // Nommé comme un fichier de logement : c'est le seul cas intéressant,
      // puisqu'un fichier hors liste blanche n'est de toute façon pas ouvert.
      'listings_casse.json': '{ ceci n\'est pas du JSON',
      'listings.json': listingsFile([{ id: '66666666', name: 'Logement valide' }]),
    });
    const { listings, warnings } = extractListingsFromArchive(zip);
    expect(listings).toHaveLength(1);
    expect(listings[0].name).toBe('Logement valide');
    expect(warnings.join(' ')).toMatch(/listings_casse\.json/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('import de bout en bout', () => {
  it('importe plus de 10 logements en une seule opération', async () => {
    const listings = manyListings(14, `Logement A ${TAG}`);
    const zip = makeZip({ 'listings/listings.json': listingsFile(listings) });

    const preview = await postArchive(tokenA, zip);
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(14);
    expect(preview.body.already_imported).toBe(0);

    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: preview.body.listings });

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(14);
    expect(res.body.summary.failed).toBe(0);

    const list = await authed(request(app).get('/api/properties'), tokenA);
    expect(list.body.filter((p) => p.name.startsWith(`Logement A ${TAG}`))).toHaveLength(14);
  }, 60000);

  it('réimporter le même ZIP ne duplique rien', async () => {
    const listings = manyListings(14, `Logement A ${TAG}`);
    const zip = makeZip({ 'listings/listings.json': listingsFile(listings) });

    const preview = await postArchive(tokenA, zip);
    expect(preview.body.already_imported).toBe(14);

    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: preview.body.listings });

    expect(res.body.summary.created).toBe(0);
    expect(res.body.summary.updated).toBe(14);

    const list = await authed(request(app).get('/api/properties'), tokenA);
    expect(list.body.filter((p) => p.name.startsWith(`Logement A ${TAG}`))).toHaveLength(14);
  }, 60000);

  it('un logement invalide n\'empêche pas les autres', async () => {
    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [
          { name: `Valide 1 ${TAG}`, external_listing_id: '77777771' },
          { name: '', external_listing_id: '77777772' },          // nom manquant
          { name: 'x' },                                           // nom trop court
          { name: `Valide 2 ${TAG}`, external_listing_id: '77777773' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(2);
    expect(res.body.summary.failed).toBe(2);

    const list = await authed(request(app).get('/api/properties'), tokenA);
    const names = list.body.map((p) => p.name);
    expect(names).toContain(`Valide 1 ${TAG}`);
    expect(names).toContain(`Valide 2 ${TAG}`);
  });

  it('un logement sans identifiant est créé mais marqué à vérifier', async () => {
    await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: [{ name: `Sans identifiant ${TAG}`, external_listing_id: null }] });

    const [row] = await db.query(
      'SELECT import_status, airbnb_listing_id FROM property_profiles WHERE name = ?',
      [`Sans identifiant ${TAG}`]
    );
    expect(row.import_status).toBe('needs_verification');
    expect(row.airbnb_listing_id).toBeNull();
  });

  it('une URL qui ne pointe pas chez Airbnb est écartée', async () => {
    await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [{
          name: `URL douteuse ${TAG}`,
          external_listing_id: '88888888',
          url: 'https://exemple-malveillant.test/rooms/88888888',
        }],
      });

    const [row] = await db.query(
      'SELECT source_url FROM property_profiles WHERE name = ?',
      [`URL douteuse ${TAG}`]
    );
    // L'URL hostile n'est pas enregistrée. Ce qui la remplace n'est pas
    // « rien » mais l'adresse canonique DÉDUITE de l'identifiant, déjà validé
    // comme un entier : l'export structuré ne porte pas d'URL d'annonce, et
    // sans elle le lien vers Airbnb manquerait sur toutes les fiches importées.
    expect(row.source_url).not.toContain('exemple-malveillant');
    expect(row.source_url).toBe('https://www.airbnb.fr/rooms/88888888');
  });

  it("n'invente pas d'URL quand il n'y a pas d'identifiant", async () => {
    await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [{
          name: `Sans identifiant ni URL ${TAG}`,
          url: 'https://exemple-malveillant.test/rooms/1',
        }],
      });

    const [row] = await db.query(
      'SELECT source_url FROM property_profiles WHERE name = ?',
      [`Sans identifiant ni URL ${TAG}`]
    );
    expect(row.source_url).toBeNull();
  });

  it('refuse une requête sans corps', async () => {
    const res = await authed(request(app).post('/api/properties/import-archive/preview'), tokenA)
      .set('Content-Type', 'application/zip')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('refuse un import non authentifié', async () => {
    const res = await request(app).post('/api/properties/import-archive').send({ listings: [] });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export déjà décompressé : le .json seul
//
// Airbnb livre un ZIP, mais l'hôte le décompresse souvent avant de revenir sur
// l'application, ou ne garde que le fichier des annonces. Lui répondre
// « remettez-le dans un ZIP » serait un mur inutile : le contenu à lire est le
// même, et c'est le même détecteur de logements qui s'en charge.
// ─────────────────────────────────────────────────────────────────────────────
describe('fichier JSON seul, hors archive', () => {
  it('détecte les logements dans un .json déposé directement', () => {
    const json = listingsFile([
      { id: '31415926', name: 'Studio Canal Saint-Martin' },
      { id: '27182818', name: 'Loft Belleville' },
    ]);
    const { listings, jsonFiles } = extractListingsFromJson(Buffer.from(json, 'utf8'));
    expect(jsonFiles).toBe(1);
    expect(listings.map((l) => l.name).sort()).toEqual(['Loft Belleville', 'Studio Canal Saint-Martin']);
    expect(listings.every((l) => l.import_status === 'ready')).toBe(true);
  });

  it('donne le MÊME résultat que le même contenu placé dans un ZIP', () => {
    const json = listingsFile(manyListings(12, 'Comparaison', 700000));
    const viaJson = extractListingsFromUpload(Buffer.from(json, 'utf8'));
    const viaZip = extractListingsFromUpload(makeZip({ 'listings/listings.json': json }));

    // `source_file` diffère forcément — c'est le nom du fichier d'origine, et
    // c'est précisément ce qui change entre un dépôt JSON et un dépôt ZIP.
    const sansSource = (arr) => arr.map(({ source_file, ...reste }) => reste);
    expect(sansSource(viaJson.listings)).toEqual(sansSource(viaZip.listings));
  });

  it('reconnaît le format au CONTENU, pas à l\'extension', () => {
    const zip = makeZip({ 'listings.json': listingsFile([{ id: '55555555', name: 'Renommé' }]) });
    expect(looksLikeZip(zip)).toBe(true);
    expect(looksLikeZip(Buffer.from('{"listings":[]}', 'utf8'))).toBe(false);
    // Un ZIP soumis sous un nom trompeur reste lu comme un ZIP.
    expect(extractListingsFromUpload(zip, 'donnees.json').listings).toHaveLength(1);
  });

  it('supporte un BOM en tête de fichier', () => {
    const json = '\uFEFF' + listingsFile([{ id: '12121212', name: 'Avec BOM' }]);
    expect(extractListingsFromJson(Buffer.from(json, 'utf8')).listings).toHaveLength(1);
  });

  it('refuse un JSON invalide avec un message exploitable', () => {
    expect(() => extractListingsFromJson(Buffer.from('{ pas du JSON', 'utf8')))
      .toThrow(/JSON valide/i);
  });

  it('refuse un fichier vide', () => {
    expect(() => extractListingsFromUpload(Buffer.alloc(0))).toThrow(ZipError);
  });

  it('un JSON sans aucun logement ne fait pas échouer la lecture', () => {
    const json = JSON.stringify({ payments: [{ amount: 120, currency: 'EUR' }] });
    expect(extractListingsFromJson(Buffer.from(json, 'utf8')).listings).toEqual([]);
  });

  it('importe de bout en bout depuis un .json déposé', async () => {
    const listings = manyListings(11, `JSON direct ${TAG}`, 300000);
    const preview = await postJson(tokenA, listingsFile(listings));
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(11);

    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: preview.body.listings });
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(11);

    // Idempotence : le même fichier redéposé ne duplique rien.
    const again = await postJson(tokenA, listingsFile(listings));
    expect(again.body.already_imported).toBe(11);
    const second = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: again.body.listings });
    expect(second.body.summary.created).toBe(0);
  });

  it('rejette proprement un fichier qui n\'est ni ZIP ni JSON', async () => {
    const res = await postJson(tokenA, Buffer.from('%PDF-1.4 ...', 'utf8'));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/JSON/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Un seul lien de profil → tous les logements
//
// Le scan de la page publique d'un hôte rend des identifiants, et parfois le
// titre de l'annonce. Quand Airbnb masque le titre, le client pose un libellé
// de repère et le SIGNALE : le logement doit alors être créé « à vérifier »,
// jamais présenté comme constaté.
// ─────────────────────────────────────────────────────────────────────────────
describe('import de tous les logements d\'un profil', () => {
  it('crée tous les logements scannés en une seule opération', async () => {
    const scanned = manyListings(9, `Profil ${TAG}`, 400000).map((l) => ({
      name: l.name,
      external_listing_id: l.id,
      url: `https://www.airbnb.com/rooms/${l.id}`,
    }));

    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: scanned });
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(9);
    expect(res.body.summary.failed).toBe(0);
  });

  // Comportement VOULU, changé à la demande de l'hôte : un nom de repli n'est
  // plus accepté du tout.
  //
  // Il l'était, avec import_status = 'needs_verification' pour signaler le
  // doute. Mais ce marqueur n'était lu nulle part : en pratique un logement
  // s'appelait « Logement Airbnb #90909090 » dans la liste, indiscernable d'un
  // vrai nom — et c'est ce nom que Michel citait au voyageur. Les titres
  // qu'Airbnb sert à la place d'une fiche (« Redirection vers fr.airbnb.com »,
  // « 404 Page Not Found ») entraient par la même porte.
  //
  // Refuser la ligne et le dire vaut mieux que créer un logement mal nommé.
  it('refuse un nom de repli au lieu de créer un logement mal nommé', async () => {
    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [{
          name: 'Logement Airbnb #90909090',
          external_listing_id: '90909090',
          url: 'https://www.airbnb.com/rooms/90909090',
          name_provisional: true,
        }],
      });
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(0);
    expect(res.body.summary.failed).toBe(1);

    const rows = await db.query(
      'SELECT id FROM property_profiles WHERE airbnb_listing_id = ?',
      ['90909090']
    );
    expect(rows).toHaveLength(0);
  });

  it("refuse les titres qu'Airbnb sert à la place d'une fiche", async () => {
    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [
          { name: 'Redirection vers fr.airbnb.com', external_listing_id: '90909091' },
          { name: '404 Page Not Found - Airbnb', external_listing_id: '90909092' },
          { name: 'fr.airbnb.com', external_listing_id: '90909093' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(0);
    expect(res.body.summary.failed).toBe(3);
  });

  it('un titre réellement lu sur le profil reste « ready »', async () => {
    const res = await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({
        listings: [{
          name: `Titre constaté ${TAG}`,
          external_listing_id: '80808080',
          url: 'https://www.airbnb.com/rooms/80808080',
        }],
      });
    expect(res.status).toBe(200);

    const rows = await db.query(
      'SELECT import_status FROM property_profiles WHERE airbnb_listing_id = ?',
      ['80808080']
    );
    expect(rows[0].import_status).toBe('ready');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('isolation entre hôtes', () => {
  it('deux hôtes important le MÊME logement Airbnb en ont chacun un exemplaire', async () => {
    const zip = makeZip({
      'listings.json': listingsFile([{ id: '99999999', name: `Partagé ${TAG}` }]),
    });

    const previewA = await postArchive(tokenA, zip);
    await authed(request(app).post('/api/properties/import-archive'), tokenA)
      .send({ listings: previewA.body.listings });

    const previewB = await postArchive(tokenB, zip);
    // L'archive de B ne voit pas le logement de A.
    expect(previewB.body.already_imported).toBe(0);
    await authed(request(app).post('/api/properties/import-archive'), tokenB)
      .send({ listings: previewB.body.listings });

    const rows = await db.query(
      'SELECT user_id FROM property_profiles WHERE airbnb_listing_id = ? ORDER BY user_id',
      ['99999999']
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).not.toBe(rows[1].user_id);

    // Et chacun ne voit que le sien.
    const listA = await authed(request(app).get('/api/properties'), tokenA);
    const listB = await authed(request(app).get('/api/properties'), tokenB);
    expect(listA.body.filter((p) => p.name === `Partagé ${TAG}`)).toHaveLength(1);
    expect(listB.body.filter((p) => p.name === `Partagé ${TAG}`)).toHaveLength(1);
    // B n'a QUE ce logement : rien de l'archive de A n'a fui.
    expect(listB.body.filter((p) => p.name.startsWith(`Logement A ${TAG}`))).toHaveLength(0);
  }, 60000);
});

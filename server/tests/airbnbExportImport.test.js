/**
 * Import de l'export Airbnb, de bout en bout.
 *
 * CE QUE CE FICHIER VÉRIFIE, ET POURQUOI
 * --------------------------------------
 * Les caractéristiques d'un logement importé étaient vides. Trois maillons
 * pouvaient en être la cause : la lecture du fichier, l'écriture en base, ou la
 * relecture par l'API. `airbnbExport.test.js` couvre le premier ; celui-ci
 * parcourt les deux autres, jusqu'à la forme exacte que le formulaire relit.
 *
 * Un test qui s'arrêterait au contrôleur ne prouverait rien : c'est justement
 * entre le parseur et l'affichage que la donnée se perdait.
 *
 * ISOLATION
 * ---------
 * Deux comptes sont créés et importent LE MÊME logement Airbnb. C'est le seul
 * moyen de vérifier que la contrainte d'unicité est bien par utilisateur et non
 * globale — une unicité globale ferait échouer le second import, ou pire, lui
 * rendrait le logement du premier.
 */

const zlib = require('zlib');
const request = require('supertest');
const serverModule = require('../server');

const app = serverModule;
const { initializeApp } = serverModule;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');

const TAG = `exp${Date.now()}`;
const PASSWORD = 'MotDePasse123!';
const EMAIL_A = `export-a-${TAG}@test.local`;
const EMAIL_B = `export-b-${TAG}@test.local`;

const LISTING_ID = '1684090983577235984';   // 19 chiffres : au-delà de 2^53 − 1
const OTHER_ID = '1026039117214176726';

let db;
let tokenA;
let tokenB;

// La prévisualisation du MÊME ZIP est déterministe : la refaire à chaque test
// n'apprendrait rien et ferait cogner le limiteur de débit de la route, qui
// est un vrai garde-fou de production et n'a pas à être désactivé pour nous
// arranger. Elle est donc faite une fois et réutilisée.
//
// Elle dépend du compte : `already_imported` se calcule par utilisateur. Le
// cache est donc celui de A, et B refait la sienne là où c'est le sujet.
let cachedPreview;

// ── Construction d'un ZIP minimal (deflate), comme archiveImport.test.js ────
function makeZip(files) {
  const encoder = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = encoder(content);
    const deflated = zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(zlib.crc32 ? zlib.crc32(raw) : 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, deflated);
    centrals.push(central);
    offset += local.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ── Contenus à la forme réelle de l'export ─────────────────────────────────
function listingsJson(id = LISTING_ID, name = `Villa ${TAG}`) {
  // Écrit à la main plutôt que par JSON.stringify : c'est le seul moyen que
  // l'identifiant de 19 chiffres arrive au parseur tel qu'Airbnb l'écrit, sans
  // passer par un nombre JavaScript qui l'aurait déjà arrondi.
  return `[{"listings":[{
    "id": ${id},
    "nickname": null,
    "propertyType": "House",
    "roomType": "Entire home/apt",
    "bathroomType": "private",
    "bedrooms": 3,
    "beds": 4,
    "bathrooms": 2.0,
    "personCapacity": 8,
    "city": "Gaillan-en-Médoc",
    "country": "FR",
    "zipcode": "33340",
    "street": "1 route du Test",
    "formattedAddress": "1 route du Test, 33340 Gaillan-en-Médoc, France",
    "directions": "Le portail bleu au bout du chemin.",
    "houseManual": "Le disjoncteur est dans le garage.",
    "license": null,
    "petsAllowed": true,
    "smokingAllowed": false,
    "eventsAllowed": false,
    "infantsAllowed": true,
    "childrenAlloewd": true,
    "amenities": ["wireless_internet","kitchen","pool","jacuzzi","free_parking","tv","heating","washer","essentials","smoke_detector"],
    "expectations": [{"expectationType":"pool_or_jacuzzi_with_no_fence","addedDetails":"la piscine n'est pas clôturée","hasExpectation":true}],
    "listingDescriptions": [{
      "name": ${JSON.stringify(name)},
      "summary": "Résumé.",
      "description": "Grande villa avec piscine et jacuzzi.",
      "neighborhoodOverview": "À quinze minutes de l'océan.",
      "language": "fr"
    }],
    "rooms": [
      {"roomNumber":1,"roomType":"BEDROOM","isPrivate":true,"amenities":["BED_LINENS","KING_BED"]},
      {"roomNumber":2,"roomType":"BEDROOM","isPrivate":true,"amenities":["BUNK_BED"]}
    ],
    "photos": []
  }]}]`;
}

function pricingJson(id = LISTING_ID) {
  return `[{"pricingData":[{
    "listingId": ${id},
    "listingPriceSetting": {
      "defaultDailyPrice": {"amount": 250, "currency": "EUR"},
      "weekendPrice": {"amount": 290, "currency": "EUR"},
      "weeklyPriceFactor": 0.9,
      "monthlyPriceFactor": 0.75,
      "securityDeposit": {"amount": 800, "currency": "EUR"},
      "pricePerExtraPerson": {"amount": 15, "currency": "EUR"},
      "guestsIncluded": 6,
      "listingCurrency": "EUR"
    },
    "smartPricingSetting": {"isEnabled": false},
    "customPricings": {"customDailyPrices": []}
  }],"pricingRules":[]}]`;
}

// La période qui encadre aujourd'hui. Deux périodes historiques de 7 nuits la
// précèdent dans le fichier : si l'import rendait la valeur la PLUS FRÉQUENTE,
// il dirait « 7 nuits ». C'est la règle en vigueur qui doit sortir.
const WIDE_START = '2000-01-01';
const WIDE_END = '2099-12-31';

function calendarJson(id = LISTING_ID, { busy = true } = {}) {
  const busyOverrides = busy ? `
        {"busyReason": ["HOST_BUSY"], "calendarDate": "2099-08-10"},
        {"busyReason": ["HOST_BUSY"], "calendarDate": "2099-08-11"},
        {"busyReason": ["HOST_BUSY"], "calendarDate": "2099-08-12"},
        {"busyReason": ["HOST_BUSY"], "calendarDate": "1999-01-01"}
      ` : '';
  return `[{"listingsCalendarData":[{
    "listingId": ${id},
    "globalCalendarData": {"bookingLeadTime": {"bookingLeadTimeRule": 2}},
    "seasonalCalendarData": {"seasonalMinNights": [
      {"minNights": 7, "startDate": "2000-01-01", "endDate": "2000-12-31", "checkinAllowedOn": "ALL"},
      {"minNights": 7, "startDate": "2001-01-01", "endDate": "2001-12-31", "checkinAllowedOn": "ALL"},
      {"minNights": 3, "startDate": "${WIDE_START}", "endDate": "${WIDE_END}", "checkinAllowedOn": "ALL"}
    ]},
    "dailyCalendarData": {
      "busyOverrides": [${busyOverrides}],
      "minNightOverrides": [], "availableOverrides": []
    }
  }],"ruleGroupAvailabilityRules":[]}]`;
}

function permitsJson(id = LISTING_ID) {
  return `[{"listingRegistrations":[{
    "listingUrl": "https://www.airbnb.com/rooms/${id}",
    "registrations": [{"registrationSubmissions": [{
      "regulatoryBody": "France",
      "type": "Existing registration",
      "data": {"permit_number": "3334000123456", "listing_address": "1 route du Test, 33340 Gaillan-en-Médoc, FR"}
    }]}]
  }]}]`;
}

function reviewsJson(id = LISTING_ID) {
  const one = (rating) => `{"review": {"entityType": "HOME", "revieweeRole": "HOST",
    "hasSubmitted": true, "isSystemAutoGenerated": false, "entityId": ${id}, "rating": ${rating}}}`;
  return `[{"reviewsReceived":[${one(5)},${one(5)},${one(4)}],"reviewsProvided":[]}]`;
}

// Un séjour à venir et un séjour terminé : seul le premier doit entrer.
const FUTURE_START = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);

function reservationsJson(id = LISTING_ID) {
  return `[{"reservations":[
    {"confirmationCode": "HM${TAG.slice(-8).toUpperCase()}", "hostingUrl": "https://www.airbnb.com/rooms/${id}",
     "startDate": "${FUTURE_START}", "nights": 4, "status": "accepted", "numberOfGuests": 3,
     "message": "je serai en retard", "guestProfileUrl": "https://www.airbnb.com/users/show/4242"},
    {"confirmationCode": "HMPASSE01", "hostingUrl": "https://www.airbnb.com/rooms/${id}",
     "startDate": "2019-05-01", "nights": 2, "status": "accepted", "numberOfGuests": 2}
  ]}]`;
}

/** L'export complet, avec les fichiers sensibles qu'Airbnb livre aussi. */
function fullExportZip(overrides = {}) {
  return makeZip({
    'listings.json': listingsJson(),
    'listing_pricing.json': pricingJson(),
    'listing_calendar.json': calendarJson(),
    'listing_permits.json': permitsJson(),
    'reviews.json': reviewsJson(),
    'reservations.json': reservationsJson(),
    // Présents dans un export réel. Seul `messages.json` est ouvert, et
    // uniquement pour les conversations : celui-ci n'a pas la forme attendue,
    // il ne doit donc RIEN produire — surtout pas un logement « Florine ».
    'messages.json': JSON.stringify([{ name: 'Florine', message: 'Bonjour', bedrooms: 2, city: 'Lyon' }]),
    // Ceux-là ne doivent jamais être ouverts.
    'payment_processing.json': JSON.stringify([{ name: 'Virement', amount: 1250, city: 'Paris' }]),
    'id_verification.json': JSON.stringify([{ name: 'Passeport', country: 'FR', address: 'secret' }]),
    'activity_log.json': JSON.stringify([{ name: 'Connexion', city: 'Bordeaux', address: 'x' }]),
    ...overrides,
  });
}

function authed(req, token) {
  return req.set('Authorization', `Bearer ${token}`);
}

function preview(token, buffer) {
  return authed(request(app).post('/api/properties/import-archive/preview'), token)
    .set('Content-Type', 'application/zip')
    .send(buffer);
}

function doImport(token, listings) {
  return authed(request(app).post('/api/properties/import-archive'), token).send({ listings });
}

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

beforeAll(async () => {
  await initializeApp();
  db = getDatabase();
  tokenA = await registerAndLogin(EMAIL_A);
  tokenB = await registerAndLogin(EMAIL_B);
  cachedPreview = await preview(tokenA, fullExportZip());
}, 30000);

afterAll(async () => {
  stopScheduler();
  if (!db) return;
  try {
    const users = await db.query('SELECT id FROM users WHERE email IN (?, ?)', [EMAIL_A, EMAIL_B]);
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(', ');
      await db.query(`DELETE FROM availability_blocks WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM property_profiles WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('cleanup failed:', err.message);
  }
}, 30000);

// ────────────────────────────────────────────────────────────────────────────
describe('prévisualisation du ZIP complet', () => {
  it('détecte le logement et dit ce qu’il a trouvé', async () => {
    const res = cachedPreview;
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    const [listing] = res.body.listings;
    expect(listing.name).toBe(`Villa ${TAG}`);
    expect(listing.external_listing_id).toBe(LISTING_ID);
    expect(listing.found).toMatchObject({
      general: true, address: true, capacity: true, amenities: true,
      rules: true, access: true, pricing: true, calendar: true, permits: true,
    });
    expect(res.body.sources).toMatchObject({
      listings: true, pricing: true, calendar: true, permits: true,
    });
  });

  it('n’examine QUE les fichiers de logement et les conversations', async () => {
    const res = cachedPreview;
    // `messages.json` figure ici : il est ouvert, pour les conversations et
    // pour rien d'autre. Les fichiers de paiement, d'identité et d'historique
    // de navigation, eux, ne sont toujours jamais décompressés.
    expect(res.body.scanned_files.sort()).toEqual([
      'listing_calendar.json', 'listing_permits.json', 'listing_pricing.json',
      'listings.json', 'messages.json', 'reservations.json', 'reviews.json',
    ]);
    // Le point qui compte : rien de ce que contiennent les fichiers sensibles
    // ne ressort, pas même sous forme de logement mal détecté.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Florine');
    expect(body).not.toContain('Passeport');
    expect(body).not.toContain('Virement');
  });

  it('ne coche pas une case pour un fichier absent', async () => {
    const res = await preview(tokenA, makeZip({ 'listings.json': listingsJson() }));
    expect(res.body.listings[0].found).toMatchObject({
      general: true, address: true, capacity: true,
      pricing: false, calendar: false, permits: false, reviews: false,
    });
  });

  it('rend une fiche complète, sans « [object Object] »', async () => {
    const res = cachedPreview;
    const [listing] = res.body.listings;
    expect(listing).toMatchObject({
      property_type: 'house',
      bedrooms: 3,
      beds: 4,
      bathrooms: 2,
      max_guests: 8,
      city: 'Gaillan-en-Médoc',
      country: 'France',
      has_wifi: true,
      has_pool: true,
      has_jacuzzi: true,
      allows_pets: true,
      allows_smoking: false,
    });
    expect(listing.description).toBe('Grande villa avec piscine et jacuzzi.');
    expect(listing.bed_types).toBe('Chambre 1 : lit king size\nChambre 2 : lits superposés');
    expect(JSON.stringify(listing)).not.toContain('[object Object]');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('écriture en base et relecture par l’API', () => {
  let propertyId;

  it('enregistre les caractéristiques, pas seulement le nom', async () => {
    const importRes = await doImport(tokenA, cachedPreview.body.listings);

    expect(importRes.status).toBe(200);
    expect(importRes.body.summary.created).toBe(1);
    propertyId = importRes.body.details.created[0].id;

    const [row] = await db.query(
      'SELECT * FROM property_profiles WHERE id = ? AND user_id > 0',
      [propertyId]
    );
    expect(row.name).toBe(`Villa ${TAG}`);
    expect(String(row.airbnb_listing_id)).toBe(LISTING_ID);
    expect(row.property_type).toBe('house');
    expect(row.bedrooms).toBe(3);
    expect(row.beds).toBe(4);
    expect(row.bathrooms).toBe(2);
    expect(row.max_guests).toBe(8);
    expect(row.city).toBe('Gaillan-en-Médoc');
    expect(row.country).toBe('France');
    expect(row.address).toContain('route du Test');
    expect(row.description).toContain('piscine et jacuzzi');
    expect(row.house_rules).toContain('Piscine ou jacuzzi sans barrière');
    expect(!!row.has_wifi).toBe(true);
    expect(!!row.has_pool).toBe(true);
    expect(!!row.has_washing_machine).toBe(true);
    expect(!!row.allows_pets).toBe(true);
    expect(!!row.allows_smoking).toBe(false);
    // Aucune case cochée à tort.
    expect(!!row.has_gym).toBe(false);
  });

  it('range dans context_json ce qui n’a pas de colonne', async () => {
    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    const context = JSON.parse(row.context_json);

    expect(context.house_manual).toContain('disjoncteur');
    expect(context.registration_number).toBe('3334000123456');
    expect(context.building_entry).toContain('portail bleu');
    expect(context.nearby).toContain("l'océan");
    expect(context.has_jacuzzi).toBe(true);
    expect(context.min_stay).toBe('3 nuits');
    expect(context.payment_notes).toContain('Tarif de base 250 EUR par nuit');
    expect(context.has_deposit_required).toBe(true);
    expect(context.deposit_amount).toBe('800 EUR');
    expect(context.price_extra_guest_amount).toBe('15 EUR');
    expect(context.extra_guest_threshold).toBe('7');
    // La forme attendue par promptBuilder et le formulaire est respectée.
    expect(typeof context.amenities).toBe('string');
    expect(context.amenities).toContain('Piscine');
    expect(typeof context.amenities_detail).toBe('object');
    expect(row.context_json).not.toContain('[object Object]');
  });

  it('crée les indisponibilités du calendrier, sans les dates passées', async () => {
    const blocks = await db.query(
      'SELECT start_date, end_date, source FROM availability_blocks WHERE property_id = ?',
      [propertyId]
    );
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0].start_date)).toContain('2099-08-10');
    expect(String(blocks[0].end_date)).toContain('2099-08-13');
    expect(blocks[0].source).toBe('airbnb_export');
  });

  it('l’API rend la fiche telle que le formulaire la relit', async () => {
    const res = await authed(request(app).get(`/api/properties/${propertyId}`), tokenA);
    expect(res.status).toBe(200);
    expect(res.body.bedrooms).toBe(3);
    expect(res.body.max_guests).toBe(8);
    expect(res.body.city).toBe('Gaillan-en-Médoc');
    expect(String(res.body.airbnb_listing_id)).toBe(LISTING_ID);

    // Le formulaire fusionne colonnes + context_json : c'est cette fusion qui
    // doit rendre un champ rempli, pas la seule ligne SQL.
    const merged = { ...res.body, ...JSON.parse(res.body.context_json) };
    expect(merged.house_manual).toContain('disjoncteur');
    expect(merged.registration_number).toBe('3334000123456');
    expect(merged.has_jacuzzi).toBe(true);
    expect(merged.min_stay).toBe('3 nuits');
  });

  it('enregistre la note moyenne et le nombre d’avis', async () => {
    const [row] = await db.query(
      'SELECT rating, review_count FROM property_profiles WHERE id = ?', [propertyId]
    );
    // Trois avis recevables : 5, 5 et 4.
    expect(Number(row.rating)).toBeCloseTo(4.67, 2);
    expect(row.review_count).toBe(3);
  });

  it('enregistre le séjour à venir, et lui seul', async () => {
    const stays = await db.query(
      `SELECT check_in_date, check_out_date, status, number_of_guests, property_id, airbnb_listing_id
         FROM reservations WHERE property_id = ?`,
      [propertyId]
    );
    expect(stays).toHaveLength(1);
    expect(String(stays[0].check_in_date)).toContain(FUTURE_START);
    expect(stays[0].status).toBe('accepted');
    expect(stays[0].number_of_guests).toBe(3);
    expect(String(stays[0].airbnb_listing_id)).toBe(LISTING_ID);
  });

  it('n’enregistre rien du voyageur', async () => {
    const [stay] = await db.query(
      'SELECT * FROM reservations WHERE property_id = ?', [propertyId]
    );
    const serialized = JSON.stringify(stay);
    expect(serialized).not.toContain('en retard');
    expect(serialized).not.toContain('users/show/4242');
    expect(stay.guest_name).toBeNull();
  });

  it('conserve la provenance de chaque champ', async () => {
    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    const sources = JSON.parse(JSON.parse(row.context_json).import_sources);
    expect(sources.max_guests).toBe('listings.json');
    expect(sources.payment_notes).toBe('listing_pricing.json');
    expect(sources.min_stay).toBe('listing_calendar.json');
    expect(sources.rating).toBe('reviews.json');
  });

  it('cite la valeur exacte des demi-salles de bain à l’IA', async () => {
    const changed = listingsJson().replace('"bathrooms": 2.0', '"bathrooms": 1.5');
    const previewRes = await preview(tokenA, makeZip({ 'listings.json': changed }));
    await doImport(tokenA, previewRes.body.listings);

    const [row] = await db.query(
      'SELECT bathrooms, context_json FROM property_profiles WHERE id = ?', [propertyId]
    );
    // La colonne est entière ; le contexte, lui, garde 1.5 — et c'est lui que
    // promptBuilder lit pour répondre au voyageur.
    expect(row.bathrooms).toBe(2);
    // Rangée en texte, comme tous les champs de contexte : promptBuilder
    // l'interpole telle quelle dans la phrase qu'il donne à l'IA.
    expect(JSON.parse(row.context_json).bathrooms_exact).toBe('1.5');
  });

  it('la liste des logements montre le logement importé', async () => {
    const res = await authed(request(app).get('/api/properties'), tokenA);
    const found = res.body.find((p) => p.id === propertyId);
    expect(found).toBeTruthy();
    expect(found.import_status).toBe('ready');
    expect(!!found.has_pool).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('ré-import : mise à jour, jamais de doublon', () => {
  it('un second import du même ZIP met à jour au lieu de dupliquer', async () => {
    const res = await doImport(tokenA, cachedPreview.body.listings);

    expect(res.body.summary.created).toBe(0);
    expect(res.body.summary.updated).toBe(1);

    const rows = await db.query(
      'SELECT id FROM property_profiles WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
      [LISTING_ID, EMAIL_A]
    );
    expect(rows).toHaveLength(1);
  });

  it('ne duplique pas non plus les dates bloquées', async () => {
    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    const blocks = await db.query(
      'SELECT id FROM availability_blocks WHERE property_id = ? AND source = ?',
      [row.id, 'airbnb_export']
    );
    expect(blocks).toHaveLength(1);
  });

  it('une caractéristique modifiée chez Airbnb est reprise', async () => {
    const changed = listingsJson().replace('"personCapacity": 8', '"personCapacity": 10');
    const previewRes = await preview(tokenA, makeZip({ 'listings.json': changed }));
    await doImport(tokenA, previewRes.body.listings);

    const [row] = await db.query(
      `SELECT max_guests FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    expect(row.max_guests).toBe(10);
  });

  it('ne touche pas à ce que l’hôte a saisi et qu’Airbnb n’exporte pas', async () => {
    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );

    // L'hôte renseigne le Wi-Fi et le code d'accès : deux informations que
    // l'export Airbnb ne contient pas.
    await authed(request(app).patch(`/api/properties/${row.id}`), tokenA)
      .send({ wifi_password: 'secret-du-proprietaire', access_code: '4821' });

    await doImport(tokenA, cachedPreview.body.listings);

    const [after] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [row.id]);
    const context = JSON.parse(after.context_json);
    expect(context.wifi_password).toBe('secret-du-proprietaire');
    expect(context.access_code).toBe('4821');
  });

  it('un import sans calendrier ne supprime pas les dates déjà importées', async () => {
    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    const before = await db.query(
      'SELECT id FROM availability_blocks WHERE property_id = ?', [row.id]
    );
    expect(before.length).toBeGreaterThan(0);

    // Ce que produit le scan de profil : un nom, un identifiant, un lien, et
    // rien sur le calendrier. Il ne doit pas effacer ce que le ZIP a apporté.
    await doImport(tokenA, [{
      name: `Villa ${TAG}`,
      external_listing_id: LISTING_ID,
      url: `https://www.airbnb.fr/rooms/${LISTING_ID}`,
    }]);

    const after = await db.query(
      'SELECT id FROM availability_blocks WHERE property_id = ?', [row.id]
    );
    expect(after).toHaveLength(before.length);
  });

  it('un calendrier vidé chez Airbnb libère bien les dates', async () => {
    // Le fichier est produit vide à la source. Le refabriquer par
    // JSON.parse/stringify aurait arrondi son identifiant de 19 chiffres — le
    // calendrier ne se serait plus rattaché à rien, et le test aurait passé
    // pour la mauvaise raison.
    const emptied = calendarJson(LISTING_ID, { busy: false });
    const previewRes = await preview(tokenA, makeZip({
      'listings.json': listingsJson(),
      'listing_calendar.json': emptied,
    }));
    await doImport(tokenA, previewRes.body.listings);

    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    const blocks = await db.query(
      'SELECT id FROM availability_blocks WHERE property_id = ? AND source = ?',
      [row.id, 'airbnb_export']
    );
    expect(blocks).toHaveLength(0);
  });

  it('ne supprime pas un blocage que l’hôte a posé à la main', async () => {
    const [row] = await db.query(
      `SELECT id, user_id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    await db.query(
      `INSERT INTO availability_blocks (property_id, user_id, start_date, end_date, reason, source)
       VALUES (?, ?, '2099-12-01', '2099-12-10', 'travaux', 'manual')`,
      [row.id, row.user_id]
    );

    await doImport(tokenA, cachedPreview.body.listings);

    const manual = await db.query(
      'SELECT id FROM availability_blocks WHERE property_id = ? AND source = ?',
      [row.id, 'manual']
    );
    expect(manual).toHaveLength(1);
  });

  it('conserve dans le contexte un équipement coché à la main', async () => {
    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    // La salle de sport n'est pas dans l'export : l'hôte la coche lui-même.
    await authed(request(app).patch(`/api/properties/${row.id}`), tokenA).send({ has_gym: true });

    await doImport(tokenA, cachedPreview.body.listings);

    const [after] = await db.query(
      'SELECT has_gym, context_json FROM property_profiles WHERE id = ?', [row.id]
    );
    expect(!!after.has_gym).toBe(true);
    // Le résumé lisible que l'IA reçoit doit la mentionner encore.
    expect(JSON.parse(after.context_json).amenities).toContain('Salle de sport');
  });

  it('ne réécrit pas un nom que l’hôte a corrigé lui-même', async () => {
    const [row] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    await authed(request(app).patch(`/api/properties/${row.id}`), tokenA)
      .send({ name: `Mon nom à moi ${TAG}` });

    await doImport(tokenA, cachedPreview.body.listings);

    const [after] = await db.query('SELECT name FROM property_profiles WHERE id = ?', [row.id]);
    expect(after.name).toBe(`Mon nom à moi ${TAG}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('isolation entre deux hôtes', () => {
  it('le même logement Airbnb peut exister sur deux comptes, séparément', async () => {
    const previewRes = await preview(tokenB, fullExportZip());
    // Chez B, le logement n'est pas « déjà présent » : celui de A ne le regarde pas.
    expect(previewRes.body.listings[0].already_imported).toBe(false);

    const res = await doImport(tokenB, previewRes.body.listings);
    expect(res.body.summary.created).toBe(1);

    const rows = await db.query(
      'SELECT user_id FROM property_profiles WHERE airbnb_listing_id = ?',
      [LISTING_ID]
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(rows.length);
  });

  it('B ne voit pas le logement de A et ne peut pas l’ouvrir', async () => {
    const [aRow] = await db.query(
      `SELECT id FROM property_profiles
       WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)`,
      [LISTING_ID, EMAIL_A]
    );
    const res = await authed(request(app).get(`/api/properties/${aRow.id}`), tokenB);
    expect(res.status).toBe(404);
  });

  it('les indisponibilités importées restent attachées à leur propriétaire', async () => {
    const rows = await db.query(
      'SELECT id, user_id FROM property_profiles WHERE airbnb_listing_id = ?',
      [LISTING_ID]
    );
    for (const row of rows) {
      const blocks = await db.query(
        'SELECT user_id FROM availability_blocks WHERE property_id = ?',
        [row.id]
      );
      for (const block of blocks) expect(block.user_id).toBe(row.user_id);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('fichiers manquants, invalides ou hostiles', () => {
  it('accepte listings.json seul — le cas qui marchait déjà', async () => {
    const res = await preview(tokenA, makeZip({ 'listings.json': listingsJson(OTHER_ID, `Solo ${TAG}`) }));
    expect(res.status).toBe(200);
    expect(res.body.listings[0].name).toBe(`Solo ${TAG}`);
    expect(res.body.listings[0].bedrooms).toBe(3);
  });

  it('accepte listings.json déposé seul, hors archive', async () => {
    const res = await authed(request(app).post('/api/properties/import-archive/preview'), tokenA)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(listingsJson(OTHER_ID, `Nu ${TAG}`), 'utf8'));
    expect(res.status).toBe(200);
    expect(res.body.listings[0].name).toBe(`Nu ${TAG}`);
    expect(res.body.listings[0].max_guests).toBe(8);
  });

  it('un fichier annexe illisible n’empêche pas d’importer les logements', async () => {
    const res = await preview(tokenA, makeZip({
      'listings.json': listingsJson(),
      'listing_pricing.json': '{ ceci ne ferme pas',
      'listing_calendar.json': calendarJson(),
    }));
    expect(res.status).toBe(200);
    expect(res.body.listings).toHaveLength(1);
    expect(res.body.listings[0].found.calendar).toBe(true);
    expect(res.body.listings[0].found.pricing).toBe(false);
    expect(res.body.warnings.join(' ')).toMatch(/listing_pricing\.json/);
  });

  it('des valeurs nulles ou absentes ne font pas échouer la lecture', async () => {
    const sparse = `[{"listings":[{
      "id": ${OTHER_ID},
      "nickname": null,
      "propertyType": null,
      "bedrooms": null,
      "beds": null,
      "bathrooms": null,
      "personCapacity": null,
      "city": null,
      "country": null,
      "formattedAddress": null,
      "amenities": null,
      "expectations": null,
      "rooms": null,
      "listingDescriptions": [{"name": "Minimal ${TAG}"}]
    }]}]`;
    const previewRes = await preview(tokenA, makeZip({ 'listings.json': sparse }));
    expect(previewRes.status).toBe(200);

    const importRes = await doImport(tokenA, previewRes.body.listings);
    expect(importRes.body.summary.created + importRes.body.summary.updated).toBe(1);

    // Les colonnes NOT NULL reçoivent la valeur minimale, pas une valeur
    // inventée qui se ferait passer pour une donnée Airbnb.
    const [row] = await db.query(
      'SELECT * FROM property_profiles WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
      [OTHER_ID, EMAIL_A]
    );
    expect(row.name).toBe(`Minimal ${TAG}`);
    expect(row.bedrooms).toBe(1);
    expect(row.max_guests).toBe(2);
    expect(row.description).toBeNull();
  });

  it('refuse une archive dont aucun fichier ne concerne les logements', async () => {
    const res = await preview(tokenA, makeZip({
      'messages.json': JSON.stringify([{ name: 'x', bedrooms: 1, city: 'y' }]),
      'host_payouts.json': JSON.stringify([{ name: 'z', city: 'y', address: 'w' }]),
    }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_LISTING_FILE');
  });

  it('n’écrit pas un champ que le client aurait inventé', async () => {
    await doImport(tokenA, [{
      name: `Injection ${TAG}`,
      external_listing_id: '55550000',
      property_type: 'chateau-fort',       // hors du menu
      bedrooms: 99999,                     // hors bornes
      max_guests: -3,
      champ_inconnu: 'valeur',
      has_wifi: 'oui-mais-pas-un-booleen',
      city: { objet: true },
    }]);

    const [row] = await db.query(
      'SELECT * FROM property_profiles WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
      ['55550000', EMAIL_A]
    );
    expect(row.property_type).toBe('apartment');   // valeur de repli
    expect(row.bedrooms).toBe(50);                 // borné
    expect(row.max_guests).toBe(1);                // borné
    expect(row.city).toBeNull();                   // un objet n'est pas du texte
    expect(!!row.has_wifi).toBe(false);            // seul un vrai booléen passe
    expect(Object.keys(row)).not.toContain('champ_inconnu');
    expect(row.context_json).not.toContain('champ_inconnu');
  });

  it('refuse une plage de dates incohérente', async () => {
    await doImport(tokenA, [{
      name: `Dates ${TAG}`,
      external_listing_id: '55550001',
      blocked_dates: [
        { start_date: '2099-05-10', end_date: '2099-05-01' },   // fin avant début
        { start_date: 'pas-une-date', end_date: '2099-05-20' },
        { start_date: '2099-06-01', end_date: '2099-06-05' },   // valide
      ],
    }]);

    const [row] = await db.query(
      'SELECT id FROM property_profiles WHERE airbnb_listing_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
      ['55550001', EMAIL_A]
    );
    const blocks = await db.query(
      'SELECT start_date FROM availability_blocks WHERE property_id = ?',
      [row.id]
    );
    expect(blocks).toHaveLength(1);
  });
});

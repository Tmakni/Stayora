/**
 * De la conversation au fait vérifié, de bout en bout.
 *
 * CE QUI EST VERROUILLÉ ICI
 * -------------------------
 *   - un fil n'est rattaché à un logement que par un code de réservation
 *     RÉELLEMENT présent dans l'export ; un code inconnu ne rattache rien ;
 *   - les messages des voyageurs ne deviennent jamais une caractéristique ;
 *   - un fait sensible ou incertain n'est pas écrit dans la fiche ;
 *   - une confirmation de l'hôte n'est jamais écrasée par une analyse ;
 *   - un hôte ne voit ni ne modifie les faits d'un autre.
 */

const request = require('supertest');
const zlib = require('zlib');
const serverModule = require('../server');

const app = serverModule;
const { initializeApp } = serverModule;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');
const { reduceThreads, parseDigest, wrapDigest, evidenceByListing } = require('../services/airbnbMessages');
const { reservationIndex, hostAccountIds } = require('../services/airbnbExport');
const { saveFacts, autoApplicableValues, noteHostMessage } = require('../services/propertyFacts');

const TAG = `fx${Date.now().toString(36)}`;
const EMAIL_A = `a-${TAG}@test.dev`;
const EMAIL_B = `b-${TAG}@test.dev`;
const PASSWORD = 'Password123!';

// Un identifiant de 19 chiffres, comme les annonces Airbnb récentes.
const LISTING_ID = '1026039117214176726';
const HOST_ID = '25578577';
const GUEST_ID = '681817971';

let db;
let tokenA;
let tokenB;

// ── ZIP minimal (deflate) ───────────────────────────────────────────────────
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
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
//
// L'identifiant est écrit à la main dans le JSON : passer par JSON.stringify
// l'arrondirait avant même que le parseur le voie.
function listingsJson() {
  return `[{"listings":[{
    "id": ${LISTING_ID},
    "hostUserId": ${HOST_ID},
    "nickname": "villa",
    "propertyType": "House",
    "roomType": "Entire home/apt",
    "personCapacity": 4,
    "bedrooms": 2,
    "beds": 3,
    "bathrooms": 1,
    "city": "Bordeaux",
    "country": "FR",
    "amenities": [],
    "listingDescriptions": [{"name": "Villa ${TAG}", "summary": "Belle villa"}]
  }]}]`;
}

/** `count` réservations passées, échelonnées d'un mois. */
function reservationsJson(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - (count - i));
    rows.push(`{"confirmationCode": "HM${TAG.toUpperCase().slice(-4)}${String(i).padStart(4, '0')}",
      "hostingUrl": "https://www.airbnb.com/rooms/${LISTING_ID}",
      "hostProfileUrl": "https://www.airbnb.com/users/show/${HOST_ID}",
      "startDate": "${date.toISOString().slice(0, 10)}", "nights": 2, "status": "accepted",
      "numberOfGuests": 2}`);
  }
  return `[{"reservations":[${rows.join(',')}]}]`;
}

/**
 * `count` fils, chacun rattaché à une réservation par son code, chacun portant
 * un message de l'hôte et un message du voyageur.
 */
function messagesJson(count, hostBody, { guestBody = 'Bonjour, à quelle heure puis-je arriver ?' } = {}) {
  const threads = [];
  for (let i = 0; i < count; i++) {
    const code = `HM${TAG.toUpperCase().slice(-4)}${String(i).padStart(4, '0')}`;
    const date = new Date();
    date.setUTCMonth(date.getUTCMonth() - (count - i));
    const at = date.toISOString();
    threads.push({
      id: 1000 + i,
      messagesAndContents: [
        {
          message: { accountId: Number(HOST_ID), createdAt: at, id: 90000 + i, contentType: 'MessageContent' },
          messageContent: {
            messageContentV2: {
              content: `StaticBulletinContent{linkMessagingAction=MessagingAction{confirmationCode=${code}}}`,
            },
          },
        },
        {
          message: { accountId: Number(GUEST_ID), createdAt: at, id: 91000 + i, contentType: 'TextContent' },
          messageContent: { textContent: { body: guestBody } },
        },
        {
          message: { accountId: Number(HOST_ID), createdAt: at, id: 92000 + i, contentType: 'TextContent' },
          messageContent: { textContent: { body: typeof hostBody === 'function' ? hostBody(i) : hostBody } },
        },
      ],
    });
  }
  return JSON.stringify([{ messageThreads: threads }]);
}

const HOST_TEMPLATE = [
  'Bonjour, je vous rappelle les informations pour votre arrivée à partir de 16:00.',
  'Le code de la boîte à clé est 0703',
  'Le nom du WiFi est : Livebox-A1D6 et le mot de passe : s7f2JFRbvJGNGTfD2S',
  'Votre départ est prévu à 11:00',
].join('\n');

function exportZip(reservations, threads, hostBody = HOST_TEMPLATE) {
  return makeZip({
    'listings.json': listingsJson(),
    'reservations.json': reservationsJson(reservations),
    'messages.json': messagesJson(threads, hostBody),
  });
}

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

function preview(token, zip) {
  return request(app)
    .post('/api/properties/import-archive/preview')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/octet-stream')
    .send(zip);
}

function importListings(token, listings) {
  return request(app)
    .post('/api/properties/import-archive')
    .set('Authorization', `Bearer ${token}`)
    .send({ listings });
}

// La prévisualisation du même ZIP est déterministe : la refaire à chaque test
// ferait cogner le limiteur de débit, qui est un vrai garde-fou de production.
let cachedPreview;

beforeAll(async () => {
  await initializeApp();
  db = getDatabase();
  tokenA = await registerAndLogin(EMAIL_A);
  tokenB = await registerAndLogin(EMAIL_B);
  cachedPreview = await preview(tokenA, exportZip(40, 40));
}, 60000);

afterAll(async () => {
  stopScheduler();
  if (!db) return;
  try {
    const users = await db.query('SELECT id FROM users WHERE email IN (?, ?)', [EMAIL_A, EMAIL_B]);
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(', ');
      await db.query(`DELETE FROM property_fact_evidence WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM property_facts WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM availability_blocks WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM reservations WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM property_profiles WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('cleanup failed:', err.message);
  }
}, 30000);

// ────────────────────────────────────────────────────────────────────────────
describe('rattachement d’une conversation à un logement', () => {
  const listings = JSON.parse(listingsJson());
  const hosts = hostAccountIds(listings);

  it("identifie l'hôte depuis listings.json, pas depuis le profil", () => {
    expect([...hosts]).toEqual([HOST_ID]);
  });

  it('ne retient que les fils portant UN code de réservation', () => {
    const data = JSON.parse(messagesJson(3, HOST_TEMPLATE));
    // Un quatrième fil sans code : une demande restée sans suite.
    data[0].messageThreads.push({
      id: 7777,
      messagesAndContents: [{
        message: { accountId: Number(HOST_ID), createdAt: new Date().toISOString(), id: 1, contentType: 'TextContent' },
        messageContent: { textContent: { body: "L'arrivée est à partir de 16h" } },
      }],
    });
    const digest = reduceThreads(data, { hostAccountIds: hosts });
    expect(digest.threads).toHaveLength(3);
    expect(digest.threads_seen).toBe(4);
  });

  it('ne fait sortir aucun texte de voyageur', () => {
    const secret = 'Mon numéro personnel est le 06 12 34 56 78';
    const data = JSON.parse(messagesJson(2, HOST_TEMPLATE, { guestBody: secret }));
    const digest = reduceThreads(data, { hostAccountIds: hosts });
    expect(JSON.stringify(digest)).not.toContain(secret);
    // Seul le décompte survit.
    expect(digest.threads[0].guest_texts).toBe(1);
  });

  it("ne retient rien si l'identifiant de l'hôte est inconnu", () => {
    const data = JSON.parse(messagesJson(3, HOST_TEMPLATE));
    const digest = reduceThreads(data, { hostAccountIds: [] });
    expect(digest.threads).toHaveLength(0);
  });

  it('un code absent de reservations.json ne rattache rien', () => {
    const index = reservationIndex(JSON.parse(reservationsJson(2)));
    const threads = parseDigest(wrapDigest(
      reduceThreads(JSON.parse(messagesJson(5, HOST_TEMPLATE)), { hostAccountIds: hosts })
    )).threads;
    const { byListing, stats } = evidenceByListing(threads, index, new Set([LISTING_ID]));
    // Cinq fils, deux réservations connues : trois fils restent orphelins.
    expect(stats.threads_linked).toBe(2);
    expect(stats.threads_unlinked).toBe(3);
    expect(byListing.get(LISTING_ID).reservations.size).toBe(2);
  });

  it('un logement absent de l’export ne reçoit rien', () => {
    const index = reservationIndex(JSON.parse(reservationsJson(3)));
    const threads = parseDigest(wrapDigest(
      reduceThreads(JSON.parse(messagesJson(3, HOST_TEMPLATE)), { hostAccountIds: hosts })
    )).threads;
    const { byListing } = evidenceByListing(threads, index, new Set(['999999']));
    expect(byListing.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('prévisualisation avec conversations', () => {
  it('annonce ce que l’analyse a réellement traité', () => {
    expect(cachedPreview.status).toBe(200);
    expect(cachedPreview.body.sources.messages).toBe(true);
    expect(cachedPreview.body.fact_analysis).toMatchObject({
      threads_linked: 40,
      threads_in_export: 40,
    });
    expect(cachedPreview.body.fact_analysis.facts_total).toBeGreaterThan(0);
  });

  it('coche la case « infos tirées des messages » pour ce logement', () => {
    expect(cachedPreview.body.listings[0].found.facts).toBe(true);
  });

  it('propose l’heure d’arrivée sans la présenter comme acquise', () => {
    const fact = cachedPreview.body.listings[0].facts.find((f) => f.key === 'check_in_time');
    expect(fact.value).toBe('16:00');
    expect(fact.status).toBe('HIGH_CONFIDENCE');
    expect(fact.distinct_reservations).toBe(40);
  });

  it('marque le code de la boîte à clés comme à confirmer', () => {
    const fact = cachedPreview.body.listings[0].facts.find((f) => f.key === 'access_code');
    expect(fact.value).toBe('0703');
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('ne renvoie aucun texte de voyageur', () => {
    expect(JSON.stringify(cachedPreview.body)).not.toContain('à quelle heure puis-je arriver');
  });

  it('sans reservations.json, aucune conversation n’est exploitée', async () => {
    const zip = makeZip({
      'listings.json': listingsJson(),
      'messages.json': messagesJson(20, HOST_TEMPLATE),
    });
    const res = await preview(tokenA, zip);
    expect(res.status).toBe(200);
    expect(res.body.listings[0].facts).toEqual([]);
    expect(res.body.sources.messages).toBe(false);
  });

  it('un logement à trois séjours ne produit aucun fait acquis', async () => {
    const res = await preview(tokenA, exportZip(4, 4));
    const facts = res.body.listings[0].facts;
    for (const fact of facts) {
      expect(fact.status).not.toBe('HIGH_CONFIDENCE');
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('import et écriture dans la fiche', () => {
  let propertyId;

  beforeAll(async () => {
    const res = await importListings(tokenA, cachedPreview.body.listings.map((l) => {
      const payload = { ...l };
      delete payload.found;
      delete payload.fact_stats;
      delete payload.already_imported;
      delete payload.existing_property_id;
      return payload;
    }));
    expect(res.status).toBe(200);
    propertyId = res.body.details.created[0]?.id || res.body.details.updated[0]?.id;
  }, 30000);

  it('enregistre les faits sous le logement', async () => {
    const rows = await db.query(
      'SELECT * FROM property_facts WHERE property_id = ? ORDER BY fact_key',
      [propertyId]
    );
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.status !== 'VERIFIED')).toBe(true);
  });

  it('conserve un échantillon de preuves, pas les conversations', async () => {
    const [fact] = await db.query(
      "SELECT id FROM property_facts WHERE property_id = ? AND fact_key = 'check_in_time'",
      [propertyId]
    );
    const evidence = await db.query(
      'SELECT * FROM property_fact_evidence WHERE fact_id = ?', [fact.id]
    );
    // Quarante preuves observées, cinq conservées.
    expect(evidence.length).toBeLessThanOrEqual(5);
    expect(evidence[0].reservation_code).toBeTruthy();
    expect(evidence[0].snippet.length).toBeLessThanOrEqual(240);
  });

  it("écrit dans la fiche l'heure d'arrivée, mais pas le code d'accès", async () => {
    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    const context = JSON.parse(row.context_json);
    expect(context.check_in_time).toBe('16:00');
    // Sensible : jamais écrit sans confirmation, quels que soient les compteurs.
    expect(context.access_code || '').toBe('');
    expect(context.wifi_password || '').toBe('');
  });

  it('un second import ne duplique aucun fait', async () => {
    const before = await db.query('SELECT COUNT(*) AS n FROM property_facts WHERE property_id = ?', [propertyId]);
    await importListings(tokenA, cachedPreview.body.listings.map((l) => {
      const payload = { ...l };
      delete payload.found;
      delete payload.fact_stats;
      return payload;
    }));
    const after = await db.query('SELECT COUNT(*) AS n FROM property_facts WHERE property_id = ?', [propertyId]);
    expect(after[0].n).toBe(before[0].n);
  });

  it('refuse un fait fabriqué par le client', async () => {
    const forged = {
      ...cachedPreview.body.listings[0],
      facts: [
        // Clé inconnue du vocabulaire.
        { key: 'salaire_hote', value: '50000', status: 'VERIFIED', confidence: 100 },
        // Clé connue, mais statut que seul l'hôte peut accorder.
        { key: 'check_out_time', value: '23:00', status: 'VERIFIED', confidence: 100 },
      ],
    };
    delete forged.found;
    delete forged.fact_stats;
    await importListings(tokenA, [forged]);

    const rows = await db.query('SELECT fact_key, status FROM property_facts WHERE property_id = ?', [propertyId]);
    expect(rows.some((r) => r.fact_key === 'salaire_hote')).toBe(false);
    expect(rows.every((r) => r.status !== 'VERIFIED')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('centre de vérification', () => {
  let propertyId;
  let factId;

  beforeAll(async () => {
    const [row] = await db.query(
      'SELECT p.id FROM property_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?',
      [EMAIL_A]
    );
    propertyId = row.id;
    const [fact] = await db.query(
      "SELECT id FROM property_facts WHERE property_id = ? AND fact_key = 'access_code'",
      [propertyId]
    );
    factId = fact.id;
  });

  it('liste ce qui attend l’hôte', async () => {
    const res = await request(app)
      .get('/api/properties/facts/pending')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    const codes = res.body.properties[0].facts.filter((f) => f.fact_key === 'access_code');
    // Une information sensible n'entre jamais dans « tout confirmer ».
    expect(codes[0].bulk_confirmable).toBe(false);
  });

  it('confirme un fait et l’écrit dans la fiche', async () => {
    const res = await request(app)
      .post(`/api/properties/${propertyId}/facts/${factId}/confirm`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(res.status).toBe(200);

    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    expect(JSON.parse(row.context_json).access_code).toBe('0703');
  });

  it('une correction devient la valeur, et la source devient manuelle', async () => {
    const [fact] = await db.query(
      "SELECT id FROM property_facts WHERE property_id = ? AND fact_key = 'check_out_time'",
      [propertyId]
    );
    const res = await request(app)
      .post(`/api/properties/${propertyId}/facts/${fact.id}/confirm`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ value: '10:30' });
    expect(res.status).toBe(200);

    const [saved] = await db.query('SELECT * FROM property_facts WHERE id = ?', [fact.id]);
    expect(saved.fact_value).toBe('10:30');
    expect(saved.status).toBe('VERIFIED');
    expect(saved.source).toBe('manual');

    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    expect(JSON.parse(row.context_json).check_out_time).toBe('10:30');
  });

  it('une analyse ultérieure n’écrase pas la correction', async () => {
    // L'export dit toujours 11:00. La confirmation de l'hôte tient.
    await saveFacts(db, await userIdOf(EMAIL_A), propertyId, [{
      key: 'check_out_time', value: '11:00', status: 'HIGH_CONFIDENCE', confidence: 95,
      evidence_count: 40, distinct_reservations: 40, distinct_conversations: 40,
    }]);
    const [saved] = await db.query(
      "SELECT * FROM property_facts WHERE property_id = ? AND fact_key = 'check_out_time'",
      [propertyId]
    );
    expect(saved.fact_value).toBe('10:30');
    expect(saved.status).toBe('VERIFIED');
    // Le désaccord n'est pas caché : il est signalé.
    expect(!!saved.possible_change).toBe(true);
  });

  it('« ce n’est pas ça » écarte sans rien écrire', async () => {
    const [fact] = await db.query(
      "SELECT id FROM property_facts WHERE property_id = ? AND fact_key = 'wifi_password'",
      [propertyId]
    );
    const res = await request(app)
      .post(`/api/properties/${propertyId}/facts/${fact.id}/reject`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(res.status).toBe(200);

    const [saved] = await db.query('SELECT status FROM property_facts WHERE id = ?', [fact.id]);
    expect(saved.status).toBe('UNKNOWN');
    const [row] = await db.query('SELECT context_json FROM property_profiles WHERE id = ?', [propertyId]);
    expect(JSON.parse(row.context_json).wifi_password || '').toBe('');
  });

  it('« tout confirmer » laisse les informations sensibles de côté', async () => {
    const before = await db.query(
      "SELECT fact_key FROM property_facts WHERE property_id = ? AND fact_key = 'wifi_name'",
      [propertyId]
    );
    expect(before).toHaveLength(1);

    const res = await request(app)
      .post(`/api/properties/${propertyId}/facts/confirm-all`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(res.status).toBe(200);

    const rows = await db.query('SELECT fact_key, status FROM property_facts WHERE property_id = ?', [propertyId]);
    const byKey = Object.fromEntries(rows.map((r) => [r.fact_key, r.status]));
    expect(byKey.wifi_name).toBe('VERIFIED');
    // Écarté plus haut par l'hôte : « tout confirmer » ne le ressuscite pas.
    expect(byKey.wifi_password).toBe('UNKNOWN');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('isolation entre hôtes', () => {
  let propertyA;

  beforeAll(async () => {
    const [row] = await db.query(
      'SELECT p.id FROM property_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?',
      [EMAIL_A]
    );
    propertyA = row.id;
  });

  it('B ne voit pas les faits de A', async () => {
    const res = await request(app)
      .get(`/api/properties/${propertyA}/facts`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it('la liste de B est vide', async () => {
    const res = await request(app)
      .get('/api/properties/facts/pending')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('B ne peut pas confirmer un fait de A', async () => {
    const [fact] = await db.query(
      'SELECT id FROM property_facts WHERE property_id = ? LIMIT 1', [propertyA]
    );
    const res = await request(app)
      .post(`/api/properties/${propertyA}/facts/${fact.id}/confirm`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ value: '23:00' });
    expect(res.status).toBe(404);

    const [saved] = await db.query('SELECT fact_value FROM property_facts WHERE id = ?', [fact.id]);
    expect(saved.fact_value).not.toBe('23:00');
  });

  it('sans jeton, rien n’est accessible', async () => {
    const res = await request(app).get('/api/properties/facts/pending');
    expect(res.status).toBe(401);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('écriture automatique dans la fiche', () => {
  it('ne remplit qu’un champ vide', () => {
    const facts = [{ key: 'check_in_time', value: '16:00', status: 'HIGH_CONFIDENCE' }];
    expect(autoApplicableValues(facts, {})).toEqual({ check_in_time: '16:00' });
    // Déjà renseigné par l'export structuré ou par l'hôte : on n'y touche pas.
    expect(autoApplicableValues(facts, { check_in_time: '15:00' })).toEqual({});
  });

  it('n’écrit jamais une information volatile', () => {
    const facts = [
      { key: 'access_code', value: '0703', status: 'HIGH_CONFIDENCE' },
      { key: 'wifi_password', value: 'secret', status: 'VERIFIED' },
      { key: 'gate_code', value: '1975', status: 'HIGH_CONFIDENCE' },
    ];
    expect(autoApplicableValues(facts, {})).toEqual({});
  });

  it('n’écrit pas un simple candidat', () => {
    const facts = [
      { key: 'parking_info', value: 'Devant le portail', status: 'CANDIDATE' },
      { key: 'key_location', value: 'Sous le banc', status: 'UNSTABLE' },
      { key: 'floor_number', value: '3', status: 'REQUIRES_CONFIRMATION' },
    ];
    expect(autoApplicableValues(facts, {})).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('apprentissage continu', () => {
  let propertyId;
  let userId;

  beforeAll(async () => {
    userId = await userIdOf(EMAIL_A);
    const [row] = await db.query('SELECT id FROM property_profiles WHERE user_id = ? LIMIT 1', [userId]);
    propertyId = row.id;
  });

  it('un message de l’hôte qui dit autre chose lève un drapeau, sans rien remplacer', async () => {
    await db.query(
      `UPDATE property_facts SET fact_value = '16:00', status = 'VERIFIED', possible_change = 0
        WHERE property_id = ? AND fact_key = 'check_in_time'`,
      [propertyId]
    );

    const flagged = await noteHostMessage(
      db, userId, propertyId, "Bonjour, l'arrivée est à partir de 17h désormais."
    );
    expect(flagged).toBeGreaterThan(0);

    const [fact] = await db.query(
      "SELECT * FROM property_facts WHERE property_id = ? AND fact_key = 'check_in_time'",
      [propertyId]
    );
    // La valeur confirmée n'a PAS bougé : elle est seulement remise en question.
    expect(fact.fact_value).toBe('16:00');
    expect(!!fact.possible_change).toBe(true);
  });

  it('un message qui confirme la valeur ne lève rien', async () => {
    await db.query(
      "UPDATE property_facts SET possible_change = 0 WHERE property_id = ? AND fact_key = 'check_in_time'",
      [propertyId]
    );
    const flagged = await noteHostMessage(db, userId, propertyId, "L'arrivée est à partir de 16h.");
    expect(flagged).toBe(0);
  });

  it('un message sans information exploitable ne lève rien', async () => {
    const flagged = await noteHostMessage(db, userId, propertyId, 'Merci beaucoup, bon séjour !');
    expect(flagged).toBe(0);
  });
});

async function userIdOf(email) {
  const [row] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

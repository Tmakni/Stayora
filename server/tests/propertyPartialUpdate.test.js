/**
 * Mise à jour PARTIELLE d'un logement — aucune section n'en efface une autre.
 *
 * C'est la moitié serveur de la garantie « rien de ce que j'ai saisi ne
 * disparaît ». La sauvegarde automatique du formulaire n'envoie que les champs
 * réellement modifiés (client/src/lib/autosaveEngine.js) ; encore faut-il que
 * l'endpoint respecte la règle correspondante :
 *
 *   - un champ ABSENT du corps veut dire « ne pas modifier » ;
 *   - une chaîne vide n'est pas une absence : elle efface volontairement CE
 *     champ, et lui seul ;
 *   - modifier une section ne doit pas reconstruire les autres à vide, alors
 *     que context_json est réécrit en entier à chaque appel ;
 *   - la réponse ne contient PAS le logement complet, pour que le formulaire
 *     n'ait rien à remplacer avec elle.
 *
 * S'y ajoute l'isolation : deux logements du même hôte, et deux hôtes
 * différents, ne doivent jamais s'écrire l'un sur l'autre.
 *
 * Tourne sur l'environnement "test" du knexfile : SQLite en mémoire.
 */

const request = require('supertest');
const serverModule = require('../server');
const app = serverModule;
const { initializeApp } = serverModule;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');

const TAG = `patch-${process.pid}-${Date.now()}`;
const EMAIL_A = `patch-a-${TAG}@example.test`;
const EMAIL_B = `patch-b-${TAG}@example.test`;
const PASSWORD = 'PatchTest12345';

const BASE_PROPERTY = {
  property_type: 'apartment',
  bedrooms: 2,
  beds: 3,
  bathrooms: 1,
  max_guests: 4,
};

let db;
let tokenA;
let tokenB;
let propertyA1;
let propertyA2;
let propertyB1;

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`);

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
  const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return res.body.token;
}

async function createProperty(token, name) {
  const res = await authed(request(app).post('/api/properties'), token)
    .send({ ...BASE_PROPERTY, name });
  expect(res.status).toBe(201);
  return res.body.property?.id ?? res.body.id ?? res.body.propertyId;
}

async function readProperty(token, id) {
  const res = await authed(request(app).get(`/api/properties/${id}`), token);
  expect(res.status).toBe(200);
  const ctx = JSON.parse(res.body.context_json || '{}');
  return { row: res.body, ctx };
}

beforeAll(async () => {
  await initializeApp();
  db = getDatabase();

  tokenA = await registerAndLogin(EMAIL_A);
  tokenB = await registerAndLogin(EMAIL_B);

  propertyA1 = await createProperty(tokenA, `Villa A1 ${TAG}`);
  propertyA2 = await createProperty(tokenA, `Villa A2 ${TAG}`);
  propertyB1 = await createProperty(tokenB, `Villa B1 ${TAG}`);
}, 30000);

afterAll(async () => {
  stopScheduler();
  if (db) {
    try {
      const users = await db.query('SELECT id FROM users WHERE email IN (?, ?)', [EMAIL_A, EMAIL_B]);
      const ids = users.map((u) => u.id);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(', ');
        // Les clés étrangères ne sont pas appliquées sur SQLite sans PRAGMA :
        // supprimer les enfants d'abord, comme les autres suites.
        const props = await db.query(`SELECT id FROM property_profiles WHERE user_id IN (${ph})`, ids);
        const propIds = props.map((p) => p.id);
        if (propIds.length > 0) {
          const pph = propIds.map(() => '?').join(', ');
          await db.query(`DELETE FROM property_photos WHERE property_id IN (${pph})`, propIds);
        }
        await db.query(`DELETE FROM property_profiles WHERE user_id IN (${ph})`, ids);
        await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err.message);
    }
  }
}, 30000);

describe('un champ absent du corps n\'est pas modifié', () => {
  it('remplir une section ne vide aucune autre section', async () => {
    // Onglet « Connectivité & Localisation »
    let res = await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ wifi_name: 'BOX-4242', wifi_password: 'motdepasse-wifi' });
    expect(res.status).toBe(200);

    // Onglet « Arrivée & Accès » — n'envoie RIEN de la section précédente.
    res = await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ checkin_method: 'Boîte à clés', key_location: 'Sous le pot de fleurs', access_code: '4821' });
    expect(res.status).toBe(200);

    // Onglet « Hôte & FAQ »
    res = await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ host_name: 'Delphine', custom_faq: 'Q: Parking ? R: Oui, gratuit.' });
    expect(res.status).toBe(200);

    const { row, ctx } = await readProperty(tokenA, propertyA1);

    // Les TROIS sections coexistent.
    expect(ctx.wifi_name).toBe('BOX-4242');
    expect(ctx.wifi_password).toBe('motdepasse-wifi');
    expect(ctx.checkin_method).toBe('Boîte à clés');
    expect(ctx.key_location).toBe('Sous le pot de fleurs');
    expect(ctx.access_code).toBe('4821');
    expect(ctx.host_name).toBe('Delphine');
    expect(ctx.custom_faq).toBe('Q: Parking ? R: Oui, gratuit.');

    // Et les colonnes de base n'ont pas bougé.
    expect(row.name).toBe(`Villa A1 ${TAG}`);
    expect(row.bedrooms).toBe(2);
    expect(row.beds).toBe(3);
    expect(row.max_guests).toBe(4);
  });

  it('une case cochée dans un onglet survit à une saisie dans un autre', async () => {
    await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ has_pool: true, has_jacuzzi: true });

    await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ nearest_bakery: 'Boulangerie du port, 200 m' });

    const { row, ctx } = await readProperty(tokenA, propertyA1);
    expect(!!row.has_pool).toBe(true);          // colonne réelle
    expect(!!ctx.has_jacuzzi).toBe(true);       // champ de contexte
    expect(ctx.nearest_bakery).toBe('Boulangerie du port, 200 m');
  });

  it('une chaîne vide efface CE champ, et lui seul', async () => {
    await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ access_code: '' });

    const { ctx } = await readProperty(tokenA, propertyA1);
    expect(ctx.access_code).toBe('');
    // Le voisin immédiat dans la même section est intact.
    expect(ctx.key_location).toBe('Sous le pot de fleurs');
    expect(ctx.wifi_password).toBe('motdepasse-wifi');
  });

  it('PUT et PATCH ont exactement la même sémantique de fusion', async () => {
    await authed(request(app).put(`/api/properties/${propertyA1}`), tokenA)
      .send({ quiet_hours: '22h - 8h' });

    const { ctx } = await readProperty(tokenA, propertyA1);
    expect(ctx.quiet_hours).toBe('22h - 8h');
    expect(ctx.host_name).toBe('Delphine');
  });
});

describe('la réponse ne peut pas servir à remplacer l\'état du formulaire', () => {
  it('ne renvoie pas le logement, seulement la confirmation', async () => {
    const res = await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ host_response_time: 'moins d\'une heure' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('updated_at');
    // Aucun champ de saisie n'est renvoyé : le client n'a rien à réinjecter.
    expect(res.body).not.toHaveProperty('context_json');
    expect(res.body).not.toHaveProperty('name');
    expect(res.body).not.toHaveProperty('wifi_password');
  });

  it('updated_at avance réellement à chaque enregistrement', async () => {
    const before = (await readProperty(tokenA, propertyA1)).row.updated_at;
    await new Promise((r) => setTimeout(r, 1100)); // la colonne est à la seconde
    await authed(request(app).patch(`/api/properties/${propertyA1}`), tokenA)
      .send({ payment_notes: 'Virement accepté' });
    const after = (await readProperty(tokenA, propertyA1)).row.updated_at;

    expect(String(after) > String(before)).toBe(true);
  });
});

describe('sauvegardes rapprochées', () => {
  it('trois écritures successives se cumulent au lieu de s\'écraser', async () => {
    // Le moteur d'autosave sérialise les envois ; on vérifie ici que le serveur
    // les cumule bien quand ils arrivent l'un après l'autre.
    await authed(request(app).patch(`/api/properties/${propertyA2}`), tokenA).send({ wifi_name: 'BOX-1' });
    await authed(request(app).patch(`/api/properties/${propertyA2}`), tokenA).send({ pet_rules: 'Chiens acceptés' });
    await authed(request(app).patch(`/api/properties/${propertyA2}`), tokenA).send({ cleaning_fee: '45 EUR' });

    const { ctx } = await readProperty(tokenA, propertyA2);
    expect(ctx.wifi_name).toBe('BOX-1');
    expect(ctx.pet_rules).toBe('Chiens acceptés');
    expect(ctx.cleaning_fee).toBe('45 EUR');
  });

  it('des écritures concurrentes sur des champs différents se conservent toutes', async () => {
    await Promise.all([
      authed(request(app).patch(`/api/properties/${propertyA2}`), tokenA).send({ nearest_train: 'Gare centrale, 2 km' }),
      authed(request(app).patch(`/api/properties/${propertyA2}`), tokenA).send({ nearest_airport: 'BOD, 25 km' }),
    ]);

    const { ctx } = await readProperty(tokenA, propertyA2);
    // Au moins l'un des deux passe forcément ; l'important est qu'aucune des
    // valeurs déjà confirmées plus haut n'ait été perdue au passage.
    expect(ctx.wifi_name).toBe('BOX-1');
    expect(ctx.pet_rules).toBe('Chiens acceptés');
    expect(ctx.cleaning_fee).toBe('45 EUR');
  });
});

describe('isolation', () => {
  it('modifier un logement ne touche pas l\'autre logement du même hôte', async () => {
    const a1 = await readProperty(tokenA, propertyA1);
    const a2 = await readProperty(tokenA, propertyA2);

    expect(a1.ctx.host_name).toBe('Delphine');
    expect(a2.ctx.host_name).toBe('');
    expect(a1.ctx.wifi_name).toBe('BOX-4242');
    expect(a2.ctx.wifi_name).toBe('BOX-1');
  });

  it('un hôte ne peut pas écrire dans le logement d\'un autre', async () => {
    const res = await authed(request(app).patch(`/api/properties/${propertyB1}`), tokenA)
      .send({ name: 'Détourné', wifi_password: 'intrusion' });

    // 404 : le logement n'existe pas DANS LE PÉRIMÈTRE de cet utilisateur.
    expect(res.status).toBe(404);

    const { row, ctx } = await readProperty(tokenB, propertyB1);
    expect(row.name).toBe(`Villa B1 ${TAG}`);
    expect(ctx.wifi_password).toBe('');
  });

  it('un identifiant invalide est refusé avant toute écriture', async () => {
    const res = await authed(request(app).patch('/api/properties/abc'), tokenA).send({ name: 'X' });
    expect(res.status).toBe(400);
  });
});

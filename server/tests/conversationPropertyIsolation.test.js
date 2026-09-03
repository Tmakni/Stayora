/**
 * Une conversation ne doit jamais exposer le logement d'un AUTRE compte.
 *
 * CE QUE CES TESTS PROTÈGENT
 * --------------------------
 * `createConversation` accepte un `property_id` venu du corps de la requête et
 * l'écrit tel quel, sans vérifier qu'il appartient bien à l'appelant. Plus loin,
 * `getConversation` chargeait ce logement avec
 *
 *     SELECT id, name, context_json FROM property_profiles WHERE id = ?
 *
 * sans prédicat `user_id` — le seul endroit du projet, avec aiController, où
 * cette clause manquait. Un compte pouvait donc nommer le logement d'un autre à
 * la création, puis relire en réponse son nom ET son `context_json`, c'est-à-dire
 * le mot de passe du Wi-Fi, le code d'accès et l'emplacement des clés.
 *
 * La suite d'isolation existante ne couvrait pas ce chemin : elle vérifie qu'un
 * compte ne LIT pas les logements d'un autre par /api/properties, pas qu'il ne
 * peut pas s'en désigner un via une conversation.
 */

process.env.NODE_ENV = 'test';
process.env.USE_MEMORY_DB = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-conversation-property-isolation';

const request = require('supertest');
const { app, initializeApp } = require('../server');
const { close } = require('../db/database');

const SUFFIX = `${process.pid}-${Date.now()}`;
const EMAIL_A = `owner-${SUFFIX}@example.com`;
const EMAIL_B = `intruder-${SUFFIX}@example.com`;
const PASSWORD = 'Abcdef12';

const SECRET_WIFI = 'MotDePasseSecretDuProprietaire';

let tokenA;
let tokenB;
let propertyIdA;

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await initializeApp();

  const a = await request(app).post('/api/auth/register').send({ email: EMAIL_A, password: PASSWORD });
  tokenA = a.body.token;

  const b = await request(app).post('/api/auth/register').send({ email: EMAIL_B, password: PASSWORD });
  tokenB = b.body.token;

  const prop = await authed(request(app).post('/api/properties'), tokenA).send({
    name: 'Villa Privée du Propriétaire',
    property_type: 'villa',
    bedrooms: 3,
    beds: 4,
    bathrooms: 2,
    max_guests: 6,
    wifi_password: SECRET_WIFI,
    access_code: '4589',
  });
  propertyIdA = prop.body.property.id;
}, 60000);

afterAll(async () => {
  try {
    await close();
  } catch (_) {
    // La base de test disparaît avec le processus.
  }
}, 30000);

describe("un compte ne peut pas s'attribuer le logement d'un autre", () => {
  it('refuse la création d\'une conversation pointant sur un logement étranger', async () => {
    const res = await authed(request(app).post('/api/conversations'), tokenB).send({
      title: 'Tentative',
      property_id: propertyIdA,
    });

    // Le logement n'appartient pas à B : soit la requête est refusée, soit la
    // conversation est créée SANS logement. Ce qui est interdit, c'est qu'elle
    // reparte en portant l'identifiant du logement de A.
    if (res.status === 201) {
      expect(res.body.conversation.property_id).toBeNull();
    } else {
      expect([400, 403, 404]).toContain(res.status);
    }
  });

  it("ne divulgue ni le nom ni le contexte du logement de A", async () => {
    const created = await authed(request(app).post('/api/conversations'), tokenB).send({
      title: 'Tentative 2',
      property_id: propertyIdA,
    });

    // Si la création a été refusée, il n'y a rien à relire : le test est passé.
    if (created.status !== 201) return;

    const res = await authed(request(app).get(`/api/conversations/${created.body.conversation.id}`), tokenB);
    expect(res.status).toBe(200);

    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(SECRET_WIFI);
    expect(payload).not.toContain('Villa Privée du Propriétaire');
    expect(res.body.conversation.property_context).toBeFalsy();
  });

  it("la génération d'un brouillon n'emprunte pas le contexte du logement de A", async () => {
    const created = await authed(request(app).post('/api/conversations'), tokenB).send({
      title: 'Tentative 3',
      property_id: propertyIdA,
    });
    if (created.status !== 201) return;
    const convId = created.body.conversation.id;

    await authed(request(app).post(`/api/conversations/${convId}/messages`), tokenB).send({
      role: 'incoming',
      content: 'Bonjour, quel est le code du wifi ?',
    });

    const res = await authed(request(app).post('/api/ai/draft'), tokenB).send({
      conversation_id: convId,
      incoming_message: 'Bonjour, quel est le code du wifi ?',
    });

    // Le brouillon peut échouer faute de clé OpenAI : ce qui compte est qu'il
    // ne contienne JAMAIS le secret de A.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_WIFI);
  });
});

describe('le propriétaire légitime garde son accès', () => {
  it('A voit bien son logement dans sa propre conversation', async () => {
    const created = await authed(request(app).post('/api/conversations'), tokenA).send({
      title: 'Conversation légitime',
      property_id: propertyIdA,
    });
    expect(created.status).toBe(201);
    expect(created.body.conversation.property_id).toBe(propertyIdA);

    const res = await authed(request(app).get(`/api/conversations/${created.body.conversation.id}`), tokenA);
    expect(res.status).toBe(200);
    expect(res.body.conversation.property_context?.name).toBe('Villa Privée du Propriétaire');
  });
});

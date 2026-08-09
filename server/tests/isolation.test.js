/**
 * Cross-account data isolation — integration test
 *
 * Proves the backend half of the "property/conversation leaked to another
 * user" isolation guarantee: every read/write on a private resource must be
 * scoped to the JWT-authenticated req.userId, and the server must never
 * trust a client-supplied ownership field (e.g. a spoofed "user_id" in the
 * POST body).
 *
 * The frontend half of that guarantee — React Query's cache being wiped on
 * logout/login so a *different* browser session doesn't briefly render a
 * previous user's cached data — lives entirely in client/src/lib/auth.jsx
 * (queryClient.clear() on every auth-identity transition) and has no
 * server-side analogue to test here: each HTTP request in this backend is
 * independently authenticated via its own JWT: there is no server-held
 * session state that could leak between requests. This suite instead proves
 * there is no IDOR and no trust of client-supplied ownership fields.
 *
 * NOTE on DB target: this process runs under Jest, which sets
 * NODE_ENV=test before anything in this file (or in server/server.js) has
 * a chance to run. knexfile.js's "test" environment is a fresh in-memory
 * SQLite DB (`:memory:`), completely separate both from the Windows-side
 * <repo>/data/airbnb_ai_agent.db file (used by plain `npm run db:migrate`
 * / NODE_ENV=development) and from the WSL-side live dev DB used by the
 * running nodemon server. Nothing this file does can touch either of
 * those. Because the DB is in-memory and process-scoped, it is wiped
 * automatically when the test process exits — but we still clean up the
 * rows we create in afterAll (matching the task's persistence-safe
 * instructions) in case this ever runs against a persistent DB.
 */

const request = require('supertest');
// server/server.js does `module.exports = app; module.exports.initializeApp = initializeApp;`
// — the module IS the Express app itself, with initializeApp/start attached
// as extra properties on that function object (NOT `{ app, initializeApp }`).
const serverModule = require('../server');
const app = serverModule;
const { initializeApp } = serverModule;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');

const EMAIL_A = 'isolation-test-user-a@example.test';
const EMAIL_B = 'isolation-test-user-b@example.test';
const PASSWORD_A = 'IsolationTest123';
const PASSWORD_B = 'IsolationTest456';

let db;

let tokenA, tokenB;
let userIdA, userIdB;
let propertyIdA;
let conversationIdA;
let spoofedPropertyId; // created by B while claiming to be A's

const ORIGINAL_PROPERTY_NAME = 'Isolation Test Villa A';
const ORIGINAL_CONVERSATION_TITLE = 'Isolation Test Conversation A';

const REQUIRED_PROPERTY_FIELDS = {
  property_type: 'apartment',
  bedrooms: 2,
  beds: 2,
  bathrooms: 1,
  max_guests: 4,
};

function authed(req, token) {
  return req.set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  await initializeApp();
  db = getDatabase();
}, 30000);

afterAll(async () => {
  // Stop the 60s/5min background sync timers started by initializeApp() so
  // this process doesn't leave dangling intervals behind. Note: syncScheduler's
  // startScheduler() also fires a one-off setTimeout(...,5000) for an initial
  // sync pass that it does not keep a handle to, so it cannot be cancelled
  // here — it is harmless (it just re-queries the otherwise-empty test DB)
  // but may keep the process alive for a few extra seconds after this file's
  // tests finish; that is pre-existing server behavior, not a bug in this test.
  stopScheduler();

  // Clean up ONLY the rows this suite created. property_profiles.user_id
  // and conversations.user_id both declare `ON DELETE CASCADE` in
  // migrations/db/001_initial_schema.js, but SQLite only enforces foreign
  // keys when `PRAGMA foreign_keys = ON` has been run on the connection —
  // server/db/database.js never sets that pragma — so cascade is not
  // actually active here. Delete children before parents, manually.
  if (db) {
    try {
      const users = await db.query(
        'SELECT id FROM users WHERE email IN (?, ?)',
        [EMAIL_A, EMAIL_B]
      );
      const ids = users.map((u) => u.id);

      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');

        const convs = await db.query(
          `SELECT id FROM conversations WHERE user_id IN (${placeholders})`,
          ids
        );
        const convIds = convs.map((c) => c.id);
        if (convIds.length > 0) {
          const convPlaceholders = convIds.map(() => '?').join(', ');
          await db.query(
            `DELETE FROM messages WHERE conversation_id IN (${convPlaceholders})`,
            convIds
          );
        }
        await db.query(
          `DELETE FROM conversations WHERE user_id IN (${placeholders})`,
          ids
        );

        const props = await db.query(
          `SELECT id FROM property_profiles WHERE user_id IN (${placeholders})`,
          ids
        );
        const propIds = props.map((p) => p.id);
        if (propIds.length > 0) {
          const propPlaceholders = propIds.map(() => '?').join(', ');
          await db.query(
            `DELETE FROM property_photos WHERE property_id IN (${propPlaceholders})`,
            propIds
          );
        }
        await db.query(
          `DELETE FROM property_profiles WHERE user_id IN (${placeholders})`,
          ids
        );

        await db.query(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
      }
    } catch (err) {
      // Don't let cleanup failure mask real test results, but surface it.
      // eslint-disable-next-line no-console
      console.error('isolation.test.js afterAll cleanup failed:', err.message);
    }
  }
}, 30000);

describe('Cross-account data isolation', () => {
  test('setup: register user A and user B, capture JWTs', async () => {
    const resA = await request(app)
      .post('/api/auth/register')
      .send({ email: EMAIL_A, password: PASSWORD_A });

    expect(resA.status).toBe(201);
    expect(resA.body.success).toBe(true);
    expect(typeof resA.body.token).toBe('string');
    tokenA = resA.body.token;
    userIdA = resA.body.user.id;

    const resB = await request(app)
      .post('/api/auth/register')
      .send({ email: EMAIL_B, password: PASSWORD_B });

    expect(resB.status).toBe(201);
    expect(resB.body.success).toBe(true);
    expect(typeof resB.body.token).toBe('string');
    tokenB = resB.body.token;
    userIdB = resB.body.user.id;

    expect(userIdA).not.toBe(userIdB);
  });

  test('setup: user A creates a property', async () => {
    const res = await authed(request(app).post('/api/properties'), tokenA).send({
      name: ORIGINAL_PROPERTY_NAME,
      ...REQUIRED_PROPERTY_FIELDS,
    });

    expect(res.status).toBe(201);
    expect(res.body.property).toBeDefined();
    expect(res.body.property.name).toBe(ORIGINAL_PROPERTY_NAME);
    propertyIdA = res.body.property.id;
    expect(typeof propertyIdA).toBe('number');
  });

  describe('Property isolation', () => {
    test('list-exclusion: GET /api/properties as B does not include A\'s property', async () => {
      const res = await authed(request(app).get('/api/properties'), tokenB);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((p) => p.id);
      expect(ids).not.toContain(propertyIdA);
    });

    test('get-blocked: GET /api/properties/:id as B returns 404 and leaks no data', async () => {
      const res = await authed(
        request(app).get(`/api/properties/${propertyIdA}`),
        tokenB
      );

      expect(res.status).toBe(404);
      expect(res.body.name).toBeUndefined();
      expect(res.body.address).toBeUndefined();
      expect(res.body.context_json).toBeUndefined();
    });

    test('update-blocked: PUT /api/properties/:id as B is rejected, name unchanged', async () => {
      const attempt = await authed(
        request(app).put(`/api/properties/${propertyIdA}`),
        tokenB
      ).send({ name: 'HACKED BY B' });

      expect(attempt.status).toBe(404);

      const verify = await authed(
        request(app).get(`/api/properties/${propertyIdA}`),
        tokenA
      );
      expect(verify.status).toBe(200);
      expect(verify.body.name).toBe(ORIGINAL_PROPERTY_NAME);
    });

    test('delete-blocked: DELETE /api/properties/:id as B is rejected, property still exists', async () => {
      const attempt = await authed(
        request(app).delete(`/api/properties/${propertyIdA}`),
        tokenB
      );

      expect(attempt.status).toBe(404);

      const verify = await authed(
        request(app).get(`/api/properties/${propertyIdA}`),
        tokenA
      );
      expect(verify.status).toBe(200);
      expect(verify.body.id).toBe(propertyIdA);
    });
  });

  describe('user_id spoofing (IDOR sanity check)', () => {
    test('POST /api/properties as B with a forged user_id=A in the body still belongs to B', async () => {
      const res = await authed(request(app).post('/api/properties'), tokenB).send({
        name: 'Spoofed Ownership Property',
        ...REQUIRED_PROPERTY_FIELDS,
        user_id: userIdA, // forged — must be ignored server-side
      });

      expect(res.status).toBe(201);
      spoofedPropertyId = res.body.property.id;
      expect(typeof spoofedPropertyId).toBe('number');

      // Directly inspect the DB row: the server must have used req.userId
      // (B), never the client-supplied "user_id" field (A).
      const rows = await db.query(
        'SELECT user_id FROM property_profiles WHERE id = ?',
        [spoofedPropertyId]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].user_id).toBe(userIdB);
      expect(rows[0].user_id).not.toBe(userIdA);

      // B can read it back (it's really B's)...
      const asB = await authed(
        request(app).get(`/api/properties/${spoofedPropertyId}`),
        tokenB
      );
      expect(asB.status).toBe(200);

      // ...and it must NOT show up in A's list, nor be readable by A.
      const listAsA = await authed(request(app).get('/api/properties'), tokenA);
      expect(listAsA.status).toBe(200);
      expect(listAsA.body.map((p) => p.id)).not.toContain(spoofedPropertyId);

      const getAsA = await authed(
        request(app).get(`/api/properties/${spoofedPropertyId}`),
        tokenA
      );
      expect(getAsA.status).toBe(404);
    });
  });

  describe('Conversation isolation', () => {
    test('setup: user A creates a conversation', async () => {
      const res = await authed(request(app).post('/api/conversations'), tokenA).send({
        title: ORIGINAL_CONVERSATION_TITLE,
      });

      expect(res.status).toBe(201);
      expect(res.body.conversation).toBeDefined();
      conversationIdA = res.body.conversation.id;
      expect(typeof conversationIdA).toBe('number');
    });

    test('list-exclusion: GET /api/conversations as B does not include A\'s conversation', async () => {
      const res = await authed(request(app).get('/api/conversations'), tokenB);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.conversations)).toBe(true);
      const ids = res.body.conversations.map((c) => c.id);
      expect(ids).not.toContain(conversationIdA);
    });

    // NOTE — pre-existing, unrelated bug found while writing this suite:
    // conversationController.js's getConversation() SELECTs a column
    // `airbnb_reply_url` that no migration (migrations/db/001..011) ever
    // adds to the `conversations` table (only gmailSyncService.js writes
    // to it). That makes GET /api/conversations/:id 500 unconditionally
    // for EVERY caller — including the conversation's own owner — not
    // just for a non-owner like B. This is a plain schema/correctness bug,
    // not an authorization bypass, so per this suite's scope it is left
    // unfixed and just reported (see the final summary). To keep the
    // isolation assertions below meaningful and correct regardless of that
    // bug, "unchanged after a blocked write" is verified by querying the
    // DB directly (already available via `db`) instead of round-tripping
    // through the broken single-conversation GET endpoint.
    test('get-blocked: GET /api/conversations/:id as B never returns A\'s conversation data', async () => {
      const res = await authed(
        request(app).get(`/api/conversations/${conversationIdA}`),
        tokenB
      );

      // Whatever the exact status (currently 500 due to the bug noted
      // above, would be 403 once fixed) — B must never receive a 200 with
      // A's conversation/messages.
      expect(res.status).not.toBe(200);
      expect(res.body.conversation).toBeUndefined();
      expect(res.body.messages).toBeUndefined();
    });

    test('update-blocked: PUT /api/conversations/:id as B is rejected, title unchanged', async () => {
      const attempt = await authed(
        request(app).put(`/api/conversations/${conversationIdA}`),
        tokenB
      ).send({ title: 'HACKED BY B' });

      expect(attempt.status).toBe(403);

      const rows = await db.query('SELECT title FROM conversations WHERE id = ?', [
        conversationIdA,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe(ORIGINAL_CONVERSATION_TITLE);
    });

    // There is no DELETE /api/conversations/:id route in this API (see
    // server/routes/conversations.js — only POST /, GET /, GET /:id,
    // PUT /:id, POST /:id/messages, POST /:id/send-airbnb are registered).
    // A DELETE request to that path 404s from Express's generic "no route
    // matched" handler for BOTH owners and non-owners alike, so it proves
    // nothing about ownership enforcement and is intentionally not
    // asserted here. As the closest real "modify" endpoint beyond PUT,
    // POST /:id/messages (add a message to someone else's conversation)
    // is used instead to round out the write-path coverage.
    test('modify-blocked (closest analogue to delete): POST /:id/messages as B is rejected', async () => {
      const attempt = await authed(
        request(app).post(`/api/conversations/${conversationIdA}/messages`),
        tokenB
      ).send({ role: 'outgoing', content: 'hacked message from B' });

      expect(attempt.status).toBe(403);

      const rows = await db.query(
        'SELECT content FROM messages WHERE conversation_id = ?',
        [conversationIdA]
      );
      expect(rows.map((m) => m.content)).not.toContain('hacked message from B');
    });
  });
});

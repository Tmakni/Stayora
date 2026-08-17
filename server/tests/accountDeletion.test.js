/**
 * Integration tests for DELETE /api/auth/account (RGPD art. 17).
 *
 * The point of interest is not that the user row disappears — that part is
 * ordinary — but that NOTHING of the account survives it. Two things make that
 * non-trivial and are asserted explicitly here:
 *
 *   1. every other user-owned table is cleared only by ON DELETE CASCADE, which
 *      is silently inert if SQLite's foreign_keys pragma is ever turned off;
 *   2. outbound_replies has NO foreign key to users at all, so it is the one
 *      table the cascade cannot reach. Its rows are queued outgoing emails —
 *      an orphan left behind is a message replyWorker would still try to send
 *      on behalf of a deleted account.
 *
 * Same in-process/supertest setup and run-scoped email prefix as auth.test.js.
 */
const request = require('supertest');

const app = require('../server');
const { initializeApp } = app;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mkEmail = (label) => `del-test-${label}-${RUN_ID}@example.test`;

const STRONG_PASSWORD = 'Str0ngPass1';

// Dedicated fake source IP (TEST-NET-3, RFC 5737), same device auth.test.js
// uses for its flood test. authRateLimiter counts FAILED auth requests, and
// this file deliberately makes several (no password, wrong password, no token).
// Jest can schedule two test files into one worker process, where they share
// the limiter's in-memory store — so without its own bucket this file can push
// auth.test.js past the 10-failure threshold and make IT fail, intermittently
// and only when the two happen to land together.
const TEST_IP = '203.0.113.91';

/** supertest request pre-tagged with this file's own rate-limit bucket. */
const asTestIp = (req) => req.set('X-Forwarded-For', TEST_IP);

describe('DELETE /api/auth/account', () => {
  let db;
  const createdEmails = [];

  beforeAll(async () => {
    await initializeApp();
    db = getDatabase();
  }, 30000);

  afterAll(async () => {
    if (createdEmails.length > 0) {
      const placeholders = createdEmails.map(() => '?').join(',');
      await db.query(`DELETE FROM users WHERE email IN (${placeholders})`, createdEmails);
    }
    // Same rationale as auth.test.js: outlive startScheduler()'s uncancellable
    // 5s setTimeout so it cannot fire after Jest tears this environment down.
    await new Promise((resolve) => setTimeout(resolve, 5200));
    stopScheduler();
    await db.close();
  }, 30000);

  /** Registers a user and returns { token, userId }. */
  async function makeUser(label) {
    const email = mkEmail(label);
    const res = await asTestIp(request(app).post('/api/auth/register'))
      .send({ email, password: STRONG_PASSWORD });
    expect(res.status).toBe(201);
    createdEmails.push(email);
    return { token: res.body.token, userId: res.body.user.id, email };
  }

  test('refuses deletion without a password', async () => {
    const { token } = await makeUser('nopwd');

    const res = await asTestIp(request(app).delete('/api/auth/account'))
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);

    // The account must still be usable.
    const me = await asTestIp(request(app).get('/api/auth/me')).set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  });

  test('refuses deletion with a wrong password and leaves the account intact', async () => {
    const { token, userId } = await makeUser('wrongpwd');

    const res = await asTestIp(request(app).delete('/api/auth/account'))
      .set('Authorization', `Bearer ${token}`)
      .send({ password: 'Wr0ngPassword' });

    expect(res.status).toBe(400);

    const rows = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
    expect(rows.length).toBe(1);
  });

  test('requires authentication', async () => {
    const res = await asTestIp(request(app).delete('/api/auth/account'))
      .send({ password: STRONG_PASSWORD });

    expect(res.status).toBe(401);
  });

  test('deletes the user, every cascaded table, and the un-cascaded outbound_replies', async () => {
    const { token, userId } = await makeUser('full');

    // Owned data spanning a cascaded table (property_profiles → conversations)
    // and the one table with no foreign key (outbound_replies).
    const prop = await db.query(
      `INSERT INTO property_profiles
         (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'Test flat', 'apartment', 1, 1, 1, 2]
    );
    const conv = await db.query(
      'INSERT INTO conversations (user_id, title) VALUES (?, ?)',
      [userId, 'Test conversation']
    );

    await db.query(
      `INSERT INTO outbound_replies
         (user_id, gmail_account_id, conversation_id, idempotency_key, status, mode, body_text)
       VALUES (?, ?, ?, ?, 'pending', 'auto', ?)`,
      [userId, 999999, conv.insertId, `del-test-${RUN_ID}`, 'queued body']
    );

    // Sanity: the rows really are there before we delete.
    const queuedBefore = await db.query(
      'SELECT id FROM outbound_replies WHERE user_id = ?', [userId]
    );
    expect(queuedBefore.length).toBe(1);

    const res = await asTestIp(request(app).delete('/api/auth/account'))
      .set('Authorization', `Bearer ${token}`)
      .send({ password: STRONG_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const users = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
    expect(users.length).toBe(0);

    // Cascade reached the ordinary owned tables…
    const props = await db.query('SELECT id FROM property_profiles WHERE id = ?', [prop.insertId]);
    expect(props.length).toBe(0);
    const convs = await db.query('SELECT id FROM conversations WHERE id = ?', [conv.insertId]);
    expect(convs.length).toBe(0);

    // …and the explicit DELETE covered the table it cannot reach. A survivor
    // here is a queued email for an account that no longer exists.
    const queuedAfter = await db.query('SELECT id FROM outbound_replies WHERE user_id = ?', [userId]);
    expect(queuedAfter.length).toBe(0);
  });

  test('the deleted account token can no longer be used', async () => {
    const { token } = await makeUser('revoked');

    await asTestIp(request(app).delete('/api/auth/account'))
      .set('Authorization', `Bearer ${token}`)
      .send({ password: STRONG_PASSWORD })
      .expect(200);

    // The JWT is still cryptographically valid — what must stop working is the
    // account behind it.
    const me = await asTestIp(request(app).get('/api/auth/me')).set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(404);
  });
});

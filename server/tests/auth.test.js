/**
 * Integration tests for the authentication API.
 *
 * Runs the real Express app in-process (no network port bound) via
 * initializeApp(), driven by supertest. NOTE: server/server.js actually does
 *   module.exports = app;
 *   module.exports.start = start;
 *   module.exports.initializeApp = initializeApp;
 * i.e. the module export IS the Express app itself with .start/.initializeApp
 * attached as properties — it is NOT an { app, start, initializeApp } object.
 * `const { app } = require('../server')` would silently give `app === undefined`
 * (there is no `.app` property on the export), so we require the module once
 * and use it directly as the app, pulling `initializeApp` off of it.
 *
 * All rows created here use a uniquely-prefixed run id so they cannot collide
 * with rows from any other test file/run, and are deleted again in afterAll.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');

const app = require('../server');
const { initializeApp } = app;
const { getDatabase } = require('../config/db');
const { stopScheduler } = require('../services/syncScheduler');

// Unique per test-run prefix so emails never collide with other suites
// (e.g. a parallel data-isolation test file) even when they share the same
// on-disk/in-memory SQLite database.
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mkEmail = (label) => `authz-test-${label}-${RUN_ID}@example.test`;

const STRONG_PASSWORD = 'Str0ngPass1';

// Dedicated fake source IP (TEST-NET-3, RFC 5737 — reserved for documentation,
// guaranteed not to collide with a real client) used ONLY for the rate-limit
// flood test, via X-Forwarded-For + Express's `trust proxy` setting. This
// gives that test its own isolated rate-limit bucket so it doesn't matter how
// many failed requests the rest of the suite has already made against the
// default test IP, and vice versa — the flood test's count starts at zero.
const FLOOD_TEST_IP = '203.0.113.77';

describe('Auth API (server/routes/auth.js)', () => {
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

    // KNOWN ISSUE (server/services/syncScheduler.js, not fixed here — out of
    // this file's scope, reported as a finding instead): startScheduler()
    // schedules its first sync cycle via a bare `setTimeout(fn, 5000)` whose
    // handle is never stored, so stopScheduler() (which only clears the two
    // setInterval handles) cannot cancel it. If this test file's run
    // finishes in under 5s, that timer fires AFTER Jest has torn down this
    // file's module environment, throwing an uncatchable
    // "trying to `import` a file after the Jest environment has been torn
    // down" error that flips the whole process's exit code to 1 even though
    // every assertion above passed. Waiting out the 5s window here — before
    // stopScheduler()/db.close() — lets that stray timer fire (and its
    // internally-caught, harmless errors get logged) while the environment
    // and DB connection are still alive, so it can't do that.
    await new Promise((resolve) => setTimeout(resolve, 5200));

    stopScheduler();
    await db.close();
  }, 15000);

  // ==================================================================
  // 1. Register
  // ==================================================================
  describe('POST /api/auth/register', () => {
    test('rejects a request with a missing email (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ password: STRONG_PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    test('rejects a request with a missing password (400)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: mkEmail('reg-nopw') });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });

    test('rejects a password that is too short (400, clear error)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: mkEmail('reg-short'), password: 'Ab1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Le mot de passe doit contenir entre 8 et 128 caractères');
    });

    test('rejects a password with no uppercase letter (400, clear error)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: mkEmail('reg-noupper'), password: 'lowercase1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Le mot de passe doit contenir au moins 1 majuscule et 1 chiffre');
    });

    test('rejects a password with no digit (400, clear error)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: mkEmail('reg-nodigit'), password: 'NoDigitsHere' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Le mot de passe doit contenir au moins 1 majuscule et 1 chiffre');
    });

    test('rejects duplicate-email registration with a generic (non-revealing) error', async () => {
      const email = mkEmail('reg-dup');

      const first = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });
      expect(first.status).toBe(201);
      createdEmails.push(email);

      const dup = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });
      expect(dup.status).toBe(400);
      // Must not say "already exists"/"already registered" etc. — that would
      // directly confirm the email is taken.
      expect(dup.body.error.toLowerCase()).not.toMatch(/already|existe|exist/);

      // NOTE — verified actual behavior (server/controllers/authController.js):
      // the duplicate-email branch returns 400 "Registration failed. Please
      // check your information." while login's invalid-credentials branch
      // returns 401 "Invalid credentials". Despite the code comment claiming
      // "Same generic message as login failure", these are NOT byte-identical
      // (different text AND different status code: 400 vs 401). Reported as a
      // finding rather than asserted here as if it were true.
    });

    test('accepts a valid registration, returns a token, and sets an HttpOnly cookie', async () => {
      const email = mkEmail('reg-valid');
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.split('.')).toHaveLength(3);
      expect(res.body.user.email).toBe(email);
      createdEmails.push(email);

      const setCookie = res.headers['set-cookie'] || [];
      const tokenCookie = setCookie.find((c) => c.startsWith('token='));
      expect(tokenCookie).toBeDefined();
      expect(tokenCookie).toMatch(/HttpOnly/i);
    });
  });

  // ==================================================================
  // 2. Login
  // ==================================================================
  describe('POST /api/auth/login', () => {
    const email = mkEmail('login-user');

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });
      expect(res.status).toBe(201);
      createdEmails.push(email);
    });

    test('rejects a wrong password with a generic 401', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'TotallyWrong1' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    test('rejects a non-existent email with the SAME generic 401 (no enumeration)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: mkEmail('login-does-not-exist'), password: 'TotallyWrong1' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    test('accepts correct credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email, password: STRONG_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.email).toBe(email);
    });
  });

  // ==================================================================
  // 3. Protected routes without a token
  // ==================================================================
  describe('Protected routes reject requests with no token', () => {
    test.each([
      ['GET', '/api/properties'],
      ['GET', '/api/conversations'],
      ['GET', '/api/auth/me'],
    ])('%s %s -> 401 with no Authorization header and no cookie', async (method, url) => {
      const res = await request(app)[method.toLowerCase()](url);
      expect(res.status).toBe(401);
      expect(res.body.error).toBeTruthy();
    });
  });

  // ==================================================================
  // 4. Malformed / tampered tokens
  // ==================================================================
  describe('Malformed / tampered tokens are rejected', () => {
    let validToken;

    beforeAll(async () => {
      const email = mkEmail('tamper-user');
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });
      expect(res.status).toBe(201);
      createdEmails.push(email);
      validToken = res.body.token;
    });

    test('a token with a flipped character in its signature segment is rejected (401)', async () => {
      const parts = validToken.split('.');
      expect(parts).toHaveLength(3);
      const sig = parts[2];
      const flippedChar = sig[0] === 'A' ? 'B' : 'A';
      const flippedSig = flippedChar + sig.slice(1);
      const tamperedToken = `${parts[0]}.${parts[1]}.${flippedSig}`;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`);
      expect(res.status).toBe(401);
    });

    test('a token signed with the WRONG secret (correct HS256 algorithm) is rejected (401)', async () => {
      // Decode the real payload so this isn't rejected merely for having a
      // malformed/unexpected payload shape — only the secret is wrong.
      const realPayload = jwt.decode(validToken);
      const forgedToken = jwt.sign(
        { userId: realPayload.userId },
        'a-completely-different-secret-the-server-does-not-know',
        { algorithm: 'HS256', expiresIn: '1h' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${forgedToken}`);
      expect(res.status).toBe(401);
    });
  });

  // ==================================================================
  // 6. forgot-password / reset-password (no email enumeration)
  // ==================================================================
  describe('POST /api/auth/forgot-password and /api/auth/reset-password', () => {
    const existingEmail = mkEmail('forgot-existing');

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: existingEmail, password: STRONG_PASSWORD });
      expect(res.status).toBe(201);
      createdEmails.push(existingEmail);
    });

    // 15s, not Jest's 5s default: this path hashes a reset token with bcrypt,
    // which is intentionally slow, and the whole suite runs alongside ten others
    // competing for the same cores. The assertion is about the response being
    // indistinguishable from the unknown-email case, not about latency.
    test('forgot-password returns the same generic success response for an existing email', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: existingEmail });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe(
        'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
      );
    }, 15000);

    test('forgot-password returns the SAME generic success response for a non-existing email', async () => {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: mkEmail('forgot-does-not-exist') });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe(
        'Si un compte existe avec cet email, vous recevrez un lien de réinitialisation.'
      );
    });

    test('reset-password rejects an invalid/random token with a clear, non-revealing error', async () => {
      const randomToken = require('crypto').randomBytes(32).toString('hex');
      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({
          token: randomToken,
          newPassword: 'BrandNew1Pass',
          confirmPassword: 'BrandNew1Pass',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(
        'Ce lien de réinitialisation est invalide ou a expiré. Veuillez en demander un nouveau.'
      );
    });
  });

  // ==================================================================
  // 5. Rate limiting on login — MUST run last: it deliberately exhausts
  // authRateLimiter's budget. It uses a dedicated spoofed source IP
  // (X-Forwarded-For, honored because server.js sets `trust proxy: 1`) so
  // its own bucket starts empty regardless of how many failed
  // register/login/reset-password requests earlier tests made against the
  // default test IP — confirmed empirically to isolate buckets correctly.
  // ==================================================================
  describe('Rate limiting on login (authRateLimiter)', () => {
    const email = mkEmail('ratelimit-user');

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: STRONG_PASSWORD });
      expect(res.status).toBe(201);
      createdEmails.push(email);
    });

    test('the 11th failed login attempt within the window gets 429, not 401', async () => {
      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .set('X-Forwarded-For', FLOOD_TEST_IP)
          .send({ email, password: 'StillWrong1' });
        expect(res.status).toBe(401);
      }

      const eleventh = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', FLOOD_TEST_IP)
        .send({ email, password: 'StillWrong1' });
      expect(eleventh.status).toBe(429);
    }, 20000);

    // Regression guard: /forgot-password always answers 200 so that it never
    // reveals whether an email is registered. authRateLimiter sets
    // skipSuccessfulRequests, so it counted NONE of those requests and the
    // route was effectively unlimited (email-bombing any address). It now uses
    // the dedicated passwordResetRateLimiter, which counts every request.
    test('forgot-password is rate limited despite always returning 200', async () => {
      const statuses = [];
      for (let i = 0; i < 7; i++) {
        const res = await request(app)
          .post('/api/auth/forgot-password')
          .set('X-Forwarded-For', '203.0.113.99')
          .send({ email: 'no-such-account@example.test' });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);
    }, 20000);
  });
});

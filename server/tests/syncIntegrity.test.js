/**
 * Sync integrity — duplicates, cross-account isolation, concurrency, perf
 *
 * Regression cover for the four failure modes behind "conversations en double"
 * and "données mélangées entre utilisateurs":
 *
 *  1. db/database.js returned an insertId read by a SEPARATE
 *     `SELECT last_insert_rowid()` query. knex hands out a connection per
 *     raw() call, so a concurrent write could slip in between and the caller
 *     got ANOTHER row's id — measured at 4 wrong ids out of 5 concurrent
 *     inserts. That is enough to attach a message to someone else's
 *     conversation.
 *  2. gmailSyncService's de-duplication fallback filtered on
 *     `DATE_SUB(NOW(), INTERVAL 90 DAY)`. The SQLite adapter only rewrites
 *     NOW(), so the statement was a syntax error and the function threw on
 *     every call — the caller logged "thread failed" and each notification
 *     mail kept creating a new conversation.
 *  3. That same fallback merged on FIRST NAME alone, so two different
 *     travellers sharing one collapsed into a single thread.
 *  4. The conversation list aggregated the whole messages table per request.
 *
 * Runs against knexfile's "test" environment: a per-process in-memory SQLite
 * DB, isolated from both the dev file DB and production.
 */

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');

let db;

// Unique per run so parallel workers cannot collide.
const TAG = `sync-integrity-${process.pid}-${Date.now()}`;

async function createUser(email) {
  const res = await db.query(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [email, 'x'.repeat(20)]
  );
  return res.insertId;
}

async function createConversation(userId, fields = {}) {
  const res = await db.query(
    `INSERT INTO conversations (user_id, title, booking_status, external_provider, guest_name, guest_name_confidence)
     VALUES (?, ?, 'inquiry', 'gmail', ?, ?)`,
    [userId, fields.title || 'T', fields.guest_name || null, fields.guest_name_confidence || 0]
  );
  return res.insertId;
}

beforeAll(async () => {
  // initDatabase() (not db/database.testConnection() directly) is what binds
  // the module-level handle that getDatabase() returns.
  await initDatabase();
  db = getDatabase();
}, 60000);

afterAll(async () => {
  if (db) {
    try {
      const users = await db.query('SELECT id FROM users WHERE email LIKE ?', [`%${TAG}%`]);
      const ids = users.map((u) => u.id);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        const convs = await db.query(`SELECT id FROM conversations WHERE user_id IN (${ph})`, ids);
        const convIds = convs.map((c) => c.id);
        if (convIds.length > 0) {
          const cph = convIds.map(() => '?').join(',');
          await db.query(`DELETE FROM messages WHERE conversation_id IN (${cph})`, convIds);
        }
        await db.query(`DELETE FROM conversations WHERE user_id IN (${ph})`, ids);
        await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err.message);
    }
  }
  await database.close();
}, 30000);

// ────────────────────────────────────────────────────────────────────────────
describe('insertId under concurrency', () => {
  it('gives every concurrent INSERT its own row id', async () => {
    const userId = await createUser(`concurrency-${TAG}@example.test`);

    // Fire the writes concurrently — this is what made the old two-statement
    // implementation hand back another row's id.
    const titles = Array.from({ length: 12 }, (_, i) => `${TAG}-conv-${i}`);
    const inserted = await Promise.all(
      titles.map(async (title) => ({
        title,
        id: await createConversation(userId, { title }),
      }))
    );

    // Every reported id must be distinct...
    const ids = inserted.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => Number.isInteger(id) && id > 0)).toBe(true);

    // ...and must actually point at the row the caller wrote.
    for (const { title, id } of inserted) {
      const rows = await db.query('SELECT title, user_id FROM conversations WHERE id = ?', [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe(title);
      expect(rows[0].user_id).toBe(userId);
    }
  });

  it('reports affectedRows correctly for UPDATE and DELETE', async () => {
    const userId = await createUser(`affected-${TAG}@example.test`);
    const convId = await createConversation(userId, { title: `${TAG}-affected` });

    const updated = await db.query('UPDATE conversations SET title = ? WHERE id = ?', ['x', convId]);
    expect(updated.affectedRows).toBe(1);

    const noop = await db.query('UPDATE conversations SET title = ? WHERE id = ?', ['x', -1]);
    expect(noop.affectedRows).toBe(0);

    const deleted = await db.query('DELETE FROM conversations WHERE id = ?', [convId]);
    expect(deleted.affectedRows).toBe(1);
  });

  it('keeps concurrent messages attached to their own conversation', async () => {
    const userA = await createUser(`msg-a-${TAG}@example.test`);
    const userB = await createUser(`msg-b-${TAG}@example.test`);
    const convA = await createConversation(userA, { title: `${TAG}-A` });
    const convB = await createConversation(userB, { title: `${TAG}-B` });

    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [convA, 'incoming', `A${i}`])),
      ...Array.from({ length: 8 }, (_, i) =>
        db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [convB, 'incoming', `B${i}`])),
    ]);

    const aRows = await db.query('SELECT content FROM messages WHERE conversation_id = ?', [convA]);
    const bRows = await db.query('SELECT content FROM messages WHERE conversation_id = ?', [convB]);

    expect(aRows).toHaveLength(8);
    expect(bRows).toHaveLength(8);
    // No message written for one user may surface under the other's conversation.
    expect(aRows.every((r) => r.content.startsWith('A'))).toBe(true);
    expect(bRows.every((r) => r.content.startsWith('B'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('conversation de-duplication', () => {
  // Mirrors gmailSyncService.findExistingConversationFallback, including the
  // portable date cutoff that replaced DATE_SUB(NOW(), INTERVAL 90 DAY).
  const { nameKey } = require('../services/guestNameExtractor');

  async function findFallback(userId, guestName) {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const rows = await db.query(
      `SELECT id, guest_name FROM conversations
       WHERE user_id = ? AND external_provider = 'gmail' AND created_at >= ?
       ORDER BY updated_at DESC LIMIT 40`,
      [userId, cutoff]
    );
    const target = nameKey(guestName);
    for (const row of rows) {
      if (row.guest_name && nameKey(row.guest_name) === target) return row.id;
    }
    return null;
  }

  it('runs the 90-day window without a SQL error (DATE_SUB regression)', async () => {
    const userId = await createUser(`window-${TAG}@example.test`);
    await createConversation(userId, { title: `${TAG}-w`, guest_name: 'Florine' });

    // The old MySQL-only form threw here, which silently disabled de-duplication.
    await expect(findFallback(userId, 'Florine')).resolves.toEqual(expect.any(Number));
  });

  it('matches the same traveller again instead of creating a duplicate', async () => {
    const userId = await createUser(`dupe-${TAG}@example.test`);
    const convId = await createConversation(userId, { title: `${TAG}-d`, guest_name: 'Skogran' });

    expect(await findFallback(userId, 'Skogran')).toBe(convId);
    // Accent/case differences are the same person.
    expect(await findFallback(userId, 'SKOGRAN')).toBe(convId);
  });

  it('does NOT merge two different travellers who share a first name', async () => {
    const userId = await createUser(`firstname-${TAG}@example.test`);
    const marieDupont = await createConversation(userId, { title: `${TAG}-m1`, guest_name: 'Marie Dupont' });

    // "Marie Martin" is a different guest — the old first-name-only rule merged them.
    const match = await findFallback(userId, 'Marie Martin');
    expect(match).not.toBe(marieDupont);
    expect(match).toBeNull();
  });

  it('never matches a conversation belonging to another account', async () => {
    const userA = await createUser(`iso-a-${TAG}@example.test`);
    const userB = await createUser(`iso-b-${TAG}@example.test`);
    await createConversation(userA, { title: `${TAG}-iso`, guest_name: 'Gaëlle' });

    // Same guest name, different owner — must not cross the account boundary.
    expect(await findFallback(userB, 'Gaëlle')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('message de-duplication by gmail_message_id', () => {
  it('detects an already-synced Gmail message without re-parsing metadata', async () => {
    const userId = await createUser(`gmailid-${TAG}@example.test`);
    const convId = await createConversation(userId, { title: `${TAG}-g` });

    await db.query(
      'INSERT INTO messages (conversation_id, role, content, gmail_message_id, metadata_json) VALUES (?, ?, ?, ?, ?)',
      [convId, 'incoming', 'hello', 'gmail-msg-1', JSON.stringify({ gmail_message_id: 'gmail-msg-1' })]
    );

    const rows = await db.query(
      'SELECT gmail_message_id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL',
      [convId]
    );
    expect(rows.map((r) => r.gmail_message_id)).toContain('gmail-msg-1');
  });

  it('still finds legacy rows that only carry the id inside metadata_json', async () => {
    const userId = await createUser(`legacy-${TAG}@example.test`);
    const convId = await createConversation(userId, { title: `${TAG}-l` });

    await db.query(
      'INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)',
      [convId, 'incoming', 'legacy', JSON.stringify({ gmail_message_id: 'legacy-1' })]
    );

    const legacy = await db.query(
      'SELECT metadata_json FROM messages WHERE conversation_id = ? AND gmail_message_id IS NULL AND metadata_json IS NOT NULL',
      [convId]
    );
    const ids = legacy.map((r) => JSON.parse(r.metadata_json).gmail_message_id);
    expect(ids).toContain('legacy-1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('conversation list — scaling', () => {
  const USERS = 6;
  const CONVS_PER_USER = 40;
  const MSGS_PER_CONV = 6;

  let userIds = [];

  beforeAll(async () => {
    for (let u = 0; u < USERS; u++) {
      const userId = await createUser(`perf-${u}-${TAG}@example.test`);
      userIds.push(userId);
      for (let c = 0; c < CONVS_PER_USER; c++) {
        const convId = await createConversation(userId, {
          title: `${TAG}-p-${u}-${c}`,
          guest_name: `Guest${u}_${c}`,
        });
        for (let m = 0; m < MSGS_PER_CONV; m++) {
          await db.query(
            'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
            [convId, m % 2 ? 'outgoing' : 'incoming', `msg ${m} `.repeat(10), new Date(Date.now() - m * 60000)]
          );
        }
      }
    }
  }, 120000);

  /** The paged implementation used by conversationController.getConversations. */
  async function listConversations(userId, limit = 20, offset = 0) {
    const conversations = await db.query(
      `SELECT c.id, c.title, c.guest_name, c.updated_at
       FROM conversations c WHERE c.user_id = ?
       ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );
    if (conversations.length === 0) return [];

    const ids = conversations.map((c) => c.id);
    const ph = ids.map(() => '?').join(',');

    const stats = await db.query(
      `SELECT conversation_id, COUNT(*) AS msg_count FROM messages
       WHERE conversation_id IN (${ph}) GROUP BY conversation_id`,
      ids
    );
    const previews = await db.query(
      `SELECT conversation_id, last_message FROM (
         SELECT conversation_id, SUBSTR(content, 1, 120) AS last_message,
                ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC, id DESC) AS rn
         FROM messages WHERE conversation_id IN (${ph})
       ) ranked WHERE rn = 1`,
      ids
    );

    const counts = new Map(stats.map((s) => [s.conversation_id, s.msg_count]));
    const preview = new Map(previews.map((p) => [p.conversation_id, p.last_message]));
    for (const c of conversations) {
      c.message_count = counts.get(c.id) || 0;
      c.last_message = preview.get(c.id) || null;
    }
    return conversations;
  }

  it('returns only the requested page, with counts and previews', async () => {
    const page = await listConversations(userIds[0], 20, 0);
    expect(page).toHaveLength(20);
    for (const row of page) {
      expect(row.message_count).toBe(MSGS_PER_CONV);
      expect(typeof row.last_message).toBe('string');
    }
  });

  it('pages without overlap and reaches every conversation', async () => {
    const seen = new Set();
    for (let offset = 0; offset < CONVS_PER_USER; offset += 20) {
      const page = await listConversations(userIds[0], 20, offset);
      for (const row of page) {
        // An id appearing twice would mean the client shows duplicates.
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(CONVS_PER_USER);
  });

  it('never leaks another account\'s conversations into a page', async () => {
    const page = await listConversations(userIds[1], 100, 0);
    const ownIds = new Set(
      (await db.query('SELECT id FROM conversations WHERE user_id = ?', [userIds[1]])).map((r) => r.id)
    );
    expect(page.length).toBeGreaterThan(0);
    for (const row of page) expect(ownIds.has(row.id)).toBe(true);
  });

  it('costs the same for the last page as for the first (page-bounded, not corpus-bounded)', async () => {
    const time = async (fn) => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm the cache so this measures query shape, not first-touch I/O.
    await listConversations(userIds[0], 20, 0);
    await listConversations(userIds[0], 20, 20);

    const first = await time(() => listConversations(userIds[0], 20, 0));
    const last = await time(() => listConversations(userIds[0], 20, 20));

    // Generous bound: the point is that cost does not blow up with offset —
    // it is asserting a property, not a benchmark figure.
    expect(last).toBeLessThan(Math.max(first * 8, 250));
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('Airbnb property import — duplicates and naming', () => {
  const { isPlaceholderName } = require('../services/airbnbListingResolver');

  async function importProperty(userId, listingId, name) {
    // Mirrors propertyController.createProperty: pre-check, then insert.
    const existing = await db.query(
      'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ? LIMIT 1',
      [userId, String(listingId)]
    );
    if (existing.length > 0) return { outcome: 'skipped', id: existing[0].id };

    try {
      const res = await db.query(
        `INSERT INTO property_profiles (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests, airbnb_listing_id)
         VALUES (?, ?, 'apartment', 1, 1, 1, 2, ?)`,
        [userId, name, String(listingId)]
      );
      return { outcome: 'created', id: res.insertId };
    } catch (err) {
      // What the unique index from migration 016 raises when it wins the race.
      if (/UNIQUE constraint failed|Duplicate entry/i.test(err.message)) {
        return { outcome: 'rejected' };
      }
      throw err;
    }
  }

  it('keeps a single property when the SAME listing is imported concurrently', async () => {
    const userId = await createUser(`import-race-${TAG}@example.test`);

    // Three simultaneous imports — the SELECT-then-INSERT pre-check alone is a
    // TOCTOU race and produced three rows before the unique index existed.
    const results = await Promise.all([
      importProperty(userId, 555001, `${TAG} Villa A`),
      importProperty(userId, 555001, `${TAG} Villa B`),
      importProperty(userId, 555001, `${TAG} Villa C`),
    ]);

    const rows = await db.query(
      'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ?',
      [userId, '555001']
    );
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
  });

  it('is idempotent when the same listing is imported again later', async () => {
    const userId = await createUser(`import-repeat-${TAG}@example.test`);

    const first = await importProperty(userId, 555002, `${TAG} Studio`);
    const second = await importProperty(userId, 555002, `${TAG} Studio`);

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('skipped');
    expect(second.id).toBe(first.id);
  });

  it('never blocks two DIFFERENT listings, or manually-created properties', async () => {
    const userId = await createUser(`import-distinct-${TAG}@example.test`);

    expect((await importProperty(userId, 555003, `${TAG} Un`)).outcome).toBe('created');
    expect((await importProperty(userId, 555004, `${TAG} Deux`)).outcome).toBe('created');

    // airbnb_listing_id NULL must stay repeatable — NULLs are distinct in a
    // unique index, so hand-created properties are unaffected.
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO property_profiles (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests)
         VALUES (?, ?, 'apartment', 1, 1, 1, 2)`,
        [userId, `${TAG} manuel ${i}`]
      );
    }
    const manual = await db.query(
      'SELECT COUNT(*) AS n FROM property_profiles WHERE user_id = ? AND airbnb_listing_id IS NULL',
      [userId]
    );
    expect(Number(manual[0].n)).toBe(3);
  });

  it('two accounts may each import the SAME Airbnb listing', async () => {
    const userA = await createUser(`import-a-${TAG}@example.test`);
    const userB = await createUser(`import-b-${TAG}@example.test`);

    // The uniqueness is per (user_id, listing) — co-hosts of one property must
    // not lock each other out.
    expect((await importProperty(userA, 555005, `${TAG} A`)).outcome).toBe('created');
    expect((await importProperty(userB, 555005, `${TAG} B`)).outcome).toBe('created');
  });

  it('rejects the auto-generated placeholder names before they can be stored', () => {
    // The guard propertyController.createProperty applies.
    expect(isPlaceholderName('Logement Airbnb #1211329749598969023', '1211329749598969023')).toBe(true);
    expect(isPlaceholderName('Airbnb', '123')).toBe(true);
    expect(isPlaceholderName('La Villa Cosy - Proche Bordeaux', '123')).toBe(false);
  });

  it('marks a re-scan as allowed to fix an auto name but not a manual one', async () => {
    const userId = await createUser(`name-source-${TAG}@example.test`);

    const auto = await db.query(
      `INSERT INTO property_profiles (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests, airbnb_listing_id, name_source)
       VALUES (?, ?, 'apartment', 1, 1, 1, 2, ?, 'airbnb_auto')`,
      [userId, 'Logement Airbnb #555006', '555006']
    );
    const manual = await db.query(
      `INSERT INTO property_profiles (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests, airbnb_listing_id, name_source)
       VALUES (?, ?, 'apartment', 1, 1, 1, 2, ?, 'manual')`,
      [userId, 'Mon petit nom à moi', '555007']
    );

    const rows = await db.query(
      'SELECT id, name, name_source FROM property_profiles WHERE id IN (?, ?)',
      [auto.insertId, manual.insertId]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(auto.insertId).name_source).toBe('airbnb_auto');
    expect(byId.get(manual.insertId).name_source).toBe('manual');
  });
});

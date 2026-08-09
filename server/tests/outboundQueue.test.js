/**
 * Outbound reply queue — idempotency, worker locking, retries, isolation.
 *
 * NO REAL MESSAGE IS EVER SENT: this suite never calls the Gmail API. It
 * exercises the queue's own guarantees, which is exactly where a duplicate
 * reply to a real guest would come from.
 *
 * Runs against knexfile's "test" environment (in-memory SQLite), so it cannot
 * touch the dev or production database.
 */

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const queue = require('../services/outboundQueue');

let db;
const TAG = `queue-${process.pid}-${Date.now()}`;

async function createUser(suffix) {
  const res = await db.query(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [`${suffix}-${TAG}@example.test`, 'x'.repeat(20)]
  );
  return res.insertId;
}

async function createConversation(userId) {
  const res = await db.query(
    `INSERT INTO conversations (user_id, title, booking_status, external_provider)
     VALUES (?, ?, 'inquiry', 'gmail')`,
    [userId, `${TAG} conversation`]
  );
  return res.insertId;
}

function baseRow(userId, conversationId, overrides = {}) {
  return {
    userId,
    gmailAccountId: 1,
    conversationId,
    triggerMessageId: 1000,
    gmailMessageId: 'gmail-msg-abc',
    bodyText: 'Bonjour, le check-in est à 15h.',
    toAddress: '4abc@reply.airbnb.com',
    subject: 'Re: Objet : Demande',
    inReplyTo: '<x@geopod-ismtpd-6>',
    mode: 'manual',
    delayMs: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
}, 60000);

// claimNext() serves every account by design, so it can pick up a row left
// behind by an earlier test. Start each case from an empty queue so the
// assertions are about the row the test itself created.
beforeEach(async () => {
  await db.query('DELETE FROM outbound_replies');
});

afterAll(async () => {
  if (db) {
    try {
      const users = await db.query('SELECT id FROM users WHERE email LIKE ?', [`%${TAG}%`]);
      const ids = users.map((u) => u.id);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        await db.query(`DELETE FROM outbound_replies WHERE user_id IN (${ph})`, ids);
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
      console.error('cleanup:', err.message);
    }
  }
  await database.close();
}, 30000);

// ────────────────────────────────────────────────────────────────────────────
describe('idempotency — a guest is answered at most once', () => {
  it('derives a stable key from the triggering message', () => {
    const a = queue.buildIdempotencyKey({ conversationId: 1, triggerMessageId: 2, gmailMessageId: 'g' });
    const b = queue.buildIdempotencyKey({ conversationId: 1, triggerMessageId: 2, gmailMessageId: 'g' });
    expect(a).toBe(b);
    // A different guest message must get its own reply.
    expect(queue.buildIdempotencyKey({ conversationId: 1, triggerMessageId: 3, gmailMessageId: 'g' })).not.toBe(a);
    expect(queue.buildIdempotencyKey({ conversationId: 2, triggerMessageId: 2, gmailMessageId: 'g' })).not.toBe(a);
  });

  it('enqueuing the same guest message twice creates ONE row', async () => {
    const userId = await createUser('idem');
    const conversationId = await createConversation(userId);

    const first = await queue.enqueue(baseRow(userId, conversationId));
    const second = await queue.enqueue(baseRow(userId, conversationId));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await db.query('SELECT id FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(rows).toHaveLength(1);
  });

  it('survives CONCURRENT enqueues of the same message (double click / two syncs)', async () => {
    const userId = await createUser('idem-race');
    const conversationId = await createConversation(userId);

    // Five simultaneous attempts — only the unique index decides.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => queue.enqueue(baseRow(userId, conversationId)))
    );

    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);

    const rows = await db.query('SELECT id FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(rows).toHaveLength(1);
    // Every caller learns the same row id.
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it('a genuinely new guest message DOES get its own reply', async () => {
    const userId = await createUser('idem-new');
    const conversationId = await createConversation(userId);

    await queue.enqueue(baseRow(userId, conversationId, { triggerMessageId: 1, gmailMessageId: 'g1' }));
    const second = await queue.enqueue(baseRow(userId, conversationId, { triggerMessageId: 2, gmailMessageId: 'g2' }));

    expect(second.created).toBe(true);
    const rows = await db.query('SELECT id FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(rows).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('worker locking', () => {
  it('two concurrent workers never claim the same row', async () => {
    const userId = await createUser('lock');
    const conversationId = await createConversation(userId);
    await queue.enqueue(baseRow(userId, conversationId));

    // Both "workers" race for the single pending row.
    const [a, b] = await Promise.all([queue.claimNext(), queue.claimNext()]);

    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('sending');
  });

  it('does not start a second reply while one is in flight for the same conversation', async () => {
    const userId = await createUser('lock-conv');
    const conversationId = await createConversation(userId);

    await queue.enqueue(baseRow(userId, conversationId, { triggerMessageId: 1, gmailMessageId: 'g1' }));
    await queue.enqueue(baseRow(userId, conversationId, { triggerMessageId: 2, gmailMessageId: 'g2' }));

    const first = await queue.claimNext();
    expect(first).not.toBeNull();

    // The second row is due, but its conversation is busy.
    const second = await queue.claimNext();
    expect(second).toBeNull();

    await queue.markSent(first.id, { gmailMessageId: 'sent-1', gmailThreadId: 't1' });

    // Once the first settles, the next one becomes claimable.
    const third = await queue.claimNext();
    expect(third).not.toBeNull();
    expect(third.id).not.toBe(first.id);
  });

  it('reclaims a row abandoned by a crashed worker', async () => {
    const userId = await createUser('lock-stale');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId));

    const claimed = await queue.claimNext();
    expect(claimed.id).toBe(id);

    // Simulate the worker dying mid-send: lock older than the timeout.
    const stale = new Date(Date.now() - queue.LOCK_TIMEOUT_MS - 60_000)
      .toISOString().slice(0, 19).replace('T', ' ');
    await db.query('UPDATE outbound_replies SET locked_at = ? WHERE id = ?', [stale, id]);

    const reclaimed = await queue.reclaimStaleLocks();
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const again = await queue.claimNext();
    expect(again.id).toBe(id);
  });

  it('does not claim a row scheduled in the future (debounce window)', async () => {
    const userId = await createUser('lock-future');
    const conversationId = await createConversation(userId);
    await queue.enqueue(baseRow(userId, conversationId, { delayMs: 10 * 60_000 }));

    expect(await queue.claimNext()).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('debounce for successive guest messages', () => {
  it('pushes the deadline back instead of queuing a second reply', async () => {
    const userId = await createUser('debounce');
    const conversationId = await createConversation(userId);

    await queue.enqueue(baseRow(userId, conversationId, { mode: 'auto', delayMs: 1000 }));
    const before = await db.query('SELECT scheduled_at FROM outbound_replies WHERE conversation_id = ?', [conversationId]);

    const moved = await queue.extendDebounce(conversationId, userId);
    expect(moved).toBe(1);

    const after = await db.query('SELECT scheduled_at FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(new Date(after[0].scheduled_at).getTime())
      .toBeGreaterThanOrEqual(new Date(before[0].scheduled_at).getTime());

    // Still exactly one reply for the whole burst.
    const rows = await db.query('SELECT id FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(rows).toHaveLength(1);
  });

  it('never postpones a reply that is already sending or sent', async () => {
    const userId = await createUser('debounce-sent');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId, { mode: 'auto' }));

    await queue.markSent(id, { gmailMessageId: 'sent-x', gmailThreadId: 't' });
    expect(await queue.extendDebounce(conversationId, userId)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('retries and backoff', () => {
  it('retries a temporary failure with growing delay, then gives up', async () => {
    const userId = await createUser('retry');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId));

    let lastOutcome = null;
    for (let i = 0; i < queue.MAX_ATTEMPTS; i++) {
      await db.query('UPDATE outbound_replies SET status = ?, attempts = ? WHERE id = ?', ['sending', i + 1, id]);
      lastOutcome = await queue.markFailed(id, new Error('ETIMEDOUT'));
      if (lastOutcome.retrying) {
        expect(lastOutcome.retryInMs).toBeGreaterThan(0);
      }
    }

    expect(lastOutcome.retrying).toBe(false);
    const rows = await db.query('SELECT status FROM outbound_replies WHERE id = ?', [id]);
    expect(rows[0].status).toBe('failed');
  });

  it('gives up immediately on a permanent failure', async () => {
    const userId = await createUser('retry-perm');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId));

    const outcome = await queue.markFailed(id, new Error('GMAIL_SEND_SCOPE_MISSING'), { permanent: true });
    expect(outcome.retrying).toBe(false);

    const rows = await db.query('SELECT status, last_error FROM outbound_replies WHERE id = ?', [id]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].last_error).toContain('GMAIL_SEND_SCOPE_MISSING');
  });

  it('retry() re-arms the SAME row — never creates a duplicate', async () => {
    const userId = await createUser('retry-again');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId));

    await queue.markFailed(id, new Error('boom'), { permanent: true });

    // Pressing "Réessayer" repeatedly must stay safe.
    expect(await queue.retry(id, userId)).toBe(true);
    expect(await queue.retry(id, userId)).toBe(false); // already pending again

    const rows = await db.query('SELECT id, status, attempts FROM outbound_replies WHERE conversation_id = ?', [conversationId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
  });

  it('a sent reply can never be re-armed', async () => {
    const userId = await createUser('retry-sent');
    const conversationId = await createConversation(userId);
    const { id } = await queue.enqueue(baseRow(userId, conversationId));

    await queue.markSent(id, { gmailMessageId: 'sent-y', gmailThreadId: 't' });
    expect(await queue.retry(id, userId)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('account isolation', () => {
  it('one account cannot retry or cancel another account\'s send', async () => {
    const owner = await createUser('iso-owner');
    const stranger = await createUser('iso-stranger');
    const conversationId = await createConversation(owner);
    const { id } = await queue.enqueue(baseRow(owner, conversationId));
    await queue.markFailed(id, new Error('boom'), { permanent: true });

    expect(await queue.retry(id, stranger)).toBe(false);
    expect(await queue.cancel(id, stranger)).toBe(false);
    // The owner still can.
    expect(await queue.retry(id, owner)).toBe(true);
  });

  it('status lookups never cross the account boundary', async () => {
    const owner = await createUser('iso-status-owner');
    const stranger = await createUser('iso-status-stranger');
    const conversationId = await createConversation(owner);
    await queue.enqueue(baseRow(owner, conversationId));

    expect(await queue.latestForConversation(conversationId, owner)).not.toBeNull();
    expect(await queue.latestForConversation(conversationId, stranger)).toBeNull();
  });

  it('existsForTrigger is scoped to the account', async () => {
    const owner = await createUser('iso-trigger-owner');
    const stranger = await createUser('iso-trigger-stranger');
    const conversationId = await createConversation(owner);
    await queue.enqueue(baseRow(owner, conversationId));

    const args = { conversationId, triggerMessageId: 1000, gmailMessageId: 'gmail-msg-abc' };
    expect(await queue.existsForTrigger({ ...args, userId: owner })).not.toBeNull();
    expect(await queue.existsForTrigger({ ...args, userId: stranger })).toBeNull();
  });
});

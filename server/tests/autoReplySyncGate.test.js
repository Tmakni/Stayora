/**
 * Aucune réponse automatique tant que la synchronisation Gmail est en erreur.
 *
 * POURQUOI CE GARDE-FOU
 * ---------------------
 * Une boîte dont le sync est en erreur ne prouve plus rien sur la complétude du
 * fil : le dernier message stocké du voyageur n'est pas forcément le dernier
 * qu'il a envoyé. Répondre dans cet état, c'est répondre à côté — et un envoi
 * est irréversible, contrairement à l'attente. Dès que le compte revient à
 * 'idle', le message suivant (ou la passe de réconciliation) reprogramme.
 *
 * Le test monte un cas où TOUT le reste autorise l'envoi : mode automatique,
 * message entrant récent, hôte n'ayant pas répondu, enveloppe de réponse
 * valide. Seul l'état du compte Gmail change entre les deux cas — c'est donc
 * bien lui, et rien d'autre, qui décide.
 */

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const autoReply = require('../services/autoReplyService');

let db;
const TAG = `gate-${process.pid}-${Date.now()}`;

async function buildFixture({ syncStatus }) {
  const email = `gate-${syncStatus}-${TAG}@example.test`;

  const user = await db.query(
    "INSERT INTO users (email, password_hash, auto_reply_mode, auto_reply_paused) VALUES (?, ?, 'auto', 0)",
    [email, 'x'.repeat(20)]
  );
  const userId = user.insertId;

  const account = await db.query(
    `INSERT INTO gmail_accounts (user_id, email, is_active, can_send, sync_status)
     VALUES (?, ?, TRUE, 1, ?)`,
    [userId, `host-${TAG}@example.test`, syncStatus]
  );
  const accountId = account.insertId;

  const conv = await db.query(
    `INSERT INTO conversations (user_id, title, booking_status, guest_name, guest_language)
     VALUES (?, ?, 'confirmed', 'Florine', 'fr')`,
    [userId, `Florine ${TAG}`]
  );
  const conversationId = conv.insertId;

  await db.query(
    `INSERT INTO gmail_threads (user_id, gmail_account_id, gmail_thread_id, conversation_id, subject, last_message_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [userId, accountId, `thread-${syncStatus}-${TAG}`, conversationId, 'Réservation']
  );

  // Message entrant récent, avec une enveloppe de réponse valide : sans cela le
  // refus viendrait de l'enveloppe et non du garde-fou visé.
  await db.query(
    `INSERT INTO messages
       (conversation_id, role, content, gmail_message_id,
        email_reply_to, email_message_id, email_subject, created_at)
     VALUES (?, 'incoming', ?, ?, ?, ?, ?, NOW())`,
    [
      conversationId,
      'Bonjour, à quelle heure puis-je arriver ?',
      `msg-${syncStatus}-${TAG}`,
      `reply+${TAG}@reply.airbnb.com`,
      `<msg-${syncStatus}-${TAG}@geopod>`,
      'Réservation',
    ]
  );

  return { userId, conversationId, accountId };
}

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
});

afterAll(async () => {
  await database.close();
});

describe('réponse automatique et état de la synchronisation', () => {
  it("ne programme rien quand le compte Gmail est en erreur", async () => {
    const { userId, conversationId } = await buildFixture({ syncStatus: 'error' });

    const result = await autoReply.scheduleForConversation({ userId, conversationId });

    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe('sync_error');

    const queued = await db.query(
      'SELECT COUNT(*) AS n FROM outbound_replies WHERE conversation_id = ?',
      [conversationId]
    );
    expect(Number(queued[0].n)).toBe(0);
  });

  it('programme normalement quand la synchronisation va bien', async () => {
    // Cas témoin : la SEULE différence avec le test précédent est sync_status.
    const { userId, conversationId } = await buildFixture({ syncStatus: 'idle' });

    const result = await autoReply.scheduleForConversation({ userId, conversationId });

    expect(result.reason).not.toBe('sync_error');
    expect(result.scheduled).toBe(true);

    const queued = await db.query(
      'SELECT COUNT(*) AS n FROM outbound_replies WHERE conversation_id = ?',
      [conversationId]
    );
    expect(Number(queued[0].n)).toBe(1);
  });
});

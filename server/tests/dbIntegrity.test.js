/**
 * Intégrité de la base — les garanties qui ne doivent pas dépendre du code.
 *
 * Chaque test correspond à un défaut mesuré pendant l'audit :
 *
 *  1. DOUBLON. La déduplication du sync Gmail était un read-then-write sans
 *     contrainte : deux importateurs concurrents (cycle de sync + passe de
 *     réconciliation, ou deux processus pendant un déploiement) inséraient tous
 *     les deux. Reproduit, puis corrigé par l'index UNIQUE de la migration 020.
 *
 *  2. TRAVERSÉE DE COMPTE. airbnbSyncService cherchait une réservation par son
 *     seul identifiant Airbnb, sans user_id, et mettait à jour la ligne trouvée.
 *     Sur un logement co-hébergé, un hôte réécrivait donc la réservation d'un
 *     autre — en y inscrivant son propre property_id.
 *
 *  3. ORPHELINS. outbound_replies n'a pas de clé étrangère ; les chemins qui
 *     suppriment une conversation doivent nettoyer eux-mêmes.
 */

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');

let db;
const TAG = `integrity-${process.pid}-${Date.now()}`;

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
});

afterAll(async () => {
  await database.close();
});

async function makeUser(suffix) {
  const r = await db.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [
    `u-${TAG}-${suffix}@example.test`, 'x'.repeat(20),
  ]);
  return r.insertId;
}

async function makeConversation(userId, title = 'conv') {
  const r = await db.query('INSERT INTO conversations (user_id, title) VALUES (?, ?)', [userId, title]);
  return r.insertId;
}

describe('un message Gmail ne peut pas être enregistré deux fois', () => {
  it("refuse le second INSERT du même gmail_message_id dans une conversation", async () => {
    const userId = await makeUser('dup');
    const convId = await makeConversation(userId);

    await db.query(
      'INSERT INTO messages (conversation_id, role, content, gmail_message_id) VALUES (?, ?, ?, ?)',
      [convId, 'incoming', 'premier', 'gm-dup-1']
    );

    await expect(
      db.query(
        'INSERT INTO messages (conversation_id, role, content, gmail_message_id) VALUES (?, ?, ?, ?)',
        [convId, 'incoming', 'doublon', 'gm-dup-1']
      )
    ).rejects.toThrow(/UNIQUE constraint failed|Duplicate entry/i);

    const rows = await db.query(
      'SELECT id FROM messages WHERE conversation_id = ? AND gmail_message_id = ?',
      [convId, 'gm-dup-1']
    );
    expect(rows).toHaveLength(1);
  });

  it('tient face à deux importateurs CONCURRENTS', async () => {
    // La reproduction exacte du défaut : deux tâches lisent l'état, ne voient
    // rien, et insèrent. Avant la migration 020, les deux réussissaient.
    const userId = await makeUser('race');
    const convId = await makeConversation(userId);
    const GMAIL_ID = 'gm-race-1';

    const importer = async () => {
      const seen = await db.query(
        'SELECT gmail_message_id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL',
        [convId]
      );
      if (seen.some((r) => r.gmail_message_id === GMAIL_ID)) return 'skipped';
      try {
        await db.query(
          'INSERT INTO messages (conversation_id, role, content, gmail_message_id) VALUES (?, ?, ?, ?)',
          [convId, 'incoming', 'corps', GMAIL_ID]
        );
        return 'inserted';
      } catch (err) {
        if (/UNIQUE constraint failed|Duplicate entry/i.test(err.message)) return 'rejected';
        throw err;
      }
    };

    const outcomes = await Promise.all([importer(), importer(), importer()]);
    expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);

    const rows = await db.query(
      'SELECT id FROM messages WHERE conversation_id = ? AND gmail_message_id = ?',
      [convId, GMAIL_ID]
    );
    expect(rows).toHaveLength(1);
  });

  it("n'empêche pas plusieurs messages manuels (gmail_message_id NULL)", async () => {
    const userId = await makeUser('null');
    const convId = await makeConversation(userId);
    for (let i = 0; i < 3; i++) {
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [
        convId, 'outgoing', `manuel ${i}`,
      ]);
    }
    const rows = await db.query(
      'SELECT id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NULL',
      [convId]
    );
    expect(rows).toHaveLength(3);
  });

  it('le même identifiant Gmail reste possible dans deux conversations', async () => {
    // Portée volontaire : une fusion repointe des messages, et un identifiant
    // Gmail n'est unique que dans une boîte.
    const userId = await makeUser('scope');
    const a = await makeConversation(userId, 'A');
    const b = await makeConversation(userId, 'B');
    const insert = (conv) => db.query(
      'INSERT INTO messages (conversation_id, role, content, gmail_message_id) VALUES (?, ?, ?, ?)',
      [conv, 'incoming', 'x', 'gm-shared-1']
    );
    await insert(a);
    await expect(insert(b)).resolves.toBeDefined();
  });
});

describe('une réservation appartient à un seul hôte', () => {
  const resaRow = (userId, resaId) => [userId, resaId, '2026-07-01', '2026-07-08'];
  const INSERT = `INSERT INTO reservations (user_id, airbnb_reservation_id, check_in_date, check_out_date)
                  VALUES (?, ?, ?, ?)`;

  it('deux hôtes peuvent enregistrer la même réservation (co-hébergement)', async () => {
    const hostA = await makeUser('resa-a');
    const hostB = await makeUser('resa-b');
    const resaId = `RESA-${TAG}`;

    await db.query(INSERT, resaRow(hostA, resaId));
    // Refusé tant que l'unicité était GLOBALE (migration 021).
    await expect(db.query(INSERT, resaRow(hostB, resaId))).resolves.toBeDefined();
  });

  it('mais le doublon reste refusé chez le même hôte', async () => {
    const userId = await makeUser('resa-dup');
    const resaId = `RESA-DUP-${TAG}`;
    await db.query(INSERT, resaRow(userId, resaId));
    await expect(db.query(INSERT, resaRow(userId, resaId)))
      .rejects.toThrow(/UNIQUE constraint failed|Duplicate entry/i);
  });

  it("la recherche d'une réservation ne franchit pas la frontière de compte", async () => {
    // Le défaut : SELECT ... WHERE airbnb_reservation_id = ? sans user_id
    // retournait la ligne de l'AUTRE hôte, que l'UPDATE suivant réécrivait.
    const hostA = await makeUser('cross-a');
    const hostB = await makeUser('cross-b');
    const resaId = `RESA-CROSS-${TAG}`;
    await db.query(INSERT, resaRow(hostA, resaId));

    const unscoped = await db.query('SELECT id, user_id FROM reservations WHERE airbnb_reservation_id = ?', [resaId]);
    const scoped = await db.query(
      'SELECT id FROM reservations WHERE user_id = ? AND airbnb_reservation_id = ?',
      [hostB, resaId]
    );

    expect(unscoped.length).toBeGreaterThan(0);  // ce que voyait l'ancien code
    expect(scoped).toHaveLength(0);              // ce que voit le code corrigé
  });
});

describe('cascades de suppression', () => {
  it('les messages disparaissent avec leur conversation', async () => {
    const userId = await makeUser('casc');
    const convId = await makeConversation(userId);
    await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)', [convId, 'incoming', 'x']);

    await db.query('DELETE FROM conversations WHERE id = ?', [convId]);
    expect(await db.query('SELECT id FROM messages WHERE conversation_id = ?', [convId])).toHaveLength(0);
  });

  it("conversations et comptes Gmail disparaissent avec l'utilisateur", async () => {
    const userId = await makeUser('casc-user');
    const convId = await makeConversation(userId);
    await db.query('INSERT INTO gmail_accounts (user_id, email) VALUES (?, ?)', [userId, `g-${TAG}@example.test`]);

    await db.query('DELETE FROM users WHERE id = ?', [userId]);
    expect(await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId])).toHaveLength(0);
    expect(await db.query('SELECT id FROM gmail_accounts WHERE user_id = ?', [userId])).toHaveLength(0);
    expect(await db.query('SELECT id FROM messages WHERE conversation_id = ?', [convId])).toHaveLength(0);
  });

  it("LACUNE CONNUE : outbound_replies survit à la suppression de sa conversation", async () => {
    // outbound_replies ne porte aucune clé étrangère (migration 017 déclare les
    // colonnes notNullable mais n'appelle jamais .references()). Ce test fige le
    // comportement actuel : le jour où les FK seront posées, il échouera et
    // obligera à le mettre à jour sciemment plutôt que de laisser la lacune
    // passer inaperçue. Les chemins de suppression connus nettoient à la main
    // (authController.deleteAccount, purgeNonAirbnbConversations).
    const userId = await makeUser('orphan');
    const convId = await makeConversation(userId);
    const g = await db.query('INSERT INTO gmail_accounts (user_id, email) VALUES (?, ?)', [userId, `go-${TAG}@example.test`]);

    await db.query(
      `INSERT INTO outbound_replies (user_id, gmail_account_id, conversation_id, idempotency_key, status, mode)
       VALUES (?, ?, ?, ?, 'pending', 'auto')`,
      [userId, g.insertId, convId, `orphan-${TAG}`]
    );

    await db.query('DELETE FROM conversations WHERE id = ?', [convId]);

    const orphans = await db.query('SELECT id FROM outbound_replies WHERE conversation_id = ?', [convId]);
    expect(orphans).toHaveLength(1); // ← deviendra 0 quand les FK seront ajoutées
  });
});

describe("file d'envoi — un voyageur répondu au plus une fois", () => {
  it("refuse deux entrées portant la même clé d'idempotence", async () => {
    const userId = await makeUser('idem');
    const convId = await makeConversation(userId);
    const g = await db.query('INSERT INTO gmail_accounts (user_id, email) VALUES (?, ?)', [userId, `gi-${TAG}@example.test`]);

    const insert = () => db.query(
      `INSERT INTO outbound_replies (user_id, gmail_account_id, conversation_id, idempotency_key, status, mode)
       VALUES (?, ?, ?, ?, 'pending', 'auto')`,
      [userId, g.insertId, convId, `idem-${TAG}`]
    );

    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE constraint failed|Duplicate entry/i);
  });
});

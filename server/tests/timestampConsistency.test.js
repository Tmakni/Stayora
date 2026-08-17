/**
 * Cohérence de type des colonnes de date
 *
 * Le piège, mesuré sur la base réelle : messages.created_at contenait 3475
 * entiers et 25 chaînes, conversations.updated_at 363 entiers et 188 chaînes.
 *
 * Pourquoi : knex, sur le dialecte better-sqlite3, convertit tout binding Date
 * en `binding.valueOf()`, donc en millisecondes ENTIÈRES
 * (node_modules/knex/lib/dialects/better-sqlite3/index.js). Les autres
 * écritures des mêmes colonnes passent par NOW(), que db/database.js traduit en
 * datetime('now') — du TEXTE.
 *
 * Conséquence visible : SQLite ordonne par type avant d'ordonner par valeur
 * (NULL < INTEGER < TEXTE). Dans `ORDER BY updated_at DESC`, qui est le tri de
 * la liste des conversations, TOUTE ligne datée en texte passe devant TOUTE
 * ligne datée en entier, quelle que soit la date réelle — les conversations les
 * plus récentes se retrouvaient en bas de la liste.
 *
 * Ces tests verrouillent la règle : on ne lie jamais un objet Date, on écrit une
 * chaîne 'YYYY-MM-DD HH:MM:SS' compatible avec NOW().
 */

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');

let db;
const TAG = `ts-consistency-${process.pid}-${Date.now()}`;

beforeAll(async () => {
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

async function createUser() {
  const res = await db.query(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [`u-${Math.random().toString(36).slice(2)}-${TAG}@test.local`, 'x'.repeat(20)]
  );
  return res.insertId;
}

describe('le piège : lier un objet Date', () => {
  test('knex écrit un ENTIER quand on lie un Date, un TEXTE via NOW()', async () => {
    const userId = await createUser();

    // Écriture 1 — objet Date lié directement (ce que faisait le sync Gmail).
    const a = await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'date-liee', 'inquiry', 'gmail', ?)`,
      [userId, new Date('2026-08-01T10:00:00Z')]
    );
    // Écriture 2 — NOW(), traduit par la couche db.
    const b = await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'via-now', 'inquiry', 'gmail', NOW())`,
      [userId]
    );

    const [rowA] = await db.query('SELECT typeof(updated_at) AS t FROM conversations WHERE id = ?', [a.insertId]);
    const [rowB] = await db.query('SELECT typeof(updated_at) AS t FROM conversations WHERE id = ?', [b.insertId]);

    // C'est la démonstration du piège, pas un comportement souhaité : si un
    // jour knex cesse de convertir, ce test le signalera et la règle
    // ci-dessous restera de toute façon la bonne.
    expect(rowA.t).toBe('integer');
    expect(rowB.t).toBe('text');
  });

  test('SQLite classe le texte APRÈS les entiers, donc le tri est faussé', async () => {
    const userId = await createUser();

    // L'ancienne (mars) écrite en TEXTE, la récente (août) en entier :
    // exactement la situation observée en base.
    await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'ancienne-texte', 'inquiry', 'gmail', '2026-03-01 09:00:00')`,
      [userId]
    );
    await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'recente-entier', 'inquiry', 'gmail', ?)`,
      [userId, new Date('2026-08-01T10:00:00Z')]
    );

    const rows = await db.query(
      'SELECT title FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
      [userId]
    );
    // La plus ancienne remonte en tête : c'est le bug tel qu'il se voyait.
    expect(rows[0].title).toBe('ancienne-texte');
  });
});

describe('la règle : écrire une chaîne compatible NOW()', () => {
  // Même conversion que toSqlDateTime() dans gmailSyncService et nowIso() dans
  // outboundQueue.
  const toSqlDateTime = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

  test('la chaîne produite est du TEXTE, comme NOW()', async () => {
    const userId = await createUser();
    const res = await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'helper', 'inquiry', 'gmail', ?)`,
      [userId, toSqlDateTime(new Date('2026-08-01T10:00:00Z'))]
    );
    const [row] = await db.query(
      'SELECT updated_at, typeof(updated_at) AS t FROM conversations WHERE id = ?',
      [res.insertId]
    );
    expect(row.t).toBe('text');
    expect(row.updated_at).toBe('2026-08-01 10:00:00');
  });

  test('le tri redevient chronologique, y compris face à NOW()', async () => {
    const userId = await createUser();

    await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'ancienne', 'inquiry', 'gmail', ?)`,
      [userId, toSqlDateTime(new Date('2026-03-01T09:00:00Z'))]
    );
    await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'recente', 'inquiry', 'gmail', ?)`,
      [userId, toSqlDateTime(new Date('2026-08-01T10:00:00Z'))]
    );
    await db.query(
      `INSERT INTO conversations (user_id, title, booking_status, external_provider, updated_at)
       VALUES (?, 'maintenant', 'inquiry', 'gmail', NOW())`,
      [userId]
    );

    const rows = await db.query(
      'SELECT title FROM conversations WHERE user_id = ? ORDER BY updated_at DESC',
      [userId]
    );
    expect(rows.map((r) => r.title)).toEqual(['maintenant', 'recente', 'ancienne']);
  });

  test('la comparaison lexicographique de latestMsgDate reste chronologique', () => {
    // syncGmailThread garde le plus récent avec `msgDate > latestMsgDate`.
    // Le format 'YYYY-MM-DD HH:MM:SS' est zero-padded, donc l'ordre des
    // chaînes est l'ordre des dates — la comparaison reste valable après le
    // passage de Date à chaîne.
    const early = toSqlDateTime(new Date('2026-08-01T09:59:59Z'));
    const late = toSqlDateTime(new Date('2026-08-01T10:00:00Z'));
    const nextYear = toSqlDateTime(new Date('2027-01-01T00:00:00Z'));
    expect(late > early).toBe(true);
    expect(nextYear > late).toBe(true);
  });
});

describe('le service ne lie plus d\'objet Date sur created_at/updated_at', () => {
  test('gmailSyncService passe par toSqlDateTime', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'gmailSyncService.js'),
      'utf8'
    );
    expect(source).toMatch(/function toSqlDateTime/);
    // msgDate alimente messages.created_at ET conversations.updated_at.
    expect(source).toMatch(/const msgDate = toSqlDateTime\(/);
  });
});

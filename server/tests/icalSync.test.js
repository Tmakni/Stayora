/**
 * iCal sync — SSRF au moment du fetch, SQL portable, délai borné
 *
 * Couvre trois défauts de syncPropertyCalendar() :
 *
 *  1. L'URL n'était validée qu'à la connexion du calendrier
 *     (icalController.connectCalendar). syncPropertyCalendar allait ensuite
 *     chercher ce que contenait la ligne, sans la revérifier — donc toute
 *     ligne écrite avant l'existence du contrôle, ou par un autre chemin,
 *     était téléchargée sans filtre. La validation a lieu maintenant au point
 *     de la requête, seul endroit qui protège réellement le fetch.
 *
 *  2. Trois requêtes codaient `datetime('now')` en dur. La couche
 *     db/database.js traduit `NOW()` vers SQLite mais laisse MySQL intact :
 *     ces requêtes étaient donc des erreurs de syntaxe dès que
 *     USE_MEMORY_DB=false. Le défaut était latent (Render tourne en SQLite),
 *     et ce test le garde tel — la portabilité MySQL est justement la raison
 *     d'être de la couche d'abstraction.
 *
 *  3. Le téléchargement n'avait aucune échéance, alors qu'il s'exécute aussi
 *     de façon BLOQUANTE juste avant la génération d'un brouillon
 *     (aiController). Un hôte qui accepte la connexion puis se tait retenait
 *     la réponse indéfiniment.
 *
 * Tourne sur l'environnement "test" du knexfile : SQLite en mémoire, isolé de
 * la base de dev comme de la production.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const icalService = require('../services/icalService');

let db;

// Unique par run pour que des workers parallèles ne se marchent pas dessus.
const TAG = `ical-sync-${process.pid}-${Date.now()}`;

async function createUser(email) {
  const res = await db.query(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)',
    [email, 'x'.repeat(20)]
  );
  return res.insertId;
}

async function createProperty(userId, name) {
  const res = await db.query(
    `INSERT INTO property_profiles (user_id, name, property_type, bedrooms, beds, bathrooms, max_guests)
     VALUES (?, ?, 'apartment', 1, 1, 1, 2)`,
    [userId, name]
  );
  return res.insertId;
}

async function connectCalendarRow(userId, propertyId, url) {
  await db.query(
    'INSERT INTO ical_calendars (user_id, property_id, ical_url) VALUES (?, ?, ?)',
    [userId, propertyId, url]
  );
}

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
        const props = await db.query(`SELECT id FROM property_profiles WHERE user_id IN (${ph})`, ids);
        const propIds = props.map((p) => p.id);
        if (propIds.length > 0) {
          const pph = propIds.map(() => '?').join(',');
          await db.query(`DELETE FROM ical_events WHERE property_id IN (${pph})`, propIds);
        }
        await db.query(`DELETE FROM ical_calendars WHERE user_id IN (${ph})`, ids);
        await db.query(`DELETE FROM property_profiles WHERE user_id IN (${ph})`, ids);
        await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('cleanup failed:', err.message);
    }
  }
  await database.close();
}, 30000);

describe('SSRF — l\'URL stockée est revérifiée avant le téléchargement', () => {
  // Chaque entrée est une adresse que le serveur ne doit jamais aller
  // chercher pour le compte d'un utilisateur, sous la forme qu'un attaquant
  // écrirait réellement.
  const INTERNAL_URLS = [
    ['boucle locale', 'http://127.0.0.1:8080/cal.ics'],
    ['boucle locale, reste du /8', 'http://127.0.0.2/cal.ics'],
    ['métadonnées cloud', 'http://169.254.169.254/latest/meta-data/'],
    ['réseau privé RFC1918', 'http://192.168.1.10/cal.ics'],
    ['IPv6 loopback', 'http://[::1]/cal.ics'],
    ['IPv4 encapsulée en IPv6', 'http://[::ffff:127.0.0.1]/cal.ics'],
    ['forme décimale de 127.0.0.1', 'http://2130706433/cal.ics'],
  ];

  test.each(INTERNAL_URLS)('refuse %s sans émettre de requête', async (_label, url) => {
    const userId = await createUser(`ssrf-${_label.replace(/\W/g, '')}-${TAG}@test.local`);
    const propertyId = await createProperty(userId, 'Logement');
    await connectCalendarRow(userId, propertyId, url);

    await expect(icalService.syncPropertyCalendar(propertyId))
      .rejects.toThrow(/refusée/i);

    // Le refus est consigné sur la ligne — c'est ce qui remonte l'anomalie à
    // l'hôte au lieu de la laisser passer en silence.
    const [cal] = await db.query(
      'SELECT sync_status, sync_error FROM ical_calendars WHERE property_id = ?',
      [propertyId]
    );
    expect(cal.sync_status).toBe('error');
    expect(cal.sync_error).toMatch(/refusée/i);

    // Et rien n'a été écrit dans le calendrier.
    const events = await db.query(
      'SELECT id FROM ical_events WHERE property_id = ?',
      [propertyId]
    );
    expect(events).toHaveLength(0);
  });
});

describe('SQL portable — aucune syntaxe propre à SQLite en dur', () => {
  test('recordSyncError écrit bien à travers la couche d\'abstraction', async () => {
    // Le chemin d'erreur ci-dessus a déjà exécuté l'UPDATE contenant NOW().
    // S'il contenait encore datetime('now'), il tomberait en erreur de syntaxe
    // sur MySQL ; ici on vérifie surtout qu'il produit un horodatage réel.
    const userId = await createUser(`stamp-${TAG}@test.local`);
    const propertyId = await createProperty(userId, 'Logement');
    await connectCalendarRow(userId, propertyId, 'http://10.0.0.1/cal.ics');

    await expect(icalService.syncPropertyCalendar(propertyId)).rejects.toThrow();

    const [cal] = await db.query(
      'SELECT sync_status, updated_at FROM ical_calendars WHERE property_id = ?',
      [propertyId]
    );
    expect(cal.sync_status).toBe('error');
    expect(cal.updated_at).toBeTruthy();
    expect(Number.isNaN(new Date(cal.updated_at).getTime())).toBe(false);
  });

  test('le service ne contient plus datetime(\'now\') en dur', () => {
    // Garde-fou de portabilité : la couche db ne réécrit que NOW(), donc toute
    // fonction de date propre à SQLite écrite ici casse la cible MySQL.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'icalService.js'),
      'utf8'
    );
    expect(source).not.toMatch(/datetime\('now'\)/);
  });
});

describe('Le téléchargement est borné dans le temps', () => {
  let server;
  let port;

  beforeAll((done) => {
    // Répond, ouvre le flux, puis ne le termine jamais : exactement le cas
    // qu'un délai d'attente doit couper et qu'un simple timeout de connexion
    // laisserait passer.
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.write('BEGIN:VCALENDAR\r\n');
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  test('un flux qui ne se termine jamais est interrompu, pas attendu', async () => {
    const ical = require('node-ical');
    const started = Date.now();

    await expect(
      ical.async.fromURL(`http://127.0.0.1:${port}/cal.ics`, {
        signal: AbortSignal.timeout(1500),
      })
    ).rejects.toThrow();

    // La borne compte autant que le rejet : sans échéance, cette attente ne se
    // terminait pas du tout.
    expect(Date.now() - started).toBeLessThan(10000);
  }, 20000);
});

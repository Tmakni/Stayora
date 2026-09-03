/**
 * Les données d'un utilisateur survivent au redéploiement — ou l'application
 * refuse de démarrer.
 *
 * CE QUE CE FICHIER PROUVE
 * ------------------------
 * 1. Aucune migration ne détruit de données. Le scénario complet est rejoué sur
 *    un vrai fichier SQLite : créer un utilisateur, un logement rempli, une
 *    conversation, des messages → FERMER la base (c'est ce que fait un
 *    redéploiement au processus) → rouvrir le même fichier → rejouer
 *    `migrate.latest()` → tout doit être là, à l'identique.
 *
 * 2. Une base ÉPHÉMÈRE est reconnue comme telle, et refusée en production.
 *    C'est le vrai défaut : rien dans ce dépôt ne supprime de données (aucun
 *    DROP, TRUNCATE, seed rejoué ni réinitialisation au démarrage) — ce qui
 *    disparaissait, c'était le SUPPORT. render.yaml monte un disque persistant
 *    sur /data et pose SQLITE_DB_PATH ; ce fichier n'est lu que par Render.
 *    Ailleurs, knexfile.js retombe sur un chemin interne au conteneur, recréé
 *    vide à chaque déploiement — et l'application démarrait sans rien dire.
 *
 * 3. Aucun secret n'apparaît dans la description journalisée de la base.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const knexFactory = require('knex');

const {
  describeDatabaseTarget,
  assertPersistentStorage,
} = require('../config/persistence');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations', 'db');

// ────────────────────────────────────────────────────────────────────────────
describe('reconnaissance de la cible de stockage', () => {
  const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;

  afterEach(() => {
    if (ORIGINAL_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
  });

  it('MySQL est persistant, et son mot de passe n\'apparaît nulle part', () => {
    const target = describeDatabaseTarget({
      client: 'mysql2',
      connection: {
        host: 'mysql.exemple.net',
        user: 'michel',
        password: 'super-secret-a-ne-jamais-journaliser',
        database: 'michel_prod',
      },
    });

    expect(target.persistent).toBe(true);
    expect(target.engine).toBe('mysql');
    expect(target.location).toBe('mysql.exemple.net/michel_prod');
    expect(JSON.stringify(target)).not.toContain('super-secret');
  });

  it('DATABASE_URL est réduit à l\'hôte et au nom de base', () => {
    const target = describeDatabaseTarget({
      client: 'mysql2',
      connection: { uri: 'mysql://michel:motdepasse@db.exemple.net:3306/michel_prod' },
    });

    expect(target.persistent).toBe(true);
    expect(target.location).toBe('db.exemple.net/michel_prod');
    expect(JSON.stringify(target)).not.toContain('motdepasse');
  });

  it('SQLite en mémoire est éphémère', () => {
    const target = describeDatabaseTarget({ client: 'better-sqlite3', connection: ':memory:' });
    expect(target.persistent).toBe(false);
    expect(target.location).toBe(':memory:');
  });

  it('un fichier SQLite SANS SQLITE_DB_PATH est éphémère', () => {
    // C'est exactement la configuration obtenue en déployant ailleurs que sur
    // Render : le repli de knexfile.js pointe dans le conteneur.
    delete process.env.SQLITE_DB_PATH;
    const target = describeDatabaseTarget({
      client: 'better-sqlite3',
      connection: { filename: '/home/appuser/.local/share/airbnb-ai-agent/airbnb_ai_agent.db' },
    });
    expect(target.persistent).toBe(false);
    expect(target.reason).toMatch(/SQLITE_DB_PATH/);
  });

  it('un fichier SQLite AVEC SQLITE_DB_PATH est persistant', () => {
    process.env.SQLITE_DB_PATH = '/data/airbnb_ai_agent.db';
    const target = describeDatabaseTarget({
      client: 'better-sqlite3',
      connection: { filename: '/data/airbnb_ai_agent.db' },
    });
    expect(target.persistent).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('refus de démarrer sur une base éphémère en production', () => {
  const ORIGINAL_SQLITE_PATH = process.env.SQLITE_DB_PATH;
  const ORIGINAL_ALLOW = process.env.ALLOW_EPHEMERAL_DB;

  const EPHEMERAL = {
    client: 'better-sqlite3',
    connection: { filename: '/home/appuser/.local/share/airbnb-ai-agent/airbnb_ai_agent.db' },
  };

  beforeEach(() => {
    delete process.env.SQLITE_DB_PATH;
    delete process.env.ALLOW_EPHEMERAL_DB;
  });

  afterEach(() => {
    if (ORIGINAL_SQLITE_PATH === undefined) delete process.env.SQLITE_DB_PATH;
    else process.env.SQLITE_DB_PATH = ORIGINAL_SQLITE_PATH;
    if (ORIGINAL_ALLOW === undefined) delete process.env.ALLOW_EPHEMERAL_DB;
    else process.env.ALLOW_EPHEMERAL_DB = ORIGINAL_ALLOW;
  });

  it('échoue clairement plutôt que d\'accepter des inscriptions éphémères', () => {
    expect(() => assertPersistentStorage(EPHEMERAL, { isProd: true })).toThrow(/ÉPHÉMÈRE/);
    // Le message doit dire quoi faire, pas seulement que c'est cassé.
    try {
      assertPersistentStorage(EPHEMERAL, { isProd: true });
    } catch (err) {
      expect(err.message).toMatch(/SQLITE_DB_PATH/);
      expect(err.message).toMatch(/DB_HOST/);
      expect(err.stage).toBe('persistence');
    }
  });

  it('ne se rabat JAMAIS silencieusement sur une base en mémoire', () => {
    expect(() =>
      assertPersistentStorage({ client: 'better-sqlite3', connection: ':memory:' }, { isProd: true })
    ).toThrow(/ÉPHÉMÈRE/);
  });

  it('laisse passer une base persistante', () => {
    process.env.SQLITE_DB_PATH = '/data/airbnb_ai_agent.db';
    const target = assertPersistentStorage(
      { client: 'better-sqlite3', connection: { filename: '/data/airbnb_ai_agent.db' } },
      { isProd: true }
    );
    expect(target.persistent).toBe(true);
  });

  it('laisse passer MySQL', () => {
    const target = assertPersistentStorage(
      { client: 'mysql2', connection: { host: 'h', database: 'd', password: 'p' } },
      { isProd: true }
    );
    expect(target.persistent).toBe(true);
  });

  it('n\'entrave pas le développement local', () => {
    expect(() => assertPersistentStorage(EPHEMERAL, { isProd: false })).not.toThrow();
  });

  it('ALLOW_EPHEMERAL_DB=true reste possible pour un environnement jetable', () => {
    process.env.ALLOW_EPHEMERAL_DB = 'true';
    expect(() => assertPersistentStorage(EPHEMERAL, { isProd: true })).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('un redéploiement ne perd rien', () => {
  let dbFile;

  const makeKnex = () =>
    knexFactory({
      client: 'better-sqlite3',
      connection: { filename: dbFile },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
      migrations: { directory: MIGRATIONS_DIR, tableName: 'knex_migrations' },
    });

  beforeAll(() => {
    dbFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'michel-persist-')),
      'airbnb_ai_agent.db'
    );
  });

  afterAll(() => {
    try { fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }); } catch (_) {}
  });

  it('conserve compte, logement, champs, conversation et messages après un redémarrage et de nouvelles migrations', async () => {
    // ── Déploiement n°1 : migrations + données réelles ──────────────────────
    let db = makeKnex();
    await db.migrate.latest();

    const [userId] = await db('users').insert({
      email: 'persistance@example.test',
      password_hash: 'x'.repeat(20),
    });

    const [propertyId] = await db('property_profiles').insert({
      user_id: userId,
      name: 'Villa Persistante',
      property_type: 'house',
      bedrooms: 3,
      beds: 4,
      bathrooms: 2,
      max_guests: 6,
      address: '12 rue du Test',
      context_json: JSON.stringify({
        wifi_name: 'BOX-PERSIST',
        access_code: '4821',
        key_location: 'Boîte à clés',
        host_name: 'Delphine',
      }),
    });

    const [conversationId] = await db('conversations').insert({
      user_id: userId,
      title: 'Voyageur test',
      booking_status: 'inquiry',
      property_id: propertyId,
    });

    await db('messages').insert([
      { conversation_id: conversationId, role: 'incoming', content: 'Bonjour, le parking est-il inclus ?' },
      { conversation_id: conversationId, role: 'outgoing', content: 'Oui, il est inclus.' },
      { conversation_id: conversationId, role: 'incoming', content: 'Parfait, merci.' },
    ]);

    const migrationsAfterFirst = (await db('knex_migrations').select('name')).length;
    expect(migrationsAfterFirst).toBeGreaterThan(0);

    // ── Redéploiement : le processus s'arrête, le FICHIER reste ─────────────
    await db.destroy();

    db = makeKnex();
    const [, ranAgain] = await db.migrate.latest();
    // Une base à jour ne rejoue AUCUNE migration : c'est ce qui rend un
    // redéploiement non destructif par construction.
    expect(ranAgain).toEqual([]);
    expect((await db('knex_migrations').select('name')).length).toBe(migrationsAfterFirst);

    // ── Tout est là, à l'identique ─────────────────────────────────────────
    const users = await db('users').where({ email: 'persistance@example.test' });
    expect(users).toHaveLength(1);

    const properties = await db('property_profiles').where({ user_id: userId });
    expect(properties).toHaveLength(1);
    expect(properties[0].name).toBe('Villa Persistante');
    expect(properties[0].address).toBe('12 rue du Test');
    expect(properties[0].bedrooms).toBe(3);

    // Les champs libres du formulaire aussi — c'est là que vivent la plupart
    // des informations saisies par l'hôte.
    const ctx = JSON.parse(properties[0].context_json);
    expect(ctx.wifi_name).toBe('BOX-PERSIST');
    expect(ctx.access_code).toBe('4821');
    expect(ctx.key_location).toBe('Boîte à clés');
    expect(ctx.host_name).toBe('Delphine');

    const conversations = await db('conversations').where({ user_id: userId });
    expect(conversations).toHaveLength(1);

    const messages = await db('messages').where({ conversation_id: conversationId }).orderBy('id');
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.content)).toEqual([
      'Bonjour, le parking est-il inclus ?',
      'Oui, il est inclus.',
      'Parfait, merci.',
    ]);

    await db.destroy();
  }, 60000);
});

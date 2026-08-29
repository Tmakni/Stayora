require('dotenv').config();
const path = require('path');
const os   = require('os');

/**
 * Knex configuration — supporte SQLite (dev/test) et MySQL (production).
 *
 * Emplacement de la DB SQLite :
 *   - Linux/WSL : ~/.local/share/airbnb-ai-agent/airbnb_ai_agent.db
 *     (SQLite ne fonctionne pas sur NTFS via /mnt/c dans WSL)
 *   - Windows   : <projet>/data/airbnb_ai_agent.db
 *
 * En production: configurer les variables d'env DB_* pour MySQL cloud (ex: Render).
 * Si USE_MEMORY_DB=true, SQLite est utilisé même en production.
 */

// Chemin DB adapté à la plateforme
// SQLITE_DB_PATH env var prend la priorité (ex: /data sur Render avec disque persistant)
const DB_PATH = process.env.SQLITE_DB_PATH
  || (process.platform === 'linux'
    ? path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db')
    : path.join(__dirname, 'data', 'airbnb_ai_agent.db'));

const MIGRATIONS = {
  directory: path.join(__dirname, 'migrations', 'db'),
  tableName:  'knex_migrations'
};

const SQLITE_BASE = {
  client: 'better-sqlite3',
  useNullAsDefault: true,
  // better-sqlite3 is a synchronous, single-connection driver — a bigger
  // pool would not add concurrency and can cause "database is locked"
  // errors. This is correct as-is; do not change it. Real horizontal
  // scaling for write-heavy load requires the MySQL production path below.
  pool: { min: 1, max: 1 },
  migrations: MIGRATIONS
};

// MySQL pool size for the production path (USE_MEMORY_DB=false, DB_HOST set).
// Perf audit for a ~100-concurrent-user target: knex/mysql2 checks out a
// connection per query (not per request) and holds it only for the query's
// duration, so pool size tracks *simultaneously in-flight queries*, not
// concurrent users. max:10 undersizes this: a single dashboard page load
// alone fires several parallel queries (properties, conversations,
// reservations, sync logs...) via Promise.all-style controllers, and the
// webhook handler + 60s sync scheduler add further concurrent load on top
// of normal API traffic. max:15 gives ~50% more headroom for that kind of
// burst while staying well under the connection ceilings of typical
// managed MySQL tiers (Render/PlanetScale/Aiven free-to-mid tiers commonly
// cap total connections in the 20-60 range) — important since this pool
// is per Node process and there is currently no multi-instance scale-out.
// min stays at 2 (cheap to keep warm, no need to raise it).
const MYSQL_POOL = { min: 2, max: 15 };

/**
 * Construit la configuration MySQL pour la production.
 * Échoue immédiatement si les variables DB obligatoires sont absentes
 * (sauf si USE_MEMORY_DB=true).
 */
function buildProductionConfig() {
  // USE_MEMORY_DB=true → SQLite même en production (utile pour Render free tier)
  if (process.env.USE_MEMORY_DB === 'true') {
    return { ...SQLITE_BASE, connection: { filename: DB_PATH } };
  }

  // Valider les variables obligatoires — échoue tôt avec un message clair
  const required = ['DB_HOST', 'DB_USER', 'DB_NAME'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('');
    console.error('FATAL: Missing required database environment variables in production:');
    console.error(`  Missing: ${missing.join(', ')}`);
    console.error('');
    console.error('Set these variables in your Render dashboard > Environment.');
    console.error('To use SQLite instead, set USE_MEMORY_DB=true.');
    console.error('');
    process.exit(1);
  }

  const sslEnabled = process.env.DB_SSL === 'true' || process.env.DB_SSL === '1';

  // Support DATABASE_URL (ex: PlanetScale, Railway, etc.)
  if (process.env.DATABASE_URL) {
    return {
      client: 'mysql2',
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
      },
      pool: MYSQL_POOL,
      migrations: MIGRATIONS
    };
  }

  return {
    client: 'mysql2',
    connection: {
      host:     process.env.DB_HOST,
      port:     parseInt(process.env.DB_PORT, 10) || 3306,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME,
      charset:  'utf8mb4',
      // SSL requis pour la plupart des bases cloud (PlanetScale, Aiven, etc.)
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined
    },
    pool: MYSQL_POOL,
    migrations: MIGRATIONS
  };
}

module.exports = {

  // ─── Développement — SQLite (zéro configuration serveur) ──────────────────
  development: {
    ...SQLITE_BASE,
    connection: { filename: DB_PATH }
  },

  // ─── Test — SQLite en mémoire (isolation parfaite entre tests) ─────────────
  test: {
    ...SQLITE_BASE,
    connection: ':memory:'
  },

  // ─── Test MySQL — moteur réel, pour ce que SQLite ne peut pas prouver ──────
  //
  // SQLite et MySQL ne divergent pas sur les requêtes de cette application,
  // mais ils divergent sur ce qui nous intéresse le plus ici : le TYPAGE et les
  // CONTRAINTES. SQLite accepte une chaîne dans une colonne DATE, tolère un
  // dépassement de longueur, et applique les clés étrangères seulement si
  // PRAGMA foreign_keys est activé. MySQL refuse. Une contrainte vérifiée
  // uniquement sur SQLite n'est donc pas vérifiée.
  //
  // Activé par TEST_MYSQL_HOST. Sans cette variable, les tests concernés se
  // déclarent ignorés plutôt que de passer en silence — un test vert sur un
  // moteur absent serait pire que pas de test du tout.
  //
  //   docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=michel_test \
  //     -p 3307:3306 mysql:8
  //   TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=3307 TEST_MYSQL_USER=root \
  //     TEST_MYSQL_PASSWORD=root TEST_MYSQL_NAME=michel_test npx jest mysqlSchema
  mysqlTest: {
    client: 'mysql2',
    connection: {
      host:     process.env.TEST_MYSQL_HOST || '127.0.0.1',
      port:     parseInt(process.env.TEST_MYSQL_PORT, 10) || 3306,
      user:     process.env.TEST_MYSQL_USER || 'root',
      password: process.env.TEST_MYSQL_PASSWORD || '',
      database: process.env.TEST_MYSQL_NAME || 'michel_test',
      charset:  'utf8mb4',
      // Les dates malformées doivent ÉCHOUER, pas devenir '0000-00-00' :
      // c'est précisément ce que ces tests vérifient.
      dateStrings: true,
    },
    pool: { min: 1, max: 5 },
    migrations: MIGRATIONS
  },

  // ─── Production — MySQL cloud ou SQLite si USE_MEMORY_DB=true ──────────────
  production: buildProductionConfig()
};

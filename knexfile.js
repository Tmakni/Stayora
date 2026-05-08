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
  pool: { min: 1, max: 1 },
  migrations: MIGRATIONS
};

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
      pool: { min: 2, max: 10 },
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
    pool: { min: 2, max: 10 },
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

  // ─── Production — MySQL cloud ou SQLite si USE_MEMORY_DB=true ──────────────
  production: buildProductionConfig()
};

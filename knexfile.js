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
 * En production: configurer les variables d'env DB_* pour MySQL.
 */

// Chemin DB adapté à la plateforme
const DB_PATH = process.platform === 'linux'
  ? path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db')
  : path.join(__dirname, 'data', 'airbnb_ai_agent.db');

module.exports = {

  // ─── Développement — SQLite (zéro configuration serveur) ──────────────────
  // better-sqlite3 utilise des binaires pré-compilés — fonctionne sur Windows ET WSL
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: DB_PATH
    },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
    migrations: {
      directory: path.join(__dirname, 'migrations', 'db'),
      tableName:  'knex_migrations'
    }
  },

  // ─── Test — SQLite en mémoire (isolation parfaite entre tests) ─────────────
  test: {
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
    migrations: {
      directory: path.join(__dirname, 'migrations', 'db'),
      tableName:  'knex_migrations'
    }
  },

  // ─── Production — MySQL (scalable, pool de connexions) ─────────────────────
  production: {
    client: 'mysql2',
    connection: {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT) || 3306,
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'airbnb_ai_agent',
      charset:  'utf8mb4'
    },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: path.join(__dirname, 'migrations', 'db'),
      tableName:  'knex_migrations'
    }
  }
};

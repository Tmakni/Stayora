const logger = require('../utils/logger');

/**
 * Couche d'abstraction base de données.
 *
 * Utilise Knex.js comme framework ORM/query-builder.
 * - NODE_ENV=development (ou USE_MEMORY_DB=true) → SQLite persistant (fichier local)
 * - NODE_ENV=production                           → MySQL (configurer les vars DB_*)
 *
 * Toutes les tables sont créées automatiquement via knex migrate:latest
 * au premier démarrage — aucune configuration manuelle nécessaire.
 */

let db;

async function initDatabase() {
  db = require('../db/database');

  try {
    await db.testConnection();
    logger.info('Database ready (migrations applied)');
  } catch (error) {
    logger.error('Database initialization failed:', error.message);
    throw error;
  }

  return db;
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

module.exports = {
  initDatabase,
  getDatabase
};

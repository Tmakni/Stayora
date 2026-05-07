const logger = require('../utils/logger');

/**
 * Couche d'abstraction base de données.
 *
 * Utilise Knex.js comme framework ORM/query-builder.
 * - NODE_ENV=development (ou USE_MEMORY_DB=true) → SQLite persistant (fichier local)
 * - NODE_ENV=production + USE_MEMORY_DB=true     → SQLite (Render free tier / tests)
 * - NODE_ENV=production + USE_MEMORY_DB=false    → MySQL cloud (DB_HOST/DB_USER/DB_NAME requis)
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
    const isProd    = (process.env.NODE_ENV || 'development') === 'production';
    const useMemory = process.env.USE_MEMORY_DB === 'true';

    logger.error('Database initialization failed:', error.message);

    // Log non-sensitive diagnostics to help diagnose cloud DB issues
    if (isProd && !useMemory) {
      logger.error('--- DB connection diagnostics (no secrets logged) ---');
      logger.error(`  DB_HOST  : ${process.env.DB_HOST  ? 'set' : 'MISSING'}`);
      logger.error(`  DB_USER  : ${process.env.DB_USER  ? 'set' : 'MISSING'}`);
      logger.error(`  DB_NAME  : ${process.env.DB_NAME  ? 'set' : 'MISSING'}`);
      logger.error(`  DB_PORT  : ${process.env.DB_PORT  || '3306 (default)'}`);
      logger.error(`  DB_SSL   : ${process.env.DB_SSL === 'true' ? 'enabled' : 'disabled'}`);
      logger.error(`  DB_PASSWORD: ${process.env.DB_PASSWORD ? 'set' : 'MISSING'}`);
      logger.error('----------------------------------------------------');
    }

    const friendlyMessage = isProd && !useMemory
      ? `Database connection failed. Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME and DB_SSL settings in your Render environment variables. Original error: ${error.message}`
      : error.message;

    throw new Error(friendlyMessage);
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

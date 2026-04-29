/**
 * Knex-powered database adapter
 *
 * - Utilise Knex.js comme framework de base de données (SQLite en dev, MySQL en prod)
 * - Expose la même interface query(sql, params) pour la compatibilité avec les controllers
 * - Gère automatiquement les migrations au démarrage
 * - Convertit la syntaxe MySQL → SQLite si nécessaire (NOW(), TRUE/FALSE)
 */

const knex = require('knex');
const path = require('path');
const logger = require('../utils/logger');

let db;   // instance Knex (lazy init via initKnex)
let isSQLite = false;

/**
 * Crée et retourne l'instance Knex selon l'environnement.
 */
function initKnex() {
  if (db) return db;

  const env     = process.env.NODE_ENV || 'development';
  const config  = require('../../knexfile');
  const envConf = config[env] || config.development;

  isSQLite = envConf.client === 'sqlite3' || envConf.client === 'better-sqlite3';

  if (isSQLite) {
    // S'assure que le répertoire de la DB existe avant d'ouvrir le fichier
    if (typeof envConf.connection === 'object' && envConf.connection.filename) {
      const fs  = require('fs');
      const dir = path.dirname(envConf.connection.filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      logger.info(`SQLite database path: ${envConf.connection.filename}`);
    }
  }

  db = knex(envConf);
  return db;
}

/**
 * Retourne l'instance Knex brute pour les opérations avancées (optionnel).
 */
function getKnex() {
  return db || initKnex();
}

/**
 * Lance les migrations Knex — crée/met à jour toutes les tables.
 * Idempotent : ne recrée pas les tables déjà existantes.
 */
async function runMigrations() {
  const d = initKnex();
  try {
    const [batch, migrations] = await d.migrate.latest();
    if (migrations.length > 0) {
      logger.info(`DB migrations ran (batch ${batch}): ${migrations.join(', ')}`);
    } else {
      logger.info('DB migrations: already up to date');
    }
  } catch (err) {
    logger.error('Migration error:', err.message);
    throw err;
  }
}

/**
 * Adaptateur de compatibilité — même signature que l'ancien db.query().
 *
 * Supporte les requêtes SQL paramétrées avec `?` (MySQL-style).
 * Pour SQLite, convertit automatiquement :
 *   - NOW()  → datetime('now')
 *   - TRUE   → 1 / FALSE → 0
 *   - boolean params → 1 / 0
 */
async function query(sql, params = []) {
  const d = initKnex();
  let adaptedSql = sql;

  if (isSQLite) {
    adaptedSql = sql
      .replace(/\bNOW\(\)/gi,  "datetime('now')")
      .replace(/\bTRUE\b/gi,   '1')
      .replace(/\bFALSE\b/gi,  '0');
  }

  // Convertit les booléens JS en 0/1 pour SQLite
  const safeParams = isSQLite
    ? params.map(p => p === true ? 1 : p === false ? 0 : p)
    : params;

  const sqlTrimmed = adaptedSql.trim().toLowerCase();
  const isSelect = sqlTrimmed.startsWith('select') || sqlTrimmed.startsWith('with');
  const isInsert = sqlTrimmed.startsWith('insert');

  try {
    if (isSelect) {
      // SELECT — sqlite3 async retourne [rows, fields] via Knex raw
      const result = await d.raw(adaptedSql, safeParams);
      return normalizeSelect(result);
    }

    if (isInsert && isSQLite) {
      // sqlite3 async : raw() retourne [] pour les DML — on utilise
      // last_insert_rowid() juste après (safe car pool max=1)
      await d.raw(adaptedSql, safeParams);
      const meta = await d.raw('SELECT last_insert_rowid() as id, changes() as n');
      const row  = normalizeSelect(meta)[0] || {};
      return { insertId: row.id || 0, affectedRows: row.n || 0 };
    }

    if (isSQLite) {
      // UPDATE / DELETE sur sqlite3 async
      await d.raw(adaptedSql, safeParams);
      const meta = await d.raw('SELECT changes() as n');
      const row  = normalizeSelect(meta)[0] || {};
      return { affectedRows: row.n || 0 };
    }

    // MySQL — le résultat est dans result[0]
    const result = await d.raw(adaptedSql, safeParams);
    return normalizeMysql(result, isInsert);

  } catch (err) {
    logger.error(`DB query error: ${err.message}`, { sql: adaptedSql.slice(0, 200) });
    throw err;
  }
}

/**
 * Normalise le résultat Knex raw() vers le format attendu par les controllers.
 *
 * Controllers attendent :
 *   - SELECT  → tableau de lignes []
 *   - INSERT  → { insertId: number, affectedRows: number }
 *   - UPDATE/DELETE → { affectedRows: number }
 *
 * sqlite3 async (N-API) retourne via Knex raw() :
 *   - SELECT  : result[0] = tableau de rows
 *   - INSERT  : result.lastID  + result.changes
 *   - UPDATE  : result.changes
 * mysql2 retourne via Knex raw() :
 *   - SELECT  : result[0] = tableau de rows
 *   - INSERT  : result[0].insertId + result[0].affectedRows
 *   - UPDATE  : result[0].affectedRows
 */
// Normalise un résultat SELECT renvoyé par knex.raw() pour sqlite3 ou mysql2
function normalizeSelect(result) {
  // sqlite3 via Knex : renvoie [rows_array, fields_array]
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  // tableau direct de rows
  if (Array.isArray(result)) return result;
  // mysql2 : { rows: [...] }
  if (result && Array.isArray(result.rows)) return result.rows;
  // mysql2 knex raw : [rows, fields]
  if (result && Array.isArray(result[0])) return result[0];
  return [];
}

// Normalise un résultat DML (INSERT/UPDATE/DELETE) pour mysql2
function normalizeMysql(result, isInsert) {
  const r = Array.isArray(result) ? result[0] : result;
  if (!r) return isInsert ? { insertId: 0, affectedRows: 0 } : { affectedRows: 0 };
  if (isInsert) {
    return { insertId: r.insertId ?? 0, affectedRows: r.affectedRows ?? 0 };
  }
  return { affectedRows: r.affectedRows ?? 0 };
}

/**
 * Vérifie la connexion et lance les migrations.
 * Appelé au démarrage du serveur.
 */
async function testConnection() {
  const d = initKnex();
  // Ping minimal
  await d.raw('SELECT 1');

  // SQLite performance PRAGMAs — must run outside migration transactions
  if (isSQLite) {
    try {
      await d.raw('PRAGMA journal_mode = WAL');
      await d.raw('PRAGMA cache_size = -20000');    // ~20 MB cache
      await d.raw('PRAGMA synchronous = NORMAL');   // safe + fast
      await d.raw('PRAGMA temp_store = MEMORY');
      logger.info('SQLite PRAGMAs applied (WAL, cache 20MB, sync NORMAL)');
    } catch (err) {
      logger.warn('Could not set SQLite PRAGMAs:', err.message);
    }
  }

  // Crée / met à jour toutes les tables
  await runMigrations();
  return true;
}

async function close() {
  if (db) {
    await db.destroy();
    db = null;
    logger.info('Database connection closed');
  }
}

module.exports = {
  query,
  testConnection,
  close,
  getKnex        // accès direct au client Knex pour les opérations avancées
};

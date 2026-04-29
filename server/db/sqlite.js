// Persistent SQLite database — replaces in-memory fallback
// Data survives server restarts and user logouts

const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'airbnb_ai_agent.db');

let db;

function getDb() {
  if (!db) {
    // Ensure data directory exists
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -20000');       // 20MB cache
    db.pragma('synchronous = NORMAL');      // Faster writes (safe with WAL)
    db.pragma('temp_store = MEMORY');       // Temp tables in RAM
    db.pragma('mmap_size = 268435456');     // 256MB memory-mapped I/O
  }
  return db;
}

function initTables() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS property_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      property_type TEXT NOT NULL,
      bedrooms INTEGER NOT NULL,
      beds INTEGER NOT NULL,
      bathrooms INTEGER NOT NULL,
      max_guests INTEGER NOT NULL,
      has_wifi INTEGER DEFAULT 0,
      has_kitchen INTEGER DEFAULT 0,
      has_parking INTEGER DEFAULT 0,
      has_pool INTEGER DEFAULT 0,
      has_gym INTEGER DEFAULT 0,
      has_tv INTEGER DEFAULT 0,
      has_washing_machine INTEGER DEFAULT 0,
      has_air_conditioning INTEGER DEFAULT 0,
      has_heating INTEGER DEFAULT 0,
      has_workspace INTEGER DEFAULT 0,
      has_hair_dryer INTEGER DEFAULT 0,
      has_iron INTEGER DEFAULT 0,
      has_bathtub INTEGER DEFAULT 0,
      has_dryer INTEGER DEFAULT 0,
      has_dishwasher INTEGER DEFAULT 0,
      has_microwave INTEGER DEFAULT 0,
      has_refrigerator INTEGER DEFAULT 0,
      has_coffee_maker INTEGER DEFAULT 0,
      has_smoke_detector INTEGER DEFAULT 0,
      has_carbon_monoxide_detector INTEGER DEFAULT 0,
      has_fire_extinguisher INTEGER DEFAULT 0,
      has_first_aid_kit INTEGER DEFAULT 0,
      has_bbq INTEGER DEFAULT 0,
      has_terrace INTEGER DEFAULT 0,
      has_garden INTEGER DEFAULT 0,
      has_netflix INTEGER DEFAULT 0,
      has_fireplace INTEGER DEFAULT 0,
      allows_pets INTEGER DEFAULT 0,
      allows_smoking INTEGER DEFAULT 0,
      allows_events INTEGER DEFAULT 0,
      address TEXT,
      description TEXT,
      house_rules TEXT,
      auto_reply_enabled INTEGER DEFAULT 0,
      reply_tone TEXT DEFAULT 'professional',
      superhot_listing_id TEXT DEFAULT NULL,
      context_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS airbnb_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      airbnb_email TEXT NOT NULL,
      access_token_enc TEXT DEFAULT NULL,
      refresh_token_enc TEXT DEFAULT NULL,
      token_expires_at TEXT DEFAULT NULL,
      airbnb_user_id TEXT DEFAULT NULL,
      display_name TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      last_sync_at TEXT DEFAULT NULL,
      sync_status TEXT DEFAULT 'idle',
      sync_error TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, airbnb_email)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      property_id INTEGER DEFAULT NULL,
      airbnb_account_id INTEGER DEFAULT NULL,
      airbnb_reservation_id TEXT DEFAULT NULL UNIQUE,
      airbnb_listing_id TEXT DEFAULT NULL,
      confirmation_code TEXT DEFAULT NULL,
      guest_name TEXT DEFAULT NULL,
      guest_email TEXT DEFAULT NULL,
      guest_phone TEXT DEFAULT NULL,
      guest_photo_url TEXT DEFAULT NULL,
      number_of_guests INTEGER DEFAULT 1,
      check_in_date TEXT NOT NULL,
      check_out_date TEXT NOT NULL,
      booked_at TEXT DEFAULT NULL,
      total_price REAL DEFAULT NULL,
      currency TEXT DEFAULT 'EUR',
      host_payout REAL DEFAULT NULL,
      status TEXT DEFAULT 'pending',
      previous_status TEXT DEFAULT NULL,
      status_changed_at TEXT DEFAULT NULL,
      conversation_id INTEGER DEFAULT NULL,
      airbnb_raw_json TEXT DEFAULT NULL,
      last_synced_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (airbnb_account_id) REFERENCES airbnb_accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      booking_status TEXT DEFAULT 'inquiry',
      property_id INTEGER,
      reservation_id INTEGER DEFAULT NULL,
      airbnb_thread_id TEXT DEFAULT NULL,
      external_id TEXT DEFAULT NULL,
      external_provider TEXT DEFAULT NULL,
      guest_name TEXT DEFAULT NULL,
      guest_language TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS airbnb_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      airbnb_account_id INTEGER NOT NULL,
      airbnb_thread_id TEXT NOT NULL,
      reservation_id INTEGER DEFAULT NULL,
      conversation_id INTEGER DEFAULT NULL,
      guest_name TEXT DEFAULT NULL,
      guest_airbnb_id TEXT DEFAULT NULL,
      listing_name TEXT DEFAULT NULL,
      airbnb_listing_id TEXT DEFAULT NULL,
      last_message_at TEXT DEFAULT NULL,
      unread_count INTEGER DEFAULT 0,
      last_synced_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (airbnb_account_id) REFERENCES airbnb_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
      UNIQUE(airbnb_account_id, airbnb_thread_id)
    );

    CREATE TABLE IF NOT EXISTS user_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'superhot',
      api_key_enc TEXT DEFAULT NULL,
      webhook_secret TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, provider)
    );

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT NULL,
      provider TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed INTEGER DEFAULT 0,
      conversation_id INTEGER DEFAULT NULL,
      auto_replied INTEGER DEFAULT 0,
      error_message TEXT DEFAULT NULL,
      received_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      airbnb_account_id INTEGER DEFAULT NULL,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL,
      items_synced INTEGER DEFAULT 0,
      error_message TEXT DEFAULT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER DEFAULT NULL,
      action TEXT NOT NULL,
      entity_type TEXT DEFAULT NULL,
      entity_id INTEGER DEFAULT NULL,
      ip_address TEXT DEFAULT NULL,
      user_agent TEXT DEFAULT NULL,
      details TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS availability_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT DEFAULT 'reserved',
      guest_name TEXT DEFAULT NULL,
      source TEXT DEFAULT 'manual',
      reservation_id INTEGER DEFAULT NULL,
      notes TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ical_calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      property_id INTEGER NOT NULL,
      ical_url TEXT NOT NULL,
      last_synced_at TEXT DEFAULT NULL,
      sync_status TEXT DEFAULT 'pending',
      sync_error TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ical_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER NOT NULL,
      event_uid TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT DEFAULT 'confirmed',
      summary TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE CASCADE
    );
  `);

  // Create indexes (IF NOT EXISTS is not supported for indexes in some SQLite versions)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
    'CREATE INDEX IF NOT EXISTS idx_pp_user_id ON property_profiles(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_aa_user_id ON airbnb_accounts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_res_user_id ON reservations(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status)',
    'CREATE INDEX IF NOT EXISTS idx_res_checkin ON reservations(check_in_date)',
    'CREATE INDEX IF NOT EXISTS idx_conv_user_id ON conversations(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_conv_resa ON conversations(reservation_id)',
    'CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversations(airbnb_thread_id)',
    'CREATE INDEX IF NOT EXISTS idx_msg_conv_id ON messages(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_at_user_id ON airbnb_threads(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_wl_received ON webhook_logs(received_at)',
    'CREATE INDEX IF NOT EXISTS idx_sl_user_id ON sync_logs(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_al_user_id ON audit_logs(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_al_action ON audit_logs(action)',
    'CREATE INDEX IF NOT EXISTS idx_al_created ON audit_logs(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_ab_property ON availability_blocks(property_id)',
    'CREATE INDEX IF NOT EXISTS idx_ab_dates ON availability_blocks(start_date, end_date)',
    'CREATE INDEX IF NOT EXISTS idx_ical_cal_property ON ical_calendars(property_id)',
    'CREATE INDEX IF NOT EXISTS idx_ical_cal_user ON ical_calendars(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_ical_ev_property ON ical_events(property_id)',
    'CREATE INDEX IF NOT EXISTS idx_ical_ev_uid ON ical_events(event_uid)',
    'CREATE INDEX IF NOT EXISTS idx_ical_ev_dates ON ical_events(start_date, end_date)',
    // Composite indexes for heavy JOIN queries
    'CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_msg_conv_role ON messages(conversation_id, role)',
    'CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_conv_property ON conversations(property_id)',
    'CREATE INDEX IF NOT EXISTS idx_conv_external ON conversations(external_id)',
    'CREATE INDEX IF NOT EXISTS idx_gmail_acc_user ON gmail_accounts(user_id, is_active)',
    'CREATE INDEX IF NOT EXISTS idx_gmail_threads_acc ON gmail_threads(gmail_account_id, gmail_thread_id)',
    'CREATE INDEX IF NOT EXISTS idx_res_airbnb_id ON reservations(airbnb_reservation_id)',
  ];
  for (const idx of indexes) {
    d.exec(idx);
  }

  logger.info('SQLite tables and indexes initialized');
}

/**
 * MySQL-compatible query adapter for SQLite.
 * Translates MySQL SQL to SQLite equivalents and returns results
 * in the same format the rest of the app expects (arrays for SELECT, objects for INSERT/UPDATE/DELETE).
 * Uses a prepared statement cache for repeated queries (10x faster for hot paths).
 */
const stmtCache = new Map();
const STMT_CACHE_MAX = 500;

function getPrepared(d, sql) {
  let stmt = stmtCache.get(sql);
  if (stmt) return stmt;
  stmt = d.prepare(sql);
  if (stmtCache.size >= STMT_CACHE_MAX) {
    // Evict oldest entry
    const firstKey = stmtCache.keys().next().value;
    stmtCache.delete(firstKey);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}

async function query(sql, params = []) {
  const d = getDb();

  // Normalize MySQL-isms to SQLite
  let adaptedSql = sql
    // NOW() → datetime('now')
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    // TRUE/FALSE literals → 1/0
    .replace(/\bTRUE\b/gi, '1')
    .replace(/\bFALSE\b/gi, '0')
    // ON DUPLICATE KEY UPDATE → not used in the codebase but just in case
    .replace(/ON DUPLICATE KEY UPDATE[\s\S]*$/i, '');

  // Convert boolean params: true/false → 1/0
  const safeParams = params.map(p => {
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });

  const sqlLower = adaptedSql.toLowerCase().trim();

  try {
    if (sqlLower.startsWith('select') || sqlLower.startsWith('with')) {
      const stmt = getPrepared(d, adaptedSql);
      return stmt.all(...safeParams);
    } else if (sqlLower.startsWith('insert')) {
      const stmt = getPrepared(d, adaptedSql);
      const info = stmt.run(...safeParams);
      return { insertId: info.lastInsertRowid, affectedRows: info.changes };
    } else if (sqlLower.startsWith('update') || sqlLower.startsWith('delete')) {
      const stmt = getPrepared(d, adaptedSql);
      const info = stmt.run(...safeParams);
      return { affectedRows: info.changes };
    } else {
      // DDL or other
      d.exec(adaptedSql);
      return { affectedRows: 0 };
    }
  } catch (err) {
    logger.error(`SQLite query error: ${err.message}`, { sql: adaptedSql, params: safeParams });
    throw err;
  }
}

async function testConnection() {
  const d = getDb();
  d.prepare('SELECT 1').get();
  initTables();
  return true;
}

async function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  query,
  testConnection,
  close
};

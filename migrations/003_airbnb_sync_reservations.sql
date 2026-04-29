-- Migration 003: Airbnb sync, reservations, and credential storage
-- Run: mysql -u root -p airbnb_ai_agent < migrations/003_airbnb_sync_reservations.sql

USE airbnb_ai_agent;

-- ============================================================
-- 1. Airbnb account credentials (encrypted) per user
-- ============================================================
CREATE TABLE IF NOT EXISTS airbnb_accounts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  airbnb_email     VARCHAR(255) NOT NULL,
  -- Tokens are AES-256-GCM encrypted at app level before storage
  access_token_enc TEXT DEFAULT NULL,
  refresh_token_enc TEXT DEFAULT NULL,
  token_expires_at TIMESTAMP NULL DEFAULT NULL,
  airbnb_user_id   VARCHAR(100) DEFAULT NULL,
  display_name     VARCHAR(255) DEFAULT NULL,
  is_active        BOOLEAN DEFAULT TRUE,
  last_sync_at     TIMESTAMP NULL DEFAULT NULL,
  sync_status      ENUM('idle','syncing','error') DEFAULT 'idle',
  sync_error       TEXT DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_airbnb_email (user_id, airbnb_email),
  INDEX idx_user_id (user_id),
  INDEX idx_airbnb_user_id (airbnb_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. Reservations table — synced from Airbnb
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  property_id         INT DEFAULT NULL,
  airbnb_account_id   INT DEFAULT NULL,
  -- Airbnb IDs
  airbnb_reservation_id VARCHAR(100) DEFAULT NULL,
  airbnb_listing_id   VARCHAR(100) DEFAULT NULL,
  confirmation_code   VARCHAR(50) DEFAULT NULL,
  -- Guest info
  guest_name          VARCHAR(255) DEFAULT NULL,
  guest_email         VARCHAR(255) DEFAULT NULL,
  guest_phone         VARCHAR(100) DEFAULT NULL,
  guest_photo_url     TEXT DEFAULT NULL,
  number_of_guests    INT DEFAULT 1,
  -- Dates
  check_in_date       DATE NOT NULL,
  check_out_date      DATE NOT NULL,
  booked_at           TIMESTAMP NULL DEFAULT NULL,
  -- Pricing
  total_price         DECIMAL(10,2) DEFAULT NULL,
  currency            VARCHAR(10) DEFAULT 'EUR',
  host_payout         DECIMAL(10,2) DEFAULT NULL,
  -- Status — mirrors Airbnb statuses
  status              ENUM('pending','accepted','confirmed','checkedin','checkedout','cancelled','denied','expired') DEFAULT 'pending',
  previous_status     VARCHAR(50) DEFAULT NULL,
  status_changed_at   TIMESTAMP NULL DEFAULT NULL,
  -- Link to conversation thread
  conversation_id     INT DEFAULT NULL,
  -- Sync metadata
  airbnb_raw_json     MEDIUMTEXT DEFAULT NULL,
  last_synced_at      TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (airbnb_account_id) REFERENCES airbnb_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  UNIQUE KEY uq_airbnb_reservation (airbnb_reservation_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_check_in (check_in_date),
  INDEX idx_property (property_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. Airbnb message threads — synced from Airbnb inbox
-- ============================================================
CREATE TABLE IF NOT EXISTS airbnb_threads (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  airbnb_account_id   INT NOT NULL,
  airbnb_thread_id    VARCHAR(100) NOT NULL,
  reservation_id      INT DEFAULT NULL,
  conversation_id     INT DEFAULT NULL,
  guest_name          VARCHAR(255) DEFAULT NULL,
  guest_airbnb_id     VARCHAR(100) DEFAULT NULL,
  listing_name        VARCHAR(255) DEFAULT NULL,
  airbnb_listing_id   VARCHAR(100) DEFAULT NULL,
  last_message_at     TIMESTAMP NULL DEFAULT NULL,
  unread_count        INT DEFAULT 0,
  last_synced_at      TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (airbnb_account_id) REFERENCES airbnb_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  UNIQUE KEY uq_thread (airbnb_account_id, airbnb_thread_id),
  INDEX idx_user_id (user_id),
  INDEX idx_last_message (last_message_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. Sync log — track every sync operation
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  user_id           INT NOT NULL,
  airbnb_account_id INT DEFAULT NULL,
  sync_type         ENUM('messages','reservations','full') NOT NULL,
  status            ENUM('started','completed','failed') NOT NULL,
  items_synced      INT DEFAULT 0,
  error_message     TEXT DEFAULT NULL,
  started_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at      TIMESTAMP NULL DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. Add reservation_id link to conversations
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reservation_id INT DEFAULT NULL AFTER property_id,
  ADD COLUMN IF NOT EXISTS airbnb_thread_id VARCHAR(100) DEFAULT NULL AFTER reservation_id;

ALTER TABLE conversations
  ADD INDEX IF NOT EXISTS idx_reservation_id (reservation_id),
  ADD INDEX IF NOT EXISTS idx_airbnb_thread_id (airbnb_thread_id);

-- ============================================================
-- 6. Audit trail for security
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT DEFAULT NULL,
  action      VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) DEFAULT NULL,
  entity_id   INT DEFAULT NULL,
  ip_address  VARCHAR(45) DEFAULT NULL,
  user_agent  TEXT DEFAULT NULL,
  details     TEXT DEFAULT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_action (action),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

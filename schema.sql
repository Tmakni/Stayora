-- Schema MySQL pour Airbnb AI Agent MVP

CREATE DATABASE IF NOT EXISTS airbnb_ai_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE airbnb_ai_agent;

-- Table utilisateurs
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table profils de propriétés
CREATE TABLE IF NOT EXISTS property_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  property_type VARCHAR(100) NOT NULL,
  bedrooms INT NOT NULL,
  beds INT NOT NULL,
  bathrooms INT NOT NULL,
  max_guests INT NOT NULL,
  
  -- Équipements (amenities)
  has_wifi BOOLEAN DEFAULT FALSE,
  has_kitchen BOOLEAN DEFAULT FALSE,
  has_parking BOOLEAN DEFAULT FALSE,
  has_pool BOOLEAN DEFAULT FALSE,
  has_gym BOOLEAN DEFAULT FALSE,
  has_tv BOOLEAN DEFAULT FALSE,
  has_washing_machine BOOLEAN DEFAULT FALSE,
  has_air_conditioning BOOLEAN DEFAULT FALSE,
  has_heating BOOLEAN DEFAULT FALSE,
  has_workspace BOOLEAN DEFAULT FALSE,
  has_hair_dryer BOOLEAN DEFAULT FALSE,
  has_iron BOOLEAN DEFAULT FALSE,
  has_bathtub BOOLEAN DEFAULT FALSE,
  has_dryer BOOLEAN DEFAULT FALSE,
  has_dishwasher BOOLEAN DEFAULT FALSE,
  has_microwave BOOLEAN DEFAULT FALSE,
  has_refrigerator BOOLEAN DEFAULT FALSE,
  has_coffee_maker BOOLEAN DEFAULT FALSE,
  has_smoke_detector BOOLEAN DEFAULT FALSE,
  has_carbon_monoxide_detector BOOLEAN DEFAULT FALSE,
  has_fire_extinguisher BOOLEAN DEFAULT FALSE,
  has_first_aid_kit BOOLEAN DEFAULT FALSE,
  has_bbq BOOLEAN DEFAULT FALSE,
  has_terrace BOOLEAN DEFAULT FALSE,
  has_garden BOOLEAN DEFAULT FALSE,
  has_netflix BOOLEAN DEFAULT FALSE,
  has_fireplace BOOLEAN DEFAULT FALSE,
  
  -- Règles de la maison
  allows_pets BOOLEAN DEFAULT FALSE,
  allows_smoking BOOLEAN DEFAULT FALSE,
  allows_events BOOLEAN DEFAULT FALSE,
  
  -- Informations supplémentaires
  address TEXT,
  description TEXT,
  house_rules TEXT,
  
  -- Auto-reply & integration
  auto_reply_enabled BOOLEAN DEFAULT FALSE,
  reply_tone VARCHAR(50) DEFAULT 'professional',
  superhot_listing_id VARCHAR(255) DEFAULT NULL,
  
  -- Contexte IA (JSON avec toutes les infos pratiques)
  context_json TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Comptes Airbnb liés (credentials chiffrés AES-256-GCM)
CREATE TABLE IF NOT EXISTS airbnb_accounts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  airbnb_email     VARCHAR(255) NOT NULL,
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
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Réservations (synchronisées depuis Airbnb)
CREATE TABLE IF NOT EXISTS reservations (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  property_id         INT DEFAULT NULL,
  airbnb_account_id   INT DEFAULT NULL,
  airbnb_reservation_id VARCHAR(100) DEFAULT NULL,
  airbnb_listing_id   VARCHAR(100) DEFAULT NULL,
  confirmation_code   VARCHAR(50) DEFAULT NULL,
  guest_name          VARCHAR(255) DEFAULT NULL,
  guest_email         VARCHAR(255) DEFAULT NULL,
  guest_phone         VARCHAR(100) DEFAULT NULL,
  guest_photo_url     TEXT DEFAULT NULL,
  number_of_guests    INT DEFAULT 1,
  check_in_date       DATE NOT NULL,
  check_out_date      DATE NOT NULL,
  booked_at           TIMESTAMP NULL DEFAULT NULL,
  total_price         DECIMAL(10,2) DEFAULT NULL,
  currency            VARCHAR(10) DEFAULT 'EUR',
  host_payout         DECIMAL(10,2) DEFAULT NULL,
  status              ENUM('pending','accepted','confirmed','checkedin','checkedout','cancelled','denied','expired') DEFAULT 'pending',
  previous_status     VARCHAR(50) DEFAULT NULL,
  status_changed_at   TIMESTAMP NULL DEFAULT NULL,
  conversation_id     INT DEFAULT NULL,
  airbnb_raw_json     MEDIUMTEXT DEFAULT NULL,
  last_synced_at      TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (airbnb_account_id) REFERENCES airbnb_accounts(id) ON DELETE SET NULL,
  UNIQUE KEY uq_airbnb_reservation (airbnb_reservation_id),
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_check_in (check_in_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table conversations
CREATE TABLE IF NOT EXISTS conversations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  booking_status ENUM('inquiry', 'request', 'confirmed', 'checkedin', 'checkedout') DEFAULT 'inquiry',
  property_id INT,
  reservation_id INT DEFAULT NULL,
  airbnb_thread_id VARCHAR(100) DEFAULT NULL,
  external_id VARCHAR(255) DEFAULT NULL,
  external_provider VARCHAR(50) DEFAULT NULL,
  guest_name VARCHAR(255) DEFAULT NULL,
  guest_language VARCHAR(10) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES property_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at),
  INDEX idx_reservation_id (reservation_id),
  INDEX idx_airbnb_thread_id (airbnb_thread_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table messages
CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  role ENUM('incoming', 'outgoing', 'system') NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_conversation_id (conversation_id),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Threads Airbnb (mapping vers conversations internes)
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
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Intégrations externes (Superhot, etc.)

-- Comptes Gmail liés (credentials chiffrés AES-256-GCM)
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  email            VARCHAR(255) NOT NULL,
  access_token_enc TEXT DEFAULT NULL,
  refresh_token_enc TEXT DEFAULT NULL,
  token_expires_at TIMESTAMP NULL DEFAULT NULL,
  is_active        BOOLEAN DEFAULT TRUE,
  last_sync_at     TIMESTAMP NULL DEFAULT NULL,
  sync_status      ENUM('idle','syncing','error') DEFAULT 'idle',
  sync_error       TEXT DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_gmail_email (user_id, email),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Threads Gmail (mapping vers conversations internes)
CREATE TABLE IF NOT EXISTS gmail_threads (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  gmail_account_id    INT NOT NULL,
  gmail_thread_id     VARCHAR(100) NOT NULL,
  conversation_id     INT DEFAULT NULL,
  sender_email        VARCHAR(255) DEFAULT NULL,
  sender_name         VARCHAR(255) DEFAULT NULL,
  subject             VARCHAR(500) DEFAULT NULL,
  last_message_at     TIMESTAMP NULL DEFAULT NULL,
  last_synced_at      TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gmail_account_id) REFERENCES gmail_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  UNIQUE KEY uq_gmail_thread (gmail_account_id, gmail_thread_id),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_integrations (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  provider         VARCHAR(50) NOT NULL DEFAULT 'superhot',
  api_key_enc      TEXT DEFAULT NULL,
  webhook_secret   VARCHAR(255) DEFAULT NULL,
  is_active        BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_provider (user_id, provider),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Logs webhook (audit)
CREATE TABLE IF NOT EXISTS webhook_logs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT DEFAULT NULL,
  provider        VARCHAR(50) NOT NULL,
  payload_json    MEDIUMTEXT NOT NULL,
  processed       BOOLEAN DEFAULT FALSE,
  conversation_id INT DEFAULT NULL,
  auto_replied    BOOLEAN DEFAULT FALSE,
  error_message   TEXT DEFAULT NULL,
  received_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Logs de synchronisation
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
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Logs d'audit (sécurité)
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

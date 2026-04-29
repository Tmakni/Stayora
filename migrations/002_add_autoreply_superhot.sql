-- Migration 002: Auto-reply settings + Superhot webhook support
-- Run: mysql -u root -p airbnb_ai_agent < migrations/002_add_autoreply_superhot.sql

USE airbnb_ai_agent;

-- Add auto-reply & tone fields to property_profiles
ALTER TABLE property_profiles
  ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT FALSE AFTER house_rules,
  ADD COLUMN IF NOT EXISTS reply_tone         VARCHAR(50) DEFAULT 'professional' AFTER auto_reply_enabled,
  ADD COLUMN IF NOT EXISTS superhot_listing_id VARCHAR(255) DEFAULT NULL AFTER reply_tone;

-- Add Superhot configuration per user account
CREATE TABLE IF NOT EXISTS user_integrations (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  provider         VARCHAR(50) NOT NULL DEFAULT 'superhot',  -- 'superhot', 'hostaway', etc.
  api_key_enc      TEXT DEFAULT NULL,     -- encrypted API key (AES-256)
  webhook_secret   VARCHAR(255) DEFAULT NULL,
  is_active        BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_provider (user_id, provider),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to log all incoming webhooks (audit + debug)
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
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  INDEX idx_received_at (received_at),
  INDEX idx_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add superhot_conversation_id to conversations (to link back to Superhot thread)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS external_id       VARCHAR(255) DEFAULT NULL AFTER property_id,
  ADD COLUMN IF NOT EXISTS external_provider VARCHAR(50)  DEFAULT NULL AFTER external_id,
  ADD COLUMN IF NOT EXISTS guest_name        VARCHAR(255) DEFAULT NULL AFTER external_provider,
  ADD COLUMN IF NOT EXISTS guest_language    VARCHAR(10)  DEFAULT NULL AFTER guest_name,
  ADD INDEX IF NOT EXISTS idx_external_id (external_id);

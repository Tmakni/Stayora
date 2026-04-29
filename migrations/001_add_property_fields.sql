-- Migration: Ajouter les champs détaillés pour les propriétés
-- Date: 2026-02-20
-- Description: Extension de la table property_profiles avec des champs détaillés pour les équipements et règles

USE airbnb_ai_agent;

-- Vérifier si les colonnes existent déjà avant de les ajouter
ALTER TABLE property_profiles
  ADD COLUMN IF NOT EXISTS property_type VARCHAR(100) NOT NULL DEFAULT 'apartment' AFTER name,
  ADD COLUMN IF NOT EXISTS bedrooms INT NOT NULL DEFAULT 1 AFTER property_type,
  ADD COLUMN IF NOT EXISTS beds INT NOT NULL DEFAULT 1 AFTER bedrooms,
  ADD COLUMN IF NOT EXISTS bathrooms INT NOT NULL DEFAULT 1 AFTER beds,
  ADD COLUMN IF NOT EXISTS max_guests INT NOT NULL DEFAULT 2 AFTER bathrooms,
  
  -- Équipements
  ADD COLUMN IF NOT EXISTS has_wifi BOOLEAN DEFAULT FALSE AFTER max_guests,
  ADD COLUMN IF NOT EXISTS has_kitchen BOOLEAN DEFAULT FALSE AFTER has_wifi,
  ADD COLUMN IF NOT EXISTS has_parking BOOLEAN DEFAULT FALSE AFTER has_kitchen,
  ADD COLUMN IF NOT EXISTS has_pool BOOLEAN DEFAULT FALSE AFTER has_parking,
  ADD COLUMN IF NOT EXISTS has_gym BOOLEAN DEFAULT FALSE AFTER has_pool,
  ADD COLUMN IF NOT EXISTS has_tv BOOLEAN DEFAULT FALSE AFTER has_gym,
  ADD COLUMN IF NOT EXISTS has_washing_machine BOOLEAN DEFAULT FALSE AFTER has_tv,
  ADD COLUMN IF NOT EXISTS has_air_conditioning BOOLEAN DEFAULT FALSE AFTER has_washing_machine,
  ADD COLUMN IF NOT EXISTS has_heating BOOLEAN DEFAULT FALSE AFTER has_air_conditioning,
  ADD COLUMN IF NOT EXISTS has_workspace BOOLEAN DEFAULT FALSE AFTER has_heating,
  ADD COLUMN IF NOT EXISTS has_hair_dryer BOOLEAN DEFAULT FALSE AFTER has_workspace,
  ADD COLUMN IF NOT EXISTS has_iron BOOLEAN DEFAULT FALSE AFTER has_hair_dryer,
  
  -- Règles
  ADD COLUMN IF NOT EXISTS allows_pets BOOLEAN DEFAULT FALSE AFTER has_iron,
  ADD COLUMN IF NOT EXISTS allows_smoking BOOLEAN DEFAULT FALSE AFTER allows_pets,
  ADD COLUMN IF NOT EXISTS allows_events BOOLEAN DEFAULT FALSE AFTER allows_smoking,
  
  -- Informations supplémentaires
  ADD COLUMN IF NOT EXISTS address TEXT AFTER allows_events,
  ADD COLUMN IF NOT EXISTS description TEXT AFTER address,
  ADD COLUMN IF NOT EXISTS house_rules TEXT AFTER description,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER context_json;

-- Modifier la colonne context_json pour qu'elle puisse être NULL
ALTER TABLE property_profiles
  MODIFY COLUMN context_json TEXT NULL;

-- Message de confirmation
SELECT 'Migration 001 completed successfully' AS status;

/**
 * Migration 009 — Corrige property_profiles : colonne airbnb_listing_id manquante
 *
 * Migration 008 tentait de créer un index sur (user_id, airbnb_listing_id) sans
 * jamais avoir ajouté la colonne à property_profiles (seule superhot_listing_id
 * existait) — l'erreur était avalée par un try/catch, donc getProperties/
 * createProperty (qui lisent/écrivent airbnb_listing_id) échouaient en 500.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('property_profiles', 'airbnb_listing_id');
  if (!hasColumn) {
    await knex.schema.table('property_profiles', (t) => {
      t.string('airbnb_listing_id', 100).nullable();
    });
  }

  try {
    await knex.schema.table('property_profiles', (t) => {
      t.index(['user_id', 'airbnb_listing_id'], 'idx_pp_user_airbnb_listing');
    });
  } catch (_) {
    // Index déjà présent sur certains environnements — on ignore
  }
};

exports.down = async function (knex) {
  await knex.schema.table('property_profiles', (t) => {
    t.dropIndex(['user_id', 'airbnb_listing_id'], 'idx_pp_user_airbnb_listing');
    t.dropColumn('airbnb_listing_id');
  });
};

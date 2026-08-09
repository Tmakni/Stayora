/**
 * Migration 015 — Provenance du nom de logement
 *
 * property_profiles.name_source distingue :
 *   'airbnb_auto' — nom extrait automatiquement de l'annonce
 *   'manual'      — nom saisi ou confirmé par l'utilisateur
 *
 * Sans cette distinction, une nouvelle analyse Airbnb ne pouvait pas corriger
 * les noms automatiques erronés (« Logement Airbnb #11739290151 ») sans risquer
 * d'écraser un nom que l'utilisateur avait renommé lui-même.
 *
 * Le backfill est volontairement conservateur : seules les lignes qui portent
 * ENCORE un nom manifestement automatique sont marquées 'airbnb_auto'. Tout le
 * reste est considéré comme 'manual' et donc protégé — en cas de doute on
 * préserve le choix de l'utilisateur plutôt que de risquer de l'écraser.
 *
 * Idempotent : suit le motif hasColumn / try-catch des migrations 008 à 013.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('property_profiles', 'name_source');
  if (!hasColumn) {
    await knex.schema.table('property_profiles', (t) => {
      t.string('name_source', 24).notNullable().defaultTo('manual');
    });
  }

  // Marque comme automatiques les noms du type « Logement Airbnb #123456 »,
  // « Logement #123 » ou un identifiant nu — ce sont les seuls que le re-scan
  // a le droit de corriger.
  await knex('property_profiles')
    .where('name', 'like', 'Logement Airbnb #%')
    .orWhere('name', 'like', 'Logement #%')
    .update({ name_source: 'airbnb_auto' });

  try {
    await knex.schema.alterTable('property_profiles', (t) => {
      t.index(['user_id', 'airbnb_listing_id'], 'idx_pp_user_listing');
    });
  } catch (_) {
    // Index déjà présent sur certains environnements — on ignore
  }
};

exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('property_profiles', (t) => {
      t.dropIndex(['user_id', 'airbnb_listing_id'], 'idx_pp_user_listing');
    });
  } catch (_) {}

  try {
    if (await knex.schema.hasColumn('property_profiles', 'name_source')) {
      await knex.schema.table('property_profiles', (t) => t.dropColumn('name_source'));
    }
  } catch (_) {}
};

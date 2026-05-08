/**
 * Migration 008 — Photos des logements + colonnes import Airbnb
 *
 * - Ajoute property_photos : table des photos liées à un logement
 * - Ajoute sur property_profiles : source, source_url, city, country,
 *   rating, review_count, main_photo_url
 * - Ajoute un index unique (user_id, airbnb_listing_id) pour anti-doublon
 */

exports.up = async function (knex) {

  // ── Nouvelles colonnes sur property_profiles ──────────────────────────────
  await knex.schema.table('property_profiles', (t) => {
    t.string('source', 50).nullable().defaultTo('manual');       // 'airbnb' | 'manual'
    t.string('source_url', 512).nullable();                       // URL d'origine
    t.string('city', 255).nullable();
    t.string('country', 100).nullable();
    t.float('rating').nullable();
    t.integer('review_count').nullable().defaultTo(0);
    t.string('main_photo_url', 1024).nullable();
  });

  // Index unique pour empêcher les doublons (même user, même annonce Airbnb)
  // Compatible SQLite et MySQL
  try {
    await knex.schema.table('property_profiles', (t) => {
      t.index(['user_id', 'airbnb_listing_id'], 'idx_pp_user_airbnb_listing');
    });
  } catch (_) {
    // L'index peut déjà exister sur certains environnements — on ignore
  }

  // ── Table property_photos ─────────────────────────────────────────────────
  await knex.schema.createTable('property_photos', (t) => {
    t.increments('id').primary();

    t.integer('property_id').unsigned().notNullable()
      .references('id').inTable('property_profiles').onDelete('CASCADE');
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('source', 50).nullable().defaultTo('airbnb');  // 'airbnb' | 'manual' | 'upload'
    t.string('source_url', 1024).nullable();                 // URL Airbnb d'origine
    t.string('image_url', 1024).notNullable();               // URL utilisée pour l'affichage
    t.string('local_path', 512).nullable();                  // chemin local si téléchargé
    t.integer('position').notNullable().defaultTo(0);        // ordre d'affichage
    t.string('alt', 512).nullable();                         // texte alternatif
    t.boolean('is_main').notNullable().defaultTo(false);     // photo principale

    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['property_id', 'user_id'], 'idx_photos_prop_user');
    t.index(['user_id'], 'idx_photos_user');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('property_photos');
  await knex.schema.table('property_profiles', (t) => {
    t.dropColumn('source');
    t.dropColumn('source_url');
    t.dropColumn('city');
    t.dropColumn('country');
    t.dropColumn('rating');
    t.dropColumn('review_count');
    t.dropColumn('main_photo_url');
  });
};

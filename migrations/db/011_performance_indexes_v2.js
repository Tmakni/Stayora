/**
 * Migration 011 — Performance indexes v2
 *
 * (Originally authored as 010_performance_indexes_v2.js — renumbered to 011
 * because 010_password_reset_tokens.js was added concurrently by another
 * change and claimed the 010 slot first.)
 *
 * Perf audit (target: ~100 concurrent users) found two hot-path columns
 * that are queried but not indexed:
 *
 * 1. conversations(external_id, external_provider)
 *    Migration 004's header comment claimed this was already added
 *    ("Index on conversations.external_provider for filtered queries"),
 *    but the actual code in 004 only created idx_conv_user_updated
 *    (user_id, updated_at) — the external_id/external_provider index was
 *    never created. This pair is looked up on every inbound webhook
 *    (see webhookController.handleSuperhot):
 *      SELECT id, user_id FROM conversations
 *      WHERE external_id = ? AND external_provider = 'superhot' LIMIT 1
 *    Without an index this is a full table scan per webhook call.
 *
 * 2. reservations.property_id
 *    Has a FK reference to property_profiles but no explicit index.
 *    SQLite (unlike MySQL/InnoDB) does NOT auto-index FK columns, so on
 *    the dev/default SQLite backend this is a full table scan. Queried in
 *    propertyController.getCalendar / checkAvailability and in
 *    syncController.getReservations (?property_id= filter):
 *      SELECT ... FROM reservations WHERE property_id = ? AND ...
 *
 * Follows the hasColumn/try-catch-around-index-creation idempotency
 * pattern used in 008_property_photos.js / 009_add_airbnb_listing_id_to_property_profiles.js
 * so this migration is safe to re-run and safe on environments where an
 * equivalent index may already have been created by hand.
 */

exports.up = async function (knex) {
  // ── conversations(external_id, external_provider) ──────────────────────
  const convHasExternalId = await knex.schema.hasColumn('conversations', 'external_id');
  const convHasExternalProvider = await knex.schema.hasColumn('conversations', 'external_provider');
  if (convHasExternalId && convHasExternalProvider) {
    try {
      await knex.schema.alterTable('conversations', (t) => {
        t.index(['external_id', 'external_provider'], 'idx_conv_external');
      });
    } catch (_) {
      // Index déjà présent sur certains environnements — on ignore
    }
  }

  // ── reservations.property_id ────────────────────────────────────────────
  const resHasPropertyId = await knex.schema.hasColumn('reservations', 'property_id');
  if (resHasPropertyId) {
    try {
      await knex.schema.alterTable('reservations', (t) => {
        t.index('property_id', 'idx_res_property');
      });
    } catch (_) {
      // Index déjà présent sur certains environnements — on ignore
    }
  }
};

exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('conversations', (t) => {
      t.dropIndex(['external_id', 'external_provider'], 'idx_conv_external');
    });
  } catch (_) {}

  try {
    await knex.schema.alterTable('reservations', (t) => {
      t.dropIndex('property_id', 'idx_res_property');
    });
  } catch (_) {}
};

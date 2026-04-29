/**
 * Migration 004 — Optimize database performance
 *
 * - Composite index on messages for faster sync deduplication
 * - Index on conversations.external_provider for filtered queries
 * - WAL mode for SQLite (massive read/write concurrency improvement)
 * - Increase SQLite cache size
 */
exports.up = async function (knex) {
  // NOTE: SQLite PRAGMAs (WAL, cache_size, synchronous) are set in
  // server/db/database.js after Knex init — they cannot run inside
  // Knex migration transactions.

  // Composite index: speeds up the dedup query in syncThreadMessages
  // (SELECT metadata_json FROM messages WHERE conversation_id = ? AND metadata_json IS NOT NULL)
  const msgIdxExists = await knex.schema.hasColumn('messages', 'conversation_id');
  if (msgIdxExists) {
    await knex.schema.alterTable('messages', (t) => {
      t.index(['conversation_id', 'created_at'], 'idx_msg_conv_created');
    });
  }

  // Faster conversation list filtering
  const convHasExtProv = await knex.schema.hasColumn('conversations', 'external_provider');
  if (convHasExtProv) {
    await knex.schema.alterTable('conversations', (t) => {
      t.index(['user_id', 'updated_at'], 'idx_conv_user_updated');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.dropIndex(['conversation_id', 'created_at'], 'idx_msg_conv_created');
  });
  await knex.schema.alterTable('conversations', (t) => {
    t.dropIndex(['user_id', 'updated_at'], 'idx_conv_user_updated');
  });
};

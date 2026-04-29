/**
 * Migration 003 — Performance indexes
 *
 * Adds indexes for frequently used queries:
 * - conversations.updated_at for ORDER BY in listing
 * - gmail_threads.sender_email for purge filtering
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('conversations', (t) => {
    t.index('updated_at');
  });
  await knex.schema.alterTable('gmail_threads', (t) => {
    t.index('sender_email');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('conversations', (t) => {
    t.dropIndex('updated_at');
  });
  await knex.schema.alterTable('gmail_threads', (t) => {
    t.dropIndex('sender_email');
  });
};

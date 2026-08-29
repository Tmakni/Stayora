/**
 * Migration 007 — Property Q&A knowledge base
 *
 * Stores past guest-question / host-answer pairs per property so the AI
 * can use them as examples when generating replies for future guests.
 *
 * IMPORTANT — user_id / property_id are UNSIGNED.
 * The referenced columns (users.id, property_profiles.id) are declared with
 * t.increments() in 001, which MySQL renders as `int unsigned`. MySQL requires
 * a foreign key and its target to have strictly identical types, sign
 * included, and rejects a signed `int` with errno 150. SQLite does not enforce
 * that, so the mismatch stayed invisible in development while breaking every
 * MySQL deploy.
 */

const TABLE = 'property_qa';

exports.up = async function (knex) {
  if (await knex.schema.hasTable(TABLE)) {
    // The table is already there, yet this migration is running again: an
    // earlier run created it and then failed before the constraints were in
    // place. MySQL auto-commits DDL, so that CREATE TABLE survived the
    // rollback while the knex_migrations row did not — leaving 007 to be
    // replayed on every deploy. Finish the job rather than recreate anything.
    await completeInterruptedTable(knex);
    return;
  }

  await knex.schema.createTable(TABLE, (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable();
    t.integer('property_id').unsigned().notNullable();
    t.text('question').notNullable();
    t.text('answer').notNullable();
    // 'host_reply'  = confirmed by host (most reliable)
    // 'ai_reply'    = AI-generated reply that was sent
    t.string('source', 20).defaultTo('host_reply');
    // The conversation this pair came from (for deduplication & audit)
    t.integer('conversation_id').nullable();
    t.integer('incoming_message_id').nullable();
    t.integer('outgoing_message_id').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.foreign('user_id').references('users.id').onDelete('CASCADE');
    t.foreign('property_id').references('property_profiles.id').onDelete('CASCADE');
    t.index(['property_id']);
    t.index(['user_id']);
  });
};

/**
 * Brings an existing property_qa up to the definition above, adding only what
 * is missing. Nothing is dropped, no row is read or written.
 *
 * The foreign keys matter beyond referential tidiness: deleteAccount() in
 * server/controllers/authController.js deletes the user row and relies on
 * ON DELETE CASCADE to remove that user's Q&A pairs. Without them the guest
 * questions and answers would outlive the deleted account.
 */
async function completeInterruptedTable(knex) {
  // Only MySQL can reach this state. On SQLite the table exists only if 007
  // ran to completion, and SQLite cannot add a constraint after the fact.
  if (knex.client.dialect !== 'mysql') return;

  const [columns] = await knex.raw(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [TABLE]
  );
  const columnType = new Map(
    columns.map((c) => [c.COLUMN_NAME, String(c.COLUMN_TYPE).toLowerCase()])
  );

  // A foreign key cannot be added while the column is still signed. Widening
  // an always-positive id column from INT to INT UNSIGNED rewrites no value.
  for (const column of ['user_id', 'property_id']) {
    const type = columnType.get(column);
    if (type && !type.includes('unsigned')) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.integer(column).unsigned().notNullable().alter();
      });
    }
  }

  const [indexes] = await knex.raw('SHOW INDEX FROM ??', [TABLE]);
  const indexNames = new Set(indexes.map((r) => r.Key_name));
  for (const column of ['property_id', 'user_id']) {
    if (!indexNames.has(`${TABLE}_${column}_index`)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.index([column]);
      });
    }
  }

  const [constraints] = await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [TABLE]
  );
  const constraintNames = new Set(constraints.map((r) => r.CONSTRAINT_NAME));

  for (const [column, target] of [
    ['user_id', 'users.id'],
    ['property_id', 'property_profiles.id'],
  ]) {
    if (!constraintNames.has(`${TABLE}_${column}_foreign`)) {
      await knex.schema.alterTable(TABLE, (t) => {
        t.foreign(column).references(target).onDelete('CASCADE');
      });
    }
  }
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists(TABLE);
};

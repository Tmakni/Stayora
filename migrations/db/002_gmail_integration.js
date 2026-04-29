/**
 * Migration 002 — Gmail integration tables
 *
 * Adds gmail_accounts and gmail_threads to mirror the Airbnb sync pattern.
 */
exports.up = async function (knex) {

  // ── gmail_accounts ────────────────────────────────────────────────────────
  await knex.schema.createTable('gmail_accounts', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 255).notNullable();
    t.text('access_token_enc').nullable();
    t.text('refresh_token_enc').nullable();
    t.timestamp('token_expires_at').nullable();
    t.boolean('is_active').defaultTo(true);
    t.timestamp('last_sync_at').nullable();
    t.string('sync_status', 20).defaultTo('idle');   // idle | syncing | error
    t.text('sync_error').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['user_id', 'email']);
    t.index('user_id');
  });

  // ── gmail_threads ─────────────────────────────────────────────────────────
  await knex.schema.createTable('gmail_threads', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');
    t.integer('gmail_account_id').unsigned().notNullable()
      .references('id').inTable('gmail_accounts').onDelete('CASCADE');
    t.string('gmail_thread_id', 100).notNullable();
    t.integer('conversation_id').unsigned().nullable()
      .references('id').inTable('conversations').onDelete('SET NULL');
    t.string('sender_email', 255).nullable();
    t.string('sender_name', 255).nullable();
    t.string('subject', 500).nullable();
    t.timestamp('last_message_at').nullable();
    t.timestamp('last_synced_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.unique(['gmail_account_id', 'gmail_thread_id']);
    t.index('user_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('gmail_threads');
  await knex.schema.dropTableIfExists('gmail_accounts');
};

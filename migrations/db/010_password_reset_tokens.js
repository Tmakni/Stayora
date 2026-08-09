/**
 * Migration 010 — password_reset_tokens
 *
 * Support de la fonctionnalité "mot de passe oublié" : un token à usage
 * unique, à durée de vie courte, est généré côté serveur et envoyé par
 * email. Seul le hash SHA-256 du token est stocké — une lecture de la
 * base seule ne permet jamais de récupérer un token exploitable.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('password_reset_tokens', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable()
      .references('id').inTable('users').onDelete('CASCADE');

    t.string('token_hash', 64).notNullable(); // sha256 hex digest
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at').nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('token_hash', 'idx_prt_token_hash');
    t.index('user_id', 'idx_prt_user_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('password_reset_tokens');
};

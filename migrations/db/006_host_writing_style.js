/**
 * Migration 006 — Host writing style
 *
 * Adds columns to the users table to store the analyzed host writing style.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.text('host_writing_style').nullable();
    t.timestamp('style_analyzed_at').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('host_writing_style');
    t.dropColumn('style_analyzed_at');
  });
};

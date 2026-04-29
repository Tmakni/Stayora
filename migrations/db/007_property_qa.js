/**
 * Migration 007 — Property Q&A knowledge base
 *
 * Stores past guest-question / host-answer pairs per property so the AI
 * can use them as examples when generating replies for future guests.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('property_qa', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable();
    t.integer('property_id').notNullable();
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

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('property_qa');
};

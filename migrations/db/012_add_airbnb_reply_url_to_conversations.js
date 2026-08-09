/**
 * Migration 012 — Corrige conversations : colonne airbnb_reply_url manquante
 *
 * conversationController.js's getConversation() has always SELECTed
 * airbnb_reply_url from conversations, and gmailSyncService.js reads/writes
 * it — but the column was only ever added ad-hoc via migrate-add-reply-url.sh
 * (a raw ALTER TABLE run by hand against the live dev DB), never through a
 * tracked knex migration. Any other environment (fresh install, CI, the
 * Windows-side dev DB, production) is missing it entirely, so GET
 * /api/conversations/:id 500s unconditionally for every caller, including
 * the conversation's own owner.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('conversations', 'airbnb_reply_url');
  if (!hasColumn) {
    await knex.schema.table('conversations', (t) => {
      t.string('airbnb_reply_url', 1024).nullable();
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.table('conversations', (t) => {
    t.dropColumn('airbnb_reply_url');
  });
};

/**
 * Cleanup script: delete all gmail_sync messages (bad content),
 * reset sync timestamp, so next sync re-fetches everything with fixed extraction.
 */
require('dotenv').config();
const knex = require('knex')(require('./knexfile')['development']);

(async () => {
  try {
    // 1. Delete all messages from gmail_sync (they have bad content)
    const deleted = await knex('messages')
      .whereRaw("metadata_json LIKE '%gmail_sync%'")
      .del();
    console.log(`Deleted ${deleted} gmail_sync messages`);

    // 2. Delete gmail_threads so they get re-created on next sync
    const deletedThreads = await knex('gmail_threads').del();
    console.log(`Deleted ${deletedThreads} gmail_threads`);

    // 3. Delete orphan conversations (those with no remaining messages)
    const orphans = await knex('conversations')
      .leftJoin('messages', 'conversations.id', 'messages.conversation_id')
      .whereNull('messages.id')
      .select('conversations.id');
    if (orphans.length > 0) {
      const orphanIds = orphans.map(o => o.id);
      const deletedConvs = await knex('conversations').whereIn('id', orphanIds).del();
      console.log(`Deleted ${deletedConvs} orphan conversations`);
    } else {
      console.log('No orphan conversations to delete');
    }

    // 4. Reset last_sync_at so next sync fetches all messages
    const updated = await knex('gmail_accounts').update({
      last_sync_at: null,
      sync_status: 'idle',
      sync_error: null
    });
    console.log(`Reset ${updated} gmail account(s) sync timestamp`);

    console.log('\nDone! Trigger a new sync to re-fetch messages with fixed extraction.');
  } catch (err) {
    console.error('Error:', err.message);
  }
  await knex.destroy();
  process.exit(0);
})();

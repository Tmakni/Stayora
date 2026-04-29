/**
 * Force full resync: reset last_sync_at, delete bad messages, and trigger sync
 * all in one process (avoids scheduler overwriting our reset).
 */
require('dotenv').config();

(async () => {
  try {
    // Init DB the same way the server does
    const { initDatabase, getDatabase } = require('./server/config/db');
    await initDatabase();
    const db = getDatabase();

    // 1. Delete all gmail_sync messages
    const delResult = await db.query(
      "DELETE FROM messages WHERE metadata_json LIKE '%gmail_sync%'"
    );
    console.log('Deleted messages:', delResult);

    // 2. Delete gmail_threads
    const delThreads = await db.query('DELETE FROM gmail_threads');
    console.log('Deleted threads:', delThreads);

    // 3. Delete orphan conversations (no remaining messages)
    const orphans = await db.query(`
      SELECT c.id FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE m.id IS NULL
    `);
    if (orphans.length > 0) {
      const ids = orphans.map(o => o.id);
      for (const id of ids) {
        await db.query('DELETE FROM conversations WHERE id = ?', [id]);
      }
      console.log('Deleted', ids.length, 'orphan conversations');
    }

    // 4. Reset last_sync_at to NULL
    await db.query("UPDATE gmail_accounts SET last_sync_at = NULL, sync_status = 'idle', sync_error = NULL");
    const acc = await db.query('SELECT id, user_id, email, last_sync_at, sync_status FROM gmail_accounts WHERE is_active = TRUE');
    console.log('Gmail accounts after reset:', JSON.stringify(acc));

    // 5. Trigger full sync
    const gmailSync = require('./server/services/gmailSyncService');
    for (const account of acc) {
      console.log(`\nSyncing account ${account.id} (user ${account.user_id})...`);
      const result = await gmailSync.fetchMessages(account.user_id, account.id);
      console.log('Sync result:', JSON.stringify(result));
    }

    // 6. Check results
    const msgs = await db.query(
      "SELECT id, conversation_id, role, content FROM messages WHERE metadata_json LIKE '%gmail_sync%'"
    );
    console.log(`\nRe-synced ${msgs.length} messages:`);
    msgs.forEach(m => {
      console.log(`  id=${m.id} conv=${m.conversation_id} role=${m.role} content=${JSON.stringify(m.content.substring(0, 150))}`);
    });

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  }
  process.exit(0);
})();

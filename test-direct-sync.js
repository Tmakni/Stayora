/**
 * Direct sync test — bypasses server, calls fetchMessages directly with logging.
 */
require('dotenv').config();
const { initDatabase, getDatabase } = require('./server/config/db');

(async () => {
  try {
    // Initialize DB properly (same as server does)
    const db = await initDatabase();
    console.log('DB initialized');
    
    // Check current state
    const accs = await db.query('SELECT id, email, last_sync_at, sync_status, user_id FROM gmail_accounts WHERE id = 1');
    const acc = accs[0];
    console.log('Account:', JSON.stringify(acc));

    // Reset
    await db.query('UPDATE gmail_accounts SET last_sync_at = NULL, sync_status = ?, sync_error = NULL WHERE id = 1', ['idle']);
    console.log('Reset done');

    // Now try to call fetchMessages
    const gmailSync = require('./server/services/gmailSyncService');
    console.log('Calling fetchMessages...');
    const result = await gmailSync.fetchMessages(acc.user_id, acc.id);
    console.log('fetchMessages result:', JSON.stringify(result));

    // Check results
    const convs = await db.query("SELECT * FROM conversations WHERE external_provider = 'gmail'");
    console.log(`\nGmail conversations: ${convs.length}`);
    for (const c of convs) {
      const msgs = await db.query('SELECT * FROM messages WHERE conversation_id = ?', [c.id]);
      console.log(`  id=${c.id} title="${c.title}" guest="${c.guest_name}" msgs=${msgs.length}`);
      for (const m of msgs.slice(0, 2)) {
        console.log(`    [${m.role}] ${m.content.substring(0, 80)}...`);
      }
    }

    const threads = await db.query('SELECT * FROM gmail_threads');
    console.log(`\nGmail threads: ${threads.length}`);
    for (const t of threads) {
      console.log(`  thread=${t.gmail_thread_id} conv=${t.conversation_id} name="${t.sender_name}" email=${t.sender_email}`);
    }

  } catch (err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  } finally {
    process.exit(0);
  }
})();

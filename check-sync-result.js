require('dotenv').config();
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig['development']);

(async () => {
  // Check Gmail conversations
  const convs = await knex('conversations').where('external_provider', 'gmail');
  console.log('Gmail conversations:', convs.length);
  for (const c of convs) {
    console.log(`  id=${c.id} title="${c.title}" guest="${c.guest_name}"`);
    const msgs = await knex('messages').where('conversation_id', c.id);
    console.log(`    messages: ${msgs.length}`);
    for (const m of msgs.slice(0, 2)) {
      console.log(`    [${m.role}] ${m.content.substring(0, 100)}...`);
    }
  }

  // Check Gmail threads
  const threads = await knex('gmail_threads');
  console.log('\nGmail threads:', threads.length);
  for (const t of threads) {
    console.log(`  thread=${t.gmail_thread_id} conv=${t.conversation_id} name=${t.sender_name} subj=${t.subject}`);
  }

  // Check sync_logs
  const logs = await knex('sync_logs').orderBy('id', 'desc').limit(5);
  console.log('\nRecent sync logs:');
  for (const l of logs) {
    console.log(`  id=${l.id} type=${l.sync_type} status=${l.status} items=${l.items_synced} error=${l.error_message || 'none'}`);
  }

  // Check account status
  const acc = await knex('gmail_accounts').first();
  console.log('\nAccount status:', JSON.stringify({ 
    sync_status: acc.sync_status, 
    sync_error: acc.sync_error, 
    last_sync_at: acc.last_sync_at 
  }));

  await knex.destroy();
  process.exit(0);
})();

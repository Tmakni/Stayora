require('dotenv').config();
const knex = require('knex')(require('./knexfile')['development']);

(async () => {
  try {
    const msgs = await knex('messages')
      .whereRaw("metadata_json LIKE '%gmail_sync%'")
      .select('id', 'conversation_id', 'role', 'content');
    console.log('Gmail-synced messages:', msgs.length);
    msgs.forEach(m => {
      console.log(`  id=${m.id} conv=${m.conversation_id} role=${m.role} content=${JSON.stringify(m.content.substring(0, 120))}`);
    });

    const threads = await knex('gmail_threads').select('id', 'conversation_id', 'gmail_thread_id', 'subject');
    console.log('\nGmail threads:', threads.length);
    threads.forEach(t => {
      console.log(`  id=${t.id} conv=${t.conversation_id} subj=${JSON.stringify((t.subject || '').substring(0, 80))}`);
    });

    const accs = await knex('gmail_accounts').select('id', 'email', 'last_sync_at', 'sync_status');
    console.log('\nGmail accounts:', JSON.stringify(accs, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
  await knex.destroy();
  process.exit(0);
})();

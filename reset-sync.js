require('dotenv').config();
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig['development']);

(async () => {
  // Reset last_sync_at so next sync fetches all messages
  await knex('gmail_accounts').where('id', 1).update({ 
    last_sync_at: null, 
    sync_status: 'idle', 
    sync_error: null 
  });
  const acc = await knex('gmail_accounts').where('id', 1).first();
  console.log('Reset done:', JSON.stringify({ 
    id: acc.id, email: acc.email, 
    last_sync_at: acc.last_sync_at, 
    sync_status: acc.sync_status 
  }));
  await knex.destroy();
  process.exit(0);
})();

#!/bin/bash
source ~/.nvm/nvm.sh
nvm use 20
cd /mnt/c/home/tom/airbnb-ai-agent
node -e "
const knex = require('knex')(require('./knexfile')['development']);
(async () => {
  const accs = await knex('gmail_accounts').select('id','user_id','email','is_active','last_sync_at','sync_status');
  console.log('Gmail accounts:', JSON.stringify(accs, null, 2));
  const users = await knex('users').select('id','email','username');
  console.log('Users:', JSON.stringify(users, null, 2));
  const msgs = await knex('messages').whereRaw(\"metadata_json LIKE '%gmail_sync%'\").select('id','conversation_id','role','content');
  console.log('Current gmail messages:', msgs.length);
  if (msgs.length > 0) {
    msgs.forEach(m => console.log('  id=' + m.id + ' role=' + m.role + ' content=' + JSON.stringify(m.content.substring(0,120))));
  }
  await knex.destroy();
})();
"

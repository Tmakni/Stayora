#!/usr/bin/env node
require('dotenv').config();
const knex = require('knex');
const path = require('path');
const os = require('os');
const DB_PATH = path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db');
console.log('DB path:', DB_PATH);
const db = knex({ client: 'sqlite3', connection: { filename: DB_PATH }, useNullAsDefault: true });
db.raw('SELECT id, user_id, email, is_active, sync_status, sync_error, token_expires_at, refresh_token_enc FROM gmail_accounts').then(rows => {
  rows.forEach(r => { r.has_refresh_token = r.refresh_token_enc ? 'YES' : 'NO'; delete r.refresh_token_enc; });
  console.log(JSON.stringify(rows, null, 2));
  return db.destroy();
}).catch(e => { console.error(e.message); db.destroy(); });

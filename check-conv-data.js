const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const dbPath = path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== MESSAGES IN CONV 158 ===');
const msgs = db.prepare("SELECT id, conversation_id, role, substr(content, 1, 120) as preview, metadata_json FROM messages WHERE conversation_id = 158 ORDER BY created_at ASC").all();
console.log(JSON.stringify(msgs, null, 2));

console.log('\n=== TABLES ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(t => t.name).join(', '));

db.close();

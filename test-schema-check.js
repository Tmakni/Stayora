require('dotenv').config();
const knex = require('knex');
const config = require('./knexfile');
const db = knex(config.development);

(async () => {
  const cols = await db.raw('PRAGMA table_info(sync_logs)');
  const rows = Array.isArray(cols) && Array.isArray(cols[0]) ? cols[0] : cols;
  console.log('sync_logs columns:');
  rows.forEach(r => console.log(' ', r.name, r.type, r.notnull ? 'NOT NULL' : '', r.dflt_value || ''));
  await db.destroy();
})();

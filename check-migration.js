const { initDatabase } = require('./server/config/db');
initDatabase()
  .then(() => { console.log('DB OK - migration applied'); process.exit(0); })
  .catch(e => { console.error('DB error:', e.message); process.exit(1); });

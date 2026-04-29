const { initDatabase, getDatabase } = require('./server/config/db');

(async () => {
  await initDatabase();
  const db = getDatabase();
  const accounts = await db.query(
    'SELECT id, user_id, email, sync_status, sync_error, token_expires_at, last_sync_at FROM gmail_accounts WHERE is_active = TRUE'
  );
  console.log('Gmail accounts:', JSON.stringify(accounts, null, 2));
  
  // Check if refresh token exists
  for (const acc of accounts) {
    const full = await db.query('SELECT refresh_token_enc FROM gmail_accounts WHERE id = ?', [acc.id]);
    console.log(`Account ${acc.id} (${acc.email}): has refresh_token = ${!!full[0].refresh_token_enc}`);
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

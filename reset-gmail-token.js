const { initDatabase, getDatabase } = require('./server/config/db');

(async () => {
  await initDatabase();
  const db = getDatabase();
  
  // Reset the sync status so re-auth can proceed
  await db.query(
    "UPDATE gmail_accounts SET sync_status = 'idle', sync_error = 'Token expiré — veuillez reconnecter votre compte Gmail' WHERE id = 1"
  );
  
  console.log('Gmail account status reset. Please reconnect via the app.');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

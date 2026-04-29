/**
 * Gmail Sync Diagnostic Script
 * Checks: DB tables exist, Gmail account stored, sync runs
 */
require('dotenv').config();
const path = require('path');
const knex = require('knex');

async function diagnose() {
  // Use the knexfile directly
  const config = require('./knexfile');
  const db = knex(config.development);

  console.log('\n=== GMAIL SYNC DIAGNOSTIC ===\n');

  // 1. Check if gmail_accounts table exists
  try {
    const tables = await db.raw("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const tableNames = (Array.isArray(tables) && Array.isArray(tables[0]) ? tables[0] : tables).map(r => r.name);
    console.log('1. Tables in DB:', tableNames.join(', '));
    
    const hasGmail = tableNames.includes('gmail_accounts');
    const hasGmailThreads = tableNames.includes('gmail_threads');
    const hasSyncLogs = tableNames.includes('sync_logs');
    console.log('   gmail_accounts exists:', hasGmail);
    console.log('   gmail_threads exists:', hasGmailThreads);
    console.log('   sync_logs exists:', hasSyncLogs);
    
    if (!hasGmail) {
      console.log('\n❌ gmail_accounts table does NOT exist! Migration was not run.');
      await db.destroy();
      return;
    }
  } catch (err) {
    console.error('Error checking tables:', err.message);
    await db.destroy();
    return;
  }

  // 2. Check gmail accounts
  try {
    const accounts = await db.raw('SELECT id, user_id, email, is_active, last_sync_at, sync_status, sync_error, created_at FROM gmail_accounts');
    const rows = Array.isArray(accounts) && Array.isArray(accounts[0]) ? accounts[0] : accounts;
    console.log('\n2. Gmail accounts in DB:', rows.length);
    if (rows.length === 0) {
      console.log('   ❌ NO Gmail accounts found! The OAuth flow was NOT completed.');
      console.log('   → You need to go to Integrations and click "Connect Gmail"');
    } else {
      for (const r of rows) {
        console.log(`   Account #${r.id}: email=${r.email}, active=${r.is_active}, last_sync=${r.last_sync_at}, status=${r.sync_status}, error=${r.sync_error}`);
      }
    }
  } catch (err) {
    console.error('Error checking gmail_accounts:', err.message);
  }

  // 3. Check users
  try {
    const users = await db.raw('SELECT id, email FROM users');
    const rows = Array.isArray(users) && Array.isArray(users[0]) ? users[0] : users;
    console.log('\n3. Users in DB:', rows.length);
    for (const r of rows) {
      console.log(`   User #${r.id}: ${r.email}`);
    }
  } catch (err) {
    console.error('Error checking users:', err.message);
  }

  // 4. Check properties
  try {
    const props = await db.raw('SELECT id, user_id, name, superhot_listing_id FROM property_profiles');
    const rows = Array.isArray(props) && Array.isArray(props[0]) ? props[0] : props;
    console.log('\n4. Properties in DB:', rows.length);
    for (const r of rows) {
      console.log(`   Property #${r.id} (user ${r.user_id}): "${r.name}" listing_id=${r.superhot_listing_id}`);
    }
  } catch (err) {
    console.error('Error checking properties:', err.message);
  }

  // 5. Check conversations
  try {
    const convs = await db.raw('SELECT id, user_id, title, external_provider, external_id, property_id, guest_name FROM conversations ORDER BY id DESC LIMIT 10');
    const rows = Array.isArray(convs) && Array.isArray(convs[0]) ? convs[0] : convs;
    console.log('\n5. Recent conversations:', rows.length);
    for (const r of rows) {
      console.log(`   Conv #${r.id}: "${r.title}" provider=${r.external_provider} ext_id=${r.external_id} property=${r.property_id} guest=${r.guest_name}`);
    }
  } catch (err) {
    console.error('Error checking conversations:', err.message);
  }

  // 6. Check gmail_threads
  try {
    const threads = await db.raw('SELECT * FROM gmail_threads');
    const rows = Array.isArray(threads) && Array.isArray(threads[0]) ? threads[0] : threads;
    console.log('\n6. Gmail threads synced:', rows.length);
    for (const r of rows) {
      console.log(`   Thread #${r.id}: gmail_thread=${r.gmail_thread_id}, conv=${r.conversation_id}, subject=${r.subject}`);
    }
  } catch (err) {
    console.error('Error checking gmail_threads:', err.message);
  }

  // 7. Check sync_logs
  try {
    const logs = await db.raw("SELECT id, user_id, sync_type, status, error_message, items_synced, created_at, completed_at FROM sync_logs ORDER BY id DESC LIMIT 10");
    const rows = Array.isArray(logs) && Array.isArray(logs[0]) ? logs[0] : logs;
    console.log('\n7. Recent sync logs:', rows.length);
    for (const r of rows) {
      console.log(`   Log #${r.id}: type=${r.sync_type} status=${r.status} items=${r.items_synced} error=${r.error_message} at=${r.created_at}`);
    }
  } catch (err) {
    console.error('Error checking sync_logs:', err.message);
  }

  // 8. Check .env config
  console.log('\n8. Environment config:');
  console.log('   GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? '✅ Set' : '❌ Missing');
  console.log('   GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? '✅ Set' : '❌ Missing');
  console.log('   GOOGLE_REDIRECT_URI:', process.env.GOOGLE_REDIRECT_URI || '❌ Missing');
  
  console.log('\n=== END DIAGNOSTIC ===\n');
  await db.destroy();
}

diagnose().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});

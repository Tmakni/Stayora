/**
 * Diagnostic: Tests if the current Google OAuth setup can access Gmail API.
 * Run: node test-gmail-scope.js
 */
require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const os = require('os');

async function main() {
  console.log('=== Gmail API Scope Diagnostic ===\n');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  console.log('1. Environment:');
  console.log('   CLIENT_ID:', clientId ? `${clientId.substring(0, 20)}...` : 'MISSING');
  console.log('   CLIENT_SECRET:', clientSecret ? `${clientSecret.substring(0, 10)}...` : 'MISSING');
  console.log('   REDIRECT_URI:', redirectUri || 'MISSING');
  console.log('   Project number:', clientId ? clientId.split('-')[0] : '?');

  if (!clientId || !clientSecret) { process.exit(1); }

  // Load DB directly via knex
  const knexConfig = require('./knexfile');
  const env = process.env.NODE_ENV || 'development';
  console.log('\n2. DB config:', env, knexConfig[env].connection.filename || knexConfig[env].connection.host);
  
  const knex = require('knex')(knexConfig[env]);

  try {
    const accounts = await knex('gmail_accounts').where('is_active', 1);
    console.log(`   Active Gmail accounts: ${accounts.length}`);

    if (accounts.length === 0) {
      console.log('   No accounts to test');
      await knex.destroy();
      process.exit(0);
    }

    const { decrypt } = require('./server/utils/encryption');

    for (const acc of accounts) {
      console.log(`\n--- Account ${acc.id}: ${acc.email} ---`);
      console.log(`   sync_status: ${acc.sync_status}, sync_error: ${acc.sync_error || 'none'}`);

      if (!acc.access_token_enc) {
        console.log('   No access token stored');
        continue;
      }

      const accessToken = decrypt(acc.access_token_enc);
      const refreshToken = acc.refresh_token_enc ? decrypt(acc.refresh_token_enc) : null;
      console.log(`   has_refresh_token: ${!!refreshToken}`);

      if (!refreshToken) {
        console.log('   Cannot test without refresh token');
        continue;
      }

      const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

      console.log('   Refreshing token...');
      const { credentials } = await oauth2.refreshAccessToken();
      console.log('   Granted scopes:', credentials.scope || 'NONE');
      
      const hasGmail = (credentials.scope || '').includes('gmail');
      console.log('   Has gmail scope:', hasGmail ? 'YES' : 'NO');

      // Test Gmail API
      console.log('   Testing Gmail API...');
      oauth2.setCredentials({ access_token: credentials.access_token, refresh_token: refreshToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });

      try {
        const labels = await gmail.users.labels.list({ userId: 'me' });
        console.log(`   Gmail API: OK (${labels.data.labels.length} labels)`);

        const msgs = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox', maxResults: 3 });
        const count = msgs.data.messages ? msgs.data.messages.length : 0;
        console.log(`   Inbox messages: ${count}`);

        if (count > 0) {
          for (const m of msgs.data.messages.slice(0, 3)) {
            const full = await gmail.users.messages.get({
              userId: 'me', id: m.id, format: 'metadata',
              metadataHeaders: ['From', 'Subject']
            });
            const from = full.data.payload.headers.find(h => h.name === 'From');
            const subj = full.data.payload.headers.find(h => h.name === 'Subject');
            console.log(`     From: ${from?.value}`);
            console.log(`     Subject: ${subj?.value}`);
          }
        }
      } catch (gmailErr) {
        console.log(`   Gmail API FAILED: ${gmailErr.message}`);
        if (gmailErr.code === 403 || gmailErr.message.includes('nsufficient')) {
          console.log('   => Token does not have gmail.readonly scope');
          console.log('   => Fix: OAuth consent screen -> Scopes -> Add gmail.readonly');
          console.log('   => Then re-authorize in the app');
        }
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await knex.destroy();
    process.exit(0);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

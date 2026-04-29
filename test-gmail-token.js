/**
 * Debug Gmail token scopes and API access
 */
require('dotenv').config();
const { google } = require('googleapis');
const knex = require('knex');
const path = require('path');
const os = require('os');
const { decrypt } = require('./server/utils/encryption');

const DB_PATH = process.platform === 'linux'
  ? path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db')
  : path.join(__dirname, 'data', 'airbnb_ai_agent.db');

const db = knex({
  client: 'sqlite3',
  connection: { filename: DB_PATH },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 }
});

async function main() {
  console.log('\n=== Gmail Token Debug ===\n');

  const accounts = await db.raw('SELECT * FROM gmail_accounts WHERE is_active = 1');
  const rows = Array.isArray(accounts) && Array.isArray(accounts[0]) ? accounts[0] : accounts;
  
  if (rows.length === 0) {
    console.log('No active Gmail accounts');
    await db.destroy();
    return;
  }

  for (const acc of rows) {
    console.log(`Account #${acc.id}: ${acc.email}`);
    
    const accessToken = decrypt(acc.access_token_enc);
    const refreshToken = acc.refresh_token_enc ? decrypt(acc.refresh_token_enc) : null;
    
    console.log('  Access token:', accessToken ? accessToken.substring(0, 30) + '...' : 'MISSING');
    console.log('  Refresh token:', refreshToken ? 'Present' : 'MISSING');
    console.log('  Token expires:', acc.token_expires_at);

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });

    // Check token info
    try {
      const tokenInfo = await oauth2.getTokenInfo(accessToken);
      console.log('  Token scopes:', tokenInfo.scopes?.join(', ') || 'NONE');
      console.log('  Token email:', tokenInfo.email);
      console.log('  Token expiry:', tokenInfo.expiry_date ? new Date(tokenInfo.expiry_date) : 'N/A');
    } catch (err) {
      console.log('  Token info error:', err.message);
      
      // Try refreshing the token
      if (refreshToken) {
        console.log('  Trying token refresh...');
        try {
          const { credentials } = await oauth2.refreshAccessToken();
          console.log('  Refreshed token:', credentials.access_token ? credentials.access_token.substring(0, 30) + '...' : 'NONE');
          console.log('  Refresh scope:', credentials.scope || 'NONE');
          
          // Check new token info
          try {
            const newTokenInfo = await oauth2.getTokenInfo(credentials.access_token);
            console.log('  New token scopes:', newTokenInfo.scopes?.join(', ') || 'NONE');
          } catch (e2) {
            console.log('  New token info error:', e2.message);
          }
        } catch (refreshErr) {
          console.log('  Refresh error:', refreshErr.message);
        }
      }
    }

    // Try Gmail API directly
    console.log('\n  Testing Gmail API...');
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      console.log('  Gmail profile:', profile.data.emailAddress, '— Total msgs:', profile.data.messagesTotal);
    } catch (err) {
      console.log('  Gmail API error:', err.message);
      if (err.response) {
        console.log('  Status:', err.response.status);
        console.log('  Error details:', JSON.stringify(err.response.data?.error || {}).substring(0, 200));
      }
    }

    // Try listing messages
    try {
      const list = await gmail.users.messages.list({ userId: 'me', q: 'from:airbnb.com', maxResults: 5 });
      console.log('  Message list:', (list.data.messages || []).length, 'messages from Airbnb');
    } catch (err) {
      console.log('  Message list error:', err.message);
    }
  }

  await db.destroy();
}

main().catch(async (err) => {
  console.error('Error:', err.message);
  await db.destroy();
});

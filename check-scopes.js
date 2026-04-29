#!/usr/bin/env node
/**
 * Check what scopes the stored Gmail token has.
 */
require('dotenv').config();
const knex = require('knex');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { decrypt } = require('./server/utils/encryption');

const DB_PATH = path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db');
const db = knex({ client: 'sqlite3', connection: { filename: DB_PATH }, useNullAsDefault: true });

async function main() {
  const rows = await db.raw('SELECT * FROM gmail_accounts WHERE is_active = 1');
  if (rows.length === 0) { console.log('No active Gmail accounts'); return; }

  for (const row of rows) {
    console.log(`\n=== Account #${row.id}: ${row.email} ===`);
    const accessToken = decrypt(row.access_token_enc);
    const refreshToken = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;
    console.log('Has refresh token:', !!refreshToken);
    console.log('Token expires at:', row.token_expires_at ? new Date(parseInt(row.token_expires_at)).toISOString() : 'N/A');

    // Check token info via Google API
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

    try {
      // Refresh the token first
      const { credentials } = await oauth2.refreshAccessToken();
      console.log('Refreshed token scopes:', credentials.scope || 'NOT RETURNED');
      console.log('New token type:', credentials.token_type);
      console.log('Expires in:', credentials.expiry_date ? `${Math.round((credentials.expiry_date - Date.now()) / 1000)}s` : 'N/A');

      // Try tokeninfo endpoint
      try {
        const resp = await oauth2.getTokenInfo(credentials.access_token);
        console.log('TokenInfo scopes:', resp.scopes ? resp.scopes.join(', ') : 'N/A');
      } catch (e) {
        console.log('TokenInfo error:', e.message);
      }

      // Try to call Gmail API
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const result = await gmail.users.labels.list({ userId: 'me' });
        console.log('Gmail API test: SUCCESS (labels count:', result.data.labels?.length, ')');
      } catch (e) {
        console.log('Gmail API test FAILED:', e.message?.substring(0, 200));
      }
    } catch (e) {
      console.log('Token refresh failed:', e.message?.substring(0, 200));
    }
  }

  await db.destroy();
}

main().catch(e => { console.error(e); db.destroy(); });

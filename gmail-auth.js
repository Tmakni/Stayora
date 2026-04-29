#!/usr/bin/env node
/**
 * Gmail Authorization CLI
 * 
 * Connects a Gmail account to the app without needing the web UI.
 * Opens the browser, starts a local callback server, exchanges the code,
 * and saves the tokens directly to the database.
 * 
 * Usage:  node gmail-auth.js [user_email]
 * Example: node gmail-auth.js del.cordonnier@gmail.com
 */
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');
const knex = require('knex');
const path = require('path');
const os = require('os');

// DB setup (same as knexfile.js)
const DB_PATH = process.platform === 'linux'
  ? path.join(os.homedir(), '.local', 'share', 'airbnb-ai-agent', 'airbnb_ai_agent.db')
  : path.join(__dirname, 'data', 'airbnb_ai_agent.db');

const db = knex({
  client: 'sqlite3',
  connection: { filename: DB_PATH },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 }
});

// Encryption (reuse app's encryption module)
const { encrypt } = require('./server/utils/encryption');

// Use port 3100 for CLI auth to avoid conflict with main server on 3000.
// IMPORTANT: You must add http://localhost:3100/callback to your Google Cloud Console
// as an authorized redirect URI. If you already have http://localhost:3000/api/gmail/oauth-callback
// registered, you can pass --port=3000 to use that instead.
const cliPort = process.argv.includes('--port=3000') ? 3000 : 3100;
const REDIRECT_URI = cliPort === 3000
  ? 'http://localhost:3000/api/gmail/oauth-callback'
  : `http://localhost:${cliPort}/callback`;
const CALLBACK_PATH = cliPort === 3000 ? '/api/gmail/oauth-callback' : '/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

/**
 * Wait for the authorization code via:
 * 1) A temp HTTP server to catch the redirect, OR
 * 2) Manual paste from the user (if redirect fails)
 */
function waitForCode(port, callbackPath) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Method 1: Try to start temp HTTP server
    let server;
    try {
      server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, `http://localhost:${port}`);
          if (url.pathname === callbackPath) {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<h2>Erreur</h2><p>${error}</p><p>Fermez cet onglet.</p>`);
              if (!resolved) { resolved = true; reject(new Error('Google auth error: ' + error)); }
              server.close();
              return;
            }

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<h2>Gmail connect\u00e9 !</h2><p>Vous pouvez fermer cet onglet et retourner au terminal.</p>');
              if (!resolved) { resolved = true; resolve(code); }
              server.close();
              return;
            }
          }
          res.writeHead(404);
          res.end('Not found');
        } catch (e) {
          res.writeHead(500);
          res.end('Error');
        }
      });

      server.on('error', () => {
        // Port busy — rely on manual input only
        console.log(`   (Port ${port} busy — please paste the redirect URL below)`);
      });

      server.listen(port, () => {
        console.log(`   Listening on http://localhost:${port}${callbackPath}`);
      });
    } catch (e) {
      // Cannot start server — fallback to manual input
    }

    // Method 2: Read from stdin (user pastes the redirected URL or the code)
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('   Paste URL or code here (or wait for auto-redirect): ', (input) => {
      rl.close();
      if (resolved) return; // Already resolved via HTTP
      const trimmed = (input || '').trim();

      if (!trimmed) {
        reject(new Error('No code provided'));
        return;
      }

      // If user pasted a full URL, extract the code parameter
      if (trimmed.startsWith('http')) {
        try {
          const url = new URL(trimmed);
          const code = url.searchParams.get('code');
          if (code) {
            resolved = true;
            if (server) server.close();
            resolve(code);
            return;
          }
        } catch (e) {}
      }

      // Treat the whole input as the code
      resolved = true;
      if (server) server.close();
      resolve(trimmed);
    });

    // Timeout after 3 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (server) server.close();
        reject(new Error('Timeout: no code received within 3 minutes'));
      }
    }, 180000);
  });
}

async function main() {
  const userEmail = process.argv[2];

  console.log('\n=== Gmail Authorization CLI ===\n');

  // 1. Find user in DB
  let userId;
  if (userEmail) {
    const users = await db.raw('SELECT id, email FROM users WHERE email = ?', [userEmail]);
    const rows = Array.isArray(users) && Array.isArray(users[0]) ? users[0] : users;
    if (rows.length === 0) {
      console.error(`User "${userEmail}" not found in DB.`);
      const allUsers = await db.raw('SELECT id, email FROM users');
      const all = Array.isArray(allUsers) && Array.isArray(allUsers[0]) ? allUsers[0] : allUsers;
      console.log('Available users:', all.map(u => `  ${u.id}: ${u.email}`).join('\n'));
      await db.destroy();
      process.exit(1);
    }
    userId = rows[0].id;
    console.log(`User: ${rows[0].email} (ID: ${userId})`);
  } else {
    const allUsers = await db.raw('SELECT id, email FROM users');
    const all = Array.isArray(allUsers) && Array.isArray(allUsers[0]) ? allUsers[0] : allUsers;
    if (all.length === 0) {
      console.error('No users in DB. Create an account first via the app.');
      await db.destroy();
      process.exit(1);
    }
    // Use first user
    userId = all[0].id;
    console.log(`Using first user: ${all[0].email} (ID: ${userId})`);
  }

  // 2. Create OAuth client
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });

  console.log('\n1. Visit this URL in your browser to authorize Gmail:\n');
  console.log(`   ${authUrl}\n`);

  // Try to open browser
  try {
    const { exec } = require('child_process');
    if (process.platform === 'linux') {
      const escapedUrl = authUrl.replace(/&/g, '^&');
      exec(`cmd.exe /c start "" "${escapedUrl}"`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      exec(`start "" "${authUrl}"`, { stdio: 'ignore' });
    } else {
      exec(`open "${authUrl}"`, { stdio: 'ignore' });
    }
  } catch (e) {
    // Ignore — user can copy-paste the URL
  }

  // 3. Wait for code — either via temp HTTP server or manual paste
  console.log('2. After authorizing, you will be redirected.');
  console.log('   If the redirect fails, copy the FULL URL from your browser address bar');
  console.log('   and paste it here.\n');

  const code = await waitForCode(cliPort, CALLBACK_PATH);

  console.log('3. Got authorization code. Exchanging for tokens...');

  // 4. Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user email
  const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2Api.userinfo.get();
  const gmailEmail = userInfo.data.email;

  console.log(`   Gmail account: ${gmailEmail}`);
  console.log(`   Access token: ${tokens.access_token ? 'OK' : 'MISSING'}`);
  console.log(`   Refresh token: ${tokens.refresh_token ? 'OK' : 'MISSING'}`);

  // 5. Save to DB
  const accessTokenEnc = encrypt(tokens.access_token);
  const refreshTokenEnc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;

  // Check if already exists
  const existing = await db.raw(
    'SELECT id FROM gmail_accounts WHERE user_id = ? AND email = ?',
    [userId, gmailEmail]
  );
  const existingRows = Array.isArray(existing) && Array.isArray(existing[0]) ? existing[0] : existing;

  if (existingRows.length > 0) {
    await db.raw(
      `UPDATE gmail_accounts SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?,
       is_active = 1, sync_status = 'idle', sync_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
      [accessTokenEnc, refreshTokenEnc, expiresAt, existingRows[0].id]
    );
    console.log(`\n   Updated existing Gmail account (ID: ${existingRows[0].id})`);
  } else {
    await db.raw(
      `INSERT INTO gmail_accounts (user_id, email, access_token_enc, refresh_token_enc, token_expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [userId, gmailEmail, accessTokenEnc, refreshTokenEnc, expiresAt]
    );
    console.log('\n   Gmail account saved to database!');
  }

  // 6. Verify
  const check = await db.raw('SELECT id, email, is_active FROM gmail_accounts WHERE user_id = ?', [userId]);
  const checkRows = Array.isArray(check) && Array.isArray(check[0]) ? check[0] : check;
  console.log('\n4. Verification — Gmail accounts in DB:');
  for (const r of checkRows) {
    console.log(`   #${r.id}: ${r.email} (active: ${r.is_active})`);
  }

  console.log('\n=== Done! Gmail is now connected. ===');
  console.log('Start the server and messages will sync automatically every 60 seconds.\n');

  await db.destroy();
}

main().catch(async (err) => {
  console.error('\nError:', err.message);
  await db.destroy();
  process.exit(1);
});

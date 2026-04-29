/**
 * Test Gmail connection end-to-end via the running server.
 * 
 * 1. Creates a JWT for the user
 * 2. Calls /api/gmail/auth-url to get the OAuth URL
 * 3. Opens the browser
 * 4. Waits for the user to authorize
 * 5. Checks if the Gmail account was saved
 */
require('dotenv').config();
const http = require('http');
const jwt = require('jsonwebtoken');

const SERVER_PORT = 3000;
const BASE = `http://localhost:${SERVER_PORT}`;

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function main() {
  console.log('\n=== Test Gmail Connection via Server ===\n');

  // 1. Generate JWT for user 6 (del.cordonnier@gmail.com)
  const userId = 6;
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
  console.log('1. JWT generated for user', userId);

  // 2. Check server health
  try {
    const health = await makeRequest('/api/health');
    console.log('2. Server health:', health.status, health.data);
  } catch (err) {
    console.error('2. ERROR: Server not reachable on port 3000!', err.message);
    console.error('   Start the server first: cd /mnt/c/home/tom/airbnb-ai-agent && npm run dev:wsl');
    process.exit(1);
  }

  // 3. Check existing Gmail accounts
  const accountsResp = await makeRequest('/api/gmail/accounts', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('3. Gmail accounts:', accountsResp.status, JSON.stringify(accountsResp.data));

  // 4. Get auth URL
  const authResp = await makeRequest('/api/gmail/auth-url', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('4. Auth URL response:', authResp.status);
  
  if (authResp.status === 200 && authResp.data.url) {
    console.log('   OAuth URL:', authResp.data.url.substring(0, 80) + '...');
    console.log('\n5. NEXT STEP: Visit this URL in your browser while logged into the app:');
    console.log('   ' + authResp.data.url);
    
    // Open in browser
    try {
      const { exec } = require('child_process');
      if (process.platform === 'linux') {
        const escapedUrl = authResp.data.url.replace(/&/g, '^&');
        exec(`cmd.exe /c start "" "${escapedUrl}"`, { stdio: 'ignore' });
      }
      console.log('\n   Browser should open automatically.');
    } catch (e) {}

    console.log('\n   After authorizing, check if the account was saved:');
    
    // Poll for account creation
    console.log('\n6. Waiting for Gmail account to be connected (max 3 minutes)...');
    const startTime = Date.now();
    const timeout = 180000;
    
    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, 5000));
      const check = await makeRequest('/api/gmail/accounts', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const accounts = check.data.accounts || [];
      if (accounts.length > 0) {
        console.log('\n   ✅ Gmail account connected!');
        console.log('   Accounts:', JSON.stringify(accounts, null, 2));
        
        // Trigger manual sync
        console.log('\n7. Triggering manual sync...');
        for (const acc of accounts) {
          const syncResp = await makeRequest(`/api/gmail/sync/${acc.id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
          console.log(`   Sync result for ${acc.email}:`, syncResp.status, JSON.stringify(syncResp.data));
        }
        
        // Check conversations
        const convResp = await makeRequest('/api/conversations', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const convs = Array.isArray(convResp.data) ? convResp.data : (convResp.data.conversations || []);
        console.log(`\n8. Conversations (${convs.length}):`,
          convs.map(c => `  "${c.title}" (provider: ${c.external_provider})`).join('\n'));
        
        process.exit(0);
      }
      process.stdout.write('.');
    }
    console.log('\n   ⏰ Timeout — no account connected after 3 minutes.');
  } else {
    console.error('   ERROR getting auth URL:', authResp.data);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

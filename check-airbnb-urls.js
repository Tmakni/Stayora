/**
 * Diagnostic: extract actual Airbnb URLs from recent emails
 * Run: node check-airbnb-urls.js
 */
require('dotenv').config();

(async () => {
  const { initDatabase, getDatabase } = require('./server/config/db');
  await initDatabase();
  const db = getDatabase();
  const gmailSync = require('./server/services/gmailSyncService');

  const acc = await db.query('SELECT * FROM gmail_accounts WHERE is_active = TRUE LIMIT 1');
  if (!acc.length) { console.log('No active Gmail account'); process.exit(1); }

  const account = await gmailSync.getGmailAccount(acc[0].user_id, acc[0].id);
  const { gmail } = require('@googleapis/gmail');
  const { OAuth2Client } = require('google-auth-library');

  const oauth2 = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token });
  const client = gmail({ version: 'v1', auth: oauth2 });

  const listResp = await client.users.messages.list({
    userId: 'me',
    q: 'from:airbnb',
    maxResults: 5
  });

  const msgIds = (listResp.data.messages || []).map(m => m.id);
  if (!msgIds.length) { console.log('No messages found'); process.exit(0); }

  for (const msgId of msgIds.slice(0, 3)) {
    const fullMsg = await client.users.messages.get({ userId: 'me', id: msgId, format: 'full' });

    const hdrs = {};
    for (const h of (fullMsg.data.payload.headers || [])) {
      hdrs[h.name.toLowerCase()] = h.value;
    }

    console.log('\n=== MSG:', msgId, '===');
    console.log('Subject:', hdrs.subject);
    console.log('From:', hdrs.from);

    let htmlData = null, plainData = null;
    function findParts(part) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) htmlData = part.body.data;
      if (part.mimeType === 'text/plain' && part.body && part.body.data) plainData = part.body.data;
      if (part.parts) part.parts.forEach(findParts);
    }
    findParts(fullMsg.data.payload);

    if (plainData) {
      const txt = Buffer.from(plainData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      // Find all URLs containing airbnb
      const matches = txt.match(/https?:\/\/[^\s<"]{10,}/gi) || [];
      const airbnbUrls = matches.filter(u => u.includes('airbnb'));
      console.log('\nPLAIN TEXT Airbnb URLs:');
      airbnbUrls.slice(0, 8).forEach(u => console.log(' ', u.substring(0, 180)));
    }

    if (htmlData) {
      const html = Buffer.from(htmlData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      // Extract href values containing airbnb
      const matches = html.match(/href="([^"]*airbnb[^"]{3,})"/gi) || [];
      console.log('\nHTML href Airbnb URLs:');
      matches.slice(0, 8).forEach(m => {
        const url = m.replace(/href="/, '').replace(/"$/, '');
        console.log(' ', url.substring(0, 180));
      });

      // Also check for percent-encoded airbnb URLs
      const encodedMatches = html.match(/%2F(?:hosting%2Finbox|messaging)[^"'\s]{5,}/gi) || [];
      console.log('\nPercent-encoded paths:');
      encodedMatches.slice(0, 5).forEach(m => console.log(' ', decodeURIComponent(m).substring(0, 180)));
    }
  }

  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

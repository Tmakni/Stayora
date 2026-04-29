/**
 * Dump raw email body for a single Airbnb email to see the HTML-converted structure
 */
require('dotenv').config();

(async () => {
  try {
    const { initDatabase, getDatabase } = require('./server/config/db');
    await initDatabase();
    const db = getDatabase();
    const gmailSync = require('./server/services/gmailSyncService');

    const acc = await db.query('SELECT * FROM gmail_accounts WHERE is_active = TRUE LIMIT 1');
    if (!acc.length) { console.log('No account'); process.exit(1); }

    const account = await gmailSync.getGmailAccount(acc[0].user_id, acc[0].id);
    const { gmail } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({
      access_token: account.access_token,
      refresh_token: account.refresh_token
    });
    const client = gmail({ version: 'v1', auth: oauth2 });

    // Find a message thread with actual conversation content
    const listResp = await client.users.messages.list({
      userId: 'me',
      q: 'in:inbox from:(airbnb.com OR airbnb.fr) subject:"Demande"',
      maxResults: 5
    });

    const msgIds = (listResp.data.messages || []).map(m => m.id);
    console.log(`Found ${msgIds.length} messages\n`);

    for (const msgId of msgIds.slice(0, 2)) {
      const fullMsg = await client.users.messages.get({
        userId: 'me',
        id: msgId,
        format: 'full'
      });

      // Get headers
      const headers = {};
      for (const h of (fullMsg.data.payload.headers || [])) {
        headers[h.name.toLowerCase()] = h.value;
      }
      console.log('=== MESSAGE ID:', msgId, '===');
      console.log('Subject:', headers.subject);
      console.log('From:', headers.from);
      console.log('Date:', headers.date);

      // Extract parts
      const parts = [];
      function walkParts(part, depth) {
        parts.push({ mime: part.mimeType, size: part.body?.size, depth });
        if (part.parts) part.parts.forEach(p => walkParts(p, depth + 1));
      }
      walkParts(fullMsg.data.payload, 0);
      console.log('\nParts:', JSON.stringify(parts));

      // Get text/plain
      let plainData = null, htmlData = null;
      function findParts(part) {
        if (part.mimeType === 'text/plain' && part.body?.data) plainData = part.body.data;
        if (part.mimeType === 'text/html' && part.body?.data) htmlData = part.body.data;
        if (part.parts) part.parts.forEach(findParts);
      }
      findParts(fullMsg.data.payload);

      if (plainData) {
        const plain = Buffer.from(plainData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        console.log('\n--- PLAIN TEXT ---');
        console.log(plain.substring(0, 300));
        console.log('--- END PLAIN (total', plain.length, 'chars) ---');
      }

      if (htmlData) {
        const html = Buffer.from(htmlData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        // Strip HTML to text
        const text = html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<\/tr>/gi, '\n')
          .replace(/<\/li>/gi, '\n')
          .replace(/<\/h[1-6]>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
          .replace(/&[a-z]+;/gi, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        console.log('\n--- HTML→TEXT (full) ---');
        console.log(text);
        console.log('--- END HTML→TEXT (total', text.length, 'chars) ---');
      }

      console.log('\n\n');
    }
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  }
  process.exit(0);
})();

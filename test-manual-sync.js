/**
 * Manual sync test: resets last_sync_at, does one sync, and shows results.
 */
require('dotenv').config();
const { google } = require('googleapis');
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig['development']);
const { decrypt } = require('./server/utils/encryption');

(async () => {
  try {
    // Reset sync timestamp
    await knex('gmail_accounts').where('id', 1).update({ last_sync_at: null, sync_status: 'idle', sync_error: null });
    console.log('1. Reset last_sync_at to null');

    // Get account
    const acc = await knex('gmail_accounts').where('id', 1).first();
    const accessToken = decrypt(acc.access_token_enc);
    const refreshToken = decrypt(acc.refresh_token_enc);

    // OAuth
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials({ access_token: credentials.access_token, refresh_token: refreshToken });
    console.log('2. Token refreshed, scopes:', credentials.scope);

    // List messages
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const listResp = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox', maxResults: 20 });
    const messages = listResp.data.messages || [];
    console.log(`3. Found ${messages.length} messages in inbox (no date filter)`);

    // Show each message
    const threadMap = new Map();
    for (const m of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me', id: m.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      });
      const h = {};
      full.data.payload.headers.forEach(x => h[x.name] = x.value);
      const threadId = full.data.threadId;
      if (!threadMap.has(threadId)) threadMap.set(threadId, []);
      threadMap.get(threadId).push(full.data);
      
      // Extract sender
      const fromMatch = (h.From || '').match(/<([^>]+)>/);
      const email = fromMatch ? fromMatch[1].toLowerCase() : (h.From || '').toLowerCase().trim();
      const isSelf = email === acc.email.toLowerCase();
      
      console.log(`   msg=${m.id} thread=${threadId} from="${h.From}" isSelf=${isSelf}`);
      console.log(`     subject="${h.Subject}"`);
    }

    console.log(`\n4. Grouped into ${threadMap.size} threads`);

    // Check which threads would be skipped
    for (const [tid, msgs] of threadMap) {
      const firstHeaders = {};
      (msgs[0].payload.headers || []).forEach(h => firstHeaders[h.name.toLowerCase()] = h.value);
      const fromMatch = (firstHeaders.from || '').match(/<([^>]+)>/);
      const email = fromMatch ? fromMatch[1].toLowerCase() : (firstHeaders.from || '').toLowerCase().trim();
      const isSelf = email === acc.email.toLowerCase();
      const isAirbnb = email.includes('airbnb.com') || email.includes('airbnb.fr');
      console.log(`   thread=${tid}: from=${email}, isSelf=${isSelf}, isAirbnb=${isAirbnb}, msgs=${msgs.length}`);
      
      if (isSelf) console.log('     -> WOULD BE SKIPPED (sent by user)');
      
      // Check body extraction
      const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msgs[0].id, format: 'full' });
      const body = extractBody(fullMsg.data);
      console.log(`     body length: ${body.length} chars, first 100: "${body.substring(0, 100).replace(/\n/g, '\\n')}"`);
    }

    // Check existing synced conversations
    const convs = await knex('conversations').where('external_provider', 'gmail');
    console.log(`\n5. Existing Gmail conversations: ${convs.length}`);
    for (const c of convs) {
      const mCount = await knex('messages').where('conversation_id', c.id).count('* as cnt');
      console.log(`   id=${c.id} title="${c.title}" msgs=${mCount[0].cnt}`);
    }

  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await knex.destroy();
    process.exit(0);
  }
})();

function extractBody(message) {
  const payload = message.payload;
  if (!payload) return '';
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  const parts = payload.parts || [];
  let plainPart = null, htmlPart = null;
  function walk(partList) {
    for (const part of partList) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) plainPart = part;
      else if (part.mimeType === 'text/html' && part.body && part.body.data) htmlPart = part;
      if (part.parts) walk(part.parts);
    }
  }
  walk(parts);
  if (plainPart) return decodeBase64Url(plainPart.body.data);
  if (htmlPart) {
    const html = decodeBase64Url(htmlPart.body.data);
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\n{3,}/g, '\n\n').trim();
  }
  return '';
}

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

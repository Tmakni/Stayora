require('dotenv').config();
const { google } = require('googleapis');
const knexConfig = require('./knexfile');
const knex = require('knex')(knexConfig['development']);
const { decrypt } = require('./server/utils/encryption');

(async () => {
  const acc = await knex('gmail_accounts').where('is_active', 1).first();
  const accessToken = decrypt(acc.access_token_enc);
  const refreshToken = decrypt(acc.refresh_token_enc);

  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials({ access_token: credentials.access_token, refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const msgs = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox', maxResults: 5 });

  for (const m of (msgs.data.messages || [])) {
    const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const h = {};
    full.data.payload.headers.forEach(x => h[x.name] = x.value);
    console.log('---');
    console.log('ThreadId:', full.data.threadId);
    console.log('From:', h.From);
    console.log('Subject:', h.Subject);
    console.log('Date:', h.Date);
  }

  // Also check what's already synced
  const synced = await knex('gmail_threads').select('gmail_thread_id', 'sender_name', 'subject', 'conversation_id');
  console.log('\n=== Already synced threads ===');
  for (const t of synced) {
    console.log(`  thread=${t.gmail_thread_id} conv=${t.conversation_id} name=${t.sender_name} subj=${t.subject}`);
  }

  const convs = await knex('conversations').where('external_provider', 'gmail');
  console.log(`\n=== Gmail conversations: ${convs.length} ===`);
  for (const c of convs) {
    console.log(`  id=${c.id} title="${c.title}" guest="${c.guest_name}"`);
    const msgs2 = await knex('messages').where('conversation_id', c.id);
    console.log(`    messages: ${msgs2.length}`);
    for (const m of msgs2.slice(0, 2)) {
      console.log(`    [${m.role}] ${m.content.substring(0, 80)}...`);
    }
  }

  await knex.destroy();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

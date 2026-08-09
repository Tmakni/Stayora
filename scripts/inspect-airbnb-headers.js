#!/usr/bin/env node
/**
 * READ-ONLY inspection of the real headers on Airbnb notification mails.
 *
 *   node scripts/inspect-airbnb-headers.js [accountId]
 *
 * Answers the questions the reply feature depends on:
 *   - what exactly is in Reply-To, and is it stable?
 *   - what do Message-ID / References look like (threading)?
 *   - which domain does the reply address live on (allowlist)?
 *
 * The local part of the reply address is MASKED in the output: on Airbnb it
 * encodes a private per-thread identifier that must not end up in logs or in a
 * terminal transcript.
 *
 * Fetches with format=metadata — headers only, no bodies. Sends nothing.
 */

require('dotenv').config();

const HEADERS_OF_INTEREST = [
  'from', 'reply-to', 'to', 'subject', 'message-id',
  'in-reply-to', 'references', 'return-path', 'x-original-sender',
  'precedence', 'auto-submitted', 'list-unsubscribe',
];

/** thread+token@reply.airbnb.com → t***n@reply.airbnb.com */
function maskAddress(value) {
  if (!value) return value;
  return String(value).replace(/([^\s<>,;:"]+)@([^\s<>,;:"]+)/g, (full, local, domain) => {
    if (local.length <= 2) return `**@${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 12))}${local[local.length - 1]}@${domain}`;
  });
}

function maskMessageId(value) {
  if (!value) return value;
  return maskAddress(value);
}

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  await initDatabase();
  const db = getDatabase();

  const accountId = parseInt(process.argv[2], 10) || null;
  const accounts = await db.query(
    accountId
      ? 'SELECT id, user_id, email FROM gmail_accounts WHERE id = ? AND is_active = TRUE'
      : 'SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id LIMIT 1',
    accountId ? [accountId] : []
  );

  if (accounts.length === 0) {
    console.error('Aucun compte Gmail actif.');
    process.exit(1);
  }

  const account = accounts[0];
  console.log(`Compte : ${account.email} (id ${account.id}, user ${account.user_id})\n`);

  const gmailSync = require('../server/services/gmailSyncService');
  const full = await gmailSync.getGmailAccount(account.user_id, account.id);
  if (!full) {
    console.error('Impossible de charger le compte (token ?).');
    process.exit(1);
  }

  const { gmail } = require('@googleapis/gmail');
  const { OAuth2Client } = require('google-auth-library');
  const oauth2 = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
  const api = gmail({ version: 'v1', auth: oauth2 });

  const list = await api.users.messages.list({
    userId: 'me',
    q: 'from:airbnb',
    maxResults: 8,
  });

  const messages = list.data.messages || [];
  console.log(`${messages.length} message(s) Airbnb récent(s) inspecté(s).\n`);
  console.log('='.repeat(76));

  const replyDomains = new Map();

  for (const ref of messages) {
    const msg = await api.users.messages.get({
      userId: 'me',
      id: ref.id,
      format: 'metadata',
      metadataHeaders: HEADERS_OF_INTEREST,
    });

    const headers = {};
    for (const h of msg.data.payload?.headers || []) {
      headers[h.name.toLowerCase()] = h.value;
    }

    console.log(`\nmessage ${msg.data.id}   thread ${msg.data.threadId}`);
    console.log('-'.repeat(76));
    for (const name of HEADERS_OF_INTEREST) {
      if (!headers[name]) continue;
      const isAddressish = /^(from|reply-to|to|return-path|message-id|in-reply-to|references|x-original-sender)$/.test(name);
      let value = isAddressish ? maskMessageId(headers[name]) : headers[name];
      if (value.length > 200) value = value.slice(0, 200) + ' …';
      console.log(`  ${name.padEnd(18)} ${value}`);
    }

    const replyTo = headers['reply-to'];
    if (replyTo) {
      const m = replyTo.match(/@([^\s<>,;:"]+)/);
      if (m) replyDomains.set(m[1].toLowerCase(), (replyDomains.get(m[1].toLowerCase()) || 0) + 1);
    }
  }

  console.log('\n' + '='.repeat(76));
  console.log('\nDomaines vus dans Reply-To (candidats pour l\'allowlist) :');
  if (replyDomains.size === 0) {
    console.log('  aucun Reply-To trouvé !');
  } else {
    for (const [domain, count] of [...replyDomains].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${domain}  (${count} message(s))`);
    }
  }
  console.log('');

  await require('../server/db/database').close();
})().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});

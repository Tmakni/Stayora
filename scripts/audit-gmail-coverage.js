#!/usr/bin/env node
/**
 * AUDIT LECTURE SEULE de la couverture de la requête de synchronisation.
 *
 * Le sync interroge Gmail avec `from:airbnb`. Si Airbnb notifie depuis une
 * adresse que ce filtre ne capte pas, les messages correspondants n'entrent
 * jamais en base — et l'hôte constate des trous en comparant avec Airbnb.
 *
 * Compare plusieurs requêtes et liste les expéditeurs réellement utilisés.
 *
 *   node scripts/audit-gmail-coverage.js
 *
 * N'écrit rien, n'envoie rien.
 */

require('dotenv').config();

const QUERIES = [
  'from:airbnb',                    // la requête actuelle du sync
  'from:(airbnb.com OR airbnb.fr)', // toutes les adresses des domaines Airbnb
  'airbnb',                         // n'importe quelle mention (borne haute)
];

async function countThreads(gmail, q) {
  let total = 0;
  let pageToken = null;
  do {
    const res = await gmail.users.threads.list({ userId: 'me', q, maxResults: 500, ...(pageToken && { pageToken }) });
    total += (res.data.threads || []).length;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return total;
}

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const sync = require('../server/services/gmailSyncService');
  await initDatabase();
  const db = getDatabase();

  const accounts = await db.query('SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id');

  for (const account of accounts) {
    const full = await sync.getGmailAccount(account.user_id, account.id);
    if (!full) continue;
    const { gmail: gmailApi } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
    const gmail = gmailApi({ version: 'v1', auth: oauth2 });

    console.log(`\n=== Compte #${account.id} ===`);
    for (const q of QUERIES) {
      try {
        const n = await countThreads(gmail, q);
        console.log(`  "${q}" → ${n} fils`);
      } catch (e) {
        console.log(`  "${q}" → erreur ${e.message}`);
      }
    }

    // Quelles adresses d'expéditeur Airbnb utilise-t-il réellement ?
    console.log('  expéditeurs rencontrés :');
    const seen = new Map();
    let pageToken = null;
    let scanned = 0;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q: 'airbnb', maxResults: 500, ...(pageToken && { pageToken }) });
      const ids = (res.data.messages || []).map((m) => m.id);
      for (let i = 0; i < ids.length && scanned < 1200; i += 25) {
        const batch = ids.slice(i, i + 25);
        const metas = await Promise.all(batch.map((id) =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From'] })
            .then((r) => r.data).catch(() => null)
        ));
        for (const m of metas) {
          if (!m) continue;
          scanned++;
          const from = ((m.payload.headers || []).find((h) => h.name.toLowerCase() === 'from') || {}).value || '';
          const addr = (from.match(/<([^>]+)>/) || [null, from])[1].toLowerCase().trim();
          seen.set(addr, (seen.get(addr) || 0) + 1);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken && scanned < 1200);

    const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
    for (const [addr, n] of sorted.slice(0, 20)) {
      const caught = /airbnb/i.test(addr);
      console.log(`    ${caught ? '✓' : '✗ NON CAPTÉ'}  ${addr}  (${n})`);
    }
  }

  process.exit(0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

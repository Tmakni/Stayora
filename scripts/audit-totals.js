#!/usr/bin/env node
/**
 * AUDIT LECTURE SEULE : combien de messages Airbnb existent chez Gmail, et
 * combien sont réellement en base pour ce compte ?
 *
 * Contrairement à audit-missing-messages.js (qui échantillonne les plus gros
 * fils), celui-ci compte TOUT, sans biais de sélection, et liste les fils
 * Gmail que la base ne connaît pas du tout.
 *
 *   node scripts/audit-totals.js [--account 2]
 *
 * N'écrit rien, n'envoie rien.
 */

require('dotenv').config();

const accIdx = process.argv.indexOf('--account');
const ONLY_ACCOUNT = accIdx > -1 ? parseInt(process.argv[accIdx + 1], 10) : null;

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const sync = require('../server/services/gmailSyncService');
  await initDatabase();
  const db = getDatabase();

  const accounts = await db.query(
    ONLY_ACCOUNT
      ? 'SELECT id, user_id, email FROM gmail_accounts WHERE id = ? AND is_active = TRUE'
      : 'SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id LIMIT 1',
    ONLY_ACCOUNT ? [ONLY_ACCOUNT] : []
  );

  for (const account of accounts) {
    const full = await sync.getGmailAccount(account.user_id, account.id);
    if (!full) continue;
    const { gmail: gmailApi } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
    const gmail = gmailApi({ version: 'v1', auth: oauth2 });

    // Tous les identifiants de messages Airbnb côté Gmail
    const gmailMsgIds = new Set();
    let pageToken = null;
    do {
      const res = await gmail.users.messages.list({ userId: 'me', q: 'from:airbnb', maxResults: 500, ...(pageToken && { pageToken }) });
      for (const m of res.data.messages || []) gmailMsgIds.add(m.id);
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    // Tous ceux stockés pour ce compte
    const rows = await db.query(
      `SELECT DISTINCT m.gmail_message_id
         FROM messages m
         JOIN gmail_threads gt ON gt.conversation_id = m.conversation_id
        WHERE gt.gmail_account_id = ? AND m.gmail_message_id IS NOT NULL`,
      [account.id]
    );
    const dbIds = new Set(rows.map((r) => r.gmail_message_id));

    const missing = [...gmailMsgIds].filter((id) => !dbIds.has(id));

    console.log(`\n=== Compte #${account.id} (user ${account.user_id}) ===`);
    console.log(`  messages Airbnb chez Gmail : ${gmailMsgIds.size}`);
    console.log(`  messages en base           : ${dbIds.size}`);
    console.log(`  JAMAIS importés            : ${missing.length}`);

    if (!missing.length) continue;

    // Classer un échantillon par cause
    const causes = {};
    const examples = [];
    const sample = missing.slice(0, 120);
    for (let i = 0; i < sample.length; i += 20) {
      const batch = sample.slice(i, i + 20);
      const msgs = await Promise.all(batch.map((id) =>
        gmail.users.messages.get({ userId: 'me', id, format: 'full' }).then((r) => r.data).catch(() => null)
      ));
      for (const m of msgs) {
        if (!m) continue;
        const headers = {};
        for (const h of (m.payload.headers || [])) headers[h.name.toLowerCase()] = h.value;
        const body = sync.__extractBody(m);
        let cause;
        if (!body.trim()) cause = 'corps vide';
        else if (!String(sync.__extractAirbnbMessage(body)).trim()) cause = 'parser Airbnb vide';
        else cause = 'contenu exploitable — non importé';
        causes[cause] = (causes[cause] || 0) + 1;
        if (examples.length < 12 && cause === 'contenu exploitable — non importé') {
          examples.push(`    "${(headers.subject || '').slice(0, 72)}"  (${headers.date})`);
        }
      }
    }
    console.log(`  causes sur ${sample.length} échantillons :`);
    for (const [c, n] of Object.entries(causes)) console.log(`    ${c} : ${n}`);
    if (examples.length) {
      console.log('  exemples non importés malgré un contenu :');
      for (const e of examples) console.log(e);
    }
  }

  process.exit(0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

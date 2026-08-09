#!/usr/bin/env node
/**
 * AUDIT LECTURE SEULE : quels messages Gmail ne sont pas dans la base ?
 *
 * Répond précisément à « il me manque 2 ou 3 messages par conversation ».
 * Pour chaque fil Gmail déjà rattaché à une conversation, compare la liste des
 * message-ids côté Gmail à celle stockée, et classe chaque manquant par cause :
 *
 *   corps-vide        le MIME ne donne aucun texte              (ignoré au sync)
 *   parser-vide       extractAirbnbMessage() ne rend rien       (ignoré au sync)
 *   absent            présent chez Gmail, jamais inséré         (à expliquer)
 *
 * N'écrit rien, n'envoie rien.
 *
 *   node scripts/audit-missing-messages.js [--limit 60] [--account 2]
 */

require('dotenv').config();

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : 60;
const accIdx = process.argv.indexOf('--account');
const ONLY_ACCOUNT = accIdx > -1 ? parseInt(process.argv[accIdx + 1], 10) : null;

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const gmailSync = require('../server/services/gmailSyncService');
  const internals = require('../server/services/gmailSyncService');

  await initDatabase();
  const db = getDatabase();

  const accounts = await db.query(
    ONLY_ACCOUNT
      ? 'SELECT id, user_id, email FROM gmail_accounts WHERE id = ? AND is_active = TRUE'
      : 'SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id',
    ONLY_ACCOUNT ? [ONLY_ACCOUNT] : []
  );

  const tally = { threads: 0, gmailMsgs: 0, dbMsgs: 0, missing: 0, emptyBody: 0, parserEmpty: 0, unexplained: 0 };
  const samples = [];

  for (const account of accounts) {
    const full = await gmailSync.getGmailAccount(account.user_id, account.id);
    if (!full) continue;
    const { gmail: gmailApi } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
    const gmail = gmailApi({ version: 'v1', auth: oauth2 });

    // Fils les plus actifs d'abord : c'est là qu'un trou se voit.
    const threads = await db.query(
      `SELECT gt.gmail_thread_id, gt.conversation_id, COUNT(m.id) AS stored
         FROM gmail_threads gt
         LEFT JOIN messages m ON m.conversation_id = gt.conversation_id
        WHERE gt.gmail_account_id = ?
        GROUP BY gt.gmail_thread_id, gt.conversation_id
        ORDER BY stored DESC
        LIMIT ?`,
      [account.id, LIMIT]
    );

    console.log(`\nCompte #${account.id} — ${threads.length} fils audités`);

    for (const t of threads) {
      let data;
      try {
        const res = await gmail.users.threads.get({ userId: 'me', id: t.gmail_thread_id, format: 'full' });
        data = res.data;
      } catch (_) { continue; }
      const gmsgs = data.messages || [];
      tally.threads++;
      tally.gmailMsgs += gmsgs.length;

      const stored = await db.query(
        'SELECT gmail_message_id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL',
        [t.conversation_id]
      );
      const storedIds = new Set(stored.map((r) => r.gmail_message_id));
      tally.dbMsgs += storedIds.size;

      for (const gm of gmsgs) {
        if (storedIds.has(gm.id)) continue;
        tally.missing++;

        let body = '';
        try { body = internals.__extractBody ? internals.__extractBody(gm) : ''; } catch (_) {}
        // Repli : décodage minimal si le service n'expose pas son helper
        if (!body) body = decodeBody(gm.payload);

        const headers = {};
        for (const h of (gm.payload && gm.payload.headers) || []) headers[h.name.toLowerCase()] = h.value;

        let cause;
        if (!body.trim()) { cause = 'corps-vide'; tally.emptyBody++; }
        else {
          const cleaned = internals.__extractAirbnbMessage ? internals.__extractAirbnbMessage(body) : body;
          if (!String(cleaned).trim()) { cause = 'parser-vide'; tally.parserEmpty++; }
          else { cause = 'absent'; tally.unexplained++; }
        }

        if (samples.length < 25) {
          samples.push({
            conv: t.conversation_id,
            subject: (headers.subject || '').slice(0, 70),
            date: headers.date,
            cause,
            bodyLen: body.length,
          });
        }
      }
    }
  }

  console.log('\n=== RÉSULTAT ===');
  console.log(`fils audités        : ${tally.threads}`);
  console.log(`messages chez Gmail : ${tally.gmailMsgs}`);
  console.log(`messages en base    : ${tally.dbMsgs}`);
  console.log(`manquants           : ${tally.missing}`);
  console.log(`  dont corps vide   : ${tally.emptyBody}`);
  console.log(`  dont parser vide  : ${tally.parserEmpty}`);
  console.log(`  dont inexpliqués  : ${tally.unexplained}`);

  console.log('\n=== ÉCHANTILLON ===');
  for (const s of samples) {
    console.log(`  conv${s.conv} [${s.cause}] len=${s.bodyLen} "${s.subject}"`);
  }

  process.exit(0);

  function decodeBody(part) {
    if (!part) return '';
    if (part.body && part.body.data) {
      const raw = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (part.mimeType === 'text/html') return raw.replace(/<[^>]+>/g, ' ');
      return raw;
    }
    for (const p of part.parts || []) {
      const r = decodeBody(p);
      if (r) return r;
    }
    return '';
  }
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

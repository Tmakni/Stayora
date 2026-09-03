#!/usr/bin/env node
/**
 * AUDIT LECTURE SEULE : quels messages Gmail ne sont pas dans la base ?
 *
 * Répond précisément à « il me manque 2 ou 3 messages par conversation ».
 * Pour chaque fil Gmail déjà rattaché à une conversation, compare la liste des
 * message-ids côté Gmail à celle stockée, et classe chaque manquant par cause :
 *
 *   corps-vide        le MIME ne donne aucun texte              (placeholder stocké)
 *   parser-vide       le découpage ne rend rien                 (placeholder stocké)
 *   absent            présent chez Gmail, jamais inséré         (à expliquer)
 *
 * IMPORTANT — un e-mail Airbnb peut porter PLUSIEURS messages (blocs
 * « nom / rôle / texte »). Comparer 1 e-mail à 1 ligne déclarait complet un fil
 * amputé de 2 ou 3 messages : c'était précisément le symptôme signalé. L'audit
 * compte donc les MESSAGES extraits (services/airbnbMessageBlocks.js), et
 * reporte chaque étape de la chaîne séparément.
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

  const tally = {
    threads: 0,          // 1. fils Gmail relus
    gmailMsgs: 0,        // 2. identifiants renvoyés par Gmail
    downloaded: 0,       // 3. e-mails effectivement téléchargés en entier
    extracted: 0,        // 4. messages Airbnb extraits de ces e-mails
    dbMsgs: 0,           // 5. lignes présentes en base pour ces conversations
    missing: 0, emptyBody: 0, parserEmpty: 0, unexplained: 0,
    multiBlockMails: 0,  // e-mails portant plus d'un message
  };
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
      tally.downloaded += gmsgs.filter((m) => m && m.payload).length;

      const stored = await db.query(
        'SELECT gmail_message_id FROM messages WHERE conversation_id = ? AND gmail_message_id IS NOT NULL',
        [t.conversation_id]
      );
      const storedIds = new Set(stored.map((r) => r.gmail_message_id));
      tally.dbMsgs += storedIds.size;

      for (const gm of gmsgs) {
        let body = '';
        try { body = internals.__extractBody ? internals.__extractBody(gm) : ''; } catch (_) {}
        // Repli : décodage minimal si le service n'expose pas son helper
        if (!body) body = decodeBody(gm.payload);

        const headers = {};
        for (const h of (gm.payload && gm.payload.headers) || []) headers[h.name.toLowerCase()] = h.value;

        // Étape 4 : découpage réel du sync — un e-mail peut rendre N messages.
        const parts = internals.__buildStorableParts({
          gmailMessageId: gm.id,
          body,
          isAirbnb: true,
          subject: headers.subject || '',
          fallbackRole: 'incoming',
          baseDateMs: parseInt(gm.internalDate, 10) || Date.now(),
        });
        tally.extracted += parts.length;
        if (parts.length > 1) tally.multiBlockMails++;

        for (const part of parts) {
          if (storedIds.has(part.key)) continue;
          tally.missing++;

          let cause;
          if (!body.trim()) { cause = 'corps-vide'; tally.emptyBody++; }
          else if (part.unreadable) { cause = 'parser-vide'; tally.parserEmpty++; }
          else { cause = 'absent'; tally.unexplained++; }

          if (samples.length < 25) {
            samples.push({
              conv: t.conversation_id,
              subject: (headers.subject || '').slice(0, 70),
              date: headers.date,
              cause,
              bodyLen: body.length,
              block: part.blockIndex,
              quoted: part.quoted,
            });
          }
        }
      }
    }
  }

  console.log('\n=== RÉSULTAT ===');
  console.log(`1. fils Gmail relus        : ${tally.threads}`);
  console.log(`2. identifiants Gmail      : ${tally.gmailMsgs}`);
  console.log(`3. e-mails téléchargés     : ${tally.downloaded}`);
  console.log(`4. messages Airbnb extraits: ${tally.extracted}  (dont ${tally.multiBlockMails} e-mail(s) multi-messages)`);
  console.log(`5. lignes en base          : ${tally.dbMsgs}`);
  console.log(`manquants           : ${tally.missing}`);
  console.log(`  dont corps vide   : ${tally.emptyBody}`);
  console.log(`  dont parser vide  : ${tally.parserEmpty}`);
  console.log(`  dont inexpliqués  : ${tally.unexplained}`);

  console.log('\n=== ÉCHANTILLON ===');
  for (const s of samples) {
    const where = s.block === null || s.block === undefined ? '' : ` bloc#${s.block}${s.quoted ? ' (rappelé)' : ''}`;
    console.log(`  conv${s.conv} [${s.cause}]${where} len=${s.bodyLen} "${s.subject}"`);
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

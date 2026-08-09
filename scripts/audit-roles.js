#!/usr/bin/env node
/**
 * AUDIT LECTURE SEULE du classement hôte/voyageur.
 *
 * Le sync range chaque message en 'incoming' (voyageur) ou 'outgoing' (hôte).
 * Un mauvais classement a trois effets visibles : le message s'affiche du
 * mauvais côté du fil, il n'apparaît plus comme « message du voyageur », et
 * surtout il ne déclenche aucune réponse automatique.
 *
 * Ce script relit les vrais corps depuis Gmail, rejoue le classificateur et
 * le compare au bloc de rôle réellement présent dans l'e-mail Airbnb.
 *
 *   node scripts/audit-roles.js [--limit 40]
 *
 * N'écrit rien, n'envoie rien.
 */

require('dotenv').config();

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : 40;

/** Rôle annoncé par Airbnb juste avant le texte du message. */
function declaredRole(body) {
  const guest = body.search(/\n\s*(?:Voyageur|Guest|Traveler)\s*\n/i);
  const host = body.search(/\n\s*(?:H[ôo]te|Host|Co-?h[ôo]te|Co-?host|Superhost|Super-?h[ôo]te)\s*\n/i);
  if (guest === -1 && host === -1) return { role: null, guest, host };
  if (guest === -1) return { role: 'outgoing', guest, host };
  if (host === -1) return { role: 'incoming', guest, host };
  // Les deux présents : celui qui vient EN PREMIER précède le message.
  return { role: guest < host ? 'incoming' : 'outgoing', guest, host };
}

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const sync = require('../server/services/gmailSyncService');
  await initDatabase();
  const db = getDatabase();

  const accounts = await db.query('SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id');
  const stats = { total: 0, agree: 0, disagree: 0, noRoleBlock: 0, bothPresent: 0 };
  const samples = [];

  for (const account of accounts) {
    const full = await sync.getGmailAccount(account.user_id, account.id);
    if (!full) continue;
    const { gmail: gmailApi } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
    const gmail = gmailApi({ version: 'v1', auth: oauth2 });

    const rows = await db.query(
      `SELECT m.id, m.gmail_message_id, m.role, m.conversation_id, substr(m.content, 1, 90) AS snippet
         FROM messages m
         JOIN gmail_threads gt ON gt.conversation_id = m.conversation_id
        WHERE gt.gmail_account_id = ? AND m.gmail_message_id IS NOT NULL
        ORDER BY m.id DESC LIMIT ?`,
      [account.id, LIMIT]
    );

    for (const r of rows) {
      let msg;
      try {
        const res = await gmail.users.messages.get({ userId: 'me', id: r.gmail_message_id, format: 'full' });
        msg = res.data;
      } catch (_) { continue; }

      const body = sync.__extractBody(msg);
      const headers = {};
      for (const h of (msg.payload && msg.payload.headers) || []) headers[h.name.toLowerCase()] = h.value;

      const declared = declaredRole(body);
      const computed = sync.__detectAirbnbMessageRole(headers.subject || '', body, account.email);
      stats.total++;
      if (declared.guest > -1 && declared.host > -1) stats.bothPresent++;

      if (!declared.role) { stats.noRoleBlock++; continue; }
      if (declared.role === computed) stats.agree++;
      else {
        stats.disagree++;
        if (samples.length < 15) {
          samples.push({
            conv: r.conversation_id,
            stored: r.role,
            computed,
            declared: declared.role,
            posGuest: declared.guest,
            posHost: declared.host,
            subject: (headers.subject || '').slice(0, 60),
            snippet: (r.snippet || '').replace(/\s+/g, ' ').slice(0, 80),
          });
        }
      }
    }
  }

  console.log('\n=== CLASSEMENT HÔTE / VOYAGEUR ===');
  console.log(`messages testés                : ${stats.total}`);
  console.log(`bloc de rôle absent            : ${stats.noRoleBlock}`);
  console.log(`les deux rôles dans le corps   : ${stats.bothPresent}`);
  console.log(`accord classificateur/Airbnb   : ${stats.agree}`);
  console.log(`DÉSACCORD                      : ${stats.disagree}`);

  if (samples.length) {
    console.log('\n=== ÉCHANTILLON DES DÉSACCORDS ===');
    for (const s of samples) {
      console.log(`  conv${s.conv} stocké=${s.stored} calculé=${s.computed} MAIS Airbnb annonce=${s.declared}`);
      console.log(`    (position Voyageur=${s.posGuest}, Hôte=${s.posHost})  "${s.subject}"`);
      console.log(`    contenu: ${s.snippet}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

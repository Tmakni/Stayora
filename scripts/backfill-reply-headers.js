#!/usr/bin/env node
/**
 * Rattrape les en-têtes de réponse (Reply-To, Message-ID, References, Subject)
 * sur les messages déjà en base.
 *
 * Pourquoi ce script existe : la capture des en-têtes ajoutée par la migration
 * 017 ne s'exécute qu'à l'INSERT d'un message. Tous les messages synchronisés
 * avant 017 ont donc email_reply_to = NULL, et sans adresse de réponse
 * vérifiée l'envoi est refusé (par conception : le destinataire ne peut venir
 * que d'un en-tête Gmail authentifié). Ce script relit ces en-têtes depuis
 * Gmail et remplit les colonnes manquantes.
 *
 *   node scripts/backfill-reply-headers.js            # tous les comptes actifs
 *   node scripts/backfill-reply-headers.js --dry-run  # n'écrit rien
 *   node scripts/backfill-reply-headers.js --account 1
 *
 * N'ENVOIE RIEN. Lit Gmail en format=metadata (en-têtes seuls, pas de corps)
 * et n'écrit que les 4 colonnes d'en-tête sur nos propres lignes.
 * Les adresses complètes ne sont jamais affichées : le local-part encode un
 * identifiant privé de fil Airbnb.
 */

require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const accountArgIdx = process.argv.indexOf('--account');
const ONLY_ACCOUNT = accountArgIdx > -1 ? parseInt(process.argv[accountArgIdx + 1], 10) : null;

const METADATA_HEADERS = ['Reply-To', 'Message-ID', 'References', 'Subject', 'From'];
const BATCH_SIZE = 10;

function mask(addr) {
  if (!addr) return '(vide)';
  return String(addr).replace(/([^\s<>,;:"]+)@([^\s<>,;:"]+)/g, (_f, local, domain) =>
    `${local.slice(0, 1)}${'*'.repeat(Math.min(Math.max(local.length - 2, 1), 10))}@${domain}`);
}

function headerMap(payloadHeaders) {
  const out = {};
  for (const h of payloadHeaders || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const gmailSync = require('../server/services/gmailSyncService');

  await initDatabase();
  const db = getDatabase();

  const accounts = await db.query(
    ONLY_ACCOUNT
      ? 'SELECT id, user_id, email FROM gmail_accounts WHERE id = ? AND is_active = TRUE'
      : 'SELECT id, user_id, email FROM gmail_accounts WHERE is_active = TRUE ORDER BY id',
    ONLY_ACCOUNT ? [ONLY_ACCOUNT] : []
  );

  if (!accounts.length) {
    console.error('Aucun compte Gmail actif.');
    process.exit(1);
  }

  console.log(DRY_RUN ? '=== SIMULATION (aucune écriture) ===\n' : '=== RATTRAPAGE DES EN-TÊTES ===\n');

  // Statistique transverse : le jeton Reply-To est-il stable par conversation ?
  // S'il l'était, il ferait une clé de regroupement bien plus fiable que l'URL
  // du bouton rose. On mesure au lieu de supposer.
  const tokensByConversation = new Map();
  let grandTotal = 0;
  let grandFilled = 0;

  for (const account of accounts) {
    // Seuls les messages des conversations de CE compte, via gmail_threads :
    // l'isolation par compte doit tenir aussi dans un script de maintenance.
    const rows = await db.query(
      `SELECT m.id, m.gmail_message_id, m.conversation_id
         FROM messages m
         JOIN gmail_threads gt ON gt.conversation_id = m.conversation_id
        WHERE gt.gmail_account_id = ?
          AND m.gmail_message_id IS NOT NULL
          AND m.email_reply_to IS NULL
          AND m.email_message_id IS NULL
        GROUP BY m.id, m.gmail_message_id, m.conversation_id`,
      [account.id]
    );

    console.log(`Compte #${account.id} ${mask(account.email)} → ${rows.length} message(s) à compléter`);
    if (!rows.length) continue;

    // Réutilise le client authentifié du service (rafraîchit le token au besoin)
    const full = await gmailSync.getGmailAccount(account.user_id, account.id);
    if (!full) { console.log('  compte introuvable/inactif, ignoré'); continue; }
    const { gmail: gmailApi } = require('@googleapis/gmail');
    const { OAuth2Client } = require('google-auth-library');
    const oauth2 = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    oauth2.setCredentials({ access_token: full.access_token, refresh_token: full.refresh_token });
    const gmail = gmailApi({ version: 'v1', auth: oauth2 });

    let filled = 0;
    let missing = 0;
    let gone = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((r) =>
        gmail.users.messages.get({
          userId: 'me',
          id: r.gmail_message_id,
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        }).then((res) => ({ row: r, data: res.data }))
          .catch((err) => ({ row: r, error: err }))
      ));

      for (const res of results) {
        if (res.error) {
          gone++;
          continue;
        }
        const h = headerMap(res.data.payload && res.data.payload.headers);
        const replyTo = h['reply-to'] || null;
        const messageId = h['message-id'] || null;
        const references = h['references'] || null;
        const subject = h['subject'] || null;

        if (!replyTo && !messageId) { missing++; continue; }

        if (replyTo) {
          const local = String(replyTo).replace(/.*<|>.*/g, '').split('@')[0];
          if (!tokensByConversation.has(res.row.conversation_id)) tokensByConversation.set(res.row.conversation_id, new Set());
          tokensByConversation.get(res.row.conversation_id).add(local);
        }

        if (!DRY_RUN) {
          await db.query(
            `UPDATE messages
                SET email_reply_to = COALESCE(email_reply_to, ?),
                    email_message_id = COALESCE(email_message_id, ?),
                    email_references = COALESCE(email_references, ?),
                    email_subject = COALESCE(email_subject, ?)
              WHERE id = ?`,
            [replyTo, messageId, references, subject, res.row.id]
          );
        }
        filled++;
      }
      process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length} traités…`);
    }

    console.log(`\n  complétés=${filled}  sans en-tête utile=${missing}  introuvables dans Gmail=${gone}`);
    grandTotal += rows.length;
    grandFilled += filled;
  }

  console.log(`\nTotal : ${grandFilled}/${grandTotal} messages complétés.`);

  // Le jeton Reply-To est-il un identifiant de fil réutilisable ?
  let stable = 0;
  let rotating = 0;
  for (const set of tokensByConversation.values()) {
    if (set.size === 1) stable++; else rotating++;
  }
  if (tokensByConversation.size) {
    console.log(`\nJeton Reply-To : ${stable} conversation(s) à jeton unique, ${rotating} à jetons multiples.`);
    console.log(rotating > stable
      ? '→ Le jeton tourne par message : inutilisable comme clé de regroupement.'
      : '→ Le jeton semble stable par conversation.');
  }

  if (!DRY_RUN) {
    const [{ c: ok }] = await db.query(
      'SELECT COUNT(DISTINCT conversation_id) AS c FROM messages WHERE email_reply_to IS NOT NULL'
    );
    console.log(`\nConversations désormais répondables par e-mail : ${ok}`);
  }

  process.exit(0);
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

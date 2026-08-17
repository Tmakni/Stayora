#!/usr/bin/env node
/**
 * Recolle les conversations Airbnb éclatées sur plusieurs fils Gmail.
 *
 * Pourquoi elles sont éclatées
 * ---------------------------
 * Les mails de notification Airbnb ne portent aucun en-tête References /
 * In-Reply-To. Gmail ne peut donc les regrouper que par SUJET — et Airbnb
 * réécrit le sujet au fil de la réservation :
 *
 *     "Demande d'information pour La Villa Cosy, 24–28 août"
 *  →  "Préapprobation pour La Villa Cosy, 24–28 août"
 *  →  "Réservation pour La Villa Cosy, 24–28 août"
 *
 * Chaque réécriture ouvre un NOUVEAU fil Gmail pour la MÊME conversation
 * Airbnb, et chaque nouveau fil créait sa propre conversation. L'hôte voit
 * alors deux ou trois messages là où Airbnb en affiche dix.
 *
 * Le sync corrige désormais le cas au fil de l'eau, mais seulement pour les
 * fils qui reçoivent encore du courrier : un fil déjà terminé ne sera jamais
 * resynchronisé. Ce script rattrape l'historique.
 *
 * Ce qu'il fait : regroupe les conversations d'un même utilisateur qui
 * partagent un airbnb_thread_id et les fusionne dans la plus ancienne. Les
 * messages déjà présents des deux côtés (même gmail_message_id) ne sont pas
 * dupliqués. Rien ne franchit jamais une frontière de compte.
 *
 *   node scripts/repair-split-conversations.js            # simulation
 *   node scripts/repair-split-conversations.js --apply    # applique
 *   node scripts/repair-split-conversations.js --apply --user 3
 */

require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const userIdx = process.argv.indexOf('--user');
const ONLY_USER = userIdx > -1 ? parseInt(process.argv[userIdx + 1], 10) : null;

(async () => {
  const { initDatabase, getDatabase } = require('../server/config/db');
  const gmailSync = require('../server/services/gmailSyncService');
  const mergeConversationInto = gmailSync.__mergeConversationInto;

  await initDatabase();
  const db = getDatabase();

  // Les groupes à recoller : même utilisateur, même fil Airbnb, plusieurs
  // conversations.
  const groups = await db.query(
    `SELECT user_id, airbnb_thread_id, COUNT(*) AS n
       FROM conversations
      WHERE airbnb_thread_id IS NOT NULL AND airbnb_thread_id <> ''
        ${ONLY_USER ? 'AND user_id = ?' : ''}
      GROUP BY user_id, airbnb_thread_id
     HAVING COUNT(*) > 1
      ORDER BY n DESC`,
    ONLY_USER ? [ONLY_USER] : []
  );

  if (groups.length === 0) {
    console.log('Aucune conversation éclatée à recoller.');
    process.exit(0);
  }

  console.log(`${groups.length} conversation(s) Airbnb éclatée(s) sur plusieurs fils Gmail.`);
  console.log(APPLY ? 'Mode: APPLICATION\n' : 'Mode: SIMULATION (ajoutez --apply pour écrire)\n');

  let mergedConversations = 0;
  let movedMessages = 0;

  for (const group of groups) {
    const convs = await db.query(
      `SELECT c.id,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
         FROM conversations c
        WHERE c.user_id = ? AND c.airbnb_thread_id = ?
        ORDER BY c.id ASC`,
      [group.user_id, group.airbnb_thread_id]
    );
    if (convs.length < 2) continue;

    const target = convs[0];
    const sources = convs.slice(1);
    const totalBefore = convs.reduce((sum, c) => sum + Number(c.msgs), 0);

    console.log(
      `user ${group.user_id} · fil Airbnb ${group.airbnb_thread_id} : ` +
      `${convs.map((c) => `#${c.id}(${c.msgs})`).join(' + ')} → #${target.id} (${totalBefore} messages)`
    );

    if (!APPLY) {
      mergedConversations += sources.length;
      continue;
    }

    for (const source of sources) {
      try {
        const moved = await mergeConversationInto(db, group.user_id, source.id, target.id);
        movedMessages += moved;
        mergedConversations++;
      } catch (err) {
        console.error(`  ✗ échec de la fusion #${source.id} → #${target.id} : ${err.message}`);
      }
    }

    const after = await db.query('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', [target.id]);
    console.log(`  ✓ #${target.id} contient maintenant ${after[0].n} message(s)`);
  }

  console.log('');
  if (APPLY) {
    console.log(`Terminé : ${mergedConversations} conversation(s) fusionnée(s), ${movedMessages} message(s) déplacé(s).`);
  } else {
    console.log(`Simulation : ${mergedConversations} conversation(s) seraient fusionnées. Relancez avec --apply.`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});

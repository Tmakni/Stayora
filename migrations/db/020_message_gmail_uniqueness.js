/**
 * Migration 020 — Un message Gmail = une ligne, garanti par la base
 *
 * LE DÉFAUT
 * ---------
 * La déduplication du sync était purement applicative :
 *
 *     SELECT gmail_message_id FROM messages WHERE conversation_id = ?   (lecture)
 *     ... if (!seen.has(id))                                            (décision)
 *     INSERT INTO messages ...                                          (écriture)
 *
 * Rien entre la lecture et l'écriture. Deux importateurs qui lisent avant que
 * l'autre n'écrive insèrent tous les deux, et le voyageur apparaît deux fois
 * dans le fil. Reproduit sur cette base : deux appels concurrents produisent
 * bien 2 lignes pour UN message Gmail.
 *
 * La fenêtre n'est pas théorique et vient de s'élargir : la passe de
 * réconciliation (019) relit les mêmes fils que le sync incrémental, et un
 * chevauchement de déploiement Render fait tourner deux processus sur le même
 * fichier SQLite pendant quelques secondes.
 *
 * LA CORRECTION
 * -------------
 * Un index UNIQUE sur (conversation_id, gmail_message_id) : le second INSERT
 * échoue au lieu de réussir, et l'appelant traite l'échec comme un doublon
 * (voir gmailSyncService). La garantie descend de « si le code est bien écrit »
 * à « la base le refuse ».
 *
 * Le couple choisi est exactement celui de la déduplication existante — portée
 * conversation, pas portée globale. Deux raisons :
 *   - un identifiant Gmail est unique dans UNE boîte, pas entre boîtes ; un
 *     UNIQUE global créerait une collision entre deux hôtes ;
 *   - les fusions de conversations repointent des messages d'une conversation
 *     vers une autre ; la portée conversation est celle que ce code manipule.
 *
 * NULL reste autorisé en plusieurs exemplaires (SQLite comme MySQL considèrent
 * les NULL distincts dans un index unique) : les messages saisis à la main et
 * les réponses envoyées avant d'avoir leur identifiant Gmail ne sont pas gênés.
 *
 * LES DONNÉES EXISTANTES
 * ----------------------
 * Un index unique ne peut pas être créé si des doublons existent déjà. Le
 * nettoyage ci-dessous garde la ligne la PLUS ANCIENNE de chaque groupe et,
 * avant de supprimer les autres, recopie sur elle les en-têtes de réponse
 * qu'elle n'aurait pas (email_reply_to, email_message_id, email_references,
 * email_subject). Aucune information n'est donc perdue : les lignes retirées
 * sont, par définition du couple, le MÊME message Gmail dans la MÊME
 * conversation, et tout en-tête présent seulement sur un doublon est récupéré.
 *
 * Le nombre de lignes concernées est journalisé pour être vérifiable après
 * coup. S'il est non nul, c'est la mesure du défaut en production.
 *
 * RETOUR ARRIÈRE
 * --------------
 * down() rétablit l'index non-unique d'origine. La suppression des doublons
 * n'est pas rejouée — ce serait réintroduire volontairement des lignes en
 * double, et l'information qu'elles portaient a été fusionnée sur la survivante.
 */

const UNIQUE_INDEX = 'uq_msg_conv_gmail';
const OLD_INDEX = 'idx_msg_conv_gmail_id';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('messages'))) return;
  if (!(await knex.schema.hasColumn('messages', 'gmail_message_id'))) return;

  // ── 1. Recenser les groupes en double ───────────────────────────────────
  const duplicates = await knex('messages')
    .select('conversation_id', 'gmail_message_id')
    .whereNotNull('gmail_message_id')
    .groupBy('conversation_id', 'gmail_message_id')
    .havingRaw('COUNT(*) > 1');

  let removed = 0;

  for (const group of duplicates) {
    const rows = await knex('messages')
      .select('id', 'email_reply_to', 'email_message_id', 'email_references', 'email_subject')
      .where({ conversation_id: group.conversation_id, gmail_message_id: group.gmail_message_id })
      .orderBy('id', 'asc');

    if (rows.length < 2) continue;

    const [survivor, ...losers] = rows;

    // Récupérer sur la survivante tout en-tête qu'elle n'a pas et qu'un
    // doublon porte : c'est ce qui rend la suppression sans perte.
    const patch = {};
    for (const field of ['email_reply_to', 'email_message_id', 'email_references', 'email_subject']) {
      if (survivor[field] == null) {
        const donor = losers.find((r) => r[field] != null);
        if (donor) patch[field] = donor[field];
      }
    }
    if (Object.keys(patch).length > 0) {
      await knex('messages').where('id', survivor.id).update(patch);
    }

    await knex('messages').whereIn('id', losers.map((r) => r.id)).del();
    removed += losers.length;
  }

  if (removed > 0) {
    console.log(`[020] ${removed} message(s) Gmail en double supprimé(s) sur ${duplicates.length} groupe(s) ; en-têtes fusionnés sur la ligne conservée.`);
  } else {
    console.log('[020] Aucun message Gmail en double dans cette base.');
  }

  // ── 2. Remplacer l'index non-unique par un index UNIQUE ─────────────────
  // L'ancien couvrait déjà exactement (conversation_id, gmail_message_id) ;
  // le garder à côté de l'unique ne servirait qu'à doubler le coût d'écriture.
  try {
    await knex.raw(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
  } catch (err) {
    console.warn(`[020] ancien index ${OLD_INDEX} non supprimé : ${err.message}`);
  }

  const isSqlite = knex.client.config.client.includes('sqlite');
  if (isSqlite) {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON messages (conversation_id, gmail_message_id)`
    );
  } else {
    // MySQL n'a pas IF NOT EXISTS sur CREATE INDEX : on tolère l'erreur de
    // duplication pour que la migration reste rejouable.
    try {
      await knex.raw(
        `CREATE UNIQUE INDEX ${UNIQUE_INDEX} ON messages (conversation_id, gmail_message_id)`
      );
    } catch (err) {
      if (!/duplicate key name|already exists/i.test(err.message)) throw err;
    }
  }

  console.log(`[020] Index UNIQUE ${UNIQUE_INDEX} (conversation_id, gmail_message_id) en place.`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('messages'))) return;

  try {
    await knex.raw(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);
  } catch (err) {
    // MySQL : syntaxe ALTER TABLE ... DROP INDEX
    try {
      await knex.raw(`ALTER TABLE messages DROP INDEX ${UNIQUE_INDEX}`);
    } catch (_) {
      // absent : rien à défaire
    }
  }

  const isSqlite = knex.client.config.client.includes('sqlite');
  try {
    if (isSqlite) {
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS ${OLD_INDEX} ON messages (conversation_id, gmail_message_id)`
      );
    } else {
      await knex.raw(`CREATE INDEX ${OLD_INDEX} ON messages (conversation_id, gmail_message_id)`);
    }
  } catch (err) {
    if (!/duplicate key name|already exists/i.test(err.message)) throw err;
  }
};

/**
 * Migration 013 — Nom du voyageur + index de synchronisation Gmail
 *
 * Trois volets :
 *
 * 1. PROVENANCE DU NOM
 *    conversations.guest_name_source / guest_name_confidence permettent au sync
 *    de n'écraser un nom stocké que par une source PLUS fiable
 *    (voir services/guestNameExtractor.js#shouldReplaceStoredName). Sans ces
 *    colonnes, deux passes de sync pourraient faire osciller une conversation
 *    entre deux voyageurs.
 *
 * 2. DÉ-DOUBLONNAGE DES MESSAGES
 *    messages.gmail_message_id sort l'identifiant Gmail de metadata_json pour
 *    le mettre dans une colonne indexée. L'ancien contrôle anti-doublon
 *    chargeait TOUS les metadata_json d'une conversation et les JSON.parse-ait
 *    à chaque thread de chaque cycle de sync. La valeur est recopiée depuis
 *    metadata_json pour les lignes existantes.
 *
 * 3. INDEX MANQUANTS sur les chemins chauds du sync et de la liste
 *    (gmail_threads.user_id, conversations.guest_name, messages.gmail_message_id).
 *
 * Le backfill des noms « Airbnb » déjà enregistrés est traité séparément par
 * 014_backfill_guest_names.js, qui a besoin du contenu des messages.
 *
 * Idempotent : suit le motif hasColumn / try-catch autour des index utilisé par
 * 008, 009 et 011, donc rejouable sans risque.
 */

exports.up = async function (knex) {
  // ── 1. Provenance du nom sur conversations ────────────────────────────
  const hasSource = await knex.schema.hasColumn('conversations', 'guest_name_source');
  if (!hasSource) {
    await knex.schema.table('conversations', (t) => {
      t.string('guest_name_source', 32).nullable();
    });
  }

  const hasConfidence = await knex.schema.hasColumn('conversations', 'guest_name_confidence');
  if (!hasConfidence) {
    await knex.schema.table('conversations', (t) => {
      t.integer('guest_name_confidence').notNullable().defaultTo(0);
    });
  }

  // ── 1bis. Noms d'hôte connus, par compte Gmail ────────────────────────
  // Airbnb imprime le rôle de l'expéditeur sous son nom ("DELPHINE / Co-hôte").
  // Les noms ainsi identifiés comme hôte/co-hôte sont accumulés au fil des
  // synchronisations et exclus des candidats "voyageur" : sans cela, un
  // voyageur qui écrit « Bonjour Delphine, » — surtout quand le rôle du message
  // a été mal détecté — fait passer le nom de l'HÔTE pour celui du voyageur.
  const hasHostNames = await knex.schema.hasColumn('gmail_accounts', 'host_names_json');
  if (!hasHostNames) {
    await knex.schema.table('gmail_accounts', (t) => {
      t.text('host_names_json').nullable();
    });
  }

  // ── 2. gmail_message_id dédié sur messages ────────────────────────────
  const hasGmailMsgId = await knex.schema.hasColumn('messages', 'gmail_message_id');
  if (!hasGmailMsgId) {
    await knex.schema.table('messages', (t) => {
      t.string('gmail_message_id', 128).nullable();
    });

    // Recopie l'id depuis metadata_json pour les messages déjà synchronisés.
    // JSON_EXTRACT existe sur MySQL 5.7+ et sur SQLite compilé avec JSON1
    // (le cas de better-sqlite3) ; en cas d'indisponibilité on retombe sur un
    // parsing applicatif par lots.
    try {
      await knex.raw(`
        UPDATE messages
        SET gmail_message_id = JSON_EXTRACT(metadata_json, '$.gmail_message_id')
        WHERE gmail_message_id IS NULL
          AND metadata_json IS NOT NULL
          AND JSON_EXTRACT(metadata_json, '$.gmail_message_id') IS NOT NULL
      `);
      // SQLite renvoie la valeur JSON entre guillemets sur certaines versions.
      await knex.raw(`
        UPDATE messages
        SET gmail_message_id = TRIM(gmail_message_id, '"')
        WHERE gmail_message_id LIKE '"%"'
      `);
    } catch (_) {
      await backfillGmailMessageIdsInJs(knex);
    }
  }

  // ── 3. Index des chemins chauds ───────────────────────────────────────
  await createIndex(knex, 'messages', (t) => t.index('gmail_message_id', 'idx_msg_gmail_id'));
  await createIndex(knex, 'messages', (t) => t.index(['conversation_id', 'gmail_message_id'], 'idx_msg_conv_gmail_id'));
  await createIndex(knex, 'conversations', (t) => t.index(['user_id', 'guest_name'], 'idx_conv_user_guest_name'));
  await createIndex(knex, 'conversations', (t) => t.index(['user_id', 'airbnb_thread_id'], 'idx_conv_user_airbnb_thread'));
  await createIndex(knex, 'gmail_threads', (t) => t.index('user_id', 'idx_gmail_threads_user'));
  await createIndex(knex, 'gmail_threads', (t) => t.index('conversation_id', 'idx_gmail_threads_conv'));
};

exports.down = async function (knex) {
  for (const [table, fn] of [
    ['messages', (t) => t.dropIndex('gmail_message_id', 'idx_msg_gmail_id')],
    ['messages', (t) => t.dropIndex(['conversation_id', 'gmail_message_id'], 'idx_msg_conv_gmail_id')],
    ['conversations', (t) => t.dropIndex(['user_id', 'guest_name'], 'idx_conv_user_guest_name')],
    ['conversations', (t) => t.dropIndex(['user_id', 'airbnb_thread_id'], 'idx_conv_user_airbnb_thread')],
    ['gmail_threads', (t) => t.dropIndex('user_id', 'idx_gmail_threads_user')],
    ['gmail_threads', (t) => t.dropIndex('conversation_id', 'idx_gmail_threads_conv')],
  ]) {
    try {
      await knex.schema.alterTable(table, fn);
    } catch (_) {
      // Index absent sur cet environnement — on ignore
    }
  }

  for (const [table, column] of [
    ['messages', 'gmail_message_id'],
    ['gmail_accounts', 'host_names_json'],
    ['conversations', 'guest_name_confidence'],
    ['conversations', 'guest_name_source'],
  ]) {
    try {
      if (await knex.schema.hasColumn(table, column)) {
        await knex.schema.table(table, (t) => t.dropColumn(column));
      }
    } catch (_) {}
  }
};

async function createIndex(knex, table, builder) {
  try {
    await knex.schema.alterTable(table, builder);
  } catch (_) {
    // Index déjà présent sur certains environnements — on ignore
  }
}

/**
 * Repli applicatif si JSON_EXTRACT n'est pas disponible.
 * Traité par lots pour ne pas charger toute la table en mémoire.
 */
async function backfillGmailMessageIdsInJs(knex) {
  const BATCH = 500;
  let lastId = 0;

  for (;;) {
    const rows = await knex('messages')
      .select('id', 'metadata_json')
      .whereNull('gmail_message_id')
      .whereNotNull('metadata_json')
      .andWhere('id', '>', lastId)
      .orderBy('id', 'asc')
      .limit(BATCH);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      let gmailId = null;
      try {
        gmailId = JSON.parse(row.metadata_json)?.gmail_message_id || null;
      } catch (_) {
        gmailId = null;
      }
      if (gmailId) {
        await knex('messages').where({ id: row.id }).update({ gmail_message_id: String(gmailId) });
      }
    }
  }
}

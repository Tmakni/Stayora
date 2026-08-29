/**
 * Migration 021 — Unicité des réservations par compte, et ménage des index
 *
 * ── 1. reservations.airbnb_reservation_id : UNIQUE global → UNIQUE par hôte ──
 *
 * L'unicité était posée sur la seule colonne airbnb_reservation_id, donc
 * VALABLE POUR TOUTE LA BASE. Or le co-hébergement est normal sur Airbnb : deux
 * hôtes peuvent légitimement voir la même réservation. Avec un UNIQUE global,
 * le second hôte ne peut pas l'enregistrer du tout.
 *
 * Pire, tant que les requêtes de recherche n'étaient pas filtrées par user_id
 * (corrigé dans airbnbSyncService), cet identifiant global faisait qu'un hôte
 * RETROUVAIT la ligne d'un autre et la mettait à jour — en y écrivant au
 * passage son propre property_id.
 *
 * (user_id, airbnb_reservation_id) est la vraie clé : unique dans un compte,
 * indépendante entre comptes. C'est un ASSOUPLISSEMENT — aucune donnée
 * existante ne peut le violer, puisque toute ligne satisfaisant l'ancienne
 * contrainte satisfait la nouvelle.
 *
 * ── 2. Index redondants ──────────────────────────────────────────────────
 *
 * Chaque index est un coût payé à CHAQUE écriture. Ceux retirés ici
 * n'apportent aucune lecture que l'index conservé ne serve déjà :
 *
 *   messages.idx_msg_conv_id (conversation_id)
 *       préfixe strict de idx_msg_conv_created (conversation_id, created_at)
 *   conversations.idx_conv_user_id (user_id)
 *       préfixe strict de idx_conv_user_updated (user_id, updated_at)
 *   property_profiles.idx_pp_user_listing
 *   property_profiles.idx_pp_user_airbnb_listing
 *       tous deux (user_id, airbnb_listing_id), déjà couvert par
 *       uniq_pp_user_listing — trois index pour une seule paire de colonnes
 *   gmail_threads.idx_gmail_threads_user (user_id)
 *       doublon exact de gmail_threads_user_id_index
 *
 * Un index préfixe n'est jamais nécessaire quand l'index composite existe : le
 * moteur utilise ce dernier pour toute requête sur la première colonne seule.
 * `messages` est la table la plus écrite de l'application (chaque
 * synchronisation Gmail y insère), donc c'est là que l'économie compte.
 *
 * Retirer un index ne peut pas casser une requête — seulement la ralentir si
 * l'analyse était fausse. down() les recrée à l'identique.
 */

const REDUNDANT = [
  ['messages', 'idx_msg_conv_id', 'conversation_id'],
  ['conversations', 'idx_conv_user_id', 'user_id'],
  ['property_profiles', 'idx_pp_user_listing', 'user_id, airbnb_listing_id'],
  ['property_profiles', 'idx_pp_user_airbnb_listing', 'user_id, airbnb_listing_id'],
  ['gmail_threads', 'idx_gmail_threads_user', 'user_id'],
];

const OLD_RES_UNIQUE = 'reservations_airbnb_reservation_id_unique';
const NEW_RES_UNIQUE = 'uq_res_user_airbnb_id';

function isSqlite(knex) {
  return knex.client.config.client.includes('sqlite');
}

/** DROP INDEX portable : SQLite connaît IF EXISTS, MySQL passe par ALTER TABLE. */
async function dropIndex(knex, table, name) {
  try {
    if (isSqlite(knex)) {
      await knex.raw(`DROP INDEX IF EXISTS ${name}`);
    } else {
      await knex.raw(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``);
    }
    return true;
  } catch (err) {
    if (/no such index|check that column\/key exists|doesn't exist/i.test(err.message)) return false;
    throw err;
  }
}

async function createIndex(knex, table, name, columns, { unique = false } = {}) {
  const kind = unique ? 'UNIQUE INDEX' : 'INDEX';
  try {
    if (isSqlite(knex)) {
      await knex.raw(`CREATE ${kind} IF NOT EXISTS ${name} ON ${table} (${columns})`);
    } else {
      await knex.raw(`CREATE ${kind} \`${name}\` ON \`${table}\` (${columns})`);
    }
  } catch (err) {
    if (!/duplicate key name|already exists/i.test(err.message)) throw err;
  }
}

exports.up = async function up(knex) {
  // ── 1. Unicité des réservations ─────────────────────────────────────────
  if (await knex.schema.hasTable('reservations')) {
    const duplicates = await knex('reservations')
      .select('user_id', 'airbnb_reservation_id')
      .whereNotNull('airbnb_reservation_id')
      .groupBy('user_id', 'airbnb_reservation_id')
      .havingRaw('COUNT(*) > 1');

    if (duplicates.length > 0) {
      // Ne devrait pas arriver (l'ancienne contrainte était plus stricte), mais
      // on ne pose jamais une contrainte à l'aveugle sur des données réelles.
      console.warn(
        `[021] ${duplicates.length} couple(s) (user_id, airbnb_reservation_id) en double — ` +
        'index unique NON créé. Nettoyer ces lignes puis rejouer la migration.'
      );
    } else {
      await dropIndex(knex, 'reservations', OLD_RES_UNIQUE);
      await createIndex(knex, 'reservations', NEW_RES_UNIQUE, 'user_id, airbnb_reservation_id', { unique: true });
      console.log(`[021] reservations : unicité désormais par hôte (${NEW_RES_UNIQUE}).`);
    }
  }

  // ── 2. Index redondants ─────────────────────────────────────────────────
  const dropped = [];
  for (const [table, name] of REDUNDANT) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await dropIndex(knex, table, name)) dropped.push(`${table}.${name}`);
  }
  console.log(
    dropped.length > 0
      ? `[021] Index redondants retirés : ${dropped.join(', ')}.`
      : '[021] Aucun index redondant à retirer.'
  );
};

exports.down = async function down(knex) {
  // Rétablir les index redondants tels qu'ils étaient.
  for (const [table, name, columns] of REDUNDANT) {
    if (!(await knex.schema.hasTable(table))) continue;
    await createIndex(knex, table, name, columns);
  }

  if (await knex.schema.hasTable('reservations')) {
    await dropIndex(knex, 'reservations', NEW_RES_UNIQUE);

    // Le retour à l'unicité GLOBALE ne peut réussir que si aucun identifiant de
    // réservation n'est partagé entre deux hôtes — situation que la migration
    // "up" rend précisément possible. On avertit plutôt que d'échouer.
    const shared = await knex('reservations')
      .select('airbnb_reservation_id')
      .whereNotNull('airbnb_reservation_id')
      .groupBy('airbnb_reservation_id')
      .havingRaw('COUNT(*) > 1');

    if (shared.length > 0) {
      console.warn(
        `[021] down : ${shared.length} identifiant(s) de réservation partagé(s) entre plusieurs hôtes — ` +
        'unicité globale non rétablie (elle est incompatible avec ces données).'
      );
      return;
    }
    await createIndex(knex, 'reservations', OLD_RES_UNIQUE, 'airbnb_reservation_id', { unique: true });
  }
};

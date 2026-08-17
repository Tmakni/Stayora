/**
 * Migration 018 — Uniformise le TYPE des colonnes de date
 *
 * Le problème
 * -----------
 * Deux chemins d'écriture alimentaient les mêmes colonnes avec deux types
 * différents :
 *
 *   — via NOW(), que db/database.js traduit en datetime('now') pour SQLite
 *     → TEXTE, au format 'YYYY-MM-DD HH:MM:SS' ;
 *   — via un objet Date lié en paramètre (le sync Gmail passait `msgDate`)
 *     → knex, sur le dialecte better-sqlite3, applique `binding.valueOf()`
 *       et écrit donc des MILLISECONDES ENTIÈRES.
 *
 * Relevé sur la base de développement avant correction :
 *   conversations.updated_at : 363 entiers, 188 textes
 *   messages.created_at      : 3475 entiers,  25 textes
 *
 * Pourquoi c'est visible par l'hôte
 * ---------------------------------
 * SQLite ordonne d'abord par TYPE, ensuite par valeur : NULL < INTEGER < TEXTE.
 * Dans `ORDER BY updated_at DESC` — le tri de la liste des conversations —
 * toute ligne datée en texte passe donc devant toute ligne datée en entier,
 * quelle que soit la date réelle. Sur le compte concerné, 188 conversations de
 * mars-mai masquaient 62 conversations d'août : les plus récentes étaient en
 * bas de la liste. Même effet sur l'ordre des messages à l'intérieur des 11
 * fils qui mélangeaient les deux formats.
 *
 * Ce que fait cette migration
 * ---------------------------
 * Elle réécrit les valeurs entières en texte UTC 'YYYY-MM-DD HH:MM:SS', le
 * format que produit déjà datetime('now'). Les lignes déjà en texte ne sont pas
 * touchées, ce qui rend la migration idempotente et rejouable sans risque.
 *
 * La source (gmailSyncService.toSqlDateTime) est corrigée en parallèle : sans
 * cela, le sync suivant réintroduirait des entiers.
 *
 * Uniquement SQLite : sur MySQL ces colonnes sont des DATETIME, le driver
 * mysql2 sérialise les Date correctement et le mélange de types ne peut pas se
 * produire.
 */

// Colonnes constatées mixtes. Les autres colonnes de date de la base
// (gmail_accounts.token_expires_at, password_reset_tokens.expires_at) sont
// homogènes en entier et ne sont JAMAIS triées ni comparées en SQL — elles ne
// sont lues qu'en JS via `new Date(x).getTime()`. Les convertir en texte les
// ferait relire comme des dates LOCALES par JS et décalerait l'expiration du
// jeton selon le fuseau : on les laisse délibérément telles quelles.
const TARGETS = [
  ['conversations', 'updated_at'],
  ['messages', 'created_at'],
];

function isSQLite(knex) {
  const c = knex.client.config.client;
  return c === 'sqlite3' || c === 'better-sqlite3';
}

exports.up = async function up(knex) {
  if (!isSQLite(knex)) {
    console.log('[018] Base non-SQLite : rien à normaliser.');
    return;
  }

  for (const [table, column] of TARGETS) {
    const exists = await knex.schema.hasColumn(table, column);
    if (!exists) {
      console.log(`[018] ${table}.${column} absente — ignorée.`);
      continue;
    }

    const [{ n }] = await knex.raw(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE typeof("${column}") = 'integer'`
    );
    if (!n) {
      console.log(`[018] ${table}.${column} : déjà homogène.`);
      continue;
    }

    // strftime attend des SECONDES ; les valeurs sont en millisecondes.
    // Le / est une division entière en SQLite, ce qui tronque à la seconde —
    // exactement la précision de datetime('now').
    await knex.raw(
      `UPDATE "${table}"
          SET "${column}" = strftime('%Y-%m-%d %H:%M:%S', "${column}" / 1000, 'unixepoch')
        WHERE typeof("${column}") = 'integer'`
    );

    const [{ reste }] = await knex.raw(
      `SELECT COUNT(*) AS reste FROM "${table}" WHERE typeof("${column}") = 'integer'`
    );
    console.log(`[018] ${table}.${column} : ${n} valeur(s) converties en texte, ${reste} entier(s) restant(s).`);
  }
};

exports.down = async function down() {
  // Volontairement sans effet : revenir en arrière consisterait à réécrire des
  // entiers dans une colonne de dates, c'est-à-dire à réintroduire le défaut de
  // tri que cette migration corrige. Le format texte est de toute façon celui
  // que produit NOW(), donc l'état « normalisé » est l'état attendu par le
  // reste du code.
};

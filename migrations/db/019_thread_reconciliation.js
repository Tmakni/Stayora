/**
 * Migration 019 — Réconciliation des fils Gmail
 *
 * Le sync incrémental est un mécanisme de RAPPEL : il ne voit que les fils dont
 * un message tombe dans la fenêtre `after:`. Toute la complétude repose donc sur
 * le fait que cette fenêtre ne se trompe jamais — or elle peut se tromper pour
 * des raisons qu'aucune précaution interne à un passage n'élimine : un 5xx
 * Gmail sur un seul threads.get, un redéploiement au milieu d'un run, un jeton
 * rafraîchi en cours de route, un décalage d'horloge, un message que Gmail
 * antidate dans une fenêtre déjà refermée.
 *
 * Quand elle se trompe, les messages ne sont pas en retard : ils sont perdus,
 * parce que plus rien ne relistera ce fil.
 *
 * `reconciled_at` porte la passe de rattrapage : gmailSyncService.reconcileThreads
 * relit périodiquement les fils déjà connus, du moins récemment vérifié au plus
 * récent, en ignorant complètement la fenêtre incrémentale. Un fil complet ne
 * produit aucune écriture (la déduplication se fait sur gmail_message_id) ; un
 * fil troué se remplit.
 *
 * NULL signifie « jamais réconcilié » et passe donc en tête de file, ce qui fait
 * que la première passe après cette migration couvre le passif existant.
 *
 * Idempotent : motif hasTable/hasColumn, comme les migrations précédentes.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('gmail_threads'))) return;

  if (!(await knex.schema.hasColumn('gmail_threads', 'reconciled_at'))) {
    await knex.schema.table('gmail_threads', (t) => {
      t.timestamp('reconciled_at').nullable();
    });
  }

  // L'ordre de sélection de la passe de réconciliation est
  // (gmail_account_id, reconciled_at) : sans index, chaque passe trie
  // l'intégralité des fils du compte.
  try {
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_gmail_threads_reconcile ON gmail_threads (gmail_account_id, reconciled_at)'
    );
  } catch (err) {
    // Un index déjà présent sous un autre nom ne doit pas bloquer la migration.
    console.warn(`[019] index de réconciliation non créé : ${err.message}`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('gmail_threads'))) return;

  try {
    await knex.raw('DROP INDEX IF EXISTS idx_gmail_threads_reconcile');
  } catch (_) {
    // L'index peut ne pas exister : rien à défaire.
  }

  if (await knex.schema.hasColumn('gmail_threads', 'reconciled_at')) {
    await knex.schema.table('gmail_threads', (t) => {
      t.dropColumn('reconciled_at');
    });
  }
};

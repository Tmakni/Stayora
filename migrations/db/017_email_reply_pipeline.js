/**
 * Migration 017 — Répondre au voyageur par e-mail (Gmail) + file d'envoi
 *
 * Confirmé manuellement : répondre à la notification Airbnb depuis Gmail fait
 * bien apparaître la réponse dans la conversation Airbnb. L'inspection des
 * headers réels (scripts/inspect-airbnb-headers.js) montre que :
 *
 *   From        Airbnb <express@airbnb.com>      ← jamais utilisable pour répondre
 *   Reply-To    4xxxxxxxxxxxx@reply.airbnb.com   ← jeton UNIQUE par message
 *   Message-ID  <xxx@geopod-ismtpd-NN>           ← nécessaire pour In-Reply-To
 *
 * Trois volets :
 *
 * 1. HEADERS. messages.email_reply_to / email_message_id / email_references
 *    conservent ce qu'il faut pour construire une vraie réponse RFC 5322.
 *    Le destinataire ne peut donc venir QUE d'un e-mail réellement reçu et
 *    rattaché à la conversation — jamais du frontend.
 *
 * 2. FILE D'ENVOI (outbound_replies). Un envoi n'est pas un appel HTTP : il doit
 *    survivre à un redémarrage, être repris, et surtout ne jamais partir deux
 *    fois. D'où un statut explicite, une clé d'idempotence UNIQUE par message
 *    voyageur déclencheur, et un verrou de worker.
 *
 * 3. RÉGLAGES. Mode d'envoi global (users) et par logement (property_profiles),
 *    en « validation manuelle » par défaut, plus un arrêt d'urgence global.
 *
 * Idempotent : motif hasTable/hasColumn + try-catch autour des index.
 */

exports.up = async function (knex) {
  // ── 1. Headers e-mail sur les messages ─────────────────────────────────
  const messageColumns = [
    // Adresse de réponse à jeton (reply.airbnb.com). Longue : jeton + domaine.
    ['email_reply_to', (t) => t.string('email_reply_to', 320).nullable()],
    // Message-ID RFC de l'e-mail reçu, pour In-Reply-To.
    ['email_message_id', (t) => t.string('email_message_id', 512).nullable()],
    // Chaîne References existante, à prolonger dans la réponse.
    ['email_references', (t) => t.text('email_references').nullable()],
    // Sujet original, pour construire « Re: … » sans le redériver.
    ['email_subject', (t) => t.string('email_subject', 998).nullable()],
  ];

  for (const [name, builder] of messageColumns) {
    if (!(await knex.schema.hasColumn('messages', name))) {
      await knex.schema.table('messages', builder);
    }
  }

  // ── 2. File d'envoi ────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('outbound_replies'))) {
    await knex.schema.createTable('outbound_replies', (t) => {
      t.increments('id').primary();

      // Rattachement strict. Les quatre sont obligatoires (sauf property_id,
      // qui peut légitimement manquer) pour qu'un envoi ne puisse jamais
      // traverser la frontière d'un compte.
      t.integer('user_id').notNullable();
      t.integer('gmail_account_id').notNullable();
      t.integer('conversation_id').notNullable();
      t.integer('property_id').nullable();

      // Message voyageur qui déclenche cette réponse.
      t.integer('trigger_message_id').nullable();

      // Clé d'idempotence : dérivée du message déclencheur. UNIQUE — c'est
      // elle qui rend impossible qu'une seconde synchronisation, un second
      // worker ou un double-clic créent une deuxième réponse au même message.
      t.string('idempotency_key', 190).notNullable().unique();

      // pending | sending | sent | failed | cancelled
      t.string('status', 16).notNullable().defaultTo('pending');
      // manual | auto — d'où vient la demande d'envoi.
      t.string('mode', 16).notNullable().defaultTo('manual');

      t.text('body_text').nullable();

      // Enveloppe figée au moment de la mise en file, recopiée depuis les
      // headers reçus (jamais depuis une requête client).
      t.string('to_address', 320).nullable();
      t.string('subject', 998).nullable();
      t.string('in_reply_to', 512).nullable();
      t.text('references_header').nullable();
      t.string('gmail_thread_id', 128).nullable();

      // Reprise sur erreur temporaire.
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('next_attempt_at').nullable();
      t.text('last_error').nullable();

      // Anti-rafale : on attend la fin de la salve du voyageur avant d'envoyer.
      t.timestamp('scheduled_at').nullable();

      // Verrou de worker (identifiant du process + date de prise).
      t.string('locked_by', 64).nullable();
      t.timestamp('locked_at').nullable();

      // Résultat.
      t.string('sent_gmail_message_id', 128).nullable();
      t.string('sent_gmail_thread_id', 128).nullable();
      t.timestamp('sent_at').nullable();

      // Trace de décision (intent, risque, raison d'un passage en manuel).
      t.text('decision_json').nullable();

      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  const indexes = [
    ['outbound_replies', (t) => t.index(['status', 'scheduled_at'], 'idx_outbound_status_sched')],
    ['outbound_replies', (t) => t.index(['conversation_id', 'status'], 'idx_outbound_conv_status')],
    ['outbound_replies', (t) => t.index(['user_id', 'status'], 'idx_outbound_user_status')],
    ['messages', (t) => t.index('email_reply_to', 'idx_msg_email_reply_to')],
  ];
  for (const [table, builder] of indexes) {
    try {
      await knex.schema.alterTable(table, builder);
    } catch (_) {
      // index déjà présent — on ignore
    }
  }

  // ── 2bis. Scopes réellement accordés par le compte Gmail ───────────────
  // Les comptes connectés avant l'ajout de gmail.send portent un token qui ne
  // permet PAS d'envoyer. Stocker les scopes permet de le dire à l'utilisateur
  // dans l'interface au lieu de laisser échouer le premier envoi.
  if (!(await knex.schema.hasColumn('gmail_accounts', 'granted_scopes'))) {
    await knex.schema.table('gmail_accounts', (t) => {
      t.text('granted_scopes').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('gmail_accounts', 'can_send'))) {
    await knex.schema.table('gmail_accounts', (t) => {
      // false par défaut : tant qu'on n'a pas VU le scope d'envoi, on suppose
      // qu'il manque. Mieux vaut demander une réautorisation inutile que
      // promettre un envoi impossible.
      t.boolean('can_send').notNullable().defaultTo(false);
    });
  }

  // ── 3. Réglages du mode d'envoi ────────────────────────────────────────
  // Global, par utilisateur. Volontairement 'manual' par défaut : l'envoi
  // automatique doit être un choix explicite.
  if (!(await knex.schema.hasColumn('users', 'auto_reply_mode'))) {
    await knex.schema.table('users', (t) => {
      t.string('auto_reply_mode', 16).notNullable().defaultTo('manual');
    });
  }
  // Arrêt d'urgence : coupe TOUT envoi automatique, quel que soit le réglage
  // des logements.
  if (!(await knex.schema.hasColumn('users', 'auto_reply_paused'))) {
    await knex.schema.table('users', (t) => {
      t.boolean('auto_reply_paused').notNullable().defaultTo(false);
    });
  }

  // Par logement. NULL = suit le réglage global.
  if (!(await knex.schema.hasColumn('property_profiles', 'auto_reply_mode'))) {
    await knex.schema.table('property_profiles', (t) => {
      t.string('auto_reply_mode', 16).nullable();
    });
  }
};

exports.down = async function (knex) {
  for (const [table, name] of [
    ['property_profiles', 'auto_reply_mode'],
    ['users', 'auto_reply_paused'],
    ['users', 'auto_reply_mode'],
    ['gmail_accounts', 'can_send'],
    ['gmail_accounts', 'granted_scopes'],
    ['messages', 'email_subject'],
    ['messages', 'email_references'],
    ['messages', 'email_message_id'],
    ['messages', 'email_reply_to'],
  ]) {
    try {
      if (await knex.schema.hasColumn(table, name)) {
        await knex.schema.table(table, (t) => t.dropColumn(name));
      }
    } catch (_) {}
  }

  try {
    await knex.schema.dropTableIfExists('outbound_replies');
  } catch (_) {}
};

/**
 * Migration 023 — Base de connaissances par logement : faits et preuves
 *
 * POURQUOI DEUX TABLES, ET PAS UN CHAMP DE PLUS DANS context_json
 * ---------------------------------------------------------------
 * La fiche d'un logement stocke déjà des dizaines de champs libres dans
 * `property_profiles.context_json`. On aurait pu y ajouter les informations
 * tirées des conversations. C'était le mauvais choix, pour une raison simple :
 * ce blob ne dit QUE la valeur. Or ici la valeur ne suffit pas — il faut savoir
 * d'où elle vient, sur combien de séjours, depuis quand, si elle est contredite,
 * et si l'utilisateur l'a confirmée. Sans ces colonnes, impossible de
 * distinguer « 16h, vu dans 14 réservations, 0 contradiction » de « 16h, vu une
 * fois ». La distinction est précisément l'objet du dispositif.
 *
 * `context_json` reste la vérité de la FICHE. `property_facts` est la mémoire
 * de ce qui a été observé et de sa solidité. Un fait n'est recopié dans la
 * fiche que lorsqu'il est suffisamment sûr — et l'inverse ne se produit jamais :
 * une valeur saisie à la main n'est pas écrasée par une observation.
 *
 * IDENTITÉ D'UN FAIT
 * ------------------
 * UNIQUE (property_id, fact_key). Une seule ligne par information et par
 * logement : c'est ce que l'écran de vérification montre, une carte par
 * information. Les valeurs concurrentes ne sont pas des lignes rivales — elles
 * vivent dans `alternatives_json`, avec leurs compteurs, parce qu'elles ne sont
 * pas des candidates à égalité : il y a une valeur proposée et des valeurs
 * écartées, et il faut pouvoir dire pourquoi.
 *
 * VIE PRIVÉE
 * ----------
 * `property_fact_evidence` conserve des RÉFÉRENCES (identifiant de fil,
 * identifiant de message, code de réservation, date) et un extrait court de la
 * phrase qui a servi de preuve. L'extrait est là parce que sans lui la
 * vérification serait aveugle : l'hôte doit pouvoir lire ce sur quoi Michel
 * s'appuie avant de confirmer. Il est borné à 240 caractères, plafonné à
 * quelques lignes par fait, et ne contient JAMAIS de message de voyageur —
 * seulement ce que l'hôte a écrit lui-même.
 *
 * TYPES UNSIGNED
 * --------------
 * `user_id` et `property_id` sont déclarés UNSIGNED, comme dans la migration
 * 007 et pour la même raison : `t.increments()` produit `int unsigned` sous
 * MySQL, qui refuse une clé étrangère dont le type diffère par le signe
 * (errno 150). SQLite ne l'aurait pas signalé.
 */

const FACTS = 'property_facts';
const EVIDENCE = 'property_fact_evidence';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_profiles'))) return;

  if (!(await knex.schema.hasTable(FACTS))) {
    await knex.schema.createTable(FACTS, (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().notNullable();
      t.integer('property_id').unsigned().notNullable();

      // Nom du champ de la fiche que ce fait renseigne (`check_in_time`,
      // `parking_info`…). Réutiliser le vocabulaire existant plutôt que d'en
      // inventer un second garantit qu'un fait confirmé sait où s'écrire.
      t.string('fact_key', 64).notNullable();
      t.text('fact_value').nullable();
      t.string('value_type', 16).notNullable().defaultTo('text');

      // 'host_messages' | 'quick_replies' | 'airbnb_export' | 'manual'
      t.string('source', 32).notNullable().defaultTo('host_messages');
      // 'stable' | 'semi_stable' | 'volatile' — décide de l'exigence de preuve.
      t.string('stability', 16).notNullable().defaultTo('semi_stable');

      // Deux axes INDÉPENDANTS, et c'est le point : un code de boîte à clés peut
      // avoir 100 de confiance et rester en REQUIRES_CONFIRMATION.
      t.integer('confidence').notNullable().defaultTo(0);
      // VERIFIED | HIGH_CONFIDENCE | CANDIDATE | UNSTABLE
      // | REQUIRES_CONFIRMATION | UNKNOWN
      t.string('status', 24).notNullable().defaultTo('CANDIDATE');

      t.integer('evidence_count').notNullable().defaultTo(0);
      t.integer('distinct_conversations').notNullable().defaultTo(0);
      t.integer('distinct_reservations').notNullable().defaultTo(0);
      t.integer('distinct_periods').notNullable().defaultTo(0);
      t.integer('contradiction_count').notNullable().defaultTo(0);
      t.integer('exception_count').notNullable().defaultTo(0);

      t.date('first_seen').nullable();
      t.date('last_seen').nullable();

      // Valeur antérieure quand un changement est détecté, et le drapeau qui
      // dit que la question est ouverte. Sans ces deux colonnes, un changement
      // d'horaire ne pourrait être présenté que comme une contradiction — alors
      // que c'est une information, pas un défaut.
      t.text('previous_value').nullable();
      t.boolean('possible_change').notNullable().defaultTo(false);
      // Les autres valeurs observées, avec leurs compteurs (JSON).
      t.text('alternatives_json').nullable();

      // Confirmation utilisateur : elle rend le fait prioritaire sur toute
      // analyse future (§17).
      t.timestamp('verified_at').nullable();
      t.string('verified_by', 16).nullable();     // 'user' | 'import'
      // Quand la valeur a effectivement été recopiée dans la fiche.
      t.timestamp('applied_at').nullable();

      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.foreign('user_id').references('users.id').onDelete('CASCADE');
      t.foreign('property_id').references('property_profiles.id').onDelete('CASCADE');

      // Une seule ligne par information et par logement.
      t.unique(['property_id', 'fact_key'], 'uq_fact_property_key');
      // L'écran de vérification liste « ce qui reste à confirmer » pour un
      // hôte : sans cet index, il balaierait les faits de tous les hôtes.
      t.index(['user_id', 'status'], 'idx_fact_user_status');
    });
    console.log(`[023] Table ${FACTS} créée.`);
  }

  if (!(await knex.schema.hasTable(EVIDENCE))) {
    await knex.schema.createTable(EVIDENCE, (t) => {
      t.increments('id').primary();
      t.integer('fact_id').unsigned().notNullable();
      t.integer('user_id').unsigned().notNullable();

      // Références permettant de retrouver la preuve dans l'export sans en
      // recopier le contenu.
      t.string('thread_ref', 64).nullable();
      t.string('message_ref', 64).nullable();
      t.string('reservation_code', 32).nullable();
      t.timestamp('observed_at').nullable();

      // CONFIRMATION | UPDATE | EXCEPTION
      t.string('kind', 16).notNullable().defaultTo('CONFIRMATION');
      t.text('value').nullable();
      // Extrait de la phrase de l'HÔTE. Borné, jamais un message de voyageur.
      t.string('snippet', 240).nullable();

      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.foreign('fact_id').references(`${FACTS}.id`).onDelete('CASCADE');
      t.foreign('user_id').references('users.id').onDelete('CASCADE');
      t.index(['fact_id'], 'idx_fact_evidence_fact');
    });
    console.log(`[023] Table ${EVIDENCE} créée.`);
  }
};

exports.down = async function down(knex) {
  // L'ordre importe : les preuves référencent les faits.
  await knex.schema.dropTableIfExists(EVIDENCE);
  await knex.schema.dropTableIfExists(FACTS);
};

/**
 * Migration 022 — Statut d'import d'un logement
 *
 * POURQUOI
 * --------
 * L'import en masse depuis l'archive de données personnelles Airbnb crée des
 * logements à partir d'un fichier, sans passage par le formulaire. Deux états
 * doivent être distingués :
 *
 *   'ready'              l'archive portait un identifiant d'annonce Airbnb.
 *                        Le logement est dédupliqué de façon fiable par
 *                        (user_id, airbnb_listing_id) et un ré-import le met à
 *                        jour au lieu de le dupliquer.
 *
 *   'needs_verification' l'archive ne portait AUCUN identifiant exploitable.
 *                        L'inventer serait pire que de ne rien mettre : le
 *                        logement est créé mais signalé, pour que l'hôte
 *                        confirme ou complète. C'est aussi ce qui l'empêche
 *                        d'être rattaché à tort aux messages d'une autre annonce.
 *
 * PAS DE NOUVELLE CONTRAINTE D'UNICITÉ
 * ------------------------------------
 * La contrainte demandée — UNIQUE(user_id, provider, external_listing_id) —
 * EXISTE DÉJÀ dans ce schéma sous une autre forme : la migration 016 pose
 * UNIQUE(user_id, airbnb_listing_id), et la colonne `source` porte le
 * fournisseur ('airbnb'). Ajouter une seconde contrainte équivalente créerait
 * deux vérités pour la même règle. On réutilise l'existante.
 *
 * NON DESTRUCTIF
 * --------------
 * Une seule colonne ajoutée, avec une valeur par défaut. Aucune ligne n'est
 * supprimée ni modifiée : les logements déjà présents (créés à la main ou par
 * l'import unitaire) sont marqués 'ready', ce qui est leur état réel — ils ont
 * été validés par l'utilisateur dans le formulaire.
 *
 * Idempotent : motif hasColumn / try-catch des migrations 008 à 021.
 */

const COLUMN = 'import_status';
const INDEX = 'idx_pp_user_import_status';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_profiles'))) return;

  if (!(await knex.schema.hasColumn('property_profiles', COLUMN))) {
    await knex.schema.table('property_profiles', (t) => {
      t.string(COLUMN, 32).notNullable().defaultTo('ready');
    });
    console.log(`[022] Colonne property_profiles.${COLUMN} ajoutée (défaut 'ready').`);
  }

  // La page « Mes logements » filtre sur les logements à vérifier ; sans index,
  // ce filtre balaie tous les logements de tous les hôtes.
  try {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS ${INDEX} ON property_profiles (user_id, ${COLUMN})`
    );
  } catch (err) {
    // MySQL n'a pas IF NOT EXISTS sur CREATE INDEX : on tolère la duplication.
    if (!/duplicate key name|already exists/i.test(err.message)) {
      console.warn(`[022] index ${INDEX} non créé : ${err.message}`);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_profiles'))) return;

  try {
    await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  } catch (_) {
    try {
      await knex.raw(`ALTER TABLE property_profiles DROP INDEX ${INDEX}`);
    } catch (__) {
      // absent : rien à défaire
    }
  }

  if (await knex.schema.hasColumn('property_profiles', COLUMN)) {
    await knex.schema.table('property_profiles', (t) => t.dropColumn(COLUMN));
  }
};

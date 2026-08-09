/**
 * Migration 016 — Un logement Airbnb ne peut exister qu'une fois par compte
 *
 * createProperty() et confirmImport() vérifiaient l'absence de doublon par un
 * SELECT suivi d'un INSERT. Entre les deux, rien n'empêchait une autre requête
 * de s'intercaler : c'est un TOCTOU classique. Reproduit ici sur trois imports
 * simultanés du MÊME listing → trois logements créés.
 *
 * L'index UNIQUE déplace la garantie dans la base, seul endroit où elle tient
 * réellement sous concurrence. Les contrôleurs interceptent la violation et
 * répondent 409 « existe déjà » (voir airbnbImportController / propertyController).
 *
 * NULL reste autorisé en multiple : SQLite comme MySQL considèrent les NULL
 * comme distincts dans un index unique, donc les logements créés à la main
 * (sans identifiant Airbnb) ne sont pas affectés.
 *
 * NON DESTRUCTIF : si des doublons existent déjà, l'index ne peut pas être créé.
 * Dans ce cas la migration ne supprime RIEN — elle journalise les groupes
 * concernés et laisse la décision à l'utilisateur. La migration reste
 * rejouable : une fois les doublons traités, la relancer crée l'index.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('property_profiles', 'airbnb_listing_id');
  if (!hasColumn) return;

  // Cherche les doublons existants avant de tenter l'index.
  const duplicates = await knex('property_profiles')
    .select('user_id', 'airbnb_listing_id')
    .count({ n: '*' })
    .whereNotNull('airbnb_listing_id')
    .andWhere('airbnb_listing_id', '<>', '')
    .groupBy('user_id', 'airbnb_listing_id')
    .havingRaw('COUNT(*) > 1');

  if (duplicates.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[016] Index unique NON créé : ${duplicates.length} logement(s) Airbnb en double détecté(s). ` +
      'Aucune donnée supprimée. Groupes concernés : ' +
      duplicates.map((d) => `user ${d.user_id} / listing ${d.airbnb_listing_id} (${d.n} lignes)`).join(', ') +
      '. Conservez un seul logement par groupe puis relancez les migrations.'
    );
    return;
  }

  try {
    await knex.schema.alterTable('property_profiles', (t) => {
      t.unique(['user_id', 'airbnb_listing_id'], { indexName: 'uniq_pp_user_listing' });
    });
    // eslint-disable-next-line no-console
    console.log('[016] Index unique (user_id, airbnb_listing_id) créé.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[016] Index unique non créé (${err.message}) — la vérification applicative reste active.`);
  }
};

exports.down = async function (knex) {
  try {
    await knex.schema.alterTable('property_profiles', (t) => {
      t.dropUnique(['user_id', 'airbnb_listing_id'], 'uniq_pp_user_listing');
    });
  } catch (_) {}
};

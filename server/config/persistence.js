const path = require('path');
const logger = require('../utils/logger');

/**
 * Contrôle de démarrage : l'application écrit-elle dans une base qui SURVIT au
 * déploiement ?
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Rien dans ce dépôt ne détruit de données : aucun DROP, aucun TRUNCATE, aucun
 * seed rejoué, aucune réinitialisation au démarrage. La perte de comptes après
 * un push ne vient pas du code, elle vient du SUPPORT.
 *
 * L'application a été déployée sur Render, où render.yaml monte un disque
 * persistant sur /data et pose SQLITE_DB_PATH=/data/airbnb_ai_agent.db. Ce
 * fichier n'est lu QUE par Render. Sur toute autre plateforme (Railway, Fly,
 * Cloud Run, un conteneur Docker nu), il n'est pas appliqué : SQLITE_DB_PATH
 * n'est plus défini, et knexfile.js retombe alors sur
 *
 *     ~/.local/share/airbnb-ai-agent/airbnb_ai_agent.db
 *
 * c'est-à-dire un chemin À L'INTÉRIEUR du conteneur. Le fichier est recréé vide
 * à chaque déploiement, et avec lui disparaissent les utilisateurs, les
 * logements, les conversations et les jetons Gmail.
 *
 * Le défaut n'est donc pas d'avoir choisi SQLite : c'est que l'application
 * démarrait sans rien dire dans les deux cas, et qu'il fallait perdre les
 * données pour découvrir lequel des deux on avait.
 *
 * CE QUE FAIT CE MODULE
 * ---------------------
 *   - il décrit la cible réelle (moteur, emplacement, persistance), sans jamais
 *     journaliser de mot de passe ni d'URL de connexion complète ;
 *   - en production, il REFUSE de démarrer sur une base éphémère, au lieu de
 *     laisser l'application accepter des inscriptions qu'un redéploiement
 *     effacera.
 *
 * L'échappatoire ALLOW_EPHEMERAL_DB=true existe pour les environnements
 * jetables (aperçu de branche, démonstration) où la perte est voulue. Elle est
 * bruyante à dessein.
 */

/**
 * Le chemin SQLite pointe-t-il vers un emplacement que l'opérateur a
 * explicitement choisi ?
 *
 * Le seul signal fiable est SQLITE_DB_PATH : le poser est un acte délibéré, et
 * c'est la variable que l'on renseigne pour viser un volume monté. Le repli
 * calculé par knexfile.js (le répertoire personnel, ou <projet>/data) est par
 * construction interne au conteneur.
 */
function sqlitePathIsDeclared() {
  return typeof process.env.SQLITE_DB_PATH === 'string' && process.env.SQLITE_DB_PATH.trim() !== '';
}

/**
 * Décrit la base réellement utilisée, sans secret.
 *
 * @returns {{engine: string, location: string, persistent: boolean, reason: string}}
 */
function describeDatabaseTarget(knexConfig) {
  const client = String(knexConfig?.client || 'inconnu');
  const connection = knexConfig?.connection;

  // ── MySQL ────────────────────────────────────────────────────────────────
  if (client.includes('mysql')) {
    // DATABASE_URL et les identifiants ne doivent JAMAIS être journalisés :
    // seul l'hôte et le nom de base le sont, ce qui suffit à vérifier la cible.
    if (typeof connection === 'object' && connection.uri) {
      let host = 'via DATABASE_URL';
      let database = '';
      try {
        const parsed = new URL(connection.uri);
        host = parsed.hostname;
        database = parsed.pathname.replace(/^\//, '');
      } catch (_) {
        // URL illisible : on n'en dit rien de plus, surtout pas son contenu.
      }
      return {
        engine: 'mysql',
        location: database ? `${host}/${database}` : host,
        persistent: true,
        reason: 'serveur MySQL externe',
      };
    }
    const host = (typeof connection === 'object' && connection.host) || 'hôte non défini';
    const database = (typeof connection === 'object' && connection.database) || '';
    return {
      engine: 'mysql',
      location: database ? `${host}/${database}` : host,
      persistent: true,
      reason: 'serveur MySQL externe',
    };
  }

  // ── SQLite ───────────────────────────────────────────────────────────────
  if (client.includes('sqlite')) {
    const filename = typeof connection === 'object' ? connection.filename : connection;

    if (!filename || filename === ':memory:') {
      return {
        engine: 'sqlite',
        location: ':memory:',
        persistent: false,
        reason: 'base en mémoire — tout est perdu à l\'arrêt du processus',
      };
    }

    if (!sqlitePathIsDeclared()) {
      return {
        engine: 'sqlite',
        location: path.resolve(filename),
        persistent: false,
        reason:
          'SQLITE_DB_PATH n\'est pas défini — emplacement par défaut. En local c\'est sans ' +
          'conséquence ; une fois déployé, ce chemin est interne au conteneur et le fichier ' +
          'est recréé vide à chaque déploiement',
      };
    }

    return {
      engine: 'sqlite',
      location: path.resolve(filename),
      persistent: true,
      reason: 'fichier SQLite sur un emplacement explicitement configuré (SQLITE_DB_PATH)',
    };
  }

  return {
    engine: client,
    location: 'inconnu',
    persistent: false,
    reason: `moteur non reconnu (${client})`,
  };
}

/**
 * Vérifie la cible et, en production, refuse de démarrer sur une base éphémère.
 *
 * Appelé AVANT les migrations : il ne sert à rien de migrer un fichier qui sera
 * effacé, et l'erreur doit précéder toute inscription d'utilisateur.
 *
 * @throws {Error} en production sur une base éphémère, sauf ALLOW_EPHEMERAL_DB=true
 */
function assertPersistentStorage(knexConfig, { isProd = false } = {}) {
  const target = describeDatabaseTarget(knexConfig);

  logger.info(
    `Base de données : ${target.engine} → ${target.location} ` +
    `(${target.persistent ? 'PERSISTANTE' : 'ÉPHÉMÈRE'} — ${target.reason})`
  );

  if (!isProd || target.persistent) return target;

  if (process.env.ALLOW_EPHEMERAL_DB === 'true') {
    logger.warn(
      'ALLOW_EPHEMERAL_DB=true : démarrage accepté sur une base ÉPHÉMÈRE en production. ' +
      'Les comptes, logements, conversations et jetons Gmail seront perdus au prochain déploiement.'
    );
    return target;
  }

  throw Object.assign(
    new Error(
      'Base de données ÉPHÉMÈRE en production — démarrage refusé.\n' +
      `  Cible actuelle : ${target.engine} → ${target.location}\n` +
      `  Raison         : ${target.reason}\n` +
      '\n' +
      '  Les données d\'un utilisateur ne doivent jamais disparaître au déploiement.\n' +
      '  Deux façons de corriger :\n' +
      '    1) SQLite sur volume — montez un disque persistant et posez\n' +
      '       SQLITE_DB_PATH=<point de montage>/airbnb_ai_agent.db\n' +
      '       (Render : voir render.yaml. Railway/Fly : créer un volume et le monter.)\n' +
      '    2) MySQL managé — USE_MEMORY_DB=false puis DB_HOST, DB_USER, DB_PASSWORD,\n' +
      '       DB_NAME (et DB_SSL=true chez la plupart des hébergeurs).\n' +
      '\n' +
      '  Sur un environnement volontairement jetable : ALLOW_EPHEMERAL_DB=true.'
    ),
    { stage: 'persistence', target }
  );
}

module.exports = {
  describeDatabaseTarget,
  assertPersistentStorage,
};

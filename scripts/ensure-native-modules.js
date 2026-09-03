/**
 * Modules natifs — le cas Windows + WSL sur le MÊME node_modules.
 *
 * LE PROBLÈME
 * -----------
 * Ce projet se lance tantôt depuis Windows, tantôt depuis WSL, sur le même
 * dossier (`C:\home\tom\...` = `/mnt/c/home/tom/...`). Or better-sqlite3 est un
 * module NATIF : son binaire `.node` est compilé pour UN système. Il ne peut y
 * en avoir qu'un dans node_modules, et celui qui gagne fait échouer l'autre :
 *
 *     invalid ELF header                 (binaire Windows, lancé sous Linux)
 *     is not a valid Win32 application   (binaire Linux, lancé sous Windows)
 *
 * DEUX PIÈGES QUI ONT MASQUÉ LA CAUSE
 * -----------------------------------
 * 1. `require('better-sqlite3')` NE CHARGE PAS l'addon. lib/database.js ne fait
 *    `require('bindings')('better_sqlite3.node')` qu'à la PREMIÈRE instanciation
 *    (`DEFAULT_ADDON`, résolu paresseusement). L'ancien prestart testait le
 *    require, qui réussissait toujours — l'erreur ressortait donc bien plus loin,
 *    au premier accès à la base, déguisée en « Database connection failed », ce
 *    qui envoyait chercher un problème de connexion inexistant.
 * 2. Sous WSL, `/mnt/c` est monté en 9p et node_modules n'y est PAS accessible en
 *    écriture (`EACCES` à l'ouverture, `EIO` à l'unlink), malgré un `rwxrwxrwx`
 *    affiché. `npm rebuild` ne peut donc PAS réparer en place depuis WSL : il
 *    échoue à mi-parcours et peut laisser le binaire dans un état pire qu'avant.
 *
 * LA CORRECTION
 * -------------
 * On ne touche plus jamais à node_modules. Chaque plateforme garde SON binaire
 * dans un cache versionné par (système, architecture, ABI Node) :
 *
 *     .native-cache/better-sqlite3/<systeme>-<arch>-node<abi>/better_sqlite3.node
 *
 * et on indique à better-sqlite3 lequel charger via son option `nativeBinding`,
 * que le dialecte better-sqlite3 de knex transmet tel quel (voir knexfile.js).
 * La racine du dépôt est accessible en écriture depuis les deux plateformes,
 * contrairement à node_modules.
 *
 * Le binaire manquant est approvisionné par une installation autonome dans un
 * dossier de travail : `prebuild-install` récupère le binaire précompilé de la
 * plateforme, sans compilateur ni node-gyp. Une seule fois par plateforme.
 *
 * En PRODUCTION (un seul système, image Docker), rien de tout cela ne se
 * déclenche : le binaire de node_modules est le bon, et `nativeBinding` reste
 * nul. Si malgré tout il ne charge pas, on échoue clairement plutôt que de
 * télécharger quoi que ce soit au démarrage d'un service en ligne.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.native-cache', 'better-sqlite3');
const BINARY_REL = path.join('build', 'Release', 'better_sqlite3.node');

/**
 * Identité de la plateforme d'exécution. `process.versions.modules` est l'ABI
 * Node : deux versions majeures de Node ne partagent pas un binaire natif, même
 * sur le même système — d'où sa présence dans la clé.
 */
function platformKey() {
  return `${process.platform}-${process.arch}-node${process.versions.modules}`;
}

/** Cette erreur dit-elle « mauvais binaire » plutôt que « module absent » ? */
function isBinaryMismatch(err) {
  const message = String((err && err.message) || '');
  return (
    message.includes('invalid ELF header') ||
    message.includes('not a valid Win32 application') ||
    message.includes('was compiled against a different') ||
    message.includes('wrong ELF class') ||
    message.includes('Exec format error') ||
    message.includes('mach-o') ||
    message.includes('incompatible architecture')
  );
}

function packageDir() {
  try {
    const pkg = require.resolve('better-sqlite3/package.json', { paths: [ROOT] });
    return path.dirname(pkg);
  } catch (_) {
    return path.join(ROOT, 'node_modules', 'better-sqlite3');
  }
}

function installedVersion() {
  try {
    return require(path.join(packageDir(), 'package.json')).version;
  } catch (_) {
    return null;
  }
}

function cachedBinaryPath(key) {
  return path.join(CACHE_DIR, key, 'better_sqlite3.node');
}

/**
 * Le binaire se charge-t-il VRAIMENT ?
 *
 * `:memory:` n'écrit rien sur le disque et ne touche à aucune donnée ; c'est le
 * seul moyen de forcer le chargement de l'addon (voir le piège n°1 en tête).
 *
 * @param {string|null} nativeBinding chemin explicite, ou null pour node_modules
 */
function tryLoad(nativeBinding) {
  let db;
  try {
    const Database = require('better-sqlite3');
    db = nativeBinding
      ? new Database(':memory:', { nativeBinding })
      : new Database(':memory:');
    return null;
  } catch (err) {
    return err;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

/** Archive le binaire de node_modules pour la plateforme courante. */
function archiveDefaultBinary(key, log) {
  const source = path.join(packageDir(), BINARY_REL);
  const target = cachedBinaryPath(key);
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    log(`[native] binaire better-sqlite3 archivé pour ${key}`);
  } catch (err) {
    // Purement une optimisation pour la prochaine bascule : sans conséquence.
    log(`[native] archivage impossible (${err.message}) — sans conséquence`);
  }
}

/**
 * Installe better-sqlite3 dans un dossier de travail à part et récupère son
 * binaire. `prebuild-install` télécharge le précompilé de la plateforme, donc
 * ni compilateur ni node-gyp ne sont nécessaires dans le cas courant.
 *
 * Rien n'est écrit dans node_modules : c'est ce qui rend l'opération possible
 * depuis WSL, où ce dossier est en lecture seule.
 */
function provisionBinary(key, log) {
  const version = installedVersion();
  if (!version) {
    log('[native] version de better-sqlite3 introuvable — approvisionnement abandonné');
    return false;
  }

  const workDir = path.join(CACHE_DIR, '.build', key);
  const produced = path.join(workDir, 'node_modules', 'better-sqlite3', BINARY_REL);

  try {
    fs.mkdirSync(workDir, { recursive: true });
    // package.json minimal INDISPENSABLE : sans lui, npm remonte l'arborescence,
    // trouve le package.json du projet et son node_modules, conclut « up to
    // date » et n'installe rien.
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'native-binary-workspace', version: '1.0.0', private: true }, null, 2)
    );
    log(`[native] récupération du binaire better-sqlite3@${version} pour ${key}…`);
    require('child_process').execSync(
      `npm install better-sqlite3@${version} --no-save --no-audit --no-fund --loglevel=error`,
      { cwd: workDir, stdio: 'inherit' }
    );

    if (!fs.existsSync(produced)) {
      log('[native] installation terminée mais aucun binaire produit');
      return false;
    }

    const target = cachedBinaryPath(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(produced, target);
    log(`[native] binaire ${key} installé dans le cache`);
    return true;
  } catch (err) {
    log(`[native] approvisionnement impossible : ${err.message}`);
    return false;
  } finally {
    // Le dossier de travail pèse plusieurs dizaines de mégaoctets et n'a plus
    // d'utilité une fois le binaire copié.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Mémoïsé : knexfile peut être requis plusieurs fois (migrations, tests,
// serveur), et l'approvisionnement ne doit se tenter qu'une fois par processus.
let resolved = null;

/**
 * S'assure que better-sqlite3 est utilisable, et rend le chemin de l'addon à
 * passer à `nativeBinding` (ou null quand celui de node_modules convient).
 *
 * Ne lève JAMAIS : un échec est rendu dans `ok`, pour que l'appelant décide
 * où et comment le signaler.
 *
 * @param {{log?: Function, force?: boolean}} [options]
 * @returns {{ok: boolean, nativeBinding: string|null, action: string, error?: Error}}
 */
function ensureBetterSqlite3({ log = console.log, force = false } = {}) {
  if (resolved && !force) return resolved;

  const key = platformKey();
  const isProd = (process.env.NODE_ENV || 'development') === 'production';

  // 1. Cas normal — le binaire de node_modules est celui de cette plateforme.
  //    C'est toujours le cas en production (image Docker, un seul système).
  let err = tryLoad(null);
  if (!err) {
    if (!isProd) archiveDefaultBinary(key, log);
    resolved = { ok: true, nativeBinding: null, action: 'none' };
    return resolved;
  }

  if (!isBinaryMismatch(err)) {
    // Module absent, bibliothèque système manquante… autre sujet, autre message.
    resolved = { ok: false, nativeBinding: null, action: 'failed', error: err };
    return resolved;
  }

  log(`[native] le binaire better-sqlite3 de node_modules n'est pas celui de ${key}`);

  // 2. Binaire déjà en cache pour cette plateforme : instantané.
  const cached = cachedBinaryPath(key);
  if (fs.existsSync(cached)) {
    err = tryLoad(cached);
    if (!err) {
      log(`[native] chargement depuis le cache (${key})`);
      resolved = { ok: true, nativeBinding: cached, action: 'cached' };
      return resolved;
    }
    log('[native] le binaire en cache ne se charge pas non plus');
  }

  // 3. Approvisionnement — jamais en production : un service en ligne ne doit
  //    pas se mettre à télécharger au démarrage. Il doit échouer clairement.
  if (isProd) {
    resolved = {
      ok: false,
      nativeBinding: null,
      action: 'failed',
      error: new Error(
        `better-sqlite3 n'est pas compilé pour ${key}. ` +
        'Reconstruisez l\'image (npm ci sur la plateforme cible) plutôt que de réparer à chaud.'
      ),
    };
    return resolved;
  }

  if (provisionBinary(key, log)) {
    err = tryLoad(cached);
    if (!err) {
      resolved = { ok: true, nativeBinding: cached, action: 'provisioned' };
      return resolved;
    }
  }

  resolved = { ok: false, nativeBinding: null, action: 'failed', error: err };
  return resolved;
}

/**
 * Chemin de l'addon à passer à better-sqlite3, ou null pour le comportement par
 * défaut. Utilisé par knexfile.js. Silencieux : le message détaillé est produit
 * par l'appel explicite fait au démarrage du serveur.
 */
function resolveNativeBinding() {
  const result = ensureBetterSqlite3({ log: () => {} });
  return result.nativeBinding;
}

module.exports = {
  ensureBetterSqlite3,
  resolveNativeBinding,
  platformKey,
  isBinaryMismatch,
};

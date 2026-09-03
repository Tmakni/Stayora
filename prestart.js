/**
 * Hook prestart/predev : garantit que les modules natifs sont utilisables sur
 * la plateforme courante (Windows ou WSL, qui partagent ici le même
 * node_modules).
 *
 * Toute la logique vit dans scripts/ensure-native-modules.js, parce que
 * server.js l'appelle AUSSI au démarrage : run-server.sh et start-server.sh
 * lancent `node server/server.js` directement, sans passer par npm, donc ce
 * hook seul ne suffisait pas — l'erreur ressortait plus loin, déguisée en
 * « Database connection failed ».
 */
const { ensureBetterSqlite3 } = require('./scripts/ensure-native-modules');

const result = ensureBetterSqlite3();
if (!result.ok) {
  console.error('[prestart] better-sqlite3 inutilisable :', result.error && result.error.message);
  process.exit(1);
}

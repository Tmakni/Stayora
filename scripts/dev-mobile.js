#!/usr/bin/env node
/**
 * Dev-only launcher for testing the app on a real phone over the same Wi-Fi.
 *
 *   npm run dev:mobile
 *
 * Starts the Vite dev server bound to 0.0.0.0 and prints the exact LAN URL to
 * open on the phone. Binding to all interfaces is DEVELOPMENT ONLY: it is never
 * used by `npm start` / the production build, which serve the pre-built SPA from
 * the Express server instead.
 *
 * The API is not exposed separately — Vite proxies /api to the Express server on
 * localhost:3000 from this machine, so the phone only ever talks to Vite.
 * Express's dev CORS accepts private-LAN origins for exactly this reason
 * (see server/server.js, DEV_ORIGIN_RE).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const VITE_PORT = process.env.VITE_PORT || '5173';
const API_PORT = process.env.PORT || '3000';
const line = '─'.repeat(64);

/**
 * Running inside WSL?
 *
 * This matters twice over, and both are fatal for phone testing:
 *   1. WSL2 sits behind a NAT. Its eth0 address (172.x.x.x/20) is reachable
 *      from Windows but NOT from anything else on the Wi-Fi, so a phone can
 *      never open it — printing that URL is worse than useless.
 *   2. client/node_modules is installed from Windows here, so it carries
 *      @rollup/rollup-win32-* and Vite cannot even start under Linux.
 * The Vite dev server therefore has to run on the WINDOWS side.
 */
function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

if (isWsl()) {
  console.error('');
  console.error(line);
  console.error('  Lancez cette commande depuis WINDOWS, pas depuis WSL.');
  console.error(line);
  console.error('');
  console.error('  Deux raisons, toutes deux bloquantes :');
  console.error('');
  console.error('   1. WSL2 est derrière un NAT. Son adresse (172.x.x.x) est');
  console.error('      joignable depuis Windows mais PAS depuis votre téléphone.');
  console.error('   2. client/node_modules a été installé côté Windows : il');
  console.error('      contient @rollup/rollup-win32-*, que Linux ne peut pas charger.');
  console.error('');
  console.error('  À faire :');
  console.error('');
  console.error('    Terminal WSL      →  npm run dev          (API, port ' + API_PORT + ')');
  console.error('    Terminal Windows  →  npm run dev:mobile   (interface, port ' + VITE_PORT + ')');
  console.error('');
  console.error('  Ouvrez PowerShell ou cmd.exe dans C:\\home\\tom\\airbnb-ai-agent');
  console.error('  et relancez `npm run dev:mobile` — l\'adresse à ouvrir sur le');
  console.error('  téléphone s\'affichera alors.');
  console.error('');
  console.error('  Vite relaie /api vers localhost:' + API_PORT + ', et Windows redirige');
  console.error('  automatiquement ce port vers le serveur qui tourne dans WSL.');
  console.error(line);
  console.error('');
  process.exit(1);
}

/**
 * Fail early and legibly when node_modules was installed for another platform.
 * Without this the user gets rollup's raw MODULE_NOT_FOUND stack.
 */
function checkNativeBinaries() {
  const rollupDir = path.join(__dirname, '..', 'client', 'node_modules', '@rollup');
  let installed = [];
  try {
    installed = fs.readdirSync(rollupDir);
  } catch {
    return; // no @rollup dir — let Vite report whatever is actually wrong
  }
  if (installed.length === 0) return;

  const wantWin = process.platform === 'win32';
  const hasMatch = installed.some((name) =>
    wantWin ? /win32/.test(name) : process.platform === 'darwin' ? /darwin/.test(name) : /linux/.test(name)
  );

  if (!hasMatch) {
    console.error('');
    console.error(line);
    console.error('  Dépendances installées pour une autre plateforme.');
    console.error(line);
    console.error(`  Plateforme actuelle : ${process.platform}`);
    console.error(`  Binaires rollup présents : ${installed.join(', ')}`);
    console.error('');
    console.error('  Réinstallez les dépendances du client depuis CETTE plateforme :');
    console.error('    cd client && rm -rf node_modules package-lock.json && npm install');
    console.error(line);
    console.error('');
    process.exit(1);
  }
}

checkNativeBinaries();

/**
 * Pick the most likely LAN IPv4 address.
 * Prefers common home-network ranges and skips virtual adapters (WSL, Docker,
 * VirtualBox), which otherwise win on a typical Windows dev machine and hand
 * out an address the phone cannot reach.
 */
function findLanAddresses() {
  const skip = /^(vEthernet|WSL|Docker|VirtualBox|VMware|Loopback|Hyper-V|br-|veth|docker|Npcab|Tailscale|ZeroTier)/i;
  const results = [];

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      // Addresses handed out by a NAT'd virtual switch (WSL2, Docker, Hyper-V)
      // are reachable from this machine only. Offering one to a phone sends the
      // user chasing a connection that can never succeed, so drop them here
      // rather than ranking them last.
      const isVirtualNat =
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address) && !/wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d/i.test(name);
      if (isVirtualNat) continue;

      const isPrivate =
        /^192\.168\./.test(addr.address) ||
        /^10\./.test(addr.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address);
      results.push({ name, address: addr.address, isPrivate });
    }
  }

  // The phone is on Wi-Fi, so rank the wireless adapter first, then ordinary
  // home ranges, then anything else. On this machine that correctly picks the
  // Wi-Fi address over both the Ethernet one and the WSL virtual adapter.
  return results.sort((a, b) => {
    const score = (r) => {
      if (/wi-?fi|wlan|wireless|airport|en0/i.test(r.name)) return 0;
      if (/^192\.168\./.test(r.address)) return 1;
      return r.isPrivate ? 2 : 3;
    };
    return score(a) - score(b);
  });
}

/**
 * Is the Express API actually up? Vite proxies /api to it, so without it every
 * page loads but nothing works. On Windows this also transparently reaches a
 * server running inside WSL, thanks to WSL2's localhost forwarding.
 */
async function isApiRunning() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

(async () => {
  const addresses = findLanAddresses();
  const apiUp = await isApiRunning();

  console.log('');
  console.log(line);
  console.log('  Michel — test sur téléphone (même Wi-Fi)');
  console.log(line);

  if (addresses.length === 0) {
    console.log('  Aucune adresse réseau locale utilisable détectée.');
    console.log('  Vérifiez que cet ordinateur est bien connecté au Wi-Fi.');
  } else {
    console.log('  Ouvrez cette adresse dans le navigateur du téléphone :');
    console.log('');
    for (const [i, addr] of addresses.entries()) {
      const url = `http://${addr.address}:${VITE_PORT}`;
      console.log(`    ${i === 0 ? '→' : ' '} ${url}   (${addr.name})`);
    }
    console.log('');
    console.log(`  L'API est relayée par Vite depuis le port ${API_PORT} —`);
    console.log('  le téléphone n\'a rien d\'autre à ouvrir.');
    console.log('');

    if (apiUp) {
      console.log(`  ✓ Serveur API détecté sur le port ${API_PORT}.`);
    } else {
      console.log(`  ! Aucun serveur API sur le port ${API_PORT}.`);
      console.log('    Lancez-le en parallèle (dans WSL) :  npm run dev');
      console.log('    Sans lui, les pages s\'affichent mais aucune donnée ne charge.');
    }

    console.log('');
    console.log('  Le téléphone et l\'ordinateur doivent être sur le MÊME Wi-Fi.');
    console.log('  Si la page ne charge pas : autorisez Node.js dans le pare-feu Windows');
    console.log('  (réseau privé), ou désactivez l\'isolation client du routeur.');
  }
  console.log(line);
  console.log('');

  // Hand over to Vite. `--host 0.0.0.0` is passed here rather than baked into
  // vite.config.js so a plain `npm run dev` stays bound to localhost.
  const clientDir = path.join(__dirname, '..', 'client');
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--host', '0.0.0.0', '--port', VITE_PORT],
    { cwd: clientDir, stdio: 'inherit', shell: process.platform === 'win32' }
  );

  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('Impossible de démarrer Vite :', err.message);
    process.exit(1);
  });
})();

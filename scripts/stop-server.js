#!/usr/bin/env node
/**
 * Arrête l'instance du serveur qui occupe le port, des deux côtés du pont
 * Windows/WSL.
 *
 * Sur ce poste, le port 3000 côté Windows est souvent détenu par le service
 * "IP Helper" à cause d'une règle `netsh portproxy` qui redirige vers WSL.
 * Tuer un processus Windows ne libère alors rien : le serveur à arrêter tourne
 * en réalité dans WSL. Ce script traite les deux cas.
 *
 *   node scripts/stop-server.js       (ou : npm run stop)
 */

const { execSync, execFileSync } = require('child_process');
require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) {
    return '';
  }
}

let stopped = 0;

if (process.platform === 'win32') {
  // 1. Processus Windows réellement à l'écoute (hors service IP Helper)
  const netstat = run('netstat', ['-ano', '-p', 'TCP']);
  const pids = new Set();
  for (const line of netstat.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*TCP\\s+\\S+:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) {
    const name = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']).split(',')[0].replace(/"/g, '');
    if (/^svchost/i.test(name)) {
      console.log(`Port ${PORT} detenu par ${name} (PID ${pid}) — c'est la regle netsh portproxy, pas un serveur.`);
      continue;
    }
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      console.log(`Arrete : ${name} (PID ${pid}) cote Windows.`);
      stopped++;
    } catch (_) {
      console.log(`Echec de l'arret du PID ${pid} (droits insuffisants ?).`);
    }
  }

  // 2. Instance dans WSL, atteignable via la redirection
  const wsl = run('wsl.exe', ['-e', 'bash', '-lc', 'pkill -f "node server/server.js"; pkill -f "nodemon server/server.js"; echo done']);
  if (wsl.includes('done')) {
    console.log('Signal d\'arret envoye aux instances WSL (node/nodemon server/server.js).');
    stopped++;
  }
} else {
  run('pkill', ['-f', 'node server/server.js']);
  run('pkill', ['-f', 'nodemon server/server.js']);
  console.log('Signal d\'arret envoye (node/nodemon server/server.js).');
  stopped++;
}

if (!stopped) console.log(`Aucune instance a arreter sur le port ${PORT}.`);

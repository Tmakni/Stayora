/**
 * Diagnostic non destructif de l'état de la base : comptes Gmail, scopes,
 * headers de réponse capturés, file d'envoi, réglages d'automatisation.
 * Lecture seule — n'écrit rien, n'envoie rien.
 */
require('dotenv').config();
const knex = require('knex')(require('../knexfile').development);

function mask(addr) {
  if (!addr) return '(vide)';
  const at = addr.indexOf('@');
  if (at < 1) return '(invalide)';
  return addr.slice(0, 2) + '*'.repeat(Math.max(3, at - 2)) + addr.slice(at);
}

async function tableExists(name) {
  return knex.schema.hasTable(name);
}

(async () => {
  console.log('DB :', knex.client.config.connection.filename || '(mysql)');

  const [{ v: version } = {}] = await knex('knex_migrations').max('name as v');
  console.log('Dernière migration :', version);

  console.log('\n=== COMPTES GMAIL ===');
  const accounts = await knex('gmail_accounts').select('*');
  for (const a of accounts) {
    console.log(`  #${a.id} user=${a.user_id} ${mask(a.email)}`);
    console.log(`     can_send=${a.can_send} sync_enabled=${a.sync_enabled ?? 'n/a'} last_sync=${a.last_sync_at || 'jamais'}`);
    console.log(`     scopes=${(a.granted_scopes || '(non enregistré)').slice(0, 200)}`);
    console.log(`     history_id=${a.last_history_id || '(aucun)'}`);
  }
  if (!accounts.length) console.log('  (aucun)');

  console.log('\n=== VOLUME ===');
  const [{ c: convs }] = await knex('conversations').count('* as c');
  const [{ c: msgs }] = await knex('messages').count('* as c');
  console.log(`  conversations=${convs}  messages=${msgs}`);

  const hasReplyTo = await knex.schema.hasColumn('messages', 'email_reply_to');
  console.log('  colonne messages.email_reply_to :', hasReplyTo ? 'présente' : 'ABSENTE');
  if (hasReplyTo) {
    const [{ c: withReply }] = await knex('messages').whereNotNull('email_reply_to').count('* as c');
    const bySender = await knex('messages').select('role').count('* as c').groupBy('role');
    console.log(`  avec Reply-To capturé=${withReply}`);
    console.log('  par role : ' + bySender.map((r) => `${r.role}=${r.c}`).join(', '));

    const convsReplyable = await knex('messages')
      .whereNotNull('email_reply_to')
      .countDistinct('conversation_id as c')
      .first();
    console.log(`  conversations répondables par e-mail=${convsReplyable.c} / ${convs}`);
  }

  console.log('\n=== ÉCLATEMENT DES CONVERSATIONS ===');
  const [{ c: noThread }] = await knex('conversations').whereNull('airbnb_thread_id').count('* as c');
  console.log(`  conversations SANS airbnb_thread_id = ${noThread} / ${convs}`);
  const dupGroups = await knex('conversations')
    .whereNotNull('airbnb_thread_id')
    .select('user_id', 'airbnb_thread_id')
    .count('* as n')
    .groupBy('user_id', 'airbnb_thread_id')
    .having(knex.raw('count(*) > 1'))
    .orderBy('n', 'desc');
  const extra = dupGroups.reduce((s, g) => s + (g.n - 1), 0);
  console.log(`  fils Airbnb éclatés sur plusieurs conversations = ${dupGroups.length} (soit ${extra} lignes en trop)`);
  for (const g of dupGroups.slice(0, 5)) {
    const parts = await knex('conversations as c')
      .leftJoin('messages as m', 'm.conversation_id', 'c.id')
      .where('c.airbnb_thread_id', g.airbnb_thread_id)
      .where('c.user_id', g.user_id)
      .select('c.id', 'c.guest_name')
      .count('m.id as n')
      .groupBy('c.id', 'c.guest_name');
    console.log(`    thread ${g.airbnb_thread_id} → ${parts.map((p) => `conv${p.id}(${p.n} msg)`).join(' + ')}`);
  }

  console.log('\n=== MESSAGES PAR CONVERSATION ===');
  const dist = await knex.raw(
    `SELECT n, COUNT(*) AS conversations FROM (
       SELECT c.id, COUNT(m.id) AS n FROM conversations c
       LEFT JOIN messages m ON m.conversation_id = c.id GROUP BY c.id
     ) GROUP BY n ORDER BY n LIMIT 15`
  );
  for (const r of dist) console.log(`  ${r.n} message(s) → ${r.conversations} conversations`);

  console.log('\n=== FILE D\'ENVOI ===');
  if (await tableExists('outbound_replies')) {
    const rows = await knex('outbound_replies').select('status').count('* as c').groupBy('status');
    console.log(rows.length ? rows.map((r) => `  ${r.status}=${r.c}`).join('\n') : '  (vide)');
    const recent = await knex('outbound_replies').orderBy('id', 'desc').limit(5);
    for (const r of recent) {
      console.log(`  #${r.id} conv=${r.conversation_id} ${r.status} mode=${r.mode} tentatives=${r.attempts} err=${(r.last_error || '').slice(0, 90)}`);
    }
  } else {
    console.log('  table absente — migration 017 non appliquée');
  }

  console.log('\n=== RÉGLAGES AUTO ===');
  const users = await knex('users').select('id', 'email', 'auto_reply_mode', 'auto_reply_paused').catch(() => []);
  for (const u of users) console.log(`  user#${u.id} ${mask(u.email)} mode=${u.auto_reply_mode} pause=${u.auto_reply_paused}`);
  const props = await knex('property_profiles').select('id', 'name', 'auto_reply_mode', 'auto_reply_enabled').catch(() => []);
  for (const p of props) console.log(`  logement#${p.id} "${p.name}" mode=${p.auto_reply_mode || '(hérite)'} enabled=${p.auto_reply_enabled}`);

  console.log('\n=== ERREURS DE SYNC ===');
  for (const a of accounts) {
    console.log(`  compte#${a.id} sync_status=${a.sync_status || '-'} sync_error=${a.sync_error || '(aucune)'}`);
  }
  if (await tableExists('sync_logs')) {
    const failed = await knex('sync_logs').where('status', 'failed').orderBy('id', 'desc').limit(10);
    console.log(`  syncs en échec (10 dernières) : ${failed.length}`);
    for (const l of failed) {
      console.log(`    ${l.started_at || l.created_at} :: ${(l.error_message || '').slice(0, 160)}`);
    }
    const logs = await knex('sync_logs').orderBy('id', 'desc').limit(8);
    console.log('  dernières syncs :');
    for (const l of logs) {
      console.log(`    ${l.started_at || l.created_at} ${l.status} messages=${l.messages_synced ?? '-'}`);
    }
  }

  console.log('\n=== THREADS GMAIL PAR CONVERSATION ===');
  if (await tableExists('gmail_threads')) {
    const [{ c: gt }] = await knex('gmail_threads').count('* as c');
    console.log(`  lignes gmail_threads=${gt}`);
    const multi = await knex('gmail_threads')
      .select('conversation_id')
      .count('* as n')
      .groupBy('conversation_id')
      .orderBy('n', 'desc')
      .limit(8);
    console.log('  threads Gmail rattachés par conversation (top 8) : ' + multi.map((m) => `conv${m.conversation_id}:${m.n}`).join(', '));
    const orphan = await knex('gmail_threads').whereNull('conversation_id').count('* as c').first();
    console.log(`  threads sans conversation=${orphan.c}`);
  }

  await knex.destroy();
})().catch((e) => { console.error('ERREUR', e); process.exit(1); });

#!/usr/bin/env node
/**
 * Duplicate diagnostic — READ ONLY.
 *
 *   node scripts/diagnose-duplicates.js [--user <id>] [--json]
 *
 * Reports conversations and properties that look duplicated, and why. It never
 * writes, merges or deletes anything: which of two look-alike threads is the
 * real one is a judgement call about a host's guests, not something a script
 * should decide. Use it to size the problem and to check that the fixes stopped
 * it growing.
 *
 * Context — the causes, all now fixed upstream:
 *   • gmailSyncService's 90-day de-duplication window used MySQL's DATE_SUB,
 *     which is a syntax error on SQLite, so the function threw on every call
 *     and the merge path never ran. Every Airbnb notification mail therefore
 *     created a brand-new conversation.
 *   • airbnb_thread_id extraction failing left nothing to group threads by.
 *   • the property anti-duplicate check was a SELECT-then-INSERT race
 *     (fixed by the unique index in migration 016).
 *
 * Existing rows are NOT cleaned up by those fixes — hence this report.
 */

const path = require('path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const userArgIndex = args.indexOf('--user');
const onlyUser = userArgIndex >= 0 ? parseInt(args[userArgIndex + 1], 10) : null;

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const knex = require('knex')(require(path.join(__dirname, '..', 'knexfile'))[process.env.NODE_ENV]);

function pad(v, n) {
  return String(v == null ? '' : v).padEnd(n);
}

(async () => {
  const report = { conversations: {}, properties: {}, generatedAt: new Date().toISOString() };

  // ── Conversations grouped by (user, property, guest name) ────────────────
  // Same guest + same property + no shared airbnb_thread_id = almost certainly
  // the same real conversation split across several notification mails.
  const convRows = await knex('conversations')
    .select('id', 'user_id', 'property_id', 'guest_name', 'title', 'airbnb_thread_id', 'created_at', 'updated_at')
    .modify((q) => { if (onlyUser) q.where('user_id', onlyUser); })
    .orderBy('id', 'asc');

  const groups = new Map();
  for (const row of convRows) {
    const name = (row.guest_name || '').trim().toLowerCase();
    // Unnamed rows can't be grouped by name without inventing links.
    if (!name || name === 'voyageur' || name === 'airbnb') continue;
    const key = `${row.user_id}|${row.property_id ?? 'none'}|${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const convDuplicates = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const [userId, propertyId, name] = key.split('|');
      const threadIds = new Set(rows.map((r) => r.airbnb_thread_id).filter(Boolean));
      return {
        user_id: Number(userId),
        property_id: propertyId === 'none' ? null : Number(propertyId),
        guest_name: rows[0].guest_name,
        count: rows.length,
        // Distinct airbnb_thread_ids mean Airbnb itself considers these
        // separate threads — likely a returning guest, NOT a duplicate.
        distinct_airbnb_threads: threadIds.size,
        confidence: threadIds.size > 1 ? 'faible (fils Airbnb distincts)' : 'élevée',
        ids: rows.map((r) => r.id),
        first_seen: rows[0].created_at,
        last_seen: rows[rows.length - 1].updated_at,
      };
    })
    .sort((a, b) => b.count - a.count);

  const messageCounts = new Map();
  if (convDuplicates.length > 0) {
    const allIds = convDuplicates.flatMap((d) => d.ids);
    const counts = await knex('messages')
      .select('conversation_id')
      .count({ n: '*' })
      .whereIn('conversation_id', allIds)
      .groupBy('conversation_id');
    for (const c of counts) messageCounts.set(c.conversation_id, Number(c.n));
  }

  report.conversations = {
    total: convRows.length,
    groups_with_duplicates: convDuplicates.length,
    extra_rows: convDuplicates.reduce((sum, d) => sum + d.count - 1, 0),
    high_confidence: convDuplicates.filter((d) => d.confidence === 'élevée').length,
    details: convDuplicates.slice(0, 50).map((d) => ({
      ...d,
      messages_per_conversation: d.ids.map((id) => messageCounts.get(id) || 0),
    })),
  };

  // ── Conversations with no messages at all ────────────────────────────────
  const empties = await knex('conversations as c')
    .select('c.id', 'c.user_id', 'c.title')
    .modify((q) => { if (onlyUser) q.where('c.user_id', onlyUser); })
    .whereNotExists(function () {
      this.select('*').from('messages as m').whereRaw('m.conversation_id = c.id');
    });
  report.conversations.empty = { count: empties.length, ids: empties.map((e) => e.id).slice(0, 50) };

  // ── Properties sharing an Airbnb listing id ──────────────────────────────
  const propDupes = await knex('property_profiles')
    .select('user_id', 'airbnb_listing_id')
    .count({ n: '*' })
    .whereNotNull('airbnb_listing_id')
    .andWhere('airbnb_listing_id', '<>', '')
    .modify((q) => { if (onlyUser) q.where('user_id', onlyUser); })
    .groupBy('user_id', 'airbnb_listing_id')
    .havingRaw('COUNT(*) > 1');

  report.properties = {
    duplicate_listing_groups: propDupes.length,
    details: propDupes.map((d) => ({ user_id: d.user_id, airbnb_listing_id: d.airbnb_listing_id, count: Number(d.n) })),
  };

  // ── Properties still carrying an auto-generated name ─────────────────────
  // name_source arrives with migration 015; this report must still run against
  // a database that has not been migrated yet.
  const hasNameSource = await knex.schema.hasColumn('property_profiles', 'name_source');
  const badNames = await knex('property_profiles')
    .select(['id', 'user_id', 'name', ...(hasNameSource ? ['name_source'] : [])])
    .modify((q) => { if (onlyUser) q.where('user_id', onlyUser); })
    .where((q) => q.where('name', 'like', 'Logement Airbnb #%').orWhere('name', 'like', 'Logement #%'));
  report.properties.placeholder_names = {
    count: badNames.length,
    rows: badNames.map((r) => ({ ...r, name_source: r.name_source || 'n/a (migration 015 non appliquée)' })),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    await knex.destroy();
    return;
  }

  const line = '─'.repeat(78);
  console.log('');
  console.log(line);
  console.log('  DIAGNOSTIC DES DOUBLONS — lecture seule, aucune donnée modifiée');
  console.log(line);

  console.log('');
  console.log(`CONVERSATIONS  (${report.conversations.total} au total)`);
  console.log(`  Groupes suspects            : ${report.conversations.groups_with_duplicates}`);
  console.log(`  Dont confiance élevée       : ${report.conversations.high_confidence}`);
  console.log(`  Lignes en trop (estimation) : ${report.conversations.extra_rows}`);
  console.log(`  Conversations sans message  : ${report.conversations.empty.count}`);

  if (report.conversations.details.length > 0) {
    console.log('');
    console.log('  voyageur              logement  n  fils  messages          confiance');
    console.log('  ' + '─'.repeat(74));
    for (const d of report.conversations.details.slice(0, 25)) {
      console.log(
        '  ' + pad(d.guest_name, 21) + pad(d.property_id ?? '—', 10) +
        pad(d.count, 3) + pad(d.distinct_airbnb_threads, 6) +
        pad(d.messages_per_conversation.join(','), 18) + d.confidence
      );
    }
    if (report.conversations.details.length > 25) {
      console.log(`  … et ${report.conversations.details.length - 25} autre(s) groupe(s)`);
    }
  }

  console.log('');
  console.log('LOGEMENTS');
  console.log(`  Listings Airbnb en double   : ${report.properties.duplicate_listing_groups}`);
  console.log(`  Noms automatiques restants  : ${report.properties.placeholder_names.count}`);
  for (const row of report.properties.placeholder_names.rows.slice(0, 10)) {
    console.log(`      #${row.id} (user ${row.user_id}, ${row.name_source}) — ${row.name}`);
  }

  console.log('');
  console.log(line);
  console.log('  Rien n\'a été supprimé ni fusionné.');
  console.log('  • Les noms automatiques se corrigent seuls via « Mettre à jour depuis Airbnb ».');
  console.log('  • Les conversations en double sont un héritage : la cause est corrigée,');
  console.log('    mais le regroupement rétroactif supprimerait des données — à décider par vous.');
  console.log('  • Détail complet : --json');
  console.log(line);
  console.log('');

  await knex.destroy();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

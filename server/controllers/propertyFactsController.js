/**
 * Centre de vérification : ce que Michel a trouvé, et que l'hôte tranche.
 *
 * L'écran existe parce qu'aucune information tirée des conversations n'est
 * présentée comme acquise. Il montre la valeur proposée, sur quoi elle repose
 * (combien de réservations, sur quelle période, combien de contradictions), et
 * laisse deux gestes : confirmer, ou corriger.
 *
 * « TOUT CONFIRMER » NE CONFIRME PAS TOUT
 * ---------------------------------------
 * Le bouton ne vaut que pour les faits SANS CONFLIT : pas de contradiction, pas
 * de changement probable, pas d'information sensible. Un code de boîte à clés
 * n'y passe jamais, même vu cinquante fois — un geste global ne doit pas
 * pouvoir valider ce qu'on n'a pas lu.
 */

const { getDatabase } = require('../config/db');
const logger = require('../utils/logger');
const {
  listFacts, listPending, confirmFact, rejectFact, markApplied, COLUMN_FACTS,
} = require('../services/propertyFacts');
const { STABILITY, VALUE_TYPE, FACT_LABELS } = require('../services/factExtraction');
const { buildContextData, CONTEXT_ONLY_FIELDS } = require('./propertyController');

const CONTEXT_FIELDS = new Set(CONTEXT_ONLY_FIELDS);

/** Statuts que le bouton « tout confirmer » accepte de valider d'un coup. */
const BULK_CONFIRMABLE = new Set(['HIGH_CONFIDENCE', 'REQUIRES_CONFIRMATION']);

/** Vérifie que le logement appartient bien à cet hôte. */
async function ownedProperty(db, userId, propertyId) {
  const rows = await db.query(
    'SELECT * FROM property_profiles WHERE id = ? AND user_id = ?',
    [propertyId, userId]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * GET /api/properties/:id/facts
 * Tous les faits connus d'un logement, preuves comprises.
 */
async function getPropertyFacts(req, res) {
  const db = getDatabase();
  const property = await ownedProperty(db, req.userId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Logement introuvable.' });

  const facts = await listFacts(db, req.userId, property.id);
  return res.json({
    property_id: property.id,
    property_name: property.name,
    facts,
    summary: summarize(facts),
  });
}

/**
 * GET /api/properties/facts/pending
 * Ce qui attend l'hôte, tous logements confondus.
 */
async function getPendingFacts(req, res) {
  const db = getDatabase();
  const rows = await listPending(db, req.userId);

  const byProperty = new Map();
  for (const row of rows) {
    const entry = byProperty.get(row.property_id) || {
      property_id: row.property_id,
      property_name: row.property_name,
      facts: [],
    };
    entry.facts.push({
      id: row.id,
      fact_key: row.fact_key,
      label: FACT_LABELS[row.fact_key] || row.fact_key,
      value: row.fact_value,
      value_type: row.value_type,
      stability: row.stability,
      status: row.status,
      confidence: row.confidence,
      evidence_count: row.evidence_count,
      distinct_conversations: row.distinct_conversations,
      distinct_reservations: row.distinct_reservations,
      distinct_periods: row.distinct_periods,
      contradiction_count: row.contradiction_count,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      previous_value: row.previous_value,
      possible_change: !!row.possible_change,
      bulk_confirmable: isBulkConfirmable(row),
    });
    byProperty.set(row.property_id, entry);
  }

  const properties = [...byProperty.values()];
  return res.json({
    properties,
    total: rows.length,
    bulk_confirmable: properties.reduce(
      (sum, p) => sum + p.facts.filter((f) => f.bulk_confirmable).length, 0
    ),
  });
}

/**
 * Un fait peut-il être confirmé sans être lu un par un ?
 *
 * Non si l'information est volatile (un code peut avoir changé hier), non s'il
 * y a la moindre contradiction, non si un changement est en cours. Ce sont
 * exactement les cas où l'hôte doit regarder.
 */
function isBulkConfirmable(fact) {
  if (STABILITY[fact.fact_key] === 'volatile') return false;
  if (fact.possible_change) return false;
  if (fact.contradiction_count > 0) return false;
  return BULK_CONFIRMABLE.has(fact.status);
}

/**
 * POST /api/properties/:id/facts/:factId/confirm
 * Corps facultatif : { value } — la correction de l'hôte.
 *
 * Une correction devient la vérité du champ et n'est plus jamais remise en
 * cause par une analyse (§17).
 */
async function confirm(req, res) {
  const db = getDatabase();
  const property = await ownedProperty(db, req.userId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Logement introuvable.' });

  const value = typeof req.body?.value === 'string' ? req.body.value : null;
  const fact = await confirmFact(db, req.userId, req.params.factId, value);
  if (!fact) return res.status(404).json({ error: 'Information introuvable.' });
  if (fact.property_id !== property.id) {
    return res.status(404).json({ error: 'Information introuvable.' });
  }

  await applyToProfile(db, req.userId, property, [fact]);
  logger.info(`Fait confirmé (user ${req.userId}, logement ${property.id}) : ${fact.fact_key}`);
  return res.json({ success: true, fact_key: fact.fact_key, value: fact.fact_value });
}

/**
 * POST /api/properties/:id/facts/:factId/reject
 * L'hôte dit que ce n'est pas ça. Rien n'est écrit dans la fiche.
 */
async function reject(req, res) {
  const db = getDatabase();
  const property = await ownedProperty(db, req.userId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Logement introuvable.' });

  const done = await rejectFact(db, req.userId, req.params.factId);
  if (!done) return res.status(404).json({ error: 'Information introuvable.' });
  return res.json({ success: true });
}

/**
 * POST /api/properties/:id/facts/confirm-all
 * Confirme les faits sans conflit, et eux seuls.
 */
async function confirmAll(req, res) {
  const db = getDatabase();
  const property = await ownedProperty(db, req.userId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Logement introuvable.' });

  const rows = await db.query(
    'SELECT * FROM property_facts WHERE user_id = ? AND property_id = ?',
    [req.userId, property.id]
  );
  const eligible = rows.filter(isBulkConfirmable);
  if (eligible.length === 0) {
    return res.json({ success: true, confirmed: 0, skipped: rows.length });
  }

  const confirmed = [];
  for (const fact of eligible) {
    const updated = await confirmFact(db, req.userId, fact.id, null);
    if (updated) confirmed.push(updated);
  }

  await applyToProfile(db, req.userId, property, confirmed);
  logger.info(`Faits confirmés en lot (user ${req.userId}, logement ${property.id}) : ${confirmed.length}`);
  return res.json({
    success: true,
    confirmed: confirmed.length,
    skipped: rows.length - confirmed.length,
  });
}

/**
 * Recopie dans la fiche les faits que l'hôte vient de confirmer.
 *
 * Ici, et seulement ici, une valeur EXISTANTE peut être remplacée : l'hôte a
 * explicitement dit que c'était la bonne. C'est le sommet de la hiérarchie des
 * sources (§1), au-dessus même de l'export structuré.
 */
async function applyToProfile(db, userId, property, facts) {
  const applied = facts.filter((f) => f && f.fact_value && STABILITY[f.fact_key]);
  if (applied.length === 0) return;

  let context = {};
  try {
    context = JSON.parse(property.context_json || '{}');
  } catch (_) {
    context = {};
  }

  const columns = {};
  for (const fact of applied) {
    const key = fact.fact_key;
    const value = VALUE_TYPE[key] === 'boolean' ? fact.fact_value === 'true' : fact.fact_value;
    if (COLUMN_FACTS.has(key)) columns[key] = value;
    else if (CONTEXT_FIELDS.has(key)) context[key] = value;
  }

  const merged = {};
  for (const key of CONTEXT_ONLY_FIELDS) {
    if (context[key] !== undefined) merged[key] = context[key];
    else merged[key] = key.startsWith('has_') ? false : '';
  }

  const fields = [];
  const values = [];
  for (const [column, value] of Object.entries(columns)) {
    fields.push(`${column} = ?`);
    values.push(value);
  }
  fields.push('context_json = ?');
  values.push(JSON.stringify(buildContextData({ ...property, ...columns, ...merged })));
  fields.push('updated_at = NOW()');
  values.push(property.id, userId);

  await db.query(
    `UPDATE property_profiles SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
    values
  );
  await markApplied(db, userId, property.id, applied.map((f) => f.fact_key));
}

function summarize(facts) {
  const counts = {
    verified: 0, high_confidence: 0, candidate: 0,
    unstable: 0, requires_confirmation: 0, unknown: 0,
  };
  for (const fact of facts) {
    const key = String(fact.status || '').toLowerCase();
    if (counts[key] !== undefined) counts[key]++;
  }
  return counts;
}

module.exports = {
  getPropertyFacts,
  getPendingFacts,
  confirm,
  reject,
  confirmAll,
  __isBulkConfirmable: isBulkConfirmable,
};

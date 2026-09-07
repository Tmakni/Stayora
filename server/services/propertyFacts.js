/**
 * Écriture et lecture des faits d'un logement.
 *
 * DEUX RÈGLES QUI NE SE NÉGOCIENT PAS
 * -----------------------------------
 *  1. UNE CONFIRMATION UTILISATEUR NE S'ÉCRASE PAS. Un fait passé en VERIFIED
 *     par l'hôte garde sa valeur pour toujours, quoi que disent les analyses
 *     suivantes. Si une nouvelle analyse voit autre chose, elle ne remplace
 *     rien : elle lève `possible_change` et pose la question (§17, §18).
 *
 *  2. AUCUNE ANALYSE N'EFFACE. Un ré-import à partir d'un export partiel ne
 *     produit pas les mêmes faits ; supprimer ceux qu'il ne retrouve pas
 *     reviendrait à perdre une information vraie parce qu'un fichier manquait.
 *     Les faits d'hier restent, avec leurs compteurs d'hier.
 *
 * ISOLATION
 * ---------
 * Toutes les requêtes filtrent sur `user_id`, y compris celles qui pourraient
 * s'en passer parce qu'elles ciblent un identifiant de fait. Un identifiant
 * deviné ne doit pas suffire à lire ou modifier le fait d'un autre hôte.
 */

const logger = require('../utils/logger');
const { STABILITY, VALUE_TYPE, FACT_LABELS, canonicalValue } = require('./factExtraction');

const STATUSES = new Set([
  'VERIFIED', 'HIGH_CONFIDENCE', 'CANDIDATE', 'UNSTABLE', 'REQUIRES_CONFIRMATION', 'UNKNOWN',
]);

/**
 * Statuts qu'une analyse automatique a le droit d'écrire dans la FICHE, et
 * seulement si le champ y est vide.
 *
 * HIGH_CONFIDENCE n'est pas une vérité (§13) : ce qui autorise l'écriture ici,
 * c'est la conjonction « très fortement concordant » ET « le champ est vide ».
 * Remplir un vide avec la meilleure information disponible sert l'hôte ;
 * remplacer une valeur existante par une déduction ne le sert pas.
 */
const AUTO_APPLICABLE = new Set(['HIGH_CONFIDENCE']);

/** Faits qui correspondent à une VRAIE colonne de `property_profiles`. */
const COLUMN_FACTS = new Set(['allows_pets']);

const MAX_VALUE_LENGTH = 2000;
const MAX_SNIPPET_LENGTH = 240;
const MAX_EVIDENCE_ROWS = 5;

function clean(value, max = MAX_VALUE_LENGTH) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const str = String(value).trim();
  return str ? str.slice(0, max) : null;
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function wholeNumber(value, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.round(n));
}

/**
 * Ramène un fait, d'où qu'il vienne, à ce qui peut être écrit. Un fait arrivé
 * par le réseau passe par ici avant toute requête : ni la clé, ni le statut, ni
 * les compteurs ne sont repris tels quels.
 */
function sanitizeFact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = clean(raw.key || raw.fact_key, 64);
  if (!key || !STABILITY[key]) return null;

  const value = clean(raw.value !== undefined ? raw.value : raw.fact_value);
  if (!value) return null;

  const status = STATUSES.has(raw.status) ? raw.status : 'CANDIDATE';

  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .slice(0, MAX_EVIDENCE_ROWS)
    .map((item) => ({
      thread_ref: clean(item && item.thread_ref, 64),
      message_ref: clean(item && item.message_ref, 64),
      reservation_code: clean(item && item.reservation_code, 32),
      observed_at: clean(item && item.observed_at, 40),
      kind: ['CONFIRMATION', 'UPDATE', 'EXCEPTION'].includes(item && item.kind) ? item.kind : 'CONFIRMATION',
      value: clean(item && item.value, 200),
      snippet: clean(item && item.snippet, MAX_SNIPPET_LENGTH),
    }));

  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .slice(0, 5)
    .map((item) => ({
      value: clean(item && item.value, 200),
      distinct_reservations: wholeNumber(item && item.distinct_reservations),
      evidence_count: wholeNumber(item && item.evidence_count),
      last_seen: isoDate(item && item.last_seen),
    }))
    .filter((item) => item.value);

  return {
    key,
    value,
    value_type: VALUE_TYPE[key] || 'text',
    stability: STABILITY[key],
    source: clean(raw.source, 32) || 'host_messages',
    status,
    confidence: Math.max(0, Math.min(100, wholeNumber(raw.confidence, 100))),
    evidence_count: wholeNumber(raw.evidence_count),
    distinct_conversations: wholeNumber(raw.distinct_conversations),
    distinct_reservations: wholeNumber(raw.distinct_reservations),
    distinct_periods: wholeNumber(raw.distinct_periods),
    contradiction_count: wholeNumber(raw.contradiction_count),
    exception_count: wholeNumber(raw.exception_count),
    first_seen: isoDate(raw.first_seen),
    last_seen: isoDate(raw.last_seen),
    previous_value: clean(raw.previous_value),
    possible_change: !!raw.possible_change,
    alternatives,
    evidence,
  };
}

/**
 * Écrit les faits d'un logement. Idempotent : rejouer la même analyse ne crée
 * pas de doublon, la clé étant (property_id, fact_key).
 *
 * @returns {{created: number, updated: number, protected: number}}
 *          `protected` = faits confirmés par l'hôte, laissés intacts.
 */
async function saveFacts(db, userId, propertyId, rawFacts) {
  const facts = (Array.isArray(rawFacts) ? rawFacts : [])
    .map(sanitizeFact)
    .filter(Boolean);
  const summary = { created: 0, updated: 0, protected: 0 };
  if (facts.length === 0) return summary;

  const existingRows = await db.query(
    'SELECT * FROM property_facts WHERE user_id = ? AND property_id = ?',
    [userId, propertyId]
  );
  const existing = new Map(existingRows.map((row) => [row.fact_key, row]));

  for (const fact of facts) {
    const previous = existing.get(fact.key);

    if (previous && previous.status === 'VERIFIED') {
      // L'hôte a tranché. On ne touche NI à la valeur, NI au statut : on note
      // seulement que l'observation la plus récente dit autre chose, pour
      // pouvoir le lui demander plutôt que de le décider à sa place.
      const disagrees = canonicalValue(fact.key, previous.fact_value) !== canonicalValue(fact.key, fact.value);
      if (disagrees) {
        const alternatives = [
          {
            value: fact.value,
            distinct_reservations: fact.distinct_reservations,
            evidence_count: fact.evidence_count,
            last_seen: fact.last_seen,
          },
          ...fact.alternatives,
        ].slice(0, 5);
        await db.query(
          `UPDATE property_facts
              SET possible_change = 1, alternatives_json = ?, last_seen = ?, updated_at = NOW()
            WHERE id = ? AND user_id = ?`,
          [JSON.stringify(alternatives), fact.last_seen, previous.id, userId]
        );
      }
      summary.protected++;
      continue;
    }

    const columns = [
      fact.value, fact.value_type, fact.source, fact.stability, fact.confidence, fact.status,
      fact.evidence_count, fact.distinct_conversations, fact.distinct_reservations,
      fact.distinct_periods, fact.contradiction_count, fact.exception_count,
      fact.first_seen, fact.last_seen, fact.previous_value, fact.possible_change,
      fact.alternatives.length > 0 ? JSON.stringify(fact.alternatives) : null,
    ];

    let factId;
    if (previous) {
      await db.query(
        `UPDATE property_facts SET
           fact_value = ?, value_type = ?, source = ?, stability = ?, confidence = ?, status = ?,
           evidence_count = ?, distinct_conversations = ?, distinct_reservations = ?,
           distinct_periods = ?, contradiction_count = ?, exception_count = ?,
           first_seen = ?, last_seen = ?, previous_value = ?, possible_change = ?,
           alternatives_json = ?, updated_at = NOW()
         WHERE id = ? AND user_id = ?`,
        [...columns, previous.id, userId]
      );
      factId = previous.id;
      summary.updated++;
    } else {
      const result = await db.query(
        `INSERT INTO property_facts (
           user_id, property_id, fact_key,
           fact_value, value_type, source, stability, confidence, status,
           evidence_count, distinct_conversations, distinct_reservations,
           distinct_periods, contradiction_count, exception_count,
           first_seen, last_seen, previous_value, possible_change, alternatives_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [userId, propertyId, fact.key, ...columns]
      );
      factId = result.insertId;
      summary.created++;
    }

    if (factId && fact.evidence.length > 0) {
      await replaceEvidence(db, userId, factId, fact.evidence);
    }
  }

  return summary;
}

/**
 * Remplace l'échantillon de preuves d'un fait.
 *
 * Remplacement et non ajout : ces lignes sont un ÉCHANTILLON représentatif
 * recalculé à chaque analyse, pas un journal. Les accumuler ferait grossir la
 * base sans rien apprendre, et conserverait des extraits de conversation que
 * plus rien ne justifie.
 */
async function replaceEvidence(db, userId, factId, evidence) {
  await db.query('DELETE FROM property_fact_evidence WHERE fact_id = ? AND user_id = ?', [factId, userId]);
  for (const item of evidence.slice(0, MAX_EVIDENCE_ROWS)) {
    await db.query(
      `INSERT INTO property_fact_evidence (
         fact_id, user_id, thread_ref, message_ref, reservation_code,
         observed_at, kind, value, snippet, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        factId, userId, item.thread_ref, item.message_ref, item.reservation_code,
        item.observed_at, item.kind, item.value, item.snippet,
      ]
    );
  }
}

/** Les faits d'un logement, preuves comprises. */
async function listFacts(db, userId, propertyId) {
  const facts = await db.query(
    `SELECT * FROM property_facts
      WHERE user_id = ? AND property_id = ?
      ORDER BY status = 'VERIFIED', confidence DESC, fact_key`,
    [userId, propertyId]
  );
  if (facts.length === 0) return [];

  const evidence = await db.query(
    `SELECT e.* FROM property_fact_evidence e
       JOIN property_facts f ON f.id = e.fact_id
      WHERE e.user_id = ? AND f.property_id = ?
      ORDER BY e.observed_at`,
    [userId, propertyId]
  );
  const byFact = new Map();
  for (const row of evidence) {
    const list = byFact.get(row.fact_id) || [];
    list.push(row);
    byFact.set(row.fact_id, list);
  }

  return facts.map((fact) => decorate(fact, byFact.get(fact.id) || []));
}

/** Mise en forme pour l'interface : libellé lisible et JSON déjà analysé. */
function decorate(fact, evidence) {
  let alternatives = [];
  try {
    alternatives = fact.alternatives_json ? JSON.parse(fact.alternatives_json) : [];
  } catch (_) {
    // Un JSON illisible ne doit pas casser l'écran : il n'y a simplement pas
    // d'alternative à montrer.
  }
  return {
    ...fact,
    possible_change: !!fact.possible_change,
    label: FACT_LABELS[fact.fact_key] || fact.fact_key,
    alternatives,
    evidence: evidence.map((e) => ({
      observed_at: e.observed_at,
      kind: e.kind,
      snippet: e.snippet,
      reservation_code: e.reservation_code,
    })),
  };
}

/**
 * Ce qui attend l'hôte, tous logements confondus : l'écran de vérification.
 *
 * Les faits déjà VERIFIED n'y figurent pas, SAUF si une observation récente les
 * contredit — c'est précisément le cas où il faut redemander (§18).
 */
async function listPending(db, userId) {
  return db.query(
    `SELECT f.*, p.name AS property_name
       FROM property_facts f
       JOIN property_profiles p ON p.id = f.property_id AND p.user_id = f.user_id
      WHERE f.user_id = ?
        AND (f.status IN ('REQUIRES_CONFIRMATION', 'UNSTABLE', 'HIGH_CONFIDENCE')
             OR (f.status = 'VERIFIED' AND f.possible_change = 1))
      ORDER BY p.name, f.confidence DESC`,
    [userId]
  );
}

/**
 * Confirme un fait, éventuellement avec une valeur corrigée par l'hôte.
 *
 * La correction devient la source la plus prioritaire (§17) : `source` passe à
 * `manual` et aucune analyse ultérieure ne pourra la remplacer.
 *
 * @returns {{fact: object}|null} `null` si le fait n'appartient pas à cet hôte.
 */
async function confirmFact(db, userId, factId, correctedValue = null) {
  const rows = await db.query(
    'SELECT * FROM property_facts WHERE id = ? AND user_id = ?',
    [factId, userId]
  );
  if (rows.length === 0) return null;
  const fact = rows[0];

  const value = clean(correctedValue) || fact.fact_value;
  const corrected = clean(correctedValue) !== null
    && canonicalValue(fact.fact_key, correctedValue) !== canonicalValue(fact.fact_key, fact.fact_value);

  await db.query(
    `UPDATE property_facts
        SET fact_value = ?, status = 'VERIFIED', verified_at = NOW(), verified_by = 'user',
            possible_change = 0, source = ?, confidence = 100, updated_at = NOW()
      WHERE id = ? AND user_id = ?`,
    [value, corrected ? 'manual' : fact.source, factId, userId]
  );

  return { ...fact, fact_value: value, status: 'VERIFIED', source: corrected ? 'manual' : fact.source };
}

/**
 * L'hôte dit « non ». Le fait passe en UNKNOWN : il n'est plus proposé, et
 * surtout il n'est pas supprimé — sans la ligne, la prochaine analyse le
 * reproposerait à l'identique.
 */
async function rejectFact(db, userId, factId) {
  const rows = await db.query(
    'SELECT id FROM property_facts WHERE id = ? AND user_id = ?',
    [factId, userId]
  );
  if (rows.length === 0) return false;

  await db.query(
    `UPDATE property_facts
        SET status = 'UNKNOWN', possible_change = 0, verified_at = NOW(), verified_by = 'user',
            updated_at = NOW()
      WHERE id = ? AND user_id = ?`,
    [factId, userId]
  );
  return true;
}

/**
 * Les faits qu'une analyse peut recopier d'elle-même dans la fiche.
 *
 * Trois conditions, toutes nécessaires :
 *   - le statut l'autorise (HIGH_CONFIDENCE, ou VERIFIED par l'hôte) ;
 *   - l'information n'est pas volatile (jamais un code, jamais un mot de passe) ;
 *   - le champ de la fiche est VIDE. Une valeur déjà là vient soit de l'export
 *     structuré, soit de l'hôte : dans les deux cas elle prime (§1).
 *
 * @param {Array} facts
 * @param {object} current valeurs actuelles de la fiche, colonnes et contexte
 * @returns {object} `{ clé: valeur }` à écrire
 */
function autoApplicableValues(facts, current = {}) {
  const out = {};
  for (const fact of Array.isArray(facts) ? facts : []) {
    const key = fact.key || fact.fact_key;
    const status = fact.status;
    if (!key || !STABILITY[key]) continue;
    if (STABILITY[key] === 'volatile') continue;
    if (status !== 'VERIFIED' && !AUTO_APPLICABLE.has(status)) continue;

    const existing = current[key];
    const filled = existing !== undefined && existing !== null && existing !== ''
      && !(typeof existing === 'number' && Number.isNaN(existing));
    if (filled) continue;

    const value = fact.value !== undefined ? fact.value : fact.fact_value;
    if (value === undefined || value === null || value === '') continue;

    out[key] = VALUE_TYPE[key] === 'boolean' ? value === true || value === 'true' : value;
  }
  return out;
}

/** Marque les faits effectivement recopiés dans la fiche. */
async function markApplied(db, userId, propertyId, keys) {
  const list = [...new Set((keys || []).filter((k) => STABILITY[k]))];
  if (list.length === 0) return;
  const placeholders = list.map(() => '?').join(', ');
  await db.query(
    `UPDATE property_facts SET applied_at = NOW(), updated_at = NOW()
      WHERE user_id = ? AND property_id = ? AND fact_key IN (${placeholders})`,
    [userId, propertyId, ...list]
  );
}

/**
 * Apprentissage continu (§18) : un nouveau message de l'hôte, arrivé par la
 * synchronisation et non par l'export.
 *
 * Volontairement CONSERVATEUR. Un message isolé ne peut pas créer un fait :
 * il n'a ni les huit occurrences, ni les six réservations, ni l'étalement que
 * demandent les seuils. Ce qu'il peut faire, c'est SIGNALER qu'un fait établi
 * est peut-être périmé — et c'est tout ce que fait cette fonction.
 *
 * @returns {number} nombre de faits signalés comme peut-être changés
 */
async function noteHostMessage(db, userId, propertyId, text, { extract } = {}) {
  const extractCandidates = extract || require('./factExtraction').extractCandidates;
  const candidates = extractCandidates(text)
    .filter((c) => c.kind === 'CONFIRMATION' || c.kind === 'UPDATE');
  if (candidates.length === 0) return 0;

  const rows = await db.query(
    'SELECT id, fact_key, fact_value, status FROM property_facts WHERE user_id = ? AND property_id = ?',
    [userId, propertyId]
  );
  if (rows.length === 0) return 0;
  const byKey = new Map(rows.map((row) => [row.fact_key, row]));

  let flagged = 0;
  for (const candidate of candidates) {
    const fact = byKey.get(candidate.key);
    if (!fact) continue;
    if (canonicalValue(candidate.key, fact.fact_value) === canonicalValue(candidate.key, candidate.value)) continue;

    // Un désaccord ne remplace RIEN. Il ouvre une question.
    await db.query(
      'UPDATE property_facts SET possible_change = 1, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [fact.id, userId]
    );
    flagged++;
  }

  if (flagged > 0) {
    logger.info(`Faits signalés comme peut-être changés (user ${userId}, logement ${propertyId}) : ${flagged}`);
  }
  return flagged;
}

module.exports = {
  saveFacts,
  listFacts,
  listPending,
  confirmFact,
  rejectFact,
  autoApplicableValues,
  markApplied,
  noteHostMessage,
  sanitizeFact,
  COLUMN_FACTS,
  AUTO_APPLICABLE,
  STATUSES,
};

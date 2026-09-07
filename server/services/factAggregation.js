/**
 * Décision : ce faisceau de preuves suffit-il, et à quel titre ?
 *
 * `factExtraction.js` rend des candidats — « cette phrase, ce jour-là, dit
 * 16:00 ». Ce module regarde TOUS les candidats d'un logement et tranche : est-ce
 * la règle du logement, un changement récent, ou une valeur trop fragile pour
 * être présentée comme vraie ?
 *
 * QUATRE PRINCIPES
 * ----------------
 *  1. UNE PREUVE N'EST PAS UNE OCCURRENCE. Quinze répétitions dans une seule
 *     conversation ne valent pas quinze preuves : ce qui compte est le nombre de
 *     RÉSERVATIONS DISTINCTES qui disent la même chose. Un modèle de message
 *     envoyé quinze fois au même voyageur n'apprend rien de plus que la
 *     première fois.
 *
 *  2. LE VOTE MAJORITAIRE HISTORIQUE EST UN PIÈGE. Un logement dont l'arrivée
 *     est passée de 15h à 16h a quarante preuves pour 15h et quinze pour 16h ;
 *     la majorité désigne la valeur PÉRIMÉE. La fenêtre récente est donc
 *     comparée à l'historique, et un désaccord ne se tranche pas tout seul : il
 *     part en confirmation utilisateur.
 *
 *  3. LA CONFIANCE N'EST PAS LA VÉRIFICATION. Un code de boîte à clés vu dans
 *     cinquante réservations sans la moindre contradiction peut avoir changé
 *     hier. Le score peut valoir 100 et le statut rester
 *     REQUIRES_CONFIRMATION : ce sont deux axes indépendants (§12).
 *
 *  4. AUCUN FAIT ISSU DES MESSAGES N'EST « VERIFIED ». Ce statut est réservé à
 *     ce que l'utilisateur a confirmé, ou à ce que l'export structuré affirme.
 *     HIGH_CONFIDENCE est le plafond de cette source.
 */

const { STABILITY, VALUE_TYPE, canonicalValue, isExclusive } = require('./factExtraction');

// ── Paliers de volume (§4) ──────────────────────────────────────────────────
//
// Comptés en RÉSERVATIONS DISTINCTES rattachées au logement, pas en messages.
// Un logement à trois séjours n'a pas d'historique représentatif, quoi que ses
// messages répètent.
const VOLUME_TIERS = [
  { name: 'insufficient', min: 0, max: 9 },   // aucun HIGH_CONFIDENCE possible
  { name: 'limited', min: 10, max: 29 },      // confirmation utilisateur obligatoire
  { name: 'solid', min: 30, max: 79 },        // HIGH_CONFIDENCE possible
  { name: 'very_solid', min: 80, max: Infinity },
];

function volumeTier(reservationCount) {
  const count = Number(reservationCount) || 0;
  return (VOLUME_TIERS.find((t) => count >= t.min && count <= t.max) || VOLUME_TIERS[0]).name;
}

// ── Seuils par information (§5) ─────────────────────────────────────────────
//
// Base commune, exigée quelle que soit la catégorie. Elle traduit littéralement
// le cahier des charges : « au moins 8 occurrences concordantes, dans au moins
// 6 conversations distinctes, provenant d'au moins 6 réservations distinctes,
// réparties sur plusieurs périodes ».
const BASE = {
  evidence: 8,
  conversations: 6,
  reservations: 6,
  periods: 3,
};

/**
 * Exigences supplémentaires par catégorie de stabilité (§9).
 *
 * `spanDays` : écart minimal entre la première et la dernière preuve. Une
 * information « stable » vue seulement pendant une semaine n'a pas encore
 * montré qu'elle était stable. L'exigence tombe si l'historique du logement est
 * lui-même plus court — on ne peut pas demander 90 jours de recul à un logement
 * ouvert depuis 40 jours.
 *
 * `needsRecent` : une information semi-stable doit avoir été confirmée
 * récemment, sinon rien ne dit qu'elle vaut encore.
 */
const CATEGORY_RULES = {
  stable: { spanDays: 90, needsRecent: false, automatic: true },
  semi_stable: { spanDays: 0, needsRecent: true, automatic: true },
  // Les codes et mots de passe ne franchissent JAMAIS la barre automatiquement,
  // quels que soient les compteurs.
  volatile: { spanDays: 0, needsRecent: true, automatic: false },
};

const RECENT_DAYS = 365;
// Fenêtre d'analyse du changement : les dernières réservations, pas les
// derniers jours. C'est ce que demande le §8, et c'est ce qui a du sens pour un
// logement peu loué.
const RECENT_RESERVATIONS = 25;
// En deçà, ce n'est pas un fait : c'est du bruit. Une seule mention ne peut pas
// distinguer la règle du logement d'une phrase de circonstance.
const MIN_EVIDENCE_TO_EMIT = 2;
const MIN_RESERVATIONS_TO_EMIT = 2;
// Part de preuves discordantes au-delà de laquelle la valeur est déclarée
// instable plutôt que majoritaire.
const UNSTABLE_RATIO = 0.34;
// Preuves conservées par fait. Le reste n'est pas stocké : les compteurs
// suffisent, et dupliquer des conversations serait un coût de vie privée sans
// contrepartie (§15).
const MAX_EVIDENCE_KEPT = 5;
const MAX_ALTERNATIVES = 4;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Période = mois calendaire. C'est la granularité du « réparties sur plusieurs périodes ». */
function periodOf(date) {
  return date.toISOString().slice(0, 7);
}

/**
 * Regroupe les preuves d'une même clé par valeur canonique.
 * @returns {Map<string, {value, evidence: Array}>}
 */
function groupByValue(key, evidence) {
  const groups = new Map();
  for (const item of evidence) {
    const canonical = canonicalValue(key, item.value);
    if (!canonical) continue;
    const group = groups.get(canonical) || { canonical, evidence: [], forms: new Map() };
    group.evidence.push(item);
    // La valeur AFFICHÉE est la formulation d'origine la plus fréquente : on ne
    // montre pas à l'hôte une version normalisée de sa propre phrase.
    group.forms.set(item.value, (group.forms.get(item.value) || 0) + 1);
    groups.set(canonical, group);
  }

  for (const group of groups.values()) {
    let best = null;
    let bestCount = -1;
    for (const [form, count] of group.forms) {
      if (count > bestCount) { best = form; bestCount = count; }
    }
    group.value = best;
  }
  return groups;
}

/** Compteurs d'un groupe de preuves. */
function statsOf(evidence) {
  const conversations = new Set();
  const reservations = new Set();
  const periods = new Set();
  let first = null;
  let last = null;

  for (const item of evidence) {
    if (item.thread_ref) conversations.add(String(item.thread_ref));
    if (item.reservation_code) reservations.add(String(item.reservation_code));
    const date = toDate(item.observed_at);
    if (!date) continue;
    periods.add(periodOf(date));
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }

  return {
    evidence_count: evidence.length,
    distinct_conversations: conversations.size,
    // Une conversation non rattachée à une réservation ne peut pas compter comme
    // réservation distincte : le rattachement au logement passe justement par
    // le code de réservation.
    distinct_reservations: reservations.size,
    distinct_periods: periods.size,
    first_seen: first,
    last_seen: last,
  };
}

/**
 * Les `RECENT_RESERVATIONS` réservations les plus récentes du logement, d'après
 * les preuves elles-mêmes. Sert à comparer « ce qui se dit en ce moment » à
 * « ce qui s'est dit en tout ».
 */
function recentReservationSet(allEvidence) {
  const latest = new Map();
  for (const item of allEvidence) {
    const code = item.reservation_code;
    const date = toDate(item.observed_at);
    if (!code || !date) continue;
    const known = latest.get(code);
    if (!known || date > known) latest.set(code, date);
  }
  return new Set(
    [...latest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RECENT_RESERVATIONS)
      .map(([code]) => code)
  );
}

/** Le groupe qui l'emporte : d'abord les réservations distinctes, puis le volume, puis la récence. */
function leaderOf(groups) {
  let best = null;
  for (const group of groups) {
    if (!best) { best = group; continue; }
    if (group.stats.distinct_reservations !== best.stats.distinct_reservations) {
      if (group.stats.distinct_reservations > best.stats.distinct_reservations) best = group;
      continue;
    }
    if (group.stats.evidence_count !== best.stats.evidence_count) {
      if (group.stats.evidence_count > best.stats.evidence_count) best = group;
      continue;
    }
    if (group.stats.last_seen && best.stats.last_seen && group.stats.last_seen > best.stats.last_seen) {
      best = group;
    }
  }
  return best;
}

/**
 * Score de confiance, 0 à 100 (§12).
 *
 * Il agrège plusieurs facteurs indépendants plutôt que le seul nombre de
 * messages : dix messages dans une seule conversation valent moins que six
 * messages dans six réservations étalées sur six mois.
 *
 * Le score ne décide de RIEN à lui seul — c'est `decideStatus` qui tranche, et
 * il peut refuser une valeur notée 100.
 */
function confidenceOf({ stats, contradictionRatio, possibleChange, agreesWithQuickReply, agreesWithStructured, today }) {
  let score = 0;
  score += Math.min(30, stats.distinct_reservations * 3);
  score += Math.min(20, stats.distinct_conversations * 2);
  score += Math.min(15, stats.evidence_count);
  score += Math.min(15, stats.distinct_periods * 5);

  if (stats.last_seen) {
    const age = daysBetween(stats.last_seen, today);
    if (age <= 90) score += 10;
    else if (age <= 180) score += 6;
    else if (age <= RECENT_DAYS) score += 3;
  }

  // Concordance avec une source indépendante : deux chemins différents qui
  // donnent la même valeur valent mieux qu'un seul très bavard.
  if (agreesWithQuickReply) score += 5;
  if (agreesWithStructured) score += 5;

  score -= Math.round(contradictionRatio * 40);
  if (possibleChange) score -= 10;

  return Math.max(0, Math.min(100, score));
}

/**
 * Le fait remplit-il les seuils de preuve pour un statut automatique ?
 * @returns {{ok: boolean, missing: string[]}}
 */
function meetsThresholds({ stats, stability, historySpanDays, today }) {
  const rules = CATEGORY_RULES[stability] || CATEGORY_RULES.semi_stable;
  const missing = [];

  if (stats.evidence_count < BASE.evidence) missing.push('evidence');
  if (stats.distinct_conversations < BASE.conversations) missing.push('conversations');
  if (stats.distinct_reservations < BASE.reservations) missing.push('reservations');
  if (stats.distinct_periods < BASE.periods) missing.push('periods');

  if (rules.spanDays > 0 && stats.first_seen && stats.last_seen) {
    const span = daysBetween(stats.first_seen, stats.last_seen);
    // L'exigence d'étalement ne s'applique que si l'historique du logement le
    // permet : sinon on demanderait l'impossible à un logement récent.
    const required = Math.min(rules.spanDays, historySpanDays);
    if (span < required) missing.push('span');
  }

  if (rules.needsRecent) {
    const recent = stats.last_seen && daysBetween(stats.last_seen, today) <= RECENT_DAYS;
    if (!recent) missing.push('recency');
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Statut final. L'ordre des règles est significatif : la plus restrictive
 * l'emporte, et aucune ne peut être contournée par un score élevé.
 */
function decideStatus({ stability, tier, thresholds, contradictionRatio, possibleChange }) {
  const rules = CATEGORY_RULES[stability] || CATEGORY_RULES.semi_stable;

  // 1. Une information volatile ne devient jamais un fait automatique : la
  //    valeur peut avoir changé hier sans qu'aucun message ne le dise (§9C).
  if (!rules.automatic) return 'REQUIRES_CONFIRMATION';

  // 2. Un changement probable n'est pas arbitré tout seul (§8).
  if (possibleChange) return 'REQUIRES_CONFIRMATION';

  // 3. Plusieurs valeurs incompatibles : rien n'est proposé comme acquis.
  if (contradictionRatio > UNSTABLE_RATIO) return 'UNSTABLE';

  // 4. Volume d'historique du logement (§4).
  if (tier === 'insufficient') return 'CANDIDATE';
  if (tier === 'limited') return thresholds.ok ? 'REQUIRES_CONFIRMATION' : 'CANDIDATE';

  // 5. Seuils par information (§5, §9).
  return thresholds.ok ? 'HIGH_CONFIDENCE' : 'CANDIDATE';
}

/**
 * Agrège les preuves d'UN logement en faits.
 *
 * @param {Array} evidence preuves brutes, toutes clés confondues
 * @param {object} context
 * @param {number} context.reservationCount réservations distinctes rattachées
 * @param {Date}   [context.today]
 * @param {object} [context.quickReplyValues] valeurs tirées de host_quick_replies
 * @param {object} [context.structuredValues] valeurs déjà connues de l'export structuré
 * @returns {Array} faits, une entrée par clé
 */
function aggregateFacts(evidence, context = {}) {
  const today = context.today ? toDate(context.today) : new Date();
  const reservationCount = Number(context.reservationCount) || 0;
  const tier = volumeTier(reservationCount);
  const quickReplyValues = context.quickReplyValues || {};
  const structuredValues = context.structuredValues || {};

  const byKey = new Map();
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || !item.key || item.value === undefined || item.value === null) continue;
    if (!STABILITY[item.key]) continue;
    const list = byKey.get(item.key) || [];
    list.push(item);
    byKey.set(item.key, list);
  }

  // Étalement réel de l'historique du logement, toutes clés confondues.
  let historyFirst = null;
  let historyLast = null;
  for (const item of Array.isArray(evidence) ? evidence : []) {
    const date = toDate(item && item.observed_at);
    if (!date) continue;
    if (!historyFirst || date < historyFirst) historyFirst = date;
    if (!historyLast || date > historyLast) historyLast = date;
  }
  const historySpanDays = historyFirst && historyLast ? daysBetween(historyFirst, historyLast) : 0;

  const facts = [];

  for (const [key, items] of byKey) {
    const stability = STABILITY[key];

    // Les exceptions sont comptées, jamais utilisées comme preuve (§7).
    const supporting = items.filter((i) => i.kind === 'CONFIRMATION' || i.kind === 'UPDATE');
    const exceptions = items.filter((i) => i.kind === 'EXCEPTION');
    if (supporting.length === 0) continue;

    const groups = [...groupByValue(key, supporting).values()]
      .map((group) => ({ ...group, stats: statsOf(group.evidence) }));
    if (groups.length === 0) continue;

    const historical = leaderOf(groups);
    if (!historical) continue;

    // ── Analyse temporelle (§8) ────────────────────────────────────────────
    //
    // La fenêtre récente est recalculée sur les seules réservations les plus
    // récentes. Si elle désigne une AUTRE valeur, la majorité historique est
    // probablement périmée — et c'est exactement le cas que le vote majoritaire
    // seul traiterait à l'envers.
    // Ce raisonnement ne vaut que pour une information EXCLUSIVE : il n'y a
    // qu'une heure d'arrivée, donc en voir deux veut dire quelque chose. Deux
    // phrases différentes sur le stationnement ne veulent rien dire de tel.
    const exclusive = isExclusive(key);

    let winner = historical;
    let previous = null;
    let possibleChange = false;

    if (exclusive) {
      const recentCodes = recentReservationSet(supporting);
      const recentGroups = groups
        .map((group) => ({
          ...group,
          evidence: group.evidence.filter((e) => e.reservation_code && recentCodes.has(String(e.reservation_code))),
        }))
        .filter((group) => group.evidence.length > 0)
        .map((group) => ({ ...group, stats: statsOf(group.evidence) }));
      const recent = leaderOf(recentGroups);

      // Une mise à jour explicite (« désormais », « nouveau code ») pèse plus
      // lourd que n'importe quel nombre d'anciennes occurrences.
      const updates = supporting
        .filter((i) => i.kind === 'UPDATE')
        .map((i) => ({ item: i, date: toDate(i.observed_at) }))
        .filter((u) => u.date && daysBetween(u.date, today) <= RECENT_DAYS)
        .sort((a, b) => b.date - a.date);
      const announced = updates.length > 0 ? updates[0].item : null;

      if (recent && recent.canonical !== historical.canonical && recent.stats.distinct_reservations >= 3) {
        winner = recent;
        previous = historical.value;
        possibleChange = true;
      }

      if (announced && canonicalValue(key, announced.value) !== winner.canonical) {
        const announcedGroup = groups.find((g) => g.canonical === canonicalValue(key, announced.value));
        if (announcedGroup) {
          previous = winner.value;
          winner = announcedGroup;
          possibleChange = true;
        }
      }
    }

    const totalSupporting = supporting.length;
    // Sur un champ libre, les autres formulations ne sont pas des
    // contradictions : ce sont des variantes, et elles sont présentées comme
    // telles plus bas.
    const contradictionCount = exclusive ? totalSupporting - winner.stats.evidence_count : 0;
    const contradictionRatio = totalSupporting > 0 ? contradictionCount / totalSupporting : 0;

    if (winner.stats.evidence_count < MIN_EVIDENCE_TO_EMIT
        || winner.stats.distinct_reservations < MIN_RESERVATIONS_TO_EMIT) {
      continue;
    }

    const agreesWithQuickReply = quickReplyValues[key] !== undefined
      && canonicalValue(key, quickReplyValues[key]) === winner.canonical;
    const agreesWithStructured = structuredValues[key] !== undefined
      && canonicalValue(key, structuredValues[key]) === winner.canonical;

    const thresholds = meetsThresholds({
      stats: winner.stats, stability, historySpanDays, today,
    });

    const status = decideStatus({
      stability, tier, thresholds, contradictionRatio, possibleChange,
    });

    const confidence = confidenceOf({
      stats: winner.stats,
      contradictionRatio,
      possibleChange,
      agreesWithQuickReply,
      agreesWithStructured,
      today,
    });

    facts.push({
      key,
      value: winner.value,
      value_type: VALUE_TYPE[key] || 'text',
      stability,
      source: 'host_messages',
      status,
      confidence,
      evidence_count: winner.stats.evidence_count,
      distinct_conversations: winner.stats.distinct_conversations,
      distinct_reservations: winner.stats.distinct_reservations,
      distinct_periods: winner.stats.distinct_periods,
      contradiction_count: contradictionCount,
      exception_count: exceptions.length,
      first_seen: winner.stats.first_seen ? isoDay(winner.stats.first_seen) : null,
      last_seen: winner.stats.last_seen ? isoDay(winner.stats.last_seen) : null,
      previous_value: previous,
      possible_change: possibleChange,
      missing_criteria: thresholds.missing,
      // Les autres valeurs vues, pour que l'écran de vérification puisse dire
      // « Michel a trouvé plusieurs valeurs » et les montrer.
      alternatives: groups
        .filter((group) => group.canonical !== winner.canonical)
        .sort((a, b) => b.stats.distinct_reservations - a.stats.distinct_reservations)
        .slice(0, MAX_ALTERNATIVES)
        .map((group) => ({
          value: group.value,
          distinct_reservations: group.stats.distinct_reservations,
          evidence_count: group.stats.evidence_count,
          last_seen: group.stats.last_seen ? isoDay(group.stats.last_seen) : null,
        })),
      evidence: sampleEvidence(winner.evidence),
    });
  }

  facts.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
  return { facts, tier, reservation_count: reservationCount };
}

/**
 * Preuves conservées : la plus ancienne, la plus récente, et quelques-unes au
 * milieu. Garder les cinq dernières donnerait une photo d'un seul mois ;
 * l'échantillon étalé montre justement ce sur quoi la décision s'appuie.
 */
function sampleEvidence(evidence) {
  const dated = evidence
    .map((item) => ({ item, date: toDate(item.observed_at) }))
    .filter((entry) => entry.date)
    .sort((a, b) => a.date - b.date);
  if (dated.length === 0) return evidence.slice(0, MAX_EVIDENCE_KEPT);
  if (dated.length <= MAX_EVIDENCE_KEPT) return dated.map((e) => e.item);

  const picked = [];
  const step = (dated.length - 1) / (MAX_EVIDENCE_KEPT - 1);
  for (let i = 0; i < MAX_EVIDENCE_KEPT; i++) {
    picked.push(dated[Math.round(i * step)].item);
  }
  return picked;
}

module.exports = {
  aggregateFacts,
  volumeTier,
  VOLUME_TIERS,
  BASE,
  CATEGORY_RULES,
  RECENT_DAYS,
  RECENT_RESERVATIONS,
  UNSTABLE_RATIO,
  MAX_EVIDENCE_KEPT,
  // Exposés pour les tests.
  __groupByValue: groupByValue,
  __statsOf: statsOf,
  __confidenceOf: confidenceOf,
  __meetsThresholds: meetsThresholds,
  __decideStatus: decideStatus,
  __sampleEvidence: sampleEvidence,
};

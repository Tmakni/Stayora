/**
 * Décision : ce faisceau de preuves suffit-il, et à quel titre ?
 *
 * Ce fichier verrouille les règles qui font qu'une information tirée des
 * conversations peut, ou ne peut pas, être présentée comme sûre :
 *
 *   - le nombre de RÉSERVATIONS distinctes prime sur le nombre de messages ;
 *   - un logement sans historique n'apprend pas ;
 *   - un code ou un mot de passe ne franchit jamais la barre tout seul ;
 *   - la majorité historique ne l'emporte pas sur un changement récent ;
 *   - un score de 100 ne vaut pas une vérification.
 */

const {
  aggregateFacts, volumeTier,
  __statsOf: statsOf,
  __decideStatus: decideStatus,
  __sampleEvidence: sampleEvidence,
} = require('../services/factAggregation');

const TODAY = new Date('2026-09-01T00:00:00Z');

/**
 * Fabrique des preuves concordantes réparties dans le temps.
 *
 * Une preuve par réservation par défaut : c'est le cas honnête. Les tests qui
 * veulent éprouver « beaucoup de messages, peu de réservations » le disent
 * explicitement avec `perReservation`.
 */
function evidence(key, value, {
  count = 10, kind = 'CONFIRMATION', perReservation = 1,
  startMonthsAgo = 12, spreadMonths = 10, prefix = 'R',
} = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const reservation = `${prefix}${Math.floor(i / perReservation)}`;
    const monthsAgo = startMonthsAgo - Math.round((i / Math.max(1, count - 1)) * spreadMonths);
    const date = new Date(TODAY);
    date.setUTCMonth(date.getUTCMonth() - monthsAgo);
    out.push({
      key,
      value,
      kind,
      snippet: `${key} = ${value}`,
      thread_ref: `T${Math.floor(i / perReservation)}${prefix}`,
      message_ref: `M${i}${prefix}`,
      reservation_code: reservation,
      observed_at: date.toISOString(),
    });
  }
  return out;
}

function factFor(evidenceList, context = {}) {
  const { facts } = aggregateFacts(evidenceList, {
    reservationCount: 40, today: TODAY, ...context,
  });
  return facts[0];
}

// ────────────────────────────────────────────────────────────────────────────
describe('paliers de volume', () => {
  it('classe le logement selon ses réservations distinctes', () => {
    expect(volumeTier(0)).toBe('insufficient');
    expect(volumeTier(9)).toBe('insufficient');
    expect(volumeTier(10)).toBe('limited');
    expect(volumeTier(29)).toBe('limited');
    expect(volumeTier(30)).toBe('solid');
    expect(volumeTier(79)).toBe('solid');
    expect(volumeTier(80)).toBe('very_solid');
  });

  it('un logement à trois séjours n’atteint jamais HIGH_CONFIDENCE', () => {
    // Les compteurs de l'information sont excellents ; c'est l'historique du
    // LOGEMENT qui est trop mince pour que la répétition veuille dire quelque
    // chose.
    const fact = factFor(evidence('check_in_time', '16:00', { count: 20 }), { reservationCount: 3 });
    expect(fact.status).toBe('CANDIDATE');
  });

  it('entre 10 et 29 réservations, la confirmation reste obligatoire', () => {
    const fact = factFor(evidence('check_in_time', '16:00', { count: 20 }), { reservationCount: 20 });
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('au-delà de 30 réservations, une information bien étayée passe', () => {
    const fact = factFor(evidence('check_in_time', '16:00', { count: 20 }), { reservationCount: 40 });
    expect(fact.status).toBe('HIGH_CONFIDENCE');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('une preuve n’est pas une occurrence', () => {
  it('quinze répétitions dans une seule conversation ne valent pas quinze preuves', () => {
    // Une seule réservation : rien n'est même émis. Quinze messages au même
    // voyageur n'apprennent pas plus que le premier.
    const { facts } = aggregateFacts(
      evidence('check_in_time', '16:00', { count: 15, perReservation: 15 }),
      { reservationCount: 40, today: TODAY }
    );
    expect(facts).toHaveLength(0);
  });

  it('trente messages sur deux réservations restent un simple candidat', () => {
    const fact = factFor(evidence('check_in_time', '16:00', { count: 30, perReservation: 15 }));
    expect(fact.evidence_count).toBe(30);
    expect(fact.distinct_reservations).toBe(2);
    expect(fact.status).toBe('CANDIDATE');
  });

  it('compte séparément messages, conversations et réservations', () => {
    const stats = statsOf(evidence('check_out_time', '11:00', { count: 12, perReservation: 3 }));
    expect(stats.evidence_count).toBe(12);
    expect(stats.distinct_reservations).toBe(4);
    expect(stats.distinct_conversations).toBe(4);
  });

  it('une preuve sans code de réservation ne compte pas comme réservation', () => {
    const orphan = evidence('check_in_time', '16:00', { count: 12 })
      .map((e) => ({ ...e, reservation_code: null }));
    const stats = statsOf(orphan);
    expect(stats.evidence_count).toBe(12);
    expect(stats.distinct_reservations).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('seuils par information', () => {
  it('refuse une information vue sur une seule période', () => {
    const sameMonth = evidence('check_in_time', '16:00', { count: 12, spreadMonths: 0 });
    expect(factFor(sameMonth).status).toBe('CANDIDATE');
  });

  it('exige de l’étalement pour une information dite stable', () => {
    // Douze réservations, mais toutes dans une fenêtre de trois semaines : une
    // information « stable » n'a pas encore montré qu'elle l'était.
    const short = evidence('floor_number', '3', { count: 12, startMonthsAgo: 1, spreadMonths: 0 })
      .map((e, i) => ({ ...e, observed_at: new Date(Date.UTC(2026, 7, 1 + i)).toISOString() }));
    expect(factFor(short).status).toBe('CANDIDATE');
  });

  it("exige une preuve récente pour une information semi-stable", () => {
    const stale = evidence('check_out_time', '11:00', { count: 15, startMonthsAgo: 40, spreadMonths: 10 });
    expect(factFor(stale).status).toBe('CANDIDATE');
  });

  it('n’émet rien sur une mention isolée', () => {
    const { facts } = aggregateFacts(evidence('gate_code', '1975', { count: 1 }), {
      reservationCount: 40, today: TODAY,
    });
    expect(facts).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('informations sensibles', () => {
  it('un code jamais contredit reste à confirmer', () => {
    const fact = factFor(evidence('access_code', '4289', { count: 50 }), { reservationCount: 120 });
    // Le score peut être excellent…
    expect(fact.confidence).toBeGreaterThan(80);
    // …le statut ne bouge pas : la valeur a pu changer hier.
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('un mot de passe Wi-Fi non plus', () => {
    const fact = factFor(evidence('wifi_password', 'delkeys33', { count: 40 }), { reservationCount: 120 });
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('le nom du réseau, lui, peut passer', () => {
    const fact = factFor(evidence('wifi_name', 'Livebox-A1D6', { count: 20 }), { reservationCount: 40 });
    expect(fact.status).toBe('HIGH_CONFIDENCE');
  });

  it('confiance et vérification sont deux axes distincts', () => {
    const fact = factFor(evidence('gate_code', '1975', { count: 60 }), { reservationCount: 200 });
    expect(fact.confidence).toBeGreaterThanOrEqual(90);
    expect(fact.status).not.toBe('VERIFIED');
    expect(fact.status).not.toBe('HIGH_CONFIDENCE');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('analyse temporelle', () => {
  it('la majorité historique ne l’emporte pas sur un changement récent', () => {
    // 40 preuves anciennes pour 15h, 15 preuves récentes pour 16h. Le vote
    // majoritaire désignerait 15h — c'est-à-dire la valeur périmée.
    const old = evidence('check_in_time', '15:00', {
      count: 40, startMonthsAgo: 24, spreadMonths: 12, prefix: 'OLD',
    });
    const recent = evidence('check_in_time', '16:00', {
      count: 15, startMonthsAgo: 4, spreadMonths: 3, prefix: 'NEW',
    });
    const fact = factFor([...old, ...recent], { reservationCount: 90 });

    expect(fact.value).toBe('16:00');
    expect(fact.previous_value).toBe('15:00');
    expect(fact.possible_change).toBe(true);
    // Un changement ne s'arbitre pas tout seul.
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('une mise à jour annoncée pèse plus lourd que l’ancien usage', () => {
    const old = evidence('check_out_time', '10:00', {
      count: 30, startMonthsAgo: 20, spreadMonths: 10, prefix: 'OLD',
    });
    const announced = evidence('check_out_time', '11:00', {
      count: 4, kind: 'UPDATE', startMonthsAgo: 2, spreadMonths: 1, prefix: 'NEW',
    });
    const fact = factFor([...old, ...announced], { reservationCount: 60 });

    expect(fact.value).toBe('11:00');
    expect(fact.possible_change).toBe(true);
    expect(fact.status).toBe('REQUIRES_CONFIRMATION');
  });

  it('deux preuves récentes ne suffisent pas à renverser l’historique', () => {
    const old = evidence('check_in_time', '15:00', {
      count: 30, startMonthsAgo: 20, spreadMonths: 14, prefix: 'OLD',
    });
    const blip = evidence('check_in_time', '16:00', {
      count: 2, startMonthsAgo: 1, spreadMonths: 0, prefix: 'NEW',
    });
    const fact = factFor([...old, ...blip], { reservationCount: 60 });
    expect(fact.value).toBe('15:00');
    expect(fact.possible_change).toBe(false);
  });

  it("l'échantillon de preuves est étalé, pas concentré sur la fin", () => {
    const list = evidence('check_in_time', '16:00', { count: 40 });
    const sample = sampleEvidence(list);
    expect(sample).toHaveLength(5);
    expect(sample[0].observed_at).toBe(list[0].observed_at);
    expect(sample[4].observed_at).toBe(list[39].observed_at);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('contradictions', () => {
  it('deux codes de portail en désaccord rendent la valeur instable', () => {
    const a = evidence('gate_code', '1975', { count: 12, prefix: 'A' });
    const b = evidence('gate_code', '5689', { count: 11, prefix: 'B' });
    const fact = factFor([...a, ...b], { reservationCount: 60 });
    expect(fact.contradiction_count).toBeGreaterThan(0);
    expect(fact.alternatives[0].value).toBe('5689');
  });

  it('deux consignes de stationnement différentes ne se contredisent pas', () => {
    // Elles disent deux choses vraies du même stationnement. Les compter comme
    // contradictoires rendait instable TOUT champ libre.
    const a = evidence('parking_info', 'Le parking est derrière la maison, place 12.', { count: 12, prefix: 'A' });
    const b = evidence('parking_info', 'Vous pouvez vous garer gratuitement dans la rue.', { count: 8, prefix: 'B' });
    const fact = factFor([...a, ...b], { reservationCount: 60 });
    expect(fact.contradiction_count).toBe(0);
    expect(fact.status).toBe('HIGH_CONFIDENCE');
    expect(fact.alternatives).toHaveLength(1);
  });

  it('une exception n’est jamais comptée comme preuve', () => {
    const rule = evidence('check_in_time', '16:00', { count: 12, prefix: 'R' });
    const favour = evidence('check_in_time', '14:00', {
      count: 8, kind: 'EXCEPTION', prefix: 'E',
    });
    const fact = factFor([...rule, ...favour], { reservationCount: 60 });
    expect(fact.value).toBe('16:00');
    expect(fact.exception_count).toBe(8);
    // Les exceptions ne comptent pas non plus comme contradictions.
    expect(fact.contradiction_count).toBe(0);
  });

  it('un faisceau qui ne dit que des exceptions ne produit rien', () => {
    const { facts } = aggregateFacts(
      evidence('check_in_time', '14:00', { count: 20, kind: 'EXCEPTION' }),
      { reservationCount: 60, today: TODAY }
    );
    expect(facts).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('règles de statut', () => {
  const solid = { stability: 'semi_stable', tier: 'solid', thresholds: { ok: true, missing: [] } };

  it('un changement probable l’emporte sur tout le reste', () => {
    expect(decideStatus({ ...solid, contradictionRatio: 0, possibleChange: true }))
      .toBe('REQUIRES_CONFIRMATION');
  });

  it('trop de désaccord vaut instable', () => {
    expect(decideStatus({ ...solid, contradictionRatio: 0.5, possibleChange: false }))
      .toBe('UNSTABLE');
  });

  it('les seuils non atteints ramènent au simple candidat', () => {
    expect(decideStatus({ ...solid, thresholds: { ok: false, missing: ['periods'] }, contradictionRatio: 0, possibleChange: false }))
      .toBe('CANDIDATE');
  });

  it('aucune règle ne rend un fait VERIFIED', () => {
    for (const tier of ['insufficient', 'limited', 'solid', 'very_solid']) {
      for (const stability of ['stable', 'semi_stable', 'volatile']) {
        const status = decideStatus({
          stability, tier, thresholds: { ok: true, missing: [] },
          contradictionRatio: 0, possibleChange: false,
        });
        expect(status).not.toBe('VERIFIED');
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('concordance avec les autres sources', () => {
  it('un accord avec l’export structuré remonte le score', () => {
    const list = evidence('check_in_time', '16:00', { count: 12 });
    const alone = factFor(list, { reservationCount: 40 });
    const agreeing = factFor(list, {
      reservationCount: 40, structuredValues: { check_in_time: '16:00' },
    });
    expect(agreeing.confidence).toBeGreaterThan(alone.confidence);
  });

  it('une clé inconnue du vocabulaire est ignorée', () => {
    const { facts } = aggregateFacts(
      evidence('mot_de_passe_coffre', '1234', { count: 20 }),
      { reservationCount: 60, today: TODAY }
    );
    expect(facts).toHaveLength(0);
  });
});

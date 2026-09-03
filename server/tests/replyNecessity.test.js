/**
 * « Ce fil attend-il une réponse ? »
 *
 * Ce que ces tests protègent : la génération manuelle — le bouton « Générer »
 * — appelait le modèle sans condition. L'hôte obtenait donc un brouillon prêt
 * à envoyer sur un fil auquel il venait de répondre, sur un séjour clos depuis
 * des semaines, ou en face d'un simple « merci ! ». Le message existait sans
 * raison d'exister, et rien à l'écran ne le disait.
 *
 * Les cas « needed: true » comptent autant que les autres : un contrôle qui se
 * déclenche trop souvent se fait désactiver, et l'hôte perd la vérification
 * entière.
 */

const {
  evaluateReplyNecessity,
  saysNoAnswerExpected,
  NECESSITY,
} = require('../services/replyNecessity');

/** Fil du plus récent au plus ancien, comme getLatestGuestMessage(). */
const msg = (content, role = 'incoming', created_at = new Date()) => ({ role, content, created_at });

describe('le voyageur attend une réponse', () => {
  const realQuestions = [
    'Bonjour, quel est le code du wifi ?',
    'À quelle heure peut-on arriver ?',
    'Est-ce quil y a un parking dans la rue',
    "Le chauffage ne s'allume pas, comment faire ?",
    'Could you tell me where to park?',
  ];

  for (const question of realQuestions) {
    it(`répond à "${question}"`, () => {
      const verdict = evaluateReplyNecessity({ recent: [msg(question)] });
      expect(verdict.needed).toBe(true);
      expect(verdict.code).toBe(NECESSITY.OK);
    });
  }

  it('répond quand la politesse accompagne une vraie question', () => {
    const verdict = evaluateReplyNecessity({
      recent: [msg('Merci beaucoup ! Au fait, le parking est où ?')],
    });
    expect(verdict.needed).toBe(true);
  });

  it("répond quand des adieux contiennent encore une demande", () => {
    // Le garde `isStillAsking` de conversationClosure doit primer sur la
    // formule d'adieu : une vraie question ne doit jamais être étouffée.
    const verdict = evaluateReplyNecessity({
      recent: [msg("Merci pour tout, c'était parfait ! On récupère la caution comment ?")],
    });
    expect(verdict.needed).toBe(true);
  });
});

describe("l'hôte a déjà répondu", () => {
  it('ne génère rien quand le dernier message du fil est sortant', () => {
    const verdict = evaluateReplyNecessity({
      recent: [
        msg('Le code est 4589, bonne arrivée !', 'outgoing'),
        msg('Bonjour, quel est le code de la porte ?'),
      ],
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.code).toBe(NECESSITY.HOST_REPLIED_LAST);
  });

  it('répond de nouveau dès que le voyageur reprend la parole', () => {
    const verdict = evaluateReplyNecessity({
      recent: [
        msg('Et pour le parking ?'),
        msg('Le code est 4589, bonne arrivée !', 'outgoing'),
        msg('Bonjour, quel est le code de la porte ?'),
      ],
    });
    expect(verdict.needed).toBe(true);
  });
});

describe('rien à traiter', () => {
  it('ne génère rien sur un fil vide', () => {
    expect(evaluateReplyNecessity({ recent: [] }).code).toBe(NECESSITY.NO_INCOMING);
  });

  it("ne génère rien sur un fil où le voyageur n'a jamais écrit", () => {
    const verdict = evaluateReplyNecessity({ recent: [msg('Bienvenue !', 'outgoing')] });
    expect(verdict.needed).toBe(false);
  });
});

describe('simple politesse', () => {
  for (const courtesy of ['merci', 'Merci beaucoup !', 'ok', "c'est noté", '👍', 'super merci 🙏']) {
    it(`ne génère rien pour "${courtesy}"`, () => {
      const verdict = evaluateReplyNecessity({ recent: [msg(courtesy)] });
      expect(verdict.needed).toBe(false);
      expect(verdict.code).toBe(NECESSITY.COURTESY);
    });
  }
});

describe('conversation terminée', () => {
  it("s'arrête quand le voyageur a pris congé", () => {
    const verdict = evaluateReplyNecessity({
      recent: [msg("Merci pour tout, c'était parfait !")],
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.code).toBe(NECESSITY.CLOSED);
    expect(verdict.closureCode).toBe('guest_signed_off');
  });

  it("s'arrête sur une notification d'évaluation Airbnb", () => {
    const verdict = evaluateReplyNecessity({
      recent: [msg("Comment s'est passé votre séjour ? Écrivez un commentaire.")],
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.closureCode).toBe('stay_ended');
  });

  it("s'arrête sur un fil dormant", () => {
    const old = new Date(Date.now() - 60 * 86400000);
    const verdict = evaluateReplyNecessity({
      recent: [msg('Très bien.', 'incoming', old)],
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.closureCode).toBe('dormant');
  });
});

describe("le voyageur dit qu'il n'attend rien", () => {
  const closers = [
    "Je voulais juste vous prévenir qu'on arrive vers 20h, pas besoin de répondre.",
    'Inutile de me répondre, tout est réglé.',
    'Merci, je vous laisse.',
  ];

  for (const message of closers) {
    it(`ne génère rien pour "${message}"`, () => {
      const verdict = evaluateReplyNecessity({ recent: [msg(message)] });
      expect(verdict.needed).toBe(false);
    });
  }

  it("laisse passer quand une question suit dans le même message", () => {
    // La demande prime : « pas besoin de répondre » ne doit pas servir de
    // bâillon quand le voyageur enchaîne sur une vraie question.
    expect(saysNoAnswerExpected('Pas besoin de répondre. Enfin, le parking est où ?')).toBe(false);
  });
});

describe('le message jugé peut être imposé par l\'appelant', () => {
  it('emploie incomingMessage plutôt que le dernier message stocké', () => {
    // Le chemin automatique recolle la salve du voyageur avant d'appeler : le
    // texte à juger n'est alors PAS celui d'une seule ligne du fil.
    const verdict = evaluateReplyNecessity({
      recent: [msg('merci'), msg('ok')],
      incomingMessage: 'ok\n\nmerci beaucoup',
    });
    expect(verdict.needed).toBe(false);
    expect(verdict.code).toBe(NECESSITY.COURTESY);
  });
});

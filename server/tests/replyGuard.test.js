/**
 * Garde-fous des réponses automatiques.
 *
 * Ces tests décrivent le contrat de sécurité : dans quels cas Michel a le droit
 * d'écrire seul à un voyageur, et dans quels cas il doit s'abstenir et laisser
 * la main à l'hôte.
 */
const { shouldAutoSend, isCourtesyOnly } = require('../services/replyGuard');

// Résultat IA « normal » : question légitime, réponse exploitable.
function okResult(overrides = {}) {
  return {
    draft_reply: "Le check-in se fait à partir de 15h, la boîte à clés est à gauche de la porte.",
    intent: 'check-in',
    risk_level: 'low',
    escalate: false,
    needs_host: false,
    no_reply_needed: false,
    ...overrides,
  };
}

const ON = { incomingMessage: 'Bonjour, à quelle heure puis-je arriver ?', autoReplyEnabled: true };

describe('replyGuard — envoi automatique', () => {
  test('autorise une réponse normale quand tout est vert', () => {
    const v = shouldAutoSend(okResult(), ON);
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('ok');
  });

  describe('cas où AUCUNE réponse n’est nécessaire', () => {
    test.each([
      'merci',
      'Merci !',
      'ok',
      "d'accord",
      'parfait',
      'super merci',
      'très bien',
      'Thanks!',
      'noted',
      '👍',
      '🙏',
      '...',
    ])('ne répond pas à un message de politesse : %s', (msg) => {
      // Même si le modèle a produit une réponse et n'a rien signalé,
      // le filet déterministe doit bloquer l'envoi.
      const v = shouldAutoSend(okResult(), { incomingMessage: msg, autoReplyEnabled: true });
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('courtesy_message');
    });

    test('respecte no_reply_needed remonté par le modèle', () => {
      const v = shouldAutoSend(okResult({ no_reply_needed: true }), ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('no_reply_needed');
    });

    test('un "merci" suivi d’une vraie question reçoit bien une réponse', () => {
      // Piège classique : ne pas classer en politesse un message qui enchaîne
      // sur une demande réelle.
      const v = shouldAutoSend(okResult(), {
        incomingMessage: "Merci ! Par contre le chauffage ne fonctionne pas, comment faire ?",
        autoReplyEnabled: true,
      });
      expect(v.allowed).toBe(true);
    });
  });

  describe('cas nécessitant l’intervention de l’hôte', () => {
    test('ne répond pas si le modèle demande l’hôte', () => {
      const v = shouldAutoSend(okResult({ needs_host: true }), ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('needs_host');
    });

    test('ne répond pas sur un sujet escaladé', () => {
      const v = shouldAutoSend(okResult({ escalate: true }), ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('escalated');
    });

    test('ne répond pas sur un message à risque élevé', () => {
      const v = shouldAutoSend(okResult({ risk_level: 'high' }), ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('high_risk');
    });
  });

  describe('brouillons inexploitables', () => {
    test.each([
      ['vide', '', 'empty_draft'],
      ['espaces uniquement', '   \n  ', 'empty_draft'],
      ['trop court', 'Oui.', 'draft_too_short'],
      ['champ non complété', 'Bonjour, le code est [CODE_WIFI] pour vous connecter.', 'unfilled_placeholder'],
      ['gabarit non rempli', 'Bonjour, arrivée à {{check_in}} comme convenu ensemble.', 'unfilled_placeholder'],
    ])('n’envoie jamais un brouillon %s', (_label, draft, expected) => {
      const v = shouldAutoSend(okResult({ draft_reply: draft }), ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe(expected);
    });

    test('n’envoie rien si la génération a échoué', () => {
      const v = shouldAutoSend(null, ON);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('no_ai_result');
    });
  });

  describe('interrupteur du logement', () => {
    test('n’envoie rien quand les réponses auto sont désactivées', () => {
      const v = shouldAutoSend(okResult(), { ...ON, autoReplyEnabled: false });
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('auto_reply_disabled');
    });

    test('l’interrupteur prime sur tout le reste', () => {
      const v = shouldAutoSend(okResult(), { incomingMessage: 'merci', autoReplyEnabled: false });
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('auto_reply_disabled');
    });
  });
});

describe('isCourtesyOnly', () => {
  test('reconnaît les formules de politesse', () => {
    expect(isCourtesyOnly('merci')).toBe(true);
    expect(isCourtesyOnly('  OK  ')).toBe(true);
    expect(isCourtesyOnly('')).toBe(true);
  });

  test('ne classe pas une vraie question en politesse', () => {
    expect(isCourtesyOnly('Le wifi ne marche pas')).toBe(false);
    expect(isCourtesyOnly('Merci de me confirmer si le parking est inclus dans le prix')).toBe(false);
  });
});

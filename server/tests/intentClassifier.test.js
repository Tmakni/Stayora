const { classifyIntent, assessRisk, shouldEscalate, INTENTS } = require('../services/intentClassifier');

describe('Intent Classifier', () => {
  describe('classifyIntent', () => {
    test('should detect check-in intent', () => {
      const message = "Bonjour, nous arrivons demain. Quel est le code pour entrer?";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.CHECK_IN);
    });

    test('should detect wifi intent', () => {
      const message = "What is the WiFi password?";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.WIFI);
    });

    test('should detect parking intent', () => {
      const message = "Y a-t-il un parking disponible pour ma voiture?";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.PARKING);
    });

    test('should detect problem intent', () => {
      const message = "Le chauffage ne fonctionne pas, il y a un problème";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.PROBLEM);
    });

    test('should detect price negotiation intent', () => {
      const message = "Can you give me a discount on the price?";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.PRICE_NEGOTIATION);
    });

    test('should return OTHER for unclear messages', () => {
      const message = "Merci beaucoup!";
      const intent = classifyIntent(message);
      expect(intent).toBe(INTENTS.OTHER);
    });
  });

  describe('assessRisk', () => {
    test('should detect high risk for emergency keywords', () => {
      const message = "Il y a une urgence, j'appelle la police!";
      const risk = assessRisk(message);
      expect(risk).toBe('high');
    });

    test('should detect high risk for legal keywords', () => {
      const message = "I will contact my lawyer about this";
      const risk = assessRisk(message);
      expect(risk).toBe('high');
    });

    test('should detect medium risk for problems', () => {
      const message = "Le lave-linge est cassé, c'est un problème";
      const risk = assessRisk(message);
      expect(risk).toBe('medium');
    });

    test('should detect medium risk for refund requests', () => {
      const message = "I want a refund for this issue";
      const risk = assessRisk(message);
      expect(risk).toBe('medium');
    });

    test('should return low risk for normal messages', () => {
      const message = "What time is check-in?";
      const risk = assessRisk(message);
      expect(risk).toBe('low');
    });
  });

  describe('shouldEscalate', () => {
    test('should escalate on high risk', () => {
      const result = shouldEscalate(INTENTS.CHECK_IN, 'high', 100);
      expect(result).toBe(true);
    });

    test('should escalate on cancellation with medium risk', () => {
      const result = shouldEscalate(INTENTS.CANCELLATION, 'medium', 100);
      expect(result).toBe(true);
    });

    test('should escalate on problem with medium risk', () => {
      const result = shouldEscalate(INTENTS.PROBLEM, 'medium', 100);
      expect(result).toBe(true);
    });

    test('should escalate on very long messages', () => {
      const result = shouldEscalate(INTENTS.OTHER, 'low', 1500);
      expect(result).toBe(true);
    });

    test('should not escalate on low risk check-in', () => {
      const result = shouldEscalate(INTENTS.CHECK_IN, 'low', 50);
      expect(result).toBe(false);
    });

    test('should not escalate on low risk wifi query', () => {
      const result = shouldEscalate(INTENTS.WIFI, 'low', 30);
      expect(result).toBe(false);
    });
  });
});

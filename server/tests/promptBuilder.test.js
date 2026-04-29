const { buildSystemPrompt, buildUserPrompt } = require('../services/promptBuilder');

describe('Prompt Builder', () => {
  describe('buildSystemPrompt', () => {
    test('should build system prompt with full property context', () => {
      const context = {
        wifi_name: 'MyWiFi',
        wifi_password: 'password123',
        check_in_time: '15:00',
        check_out_time: '11:00',
        access_code: 'A1234',
        parking: 'Parking gratuit',
        rules: 'Non-fumeur',
        amenities: 'Cuisine, WiFi',
        nearby: 'Métro à 5 min',
        max_guests: 4
      };

      const prompt = buildSystemPrompt(context);

      expect(prompt).toContain('AirbnbHostAI');
      expect(prompt).toContain('MyWiFi');
      expect(prompt).toContain('password123');
      expect(prompt).toContain('15:00');
      expect(prompt).toContain('11:00');
      expect(prompt).toContain('A1234');
      expect(prompt).toContain('Non-fumeur');
      expect(prompt).toContain('4 personnes');
    });

    test('should handle JSON string context', () => {
      const context = JSON.stringify({
        wifi_name: 'TestWiFi',
        check_in_time: '14:00'
      });

      const prompt = buildSystemPrompt(context);

      expect(prompt).toContain('TestWiFi');
      expect(prompt).toContain('14:00');
    });

    test('should handle empty context', () => {
      const prompt = buildSystemPrompt({});

      expect(prompt).toContain('AirbnbHostAI');
      expect(prompt).toContain('Aucune information de propriété fournie');
    });
  });

  describe('buildUserPrompt', () => {
    test('should build user prompt with all parameters', () => {
      const message = "What time is check-in?";
      const history = [
        { role: 'incoming', content: 'Hello' },
        { role: 'outgoing', content: 'Hi there!' }
      ];
      const status = 'confirmed';
      const profile = {
        language: 'en',
        num_guests: 2,
        dates: '2026-03-01 to 2026-03-05'
      };

      const prompt = buildUserPrompt(message, history, status, profile);

      expect(prompt).toContain('confirmed');
      expect(prompt).toContain('Langue: en');
      expect(prompt).toContain('2 personnes');
      expect(prompt).toContain('2026-03-01 to 2026-03-05');
      expect(prompt).toContain('What time is check-in?');
      expect(prompt).toContain('VOYAGEUR: Hello');
      expect(prompt).toContain('HÔTE: Hi there!');
    });

    test('should build minimal prompt without history and profile', () => {
      const message = "Bonjour";
      const prompt = buildUserPrompt(message, [], 'inquiry', null);

      expect(prompt).toContain('inquiry');
      expect(prompt).toContain('Bonjour');
      expect(prompt).not.toContain('HISTORIQUE');
      expect(prompt).not.toContain('PROFIL VOYAGEUR');
    });

    test('should truncate long history messages', () => {
      const longMessage = 'A'.repeat(200);
      const history = [
        { role: 'incoming', content: longMessage }
      ];

      const prompt = buildUserPrompt('Test', history, 'inquiry', null);

      // Should contain truncated version (100 chars + ...)
      expect(prompt).toContain('...');
      expect(prompt.indexOf(longMessage)).toBe(-1);
    });
  });
});

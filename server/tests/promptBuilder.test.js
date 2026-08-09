/**
 * Prompt Builder tests.
 *
 * Four assertions in this file were written against an earlier revision of the
 * prompt and had been failing ever since it was rewritten. They asserted
 * incidental literals rather than behaviour, so they were retargeted at the
 * intent they were meant to protect — each change is justified inline. No
 * production behaviour was bent to make them pass:
 *
 *  - `toContain('AirbnbHostAI')` (x2): that persona identifier no longer exists.
 *    The prompt now opens with an explicit French host-persona instruction.
 *    Re-inserting a magic string into a tuned prompt to satisfy a test would be
 *    the tail wagging the dog; the assertion now checks the persona is set.
 *  - `toContain('2 personnes')` in buildUserPrompt: conflated the SYSTEM
 *    prompt's capacity line ("Capacité max: 4 personnes") with the USER
 *    prompt's guest-count line. The value was always present, as
 *    "Nombre de personnes: 2".
 *  - the truncation test used a 200-char message while the history cap is 300
 *    (raised deliberately to give the model more context). A 200-char message
 *    is CORRECTLY not truncated, so the test now uses one that really exceeds
 *    the cap — which is what it was trying to verify.
 */
const { buildSystemPrompt, buildUserPrompt } = require('../services/promptBuilder');

// Mirrors the slice length in promptBuilder.buildUserPrompt().
const HISTORY_TRUNCATE_AT = 300;

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

      // Persona is set (replaces the removed 'AirbnbHostAI' identifier).
      expect(prompt).toContain('hôte Airbnb');
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

      expect(prompt).toContain('hôte Airbnb');
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
      expect(prompt).toContain('Nombre de personnes: 2');
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
      const longMessage = 'A'.repeat(HISTORY_TRUNCATE_AT + 50);
      const history = [
        { role: 'incoming', content: longMessage }
      ];

      const prompt = buildUserPrompt('Test', history, 'inquiry', null);

      // Kept up to the cap, then an ellipsis; the full message never appears.
      expect(prompt).toContain('A'.repeat(HISTORY_TRUNCATE_AT));
      expect(prompt).toContain('...');
      expect(prompt.indexOf(longMessage)).toBe(-1);
    });
  });
});

const { 
  sanitizeString, 
  sanitizeEmail, 
  sanitizeJSON, 
  removeScriptTags 
} = require('../utils/sanitize');

describe('Sanitize Utils', () => {
  describe('sanitizeString', () => {
    test('should trim whitespace', () => {
      const result = sanitizeString('  hello world  ');
      expect(result).toBe('hello world');
    });

    test('should remove null bytes', () => {
      const result = sanitizeString('hello\0world');
      expect(result).toBe('helloworld');
    });

    test('should truncate very long strings', () => {
      const longString = 'a'.repeat(15000);
      const result = sanitizeString(longString);
      expect(result.length).toBe(10000);
    });

    test('should return non-string input as-is', () => {
      const result = sanitizeString(123);
      expect(result).toBe(123);
    });

    test('should handle empty string', () => {
      const result = sanitizeString('');
      expect(result).toBe('');
    });
  });

  describe('sanitizeEmail', () => {
    test('should lowercase and trim email', () => {
      const result = sanitizeEmail('  Test@Example.COM  ');
      expect(result).toBe('test@example.com');
    });

    test('should accept valid email', () => {
      const result = sanitizeEmail('user@example.com');
      expect(result).toBe('user@example.com');
    });

    test('should throw on invalid email format', () => {
      expect(() => sanitizeEmail('invalid-email')).toThrow('Invalid email format');
      expect(() => sanitizeEmail('no@domain')).toThrow('Invalid email format');
      expect(() => sanitizeEmail('@example.com')).toThrow('Invalid email format');
    });

    test('should throw on too long email', () => {
      const longEmail = 'a'.repeat(250) + '@example.com';
      expect(() => sanitizeEmail(longEmail)).toThrow('Email too long');
    });

    test('should return empty string for non-string input', () => {
      const result = sanitizeEmail(null);
      expect(result).toBe('');
    });
  });

  describe('sanitizeJSON', () => {
    test('should parse valid JSON string', () => {
      const result = sanitizeJSON('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    test('should return object as-is', () => {
      const obj = { key: 'value' };
      const result = sanitizeJSON(obj);
      expect(result).toEqual(obj);
    });

    test('should throw on invalid JSON', () => {
      expect(() => sanitizeJSON('invalid json')).toThrow('Invalid JSON format');
      expect(() => sanitizeJSON('{key: value}')).toThrow('Invalid JSON format');
    });

    test('should handle arrays', () => {
      const result = sanitizeJSON('[1, 2, 3]');
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('removeScriptTags', () => {
    test('should remove script tags', () => {
      const input = 'Hello <script>alert("XSS")</script> World';
      const result = removeScriptTags(input);
      expect(result).toBe('Hello  World');
    });

    test('should remove multiple script tags', () => {
      const input = '<script>bad()</script>Text<script>worse()</script>';
      const result = removeScriptTags(input);
      expect(result).toBe('Text');
    });

    test('should handle script tags with attributes', () => {
      const input = '<script type="text/javascript">code()</script>Safe';
      const result = removeScriptTags(input);
      expect(result).toBe('Safe');
    });

    test('should preserve non-script HTML', () => {
      const input = '<div>Hello</div> <span>World</span>';
      const result = removeScriptTags(input);
      expect(result).toBe(input);
    });

    test('should return non-string as-is', () => {
      const result = removeScriptTags(null);
      expect(result).toBeNull();
    });

    test('should handle empty string', () => {
      const result = removeScriptTags('');
      expect(result).toBe('');
    });
  });
});
